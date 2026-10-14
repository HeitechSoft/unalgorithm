/**
 * The canary (R22): posts pass through the server and nothing is kept. A marker in post text, link titles and the
 * interest profile is sent down every classify path in one run against one app and one database: a success, provider
 * failures that echo it, and requests the server refuses. Afterwards it must be in none of the app's log lines, nothing
 * the process wrote to standard output, standard error or the console, no error answer and no row of any table. The
 * model is the one place it may reach, and never from a friends-only post.
 *
 * The run uses PGlite in every `pnpm test`, and Postgres too when `TEST_DATABASE_URL` is set (the CI `server` job). The
 * same check runs through the Cloud's nginx in CL1-35.
 */
import { format } from 'node:util';
import { describeError } from '@unalgorithm/ai';
import { CLASSIFY_PATH, ClassifyResponseSchema } from '@unalgorithm/protocol';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { CANARY, canaryPosts, canaryProfile, FRIENDS_ONLY } from './support/canary.ts';
import { classifyBody, postClassify } from './support/classify.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { scanAllTables as scanTables } from './support/scan-tables.ts';
import { DEV_EXTENSION_ORIGIN, signInDevice } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';

/** Starting the database, signing in and eight requests: more than one test's worth on a busy CI runner. */
const RUN_TIMEOUT = 90_000;

const TOM = 'tom@example.com';

const CONFIG = testConfig({ SIGNUP_ALLOWLIST: TOM });

/**
 * The response formats the OpenAI-compatible client tries in turn (strict JSON schema, loose JSON schema, JSON object,
 * prompt only). It reads a provider's 400 as a format the provider does not take and steps down a format, so the 400 is
 * queued once for each: only then does it reach the handler as the provider's answer.
 */
const RESPONSE_FORMATS = 4;

/**
 * Tables the scan must find. Every base table is scanned, so a new one is covered by itself; one renamed or moved out of
 * these schemas fails here instead of dropping out of the scan.
 */
const REQUIRED_TABLES = [
  'user',
  'session',
  'verification',
  'jwks',
  'devices',
  'auth_codes',
  'refresh_tokens',
  'ai_routes',
  'usage_events',
  'user_limits',
];

/** What a request got back, and what the mock provider received while it ran. */
interface Answer {
  status: number;
  headers: string;
  body: string;
  sent: string[];
}

/** The eight paths, in the order they run. */
interface Answers {
  /** 1: six posts classified, the friends-only one declined. */
  classified: Answer;
  /** 2: the provider fails with a body that echoes the marker. */
  providerEcho: Answer;
  /** 2b: the same, on a later line (`errorFields` drops only the first line of a message from `err_stack`). */
  multiLineEcho: Answer;
  /** 3: the provider rejects the request on every response format, quoting the marker. */
  providerBadInput: Answer;
  /** 4: 13 posts, which the schema refuses. */
  thirteenPosts: Answer;
  /** 5: a body that is not valid JSON. */
  notJson: Answer;
  /** 6: no access token. */
  noToken: Answer;
  /** 7: only the friends-only post, which never reaches a model. */
  friendsOnly: Answer;
}

interface CanaryRun {
  answers: Answers;
  /** The app's log lines. */
  log: string[];
  /** Every chunk written to standard output or standard error, and every console call, during the run. */
  output: string[];
  /** Every base table of the `public` and `drizzle` schemas, as `schema.table`, with all its rows as JSON. */
  tables: Map<string, string>;
  /** Every body the mock provider received. */
  sent: string[];
}

interface CanaryDatabase {
  handle: DbHandle;
  close(): Promise<void>;
}

type OpenDatabase = () => Promise<CanaryDatabase>;

async function pgliteDatabase(): Promise<CanaryDatabase> {
  const handle = await createTestDb();
  return { handle, close: () => handle.close() };
}

