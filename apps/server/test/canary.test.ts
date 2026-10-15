/**
 * The canary (R22): posts pass through the server and nothing is kept. A marker in post text, link titles and the
 * interest profile is sent down every classify path in one run against one app and one database: a success, provider
 * failures that echo it, and requests the server refuses. The fact-check job endpoints get the same (P3-19): a done job,
 * a provider failure that echoes it, a friends-only post and an invalid body; so do the perspectives job endpoints
 * (P3-35), with the marker in the shared link's URL path and title. Afterwards it must be in none of the app's
 * log lines, nothing the process wrote to standard output, standard error or the console, no error answer and no row of
 * any table, graphile-worker's included. The model (and, for a check, the search provider) is the one place it may
 * reach, and never from a friends-only post.
 *
 * The run uses PGlite in every `pnpm test`, and Postgres too when `TEST_DATABASE_URL` is set (the CI `server` job). The
 * same check runs through the Cloud's nginx in CL1-35.
 */
import { readFileSync } from 'node:fs';
import { format } from 'node:util';
import { describeError } from '@unalgorithm/ai';
import { FIXTURE_REGISTRY } from '@unalgorithm/outlets/testing';
import {
  CLASSIFY_PATH,
  ClassifyResponseSchema,
  FACTCHECK_JOBS_PATH,
  FactcheckJobSchema,
  factcheckJobPath,
  PERSPECTIVES_JOBS_PATH,
  PerspectivesJobSchema,
  perspectivesJobPath,
} from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { startMockSearxng } from '@unalgorithm/research/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { createJobRegistry, startJobs } from '../src/jobs/worker.ts';
import { CANARY, canaryPosts, canaryProfile, FRIENDS_ONLY } from './support/canary.ts';
import { classifyBody, postClassify } from './support/classify.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { seedPassingRoute } from './support/routes.ts';
import { scanAllTables as scanTables } from './support/scan-tables.ts';
import { DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';

/** Starting the database, signing in and a dozen requests: more than one test's worth on a busy CI runner. */
const RUN_TIMEOUT = 90_000;

const TOM = 'tom@example.com';

/** Fact-check and perspectives on, researching through a mock SearXNG at `searchUrl`. */
const configFor = (searchUrl: string) =>
  testConfig({
    SIGNUP_ALLOWLIST: TOM,
    FACTCHECK: 'on',
    PERSPECTIVES: 'on',
    SEARCH_PROVIDER: 'searxng',
    SEARCH_URL: searchUrl,
  });

/** A shared link carrying the marker in its URL path and its title: all of a link that leaves the device. */
const CANARY_SHARED = { url: `https://news.example.com/2026/${CANARY}/bridge`, title: `Bridge reopens ${CANARY}` };
/** The friends-only post's link, with `FRIENDS_ONLY` in its path so a test can tell whether it went anywhere. */
const FRIENDS_SHARED = { url: `https://news.example.com/${FRIENDS_ONLY}/${CANARY}`, title: `Family ${CANARY}` };

/**
 * The mock SearXNG's answers: on a bucket search (a `site:` clause), one hit an hour old on each fixture domain named, so
 * a comparison finds coverage; otherwise its default three hits.
 */
function canaryHits(query: string) {
  const sites = [...query.matchAll(/site:([a-z0-9.-]+)/g)].map((m) => m[1] ?? '');
  const domains = sites.length ? sites : ['a.example', 'b.example', 'c.example'];
  const published = sites.length ? new Date(Date.now() - 3_600_000).toISOString() : null;
  return domains.map((d, i) => ({
    url: `https://${d}/record-${i + 1}`,
    title: `Record ${i + 1}`,
    snippet: `Records show that ${query.slice(0, 80)}.`,
    published,
  }));
}
const INSTANCE_NAME = testConfig().instanceName;

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

/** The classify paths, then the fact-check paths, in the order they run. */
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
  /** 8: a check of a public post, polled until done. */
  checkDone: Answer;
  /** 9: a check whose provider fails with a body that echoes the marker, polled until failed. */
  checkProviderEcho: Answer;
  /** 10: a check of the friends-only post, refused before a job. */
  checkFriendsOnly: Answer;
  /** 11: a check whose body fails the schema. */
  checkInvalid: Answer;
  /** 12: a comparison of the marked link, polled until done. */
  compareDone: Answer;
  /** 13: a comparison whose provider fails with a body that echoes the marker, polled until failed. */
  compareProviderEcho: Answer;
  /** 14: a comparison of a friends-only Facebook post's link, refused before a job. */
  compareFriendsOnly: Answer;
  /** 15: a comparison body carrying post text (the marker) in `text`, refused by the strict schema. */
  compareInvalid: Answer;
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
  /** Every query the mock SearXNG received from the fact-check paths on. */
  searched: string[];
  /** The queries of the done comparison (path 12). */
  compareSearched: string[];
  /** Every query the mock SearXNG received. */
  allSearched: string[];
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
    const searx = await startMockSearxng({ hits: canaryHits });
    cleanup.push(() => searx.close());
    const t = await createTestApp({ config: configFor(searx.url), db: database.handle, outlets: FIXTURE_REGISTRY });
    cleanup.push(t.close);
    await seedPassingRoute(database.handle.db, {
      task: 'synthesis',
      effort: 'medium',
      evalPromptVersion: FACTCHECK_PROMPT_VERSION,
      baseUrl: t.mock.baseUrl,
    });
    // graphile-worker runs around the requests (on Postgres; PGlite has none), so its tables exist to be scanned.
    const registry = createJobRegistry();
    registry.task('canary.noop', async () => {});
    const worker = await startJobs(database.handle, registry, t.deps.log);
    cleanup.push(() => worker.stop());
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
    const auth = { Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` };
    const startCheck = (body: unknown) => request(() => postJson(t.app, FACTCHECK_JOBS_PATH, body, auth));
    /** Starts a check and polls it until it ends: the answer is the last poll's, with every model call of the job. */
    const check = async (post: unknown): Promise<Answer> => {
      const before = t.mock.bodies.length;
      const start = await startCheck({ v: 1, post });
      if (start.status !== 202) return start;
      const { id } = FactcheckJobSchema.parse(JSON.parse(start.body));
      for (;;) {
        const res = await t.app.request(`${factcheckJobPath(id)}?wait=1`, { headers: auth });
        const body = await res.text();
        if (FactcheckJobSchema.parse(JSON.parse(body)).status === 'running') continue;
        const headers = JSON.stringify([...res.headers]);
        return { status: res.status, headers, body, sent: t.mock.bodies.slice(before) };
      }
    };

    const startCompare = (body: unknown) => request(() => postJson(t.app, PERSPECTIVES_JOBS_PATH, body, auth));
    /** Starts a comparison and polls it until it ends, as `check` does. */
    const compare = async (body: unknown): Promise<Answer> => {
      const before = t.mock.bodies.length;
      const start = await startCompare(body);
      if (start.status !== 202) return start;
      const { id } = PerspectivesJobSchema.parse(JSON.parse(start.body));
      for (;;) {
        const res = await t.app.request(`${perspectivesJobPath(id)}?wait=1`, { headers: auth });
        const answer = await res.text();
        if (PerspectivesJobSchema.parse(JSON.parse(answer)).status === 'running') continue;
        const headers = JSON.stringify([...res.headers]);
        return { status: res.status, headers, body: answer, sent: t.mock.bodies.slice(before) };
      }
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

    const searchedBefore = searx.queries.length;
    const checkDone = await check(posts[0]);
    t.mock.failNext(500, `echo: ${CANARY}`);
    const checkProviderEcho = await check(posts[0]);
    const searchedPublic = searx.queries.length;
    const checkFriendsOnly = await check(friendsPost[0]);
    const checkInvalid = await startCheck({ v: 1, post: { text: `Quarterly update ${CANARY}` } });
    // Neither refused check reached the search provider.
    expect(searx.queries.length).toBe(searchedPublic);

    const compareSearchedBefore = searx.queries.length;
    const compareDone = await compare({ v: 1, link: CANARY_SHARED, platform: 'linkedin' });
    const compareSearched = searx.queries.slice(compareSearchedBefore);
    t.mock.failNext(500, `echo: ${CANARY}`);
    const compareProviderEcho = await compare({ v: 1, link: CANARY_SHARED, platform: 'facebook', audience: 'public' });
    const comparedPublic = searx.queries.length;
    const compareFriendsOnly = await compare({ v: 1, link: FRIENDS_SHARED, platform: 'facebook', audience: 'friends' });
    const compareInvalid = await startCompare({
      v: 1,
      link: CANARY_SHARED,
      platform: 'linkedin',
      text: `Quarterly update ${CANARY}`,
    });
    // Neither refused comparison reached the search provider.
    expect(searx.queries.length).toBe(comparedPublic);

    const answers: Answers = {
      classified,
      providerEcho,
      multiLineEcho,
      providerBadInput,
      thirteenPosts,
      notJson,
      noToken,
      friendsOnly,
      checkDone,
      checkProviderEcho,
      checkFriendsOnly,
      checkInvalid,
      compareDone,
      compareProviderEcho,
      compareFriendsOnly,
      compareInvalid,
    };
    // `output` is filled when the capture stops, after the app and the database have closed.
    return {
      answers,
      log: t.lines,
      output: capture.output,
      tables: await scanTables(database.handle),
      sent: t.mock.bodies,
      searched: searx.queries.slice(searchedBefore),
      compareSearched,
      allSearched: [...searx.queries],
    };
  } finally {
    try {
      for (const step of cleanup.reverse()) await step();
    } finally {
      capture.stop();
    }
  }
}

describe.each(DATABASES)('canary (%s)', (name, open) => {
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
    const message = describeError('bad-request', INSTANCE_NAME);
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
    // Five classify rows, two fact-check job rows and two perspectives job rows.
    expect(JSON.parse(run.tables.get('public.usage_events') ?? '[]')).toHaveLength(9);
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

  check('test_canary_factcheck_absent_everywhere', () => {
    const { checkDone, checkProviderEcho, checkFriendsOnly, checkInvalid } = run.answers;

    // A done job: the marker travelled to the model and the search provider, as the post is public.
    expect(checkDone.status).toBe(200);
    expect(FactcheckJobSchema.parse(JSON.parse(checkDone.body)).status).toBe('done');
    expect(checkDone.sent.length).toBeGreaterThanOrEqual(2);
    for (const body of checkDone.sent) expect(body).toContain(CANARY);
    expect(run.searched.length).toBeGreaterThan(0);
    expect(run.searched.some((q) => q.includes(CANARY))).toBe(true);

    // The provider echoed the marker: the job failed with `describeError` text only.
    const failed = FactcheckJobSchema.parse(JSON.parse(checkProviderEcho.body));
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'overloaded', message: describeError('overloaded', INSTANCE_NAME) });
    expect(checkProviderEcho.sent).toHaveLength(1);

    // Refused before a job: nothing reached the model or the search provider.
    expect(checkFriendsOnly.status).toBe(400);
    expect(checkInvalid.status).toBe(400);
    for (const answer of [checkFriendsOnly, checkInvalid]) expect(answer.sent).toEqual([]);
    for (const query of run.searched) expect(query).not.toContain(FRIENDS_ONLY);

    for (const answer of [checkProviderEcho, checkFriendsOnly, checkInvalid]) {
      expect(answer.body).not.toContain(CANARY);
      expect(answer.headers).not.toContain(CANARY);
    }
    expect(run.log.filter((line) => line.includes('"event":"factcheck.done"'))).toHaveLength(2);
    expect(run.log.filter((line) => line.includes(CANARY))).toEqual([]);
    expect(run.output.filter((chunk) => chunk.includes(CANARY))).toEqual([]);

    // Two job rows (done, failed), and no table holds the marker: graphile-worker's too on Postgres.
    const rows = JSON.parse(run.tables.get('public.usage_events') ?? '[]') as { task: string }[];
    expect(rows.filter((r) => r.task === 'factcheck')).toHaveLength(2);
    if (name === 'postgres') expect([...run.tables.keys()].some((t) => t.startsWith('graphile_worker.'))).toBe(true);
    expect([...run.tables].filter(([, r]) => r.includes(CANARY)).map(([table]) => table)).toEqual([]);

    // Jobs live in memory only: the route module never touches graphile-worker.
    const source = readFileSync(new URL('../src/routes/factcheck.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*'[^']*(?:graphile-worker|jobs\/worker)/);
  });

  check('test_canary_perspectives_link_never_kept', () => {
    const { compareDone, compareProviderEcho, compareFriendsOnly, compareInvalid } = run.answers;

    // A done comparison: the link travelled to the model and, as its story query, to the search provider.
    expect(compareDone.status).toBe(200);
    const done = PerspectivesJobSchema.parse(JSON.parse(compareDone.body));
    expect(done.status).toBe('done');
    expect(done.result?.sources.length).toBeGreaterThan(0);
    expect(compareDone.sent.length).toBeGreaterThanOrEqual(2);
    expect(compareDone.sent.some((body) => body.includes(CANARY))).toBe(true);
    expect(run.compareSearched).toHaveLength(5);
    // Only the shared link left: no post text of any canary post reached the model during a comparison.
    for (const body of [...compareDone.sent, ...compareProviderEcho.sent]) expect(body).not.toContain('Quarterly update');

    // The provider echoed the marker: the job failed with `describeError` text only.
    const failed = PerspectivesJobSchema.parse(JSON.parse(compareProviderEcho.body));
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'overloaded', message: describeError('overloaded', INSTANCE_NAME) });
    expect(compareProviderEcho.sent).toHaveLength(1);

    // Refused before a job: the friends-only link reached neither the model nor the search provider.
    expect(compareFriendsOnly.status).toBe(400);
    expect(compareInvalid.status).toBe(400);
    for (const answer of [compareFriendsOnly, compareInvalid]) expect(answer.sent).toEqual([]);
    for (const body of run.sent) expect(body).not.toContain(FRIENDS_ONLY);
    for (const query of run.allSearched) expect(query).not.toContain(FRIENDS_ONLY);

    for (const answer of [compareDone, compareProviderEcho, compareFriendsOnly, compareInvalid]) {
      expect(answer.headers).not.toContain(CANARY);
    }
    for (const answer of [compareProviderEcho, compareFriendsOnly, compareInvalid]) expect(answer.body).not.toContain(CANARY);
    expect(run.log.filter((line) => line.includes('"event":"perspectives.done"'))).toHaveLength(2);
    expect(run.log.filter((line) => line.includes(CANARY) || line.includes('news.example.com'))).toEqual([]);
    expect(run.output.filter((chunk) => chunk.includes(CANARY))).toEqual([]);

    // Two job rows (done, failed), and no table holds the marker: graphile-worker's too on Postgres.
    const rows = JSON.parse(run.tables.get('public.usage_events') ?? '[]') as { task: string }[];
    expect(rows.filter((r) => r.task === 'perspectives')).toHaveLength(2);
    expect([...run.tables].filter(([, r]) => r.includes(CANARY) || r.includes('news.example.com')).map(([t]) => t)).toEqual([]);

    // Jobs live in memory only: the route module never touches graphile-worker.
    const source = readFileSync(new URL('../src/routes/perspectives.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*'[^']*(?:graphile-worker|jobs\/worker)/);
  });
});
