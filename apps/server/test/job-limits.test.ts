import { randomUUID } from 'node:crypto';
import { AIError } from '@unalgorithm/ai';
import { type NormalizedUsage, ZERO_USAGE } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkFactcheckLimits, checkJobLimits, checkLimits, createRateLimiter, type LimitDeps } from '../src/ai/limits.ts';
import { checksToday, postsToday, recordUsageEvent, type UsageEventInput } from '../src/ai/metering.ts';
import type { Db } from '../src/db/client.ts';
import { usageEvents, user } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom-user-id';
const ANA = 'ana-user-id';
const NOW = new Date('2026-10-15T12:00:00Z');
const YESTERDAY = new Date('2026-10-14T23:59:00Z');
const USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 1000, output: 100 };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  const db = handle.db;
  const now = new Date();
  await db
    .insert(user)
    .values([TOM, ANA].map((id) => ({ id, name: '', email: `${id}@example.com`, createdAt: now, updatedAt: now })));
  return db;
}

/** Limit deps over `db` with these variables, a roomy rate limit unless `perMinute` says otherwise. */
function depsFor(
  db: Db,
  env: Record<string, string> = {},
  perMinute = 100,
): LimitDeps & { events: () => Record<string, unknown>[] } {
  const { log, events } = captureLog();
  return { db, config: testConfig(env), limiter: createRateLimiter({ perMinute }), log, events };
}

/** A finished check of Tom's, as the job endpoints will record it; `over` changes any field. */
function jobRow(over: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    requestId: randomUUID(),
    userId: TOM,
    deviceId: null,
    routeId: null,
    task: 'factcheck',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    postsRequested: 1,
    postsOk: 0,
    calls: 3,
    failedCalls: 0,
    usage: USAGE,
    okUsage: USAGE,
    costMicros: 113_000,
    chargeableCostMicros: 113_000,
    ...over,
  };
}

/** Records `e` with the clock at `at`; nothing may be logged. */
async function recordAt(db: Db, at: Date, e: UsageEventInput): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  const { log, events } = captureLog();
  await recordUsageEvent(db, e, log);
  vi.useRealTimers();
  expect(events()).toEqual([]);
}

async function refusal(p: Promise<unknown>): Promise<AIError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof AIError)) throw new Error(`Expected an AIError, got ${String(err)}`);
  return err;
}