/**
 * A database of its own on the `TEST_DATABASE_URL` server: other test files use that server at the same time (a
 * fresh-database migration test, say), and the scan must see this run's rows only.
 */
async function postgresDatabase(): Promise<CanaryDatabase> {
  const pg = await createPostgresTestDb('canary');
  const handle = openPostgres(pg.url);
  const close = async () => {
    try {
      await handle.close();
    } finally {
      await pg.drop();
    }
  };
  try {
    await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
  } catch (err) {
    await close();
    throw err;
  }
  return { handle, close };
}

const DATABASES: [string, OpenDatabase | undefined][] = [
  ['pglite', pgliteDatabase],
  ['postgres', TEST_DATABASE_URL ? postgresDatabase : undefined],
];

/**
 * Records what the process writes outside the app's logger: Better Auth and other libraries may write to the console or
 * straight to standard output. Writes still go through. `stop()` fills `output` with everything recorded and puts the
 * originals back.
 */
function captureOutput(): { output: string[]; stop(): void } {
  const streams = [vi.spyOn(process.stdout, 'write'), vi.spyOn(process.stderr, 'write')];
  const consoles = (['debug', 'info', 'log', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method));
  const output: string[] = [];
  return {
    output,
    stop() {
      for (const spy of streams) {
        for (const [chunk] of spy.mock.calls) output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        spy.mockRestore();
      }
      for (const spy of consoles) {
        for (const args of spy.mock.calls) output.push(format(...args));
        spy.mockRestore();
      }
    },
  };
}

