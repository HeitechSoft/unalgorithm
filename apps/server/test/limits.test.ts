import { randomUUID } from 'node:crypto';
import { describeError } from '@unalgorithm/ai';
import { ClassifyResponseSchema, type PostForAI, type TokenResponse } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter, IDLE_BUCKET_MS } from '../src/ai/limits.ts';
import { postsToday } from '../src/ai/metering.ts';
import { main as userCap } from '../src/cli/user-cap.ts';
import type { Db } from '../src/db/client.ts';
import { usageEvents, user, userLimits } from '../src/db/schema.ts';
import { classifyBody, postClassify, serverPost, usageRowOf } from './support/classify.ts';
import { createTestDb } from './support/db.ts';
import { DEV_EXTENSION_ORIGIN, signInDevice } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const INSTANCE = 'Test server';

type TestApp = Awaited<ReturnType<typeof limitsApp>>;

/** Apps a test opened, closed after it whatever the outcome; fake timers are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with these limit variables, and signed-in devices for Tom and Ana. */
async function limitsApp(env: Record<string, string> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${TOM},${ANA}`, ...env }) });
  cleanup.push(t.close);
  const tom = await signInDevice(t.app, t.outbox, TOM);
  const ana = await signInDevice(t.app, t.outbox, ANA);
  return { ...t, tom, ana, tomId: await userId(t.deps.db.db, TOM), anaId: await userId(t.deps.db.db, ANA) };
}

async function userId(db: Db, email: string): Promise<string> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error(`No account for ${email}.`);
  return row.id;
}

let postSeq = 0;

/** `n` LinkedIn posts the mock classifies, each with a ref of its own. */
function linkedInPosts(n: number): Promise<PostForAI[]> {
  return Promise.all(
    Array.from({ length: n }, () => {
      const key = `P${++postSeq}`;
      return serverPost(key, `Post ${key} about automation`);
    }),
  );
}

/** A classify request of `n` LinkedIn posts with this device's access token. */
async function classifyAs(t: TestApp, tokens: TokenResponse, n = 1): Promise<Response> {
  return postClassify(t.app, classifyBody(await linkedInPosts(n)), tokens.access_token);
}

/** A classify request whose posts are all Facebook posts that are not public. */
async function classifyHiddenAs(t: TestApp, tokens: TokenResponse): Promise<Response> {
  const posts = [
    await serverPost(`F${++postSeq}`, 'Family news', { platform: 'facebook', audience: 'friends' }),
    await serverPost(`F${++postSeq}`, 'Holiday photos', { platform: 'facebook' }),
  ];
  return postClassify(t.app, classifyBody(posts), tokens.access_token);
}

/** A usage row written now, as an earlier request would have left it: `postsOk` posts at `costMicros`. */
async function seedUsage(t: TestApp, userId: string, { postsOk = 0, costMicros = 0 }) {
  await t.deps.db.db.insert(usageEvents).values({
    requestId: randomUUID(),
    userId,
    task: 'classify',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    postsRequested: postsOk,
    postsOk,
    calls: 1,
    failedCalls: 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: 0,
    estimated: false,
    costMicros,
    chargeableCostMicros: costMicros,
    createdAt: new Date(),
  });
}

async function expectRefused(res: Response, code: 'rate-limit' | 'cap-reached'): Promise<void> {
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ code, message: describeError(code, INSTANCE) });
}

/** Refused before any call: one row, zero usage. */
async function expectMeteredRefusal(t: TestApp, res: Response): Promise<void> {
  expect(await usageRowOf(t.deps.db.db, res)).toMatchObject({
    outcome: 'refused-before-call',
    routeId: null,
    postsOk: 0,
    calls: 0,
    uncachedInput: 0,
    output: 0,
  });
}

/** Runs `user-cap` against the test server's database and configuration; returns the exit code and output. */
async function runUserCap(t: TestApp, argv: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await userCap(argv, { db: t.deps.db, config: t.deps.config, out: (line) => lines.push(line) });
  return { code, lines };
}

const breakerLines = (t: TestApp) => t.events().filter((e) => e.event === 'limits.spend_breaker');

describe('rate limit', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_rate_limit_31st_request', async () => {
    const t = await limitsApp({ USER_REQUESTS_PER_MINUTE: '30' });
    // Only Date is faked, and it stands still: every request below falls in the same instant.
    vi.useFakeTimers({ toFake: ['Date'] });

    for (let i = 0; i < 30; i++) expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect(t.mock.bodies).toHaveLength(30);

    const limited = await classifyAs(t, t.tom);
    const retryAfter = Number(limited.headers.get('retry-after'));
    await expectRefused(limited, 'rate-limit');
    // A full bucket of 30 refills one request every 2 seconds.
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBe(2);
    expect(t.mock.bodies).toHaveLength(30);
    await expectMeteredRefusal(t, limited);

    vi.setSystemTime(Date.now() + 2000);
    expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect(t.mock.bodies).toHaveLength(31);
  });

  it('test_rate_limit_is_per_user', async () => {
    const t = await limitsApp();
    expect(t.deps.config.userRequestsPerMinute).toBe(30);
    vi.useFakeTimers({ toFake: ['Date'] });

    for (let i = 0; i < 30; i++) {
      expect((await classifyAs(t, t.tom)).status).toBe(200);
      expect((await classifyAs(t, t.ana)).status).toBe(200);
    }
    expect(t.mock.bodies).toHaveLength(60);
    // Each one's own bucket is now empty.
    await expectRefused(await classifyAs(t, t.tom), 'rate-limit');
    await expectRefused(await classifyAs(t, t.ana), 'rate-limit');
  });

  it('test_rate_limiter_drops_idle_buckets', () => {
    const limiter = createRateLimiter({ perMinute: 2 });
    const t0 = Date.parse('2026-10-13T12:00:00.000Z');

    expect(limiter.take('a', t0)).toEqual({ ok: true });
    expect(limiter.take('a', t0)).toEqual({ ok: true });
    // Two a minute: the next token is 30 seconds away, and a refusal does not spend it.
    expect(limiter.take('a', t0)).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(limiter.take('a', t0 + 10_000)).toEqual({ ok: false, retryAfterMs: 20_000 });
    expect(limiter.take('b', t0 + 20_000)).toEqual({ ok: true });
    expect(limiter.size).toBe(2);

    // Ten minutes after its last request, a's bucket goes on the next request of anyone; b's is younger and stays.
    expect(limiter.take('c', t0 + 10_000 + IDLE_BUCKET_MS)).toEqual({ ok: true });
    expect(limiter.size).toBe(2);
    expect(limiter.take('c', t0 + 20_000 + IDLE_BUCKET_MS)).toEqual({ ok: true });
    expect(limiter.size).toBe(1);

    // A dropped bucket was full anyway (it refills within a minute): a's next request starts a full one.
    const later = t0 + 20_000 + IDLE_BUCKET_MS;
    expect(limiter.take('a', later)).toEqual({ ok: true });
    expect(limiter.take('a', later)).toEqual({ ok: true });
    expect(limiter.take('a', later)).toMatchObject({ ok: false });
    expect(limiter.size).toBe(2);
  });

  it('test_rate_limit_retry_after_exposed', async () => {
    const t = await limitsApp({ USER_REQUESTS_PER_MINUTE: '1' });
    vi.useFakeTimers({ toFake: ['Date'] });

    expect((await classifyAs(t, t.tom)).status).toBe(200);
    const limited = await classifyAs(t, t.tom);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    const exposed = (limited.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim());
    expect(exposed.map((h) => h.toLowerCase())).toContain('retry-after');
    expect(limited.headers.get('retry-after')).toBe('60');
  });
});

describe('daily cap', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_daily_cap_refuses_and_meters', async () => {
    const t = await limitsApp({ USER_DAILY_POST_CAP: '10' });
    expect((await classifyAs(t, t.tom, 10)).status).toBe(200);
    expect(await postsToday(t.deps.db.db, t.tomId)).toBe(10);
    const calls = t.mock.bodies.length;

    const capped = await classifyAs(t, t.tom);
    await expectRefused(capped, 'cap-reached');
    // No Retry-After: the cap lifts at midnight UTC, and the extension pauses until then.
    expect(capped.headers.get('retry-after')).toBeNull();
    expect(t.mock.bodies).toHaveLength(calls);
    await expectMeteredRefusal(t, capped);
    expect(await t.deps.db.db.select().from(usageEvents)).toHaveLength(2);
    expect(await postsToday(t.deps.db.db, t.tomId)).toBe(10);

    // The cap is per person.
    expect((await classifyAs(t, t.ana)).status).toBe(200);
  });

  it('test_batch_below_cap_served_in_full', async () => {
    const t = await limitsApp({ USER_DAILY_POST_CAP: '10' });
    expect((await classifyAs(t, t.tom, 9)).status).toBe(200);

    const batch = await classifyAs(t, t.tom, 3);
    expect(batch.status).toBe(200);
    const { results } = ClassifyResponseSchema.parse(await batch.json());
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
    expect(await postsToday(t.deps.db.db, t.tomId)).toBe(12);

    await expectRefused(await classifyAs(t, t.tom), 'cap-reached');
  });

  it('test_user_cap_cli_override_and_default', async () => {
    const t = await limitsApp({ USER_DAILY_POST_CAP: '10' });
    expect((await classifyAs(t, t.tom, 10)).status).toBe(200);
    await expectRefused(await classifyAs(t, t.tom), 'cap-reached');

    // The address is matched in lowercase, as accounts store it.
    expect(await runUserCap(t, ['Tom@Example.com', '20'])).toEqual({
      code: 0,
      lines: ['daily cap for tom@example.com: 20 posts'],
    });
    const rows = await t.deps.db.db.select().from(userLimits);
    expect(rows).toEqual([expect.objectContaining({ userId: t.tomId, dailyPostCap: 20 })]);
    expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect(await postsToday(t.deps.db.db, t.tomId)).toBe(11);
    // Only Tom's cap changed.
    await seedUsage(t, t.anaId, { postsOk: 10 });
    await expectRefused(await classifyAs(t, t.ana), 'cap-reached');

    // Setting it again replaces the row.
    expect((await runUserCap(t, [TOM, '15'])).lines).toEqual(['daily cap for tom@example.com: 15 posts']);
    expect(await t.deps.db.db.select().from(userLimits)).toEqual([expect.objectContaining({ dailyPostCap: 15 })]);

    expect(await runUserCap(t, [TOM, 'default'])).toEqual({
      code: 0,
      lines: ['daily cap for tom@example.com uses the server default (10)'],
    });
    expect(await t.deps.db.db.select().from(userLimits)).toEqual([]);
    await expectRefused(await classifyAs(t, t.tom), 'cap-reached');
  });

  it('test_user_cap_cli_unknown_email', async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    const lines: string[] = [];
    const run = (argv: string[]) => userCap(argv, { db: handle, config: testConfig(), out: (line) => lines.push(line) });

    expect(await run(['unknown@example.com', '5'])).toBe(1);
    expect(lines).toEqual(['no account for unknown@example.com']);
    expect(await handle.db.select().from(userLimits)).toEqual([]);

    // Arguments it cannot read print the usage line, before anything is opened.
    for (const argv of [
      [],
      ['unknown@example.com'],
      ['unknown@example.com', '-1'],
      ['unknown@example.com', '2.5'],
      ['a', 'b', 'c'],
    ]) {
      lines.length = 0;
      expect(await run(argv), argv.join(' ')).toBe(1);
      expect(lines).toEqual([expect.stringMatching(/^usage: node apps\/server\/src\/cli\/user-cap\.ts /)]);
    }
  });
});

describe('spend breaker', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_spend_breaker_refuses_everyone_logs_once', async () => {
    const t = await limitsApp({ DAILY_SPEND_LIMIT_USD: '1' });
    // Just under the limit, requests are served.
    await seedUsage(t, t.anaId, { costMicros: 400_000 });
    await seedUsage(t, t.tomId, { postsOk: 3, costMicros: 599_999 });
    expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect(breakerLines(t)).toEqual([]);
    const calls = t.mock.bodies.length;

    await seedUsage(t, t.anaId, { costMicros: 1 });
    const refused = [await classifyAs(t, t.tom), await classifyAs(t, t.ana), await classifyAs(t, t.tom)];
    for (const res of refused) {
      await expectRefused(res, 'cap-reached');
      await expectMeteredRefusal(t, res);
    }
    expect(t.mock.bodies).toHaveLength(calls);

    const logged = breakerLines(t);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn', spend_micros: 1_000_000, limit_micros: 1_000_000 });
  });

  it('test_limits_reset_at_utc_midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T23:58:00.000Z'));
    // Signed in at 23:58: the 15-minute access tokens outlast midnight.
    const t = await limitsApp({ USER_DAILY_POST_CAP: '10', DAILY_SPEND_LIMIT_USD: '1' });

    // Tom has used his day; nobody has spent much yet.
    await seedUsage(t, t.tomId, { postsOk: 10 });
    await expectRefused(await classifyAs(t, t.tom), 'cap-reached');
    expect((await classifyAs(t, t.ana)).status).toBe(200);
    // Then the server reaches its limit.
    await seedUsage(t, t.anaId, { costMicros: 1_000_000 });
    await expectRefused(await classifyAs(t, t.ana), 'cap-reached');
    expect(breakerLines(t)).toHaveLength(1);

    vi.setSystemTime(new Date('2026-10-14T00:00:01.000Z'));
    expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect((await classifyAs(t, t.ana)).status).toBe(200);

    // A new day's trip is logged again, once.
    await seedUsage(t, t.tomId, { costMicros: 1_000_000 });
    await expectRefused(await classifyAs(t, t.ana), 'cap-reached');
    await expectRefused(await classifyAs(t, t.tom), 'cap-reached');
    expect(breakerLines(t)).toHaveLength(2);
  });
});

describe('ordering', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_excluded_only_requests_cost_nothing', async () => {
    const t = await limitsApp({ USER_REQUESTS_PER_MINUTE: '1', USER_DAILY_POST_CAP: '1', DAILY_SPEND_LIMIT_USD: '1' });
    vi.useFakeTimers({ toFake: ['Date'] });

    for (let i = 0; i < 3; i++) {
      const res = await classifyHiddenAs(t, t.tom);
      expect(res.status).toBe(200);
      const { results } = ClassifyResponseSchema.parse(await res.json());
      expect(results.map((r) => r.status)).toEqual(['declined', 'declined']);
    }
    expect(t.mock.bodies).toEqual([]);

    // The one token of the minute and the one post of the day are both still there.
    expect((await classifyAs(t, t.tom)).status).toBe(200);
    expect(await postsToday(t.deps.db.db, t.tomId)).toBe(1);
    await expectRefused(await classifyAs(t, t.tom), 'rate-limit');

    // Once the breaker has tripped too, a request with nothing to send is still answered, and never logged as a trip.
    await seedUsage(t, t.anaId, { costMicros: 1_000_000 });
    expect((await classifyHiddenAs(t, t.ana)).status).toBe(200);
    expect(breakerLines(t)).toEqual([]);
  });
});