describe('limits', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_check_limits_share_rate_bucket_with_classify', async () => {
    const db = await testDb();
    const deps = depsFor(db, {}, 1);
    (await checkLimits(deps, { userId: TOM }, 1, NOW))();

    const err = await refusal(checkJobLimits(deps, { userId: TOM }, NOW));
    expect(err.code).toBe('rate-limit');
    expect(err.retryAfterMs).toBeGreaterThan(0);
    // Ana's bucket is her own.
    (await checkJobLimits(deps, { userId: ANA }, NOW))();
  });

  it('test_spend_breaker_counts_job_rows', async () => {
    const db = await testDb();
    await recordAt(db, NOW, jobRow({ userId: ANA, costMicros: 5_000_000, chargeableCostMicros: 0 }));
    const deps = depsFor(db, { DAILY_SPEND_LIMIT_USD: '5' });

    expect((await refusal(checkLimits(deps, { userId: TOM }, 1, NOW))).code).toBe('cap-reached');
    expect((await refusal(checkJobLimits(deps, { userId: TOM }, NOW))).code).toBe('cap-reached');
    // Logged once for the day, whichever check tripped it.
    expect(deps.events().filter((e) => e.event === 'limits.spend_breaker')).toHaveLength(1);
  });

  it('test_daily_check_cap_counts_only_todays_checks', async () => {
    const db = await testDb();
    await recordAt(db, NOW, jobRow());
    await recordAt(db, NOW, jobRow());
    await recordAt(db, YESTERDAY, jobRow());
    await recordAt(db, NOW, jobRow({ calls: 0, outcome: 'refused-before-call', costMicros: 0, chargeableCostMicros: 0 }));
    await recordAt(db, NOW, jobRow({ userId: ANA }));
    await recordAt(db, NOW, jobRow({ task: 'classify', postsRequested: 3, postsOk: 3 }));
    expect(await checksToday(db, TOM, NOW)).toBe(2);
    expect(await checksToday(db, ANA, NOW)).toBe(1);

    const deps = depsFor(db, { USER_DAILY_CHECK_CAP: '2' });
    const err = await refusal(checkJobLimits(deps, { userId: TOM }, NOW));
    expect(err.code).toBe('cap-reached');
    expect(err.message).toBe("This account has reached today's limit for checks and comparisons. They resume tomorrow.");
    (await checkJobLimits(deps, { userId: ANA }, NOW))();
  });

  it('test_daily_cap_shared_by_checks_and_comparisons', async () => {
    const db = await testDb();
    await recordAt(db, NOW, jobRow({ task: 'perspectives', calls: 0, outcome: 'refused-before-call', costMicros: 0 }));
    await recordAt(db, NOW, jobRow());
    const deps = depsFor(db, { USER_DAILY_CHECK_CAP: '2' });
    // The perspectives row that reached no model does not count: one place is left.
    expect(await checksToday(db, TOM, NOW)).toBe(1);
    (await checkJobLimits(deps, { userId: TOM }, NOW))();

    await recordAt(db, NOW, jobRow({ task: 'perspectives', calls: 4 }));
    expect(await checksToday(db, TOM, NOW)).toBe(2);
    expect((await refusal(checkJobLimits(deps, { userId: TOM }, NOW))).code).toBe('cap-reached');
    // The fact-check name is the same guard (P3-33's spec).
    expect(checkFactcheckLimits).toBe(checkJobLimits);
  });

  it('test_check_cap_counts_checks_in_flight', async () => {
    const db = await testDb();
    const deps = depsFor(db, { USER_DAILY_CHECK_CAP: '2' });
    const first = await checkJobLimits(deps, { userId: TOM }, NOW);
    const second = await checkJobLimits(deps, { userId: TOM }, NOW);
    expect((await refusal(checkJobLimits(deps, { userId: TOM }, NOW))).code).toBe('cap-reached');

    first();
    first();
    const third = await checkJobLimits(deps, { userId: TOM }, NOW);
    // `first` twice freed one place only: `second` and `third` still hold both.
    expect((await refusal(checkJobLimits(deps, { userId: TOM }, NOW))).code).toBe('cap-reached');
    second();
    third();
    expect(deps.checksInFlight?.size).toBe(0);
    // Classify's posts in flight are a separate count.
    expect(deps.inFlight?.size ?? 0).toBe(0);
  });

  it('test_check_cap_zero_refuses', async () => {
    const db = await testDb();
    const deps = depsFor(db, { USER_DAILY_CHECK_CAP: '0' });
    expect((await refusal(checkJobLimits(deps, { userId: TOM }, NOW))).code).toBe('cap-reached');
    expect(deps.checksInFlight?.size ?? 0).toBe(0);
  });
});

describe('metering', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_usage_row_cost_override_stored_as_given', async () => {
    const db = await testDb();
    await recordAt(db, NOW, jobRow({ costMicros: 113_000, chargeableCostMicros: 0 }));
    await recordAt(db, NOW, jobRow({ userId: ANA, model: 'no-price-card', costMicros: 113_000, chargeableCostMicros: 0 }));
    await recordAt(db, NOW, jobRow({ userId: ANA, costMicros: null, chargeableCostMicros: null }));
    const rows = await db.select().from(usageEvents);
    expect(rows.map((r) => [r.costMicros, r.chargeableCostMicros])).toEqual(
      expect.arrayContaining([
        [113_000, 0],
        [113_000, 0],
        [null, null],
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it('test_job_rows_do_not_count_posts', async () => {
    const db = await testDb();
    const before = await postsToday(db, TOM, NOW);
    await recordAt(db, NOW, jobRow());
    expect(await postsToday(db, TOM, NOW)).toBe(before);
  });
});