/** The eight paths against one app on `open`'s database, then the scan of every table. */
async function runCanary(open: OpenDatabase): Promise<CanaryRun> {
  const capture = captureOutput();
  const cleanup: (() => Promise<unknown>)[] = [];
  try {
    const database = await open();
    cleanup.push(() => database.close());
    const t = await createTestApp({ config: CONFIG, db: database.handle });
    cleanup.push(t.close);
    const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;

    const profile = canaryProfile();
    const posts = await canaryPosts(6);
    const friendsPost = posts.slice(-1);
    const thirteen = await canaryPosts(12);
    const request = async (send: () => Promise<Response>): Promise<Answer> => {
      const before = t.mock.bodies.length;
      const res = await send();
      const headers = JSON.stringify([...res.headers]);
      return { status: res.status, headers, body: await res.text(), sent: t.mock.bodies.slice(before) };
    };
    const classify = (body: unknown, auth: string | null = token) => request(() => postClassify(t.app, body, auth));

    const classified = await classify(classifyBody(posts, profile));
    t.mock.failNext(500, `echo: ${CANARY}`);
    const providerEcho = await classify(classifyBody(posts, profile));
    t.mock.failNext(502, `<html>\nupstream error\n${CANARY}\n</html>`);
    const multiLineEcho = await classify(classifyBody(posts, profile));
    for (let i = 0; i < RESPONSE_FORMATS; i++) t.mock.failNext(400, `{"error":"bad input ${CANARY}"}`);
    const providerBadInput = await classify(classifyBody(posts, profile));
    const thirteenPosts = await classify(classifyBody(thirteen, profile));
    const notJson = await request(async () =>
      t.app.request(CLASSIFY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` },
        body: `{"v":1,"posts":[{"ref":"pk_x","text":"Quarterly update ${CANARY}`,
      }),
    );
    const noToken = await classify(classifyBody(posts, profile), null);
    const friendsOnly = await classify(classifyBody(friendsPost, profile));

    const answers: Answers = {
      classified,
      providerEcho,
      multiLineEcho,
      providerBadInput,
      thirteenPosts,
      notJson,
      noToken,
      friendsOnly,
    };
    // `output` is filled when the capture stops, after the app and the database have closed.
    return { answers, log: t.lines, output: capture.output, tables: await scanTables(database.handle), sent: t.mock.bodies };
  } finally {
    try {
      for (const step of cleanup.reverse()) await step();
    } finally {
      capture.stop();
    }
  }
}

describe.each(DATABASES)('canary (%s)', (_name, open) => {
  let run: CanaryRun;
  beforeAll(async () => {
    if (open) run = await runCanary(open);
  }, RUN_TIMEOUT);
  // Postgres only when `TEST_DATABASE_URL` names a server.
  const check = it.skipIf(!open);

  check('test_canary_absent_from_logs_and_stdout', () => {
    // The app's log was captured: one `classify.done` for each request that reached the handler (1, 2, 2b, 3 and 7).
    expect(run.log.filter((line) => line.includes('"event":"classify.done"'))).toHaveLength(5);
    expect(run.log.filter((line) => line.includes(CANARY))).toEqual([]);
    expect(run.output.filter((chunk) => chunk.includes(CANARY))).toEqual([]);
  });

  check('test_canary_absent_from_error_bodies', () => {
    const { answers } = run;
    const expected: [keyof Answers, number][] = [
      ['providerEcho', 503],
      ['multiLineEcho', 503],
      // A 400 is about the posts, not the provider: each post gets an error, and the request does not fail.
      ['providerBadInput', 200],
      ['thirteenPosts', 400],
      ['notJson', 400],
      ['noToken', 401],
    ];
    for (const [path, status] of expected) {
      expect(answers[path].status, path).toBe(status);
      expect(answers[path].body, path).not.toContain(CANARY);
      expect(answers[path].headers, path).not.toContain(CANARY);
    }

    // Path 3 reached the handler as the provider's own 400, which quoted the marker: every response format was tried and
    // refused, and each post's error is `describeError` text, never the provider's words.
    const badInput = answers.providerBadInput;
    expect(badInput.sent).toHaveLength(RESPONSE_FORMATS);
    for (const body of badInput.sent) expect(body).toContain(CANARY);
    const message = describeError('bad-request', CONFIG.instanceName);
    const { results } = ClassifyResponseSchema.parse(JSON.parse(badInput.body));
    expect(results.map((r) => (r.status === 'error' ? `error: ${r.message}` : r.status))).toEqual([
      ...Array.from({ length: 6 }, () => `error: ${message}`),
      'declined',
    ]);
  });

  check('test_canary_absent_from_every_table', () => {
    const names = [...run.tables.keys()];
    for (const table of REQUIRED_TABLES) expect(names).toContain(`public.${table}`);
    // Better Auth's table was read, not the current role, and the rows written during the run were there to scan.
    expect(run.tables.get('public.user')).toContain(TOM);
    expect(JSON.parse(run.tables.get('public.usage_events') ?? '[]')).toHaveLength(5);
    expect([...run.tables].filter(([, rows]) => rows.includes(CANARY)).map(([name]) => name)).toEqual([]);
  });

  check('test_canary_reached_provider_only_when_allowed', () => {
    const { classified, thirteenPosts, notJson, noToken, friendsOnly } = run.answers;
    expect(classified.status).toBe(200);
    const { results } = ClassifyResponseSchema.parse(JSON.parse(classified.body));
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'declined']);
    // The marker really travelled: the model received it in every call of path 1.
    expect(classified.sent.length).toBeGreaterThan(0);
    for (const body of classified.sent) expect(body).toContain(CANARY);

    // Refused before the handler, or nothing left to send: the model received nothing.
    for (const answer of [thirteenPosts, notJson, noToken, friendsOnly]) expect(answer.sent).toEqual([]);
    expect(friendsOnly.status).toBe(200);
    expect(ClassifyResponseSchema.parse(JSON.parse(friendsOnly.body)).results.map((r) => r.status)).toEqual(['declined']);
    // The friends-only post never reached the model, in any path.
    expect(run.sent.length).toBeGreaterThan(0);
    for (const body of run.sent) expect(body).not.toContain(FRIENDS_ONLY);
  });
});
