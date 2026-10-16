import { randomUUID } from 'node:crypto';
import { type NormalizedUsage, ZERO_USAGE } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  costByDay,
  postsToday,
  recordUsageEvent,
  spendTodayMicros,
  type UsageEventInput,
  utcDayStart,
} from '../src/ai/metering.ts';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { devices, usageEvents, user } from '../src/db/schema.ts';
import { createTestHost } from './support/billing-host.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { seedPassingRoute } from './support/routes.ts';
import { DEV_EXTENSION_ID } from './support/sign-in.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom-user-id';
const OTHER = 'other-user-id';

/** 2,400 uncached, 1,500 cache read and 360 output tokens: 435 micro-dollars on Haiku 5.5. */
const HAIKU_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 2400, cacheRead: 1500, output: 360 };
/** 1,000 uncached and 100 output tokens: 150 micro-dollars on Haiku 5.5. */
const FAILED_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 1000, output: 100 };

/** Databases a test opened, closed after it whatever the outcome; fake timers are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle.db;
}

/** The two accounts usage rows belong to; Tom also gets a device. */
async function seedUsers(db: Db): Promise<{ deviceId: string }> {
  const now = new Date();
  await db
    .insert(user)
    .values([TOM, OTHER].map((id) => ({ id, name: '', email: `${id}@example.com`, createdAt: now, updatedAt: now })));
  const [device] = await db.insert(devices).values({ userId: TOM, clientId: DEV_EXTENSION_ID }).returning();
  if (!device) throw new Error('The device was not inserted.');
  return { deviceId: device.id };
}

/** A successful three-post Haiku request of Tom's, one call; `over` changes any field. */
function event(over: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    requestId: randomUUID(),
    userId: TOM,
    deviceId: null,
    routeId: null,
    task: 'classify',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    postsRequested: 3,
    postsOk: 3,
    calls: 1,
    failedCalls: 0,
    usage: HAIKU_USAGE,
    okUsage: HAIKU_USAGE,
    ...over,
  };
}

/** Records `e`, which must succeed: nothing is logged. */
async function record(db: Db, e: UsageEventInput): Promise<void> {
  const { log, events } = captureLog();
  await recordUsageEvent(db, e, log);
  expect(events()).toEqual([]);
}

/** Records `e` with the clock at `iso`. The caller has switched to fake dates. */
async function recordAt(db: Db, iso: string, e: UsageEventInput): Promise<void> {
  vi.setSystemTime(new Date(iso));
  await record(db, e);
}

const allRows = (db: Db) => db.select().from(usageEvents);

describe('recording', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_record_haiku_costs', async () => {
    const db = await testDb();
    const { deviceId } = await seedUsers(db);
    const route = await seedPassingRoute(db);
    const e = event({ deviceId, routeId: route.id });
    await recordHaikuCase(db, e);
  });

  it('test_nothing_ok_is_not_chargeable', async () => {
    const db = await testDb();
    await seedUsers(db);
    // The first call answered but skipped all three posts, then each retry failed: a valid answer, nothing to charge.
    const answered: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 800, output: 40 };
    await record(db, event({ outcome: 'failed', postsOk: 0, calls: 4, failedCalls: 3, usage: HAIKU_USAGE, okUsage: answered }));
    const [row] = await allRows(db);
    expect(row).toMatchObject({ outcome: 'failed', postsOk: 0, costMicros: 435, chargeableCostMicros: 0 });
  });

  it('test_unknown_model_records_null_costs', async () => {
    const db = await testDb();
    await seedUsers(db);
    await record(db, event({ model: 'mock-model' }));
    const rows = await allRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'mock-model', uncachedInput: 2400, costMicros: null, chargeableCostMicros: null });
  });

  it('test_record_never_throws', async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    await seedUsers(handle.db);
    await handle.close();

    const { log, events } = captureLog();
    const e = event();
    await expect(recordUsageEvent(handle.db, e, log)).resolves.toBeUndefined();
    expect(events()).toEqual([
      expect.objectContaining({ level: 'error', event: 'usage.record_failed', rid: e.requestId, err_name: expect.any(String) }),
    ]);
  });

  it('test_duplicate_request_id_logged_not_thrown', async () => {
    const db = await testDb();
    await seedUsers(db);
    await duplicateCase(db);
  });
});

describe('daily queries', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_posts_today_utc_window_and_user', async () => {
    const db = await testDb();
    await seedUsers(db);
    await postsTodayCase(db);
  });

  it('test_spend_today_all_users_nulls_zero', async () => {
    const db = await testDb();
    await seedUsers(db);
    await spendTodayCase(db);
  });

  it('test_utc_day_start', () => {
    const start = new Date('2026-10-12T00:00:00.000Z');
    expect(utcDayStart(new Date('2026-10-12T00:00:00.000Z'))).toEqual(start);
    expect(utcDayStart(new Date('2026-10-12T23:59:59.999Z'))).toEqual(start);
    // 19:00 on 12 October at UTC-5 is already 13 October in UTC.
    expect(utcDayStart(new Date('2026-10-12T19:00:00.000-05:00'))).toEqual(new Date('2026-10-13T00:00:00.000Z'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T15:00:00.000Z'));
    expect(utcDayStart()).toEqual(start);
  });
});

describe('cost by day', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_cost_by_day_groups_by_utc_day_and_model', async () => {
    const db = await testDb();
    await seedUsers(db);
    await costByDayCase(db);
  });

  it('test_cost_by_day_rejects_bad_ranges', async () => {
    const db = await testDb();
    const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
    const cases: [from: Date, to: Date][] = [
      [new Date('2026-10-12T00:00:00.001Z'), day('2026-10-13')],
      [day('2026-10-12'), new Date('2026-10-13T12:00:00.000Z')],
      [new Date('2026-10-12T00:00:00.000-05:00'), day('2026-10-14')],
      [day('2026-10-12'), day('2026-10-12')],
      [day('2026-10-13'), day('2026-10-12')],
      // 63 days.
      [day('2026-08-01'), day('2026-10-03')],
      [new Date(Number.NaN), day('2026-10-12')],
    ];
    for (const [from, to] of cases) {
      const err = await costByDay(db, from, to).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      const message = (err as Error).message;
      expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}|2026|GMT/);
    }
    // 62 days is the longest range.
    await expect(costByDay(db, day('2026-08-01'), day('2026-10-02'))).resolves.toEqual([]);
  });

  it('test_host_usage_cost_by_day_fields', async () => {
    const t = await createTestHost();
    cleanup.push(() => t.close());
    await seedUsers(t.db.db);
    await recordCostRows(t.db.db);
    const from = new Date('2026-10-12T00:00:00.000Z');
    const to = new Date('2026-10-14T00:00:00.000Z');

    const rows = await t.host.usage.costByDay(from, to);
    expect(rows).toEqual(await costByDay(t.db.db, from, to));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(['costMicros', 'day', 'model', 'requests', 'unpricedRequests']);
  });
});

/**
 * The same cases on real Postgres, whose driver returns a `sum()` as a string where PGlite returns a number. Skipped
 * unless `TEST_DATABASE_URL` is set.
 */
describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  async function postgresDb(): Promise<Db> {
    const pg = await createPostgresTestDb('ua_metering');
    cleanup.push(() => pg.drop());
    const handle: DbHandle = openPostgres(pg.url);
    cleanup.push(() => handle.close());
    await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
    await seedUsers(handle.db);
    return handle.db;
  }

  it('test_postgres_record_and_duplicate', async () => {
    const db = await postgresDb();
    await recordHaikuCase(db, event());
    await duplicateCase(db);
  });

  it('test_postgres_daily_queries', async () => {
    const db = await postgresDb();
    await postsTodayCase(db);
    await db.delete(usageEvents);
    await spendTodayCase(db);
    await db.delete(usageEvents);
    await costByDayCase(db);
  });
});

/** AC 3: one row with every count and token, 435 micro-dollars of cost, all of it chargeable. */
async function recordHaikuCase(db: Db, e: UsageEventInput): Promise<void> {
  const before = Date.now();
  await record(db, e);
  const rows = await allRows(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    id: expect.any(String),
    requestId: e.requestId,
    userId: TOM,
    deviceId: e.deviceId,
    routeId: e.routeId,
    task: 'classify',
    model: 'claude-haiku-5-5',
    outcome: 'ok',
    postsRequested: 3,
    postsOk: 3,
    calls: 1,
    failedCalls: 0,
    uncachedInput: 2400,
    cacheRead: 1500,
    cacheWrite: 0,
    output: 360,
    webSearches: 0,
    estimated: false,
    costMicros: 435,
    chargeableCostMicros: 435,
    createdAt: expect.any(Date),
  });
  expect(rows[0]?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
}

/** AC 9: the unique index refuses a second row for the same request; the first stays as it was. */
async function duplicateCase(db: Db): Promise<void> {
  const first = event();
  await record(db, first);
  const { log, events } = captureLog();
  await expect(recordUsageEvent(db, { ...first, outcome: 'partial', postsOk: 1 }, log)).resolves.toBeUndefined();
  expect(events()).toEqual([
    expect.objectContaining({ level: 'error', event: 'usage.record_failed', rid: first.requestId, err_code: '23505' }),
  ]);
  const rows = (await allRows(db)).filter((row) => row.requestId === first.requestId);
  expect(rows).toEqual([expect.objectContaining({ outcome: 'ok', postsOk: 3 })]);
}

/** AC 7: Tom's posts since 00:00 UTC; the second before midnight and other people's rows do not count. */
async function postsTodayCase(db: Db): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  await recordAt(db, '2026-10-11T23:59:59.000Z', event({ postsOk: 5 }));
  await recordAt(db, '2026-10-12T00:00:00.000Z', event({ postsOk: 3 }));
  await recordAt(db, '2026-10-12T13:30:00.000Z', event({ postsRequested: 4, postsOk: 2, outcome: 'partial' }));
  await recordAt(db, '2026-10-12T13:31:00.000Z', event({ userId: OTHER, postsRequested: 7, postsOk: 7 }));

  expect(await postsToday(db, TOM)).toBe(5);
  expect(await postsToday(db, TOM, new Date('2026-10-12T23:59:59.999Z'))).toBe(5);
  expect(await postsToday(db, OTHER)).toBe(7);
  expect(await postsToday(db, TOM, new Date('2026-10-13T00:00:00.000Z'))).toBe(0);
  expect(await postsToday(db, 'no-such-user')).toBe(0);
}

/**
 * AC 8: everyone's cost since 00:00 UTC, failed calls included (the breaker protects the operator's bill), with a
 * missing price card counted as 0.
 */
async function spendTodayCase(db: Db): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  await recordAt(db, '2026-10-11T23:59:59.000Z', event());
  await recordAt(db, '2026-10-12T00:00:00.000Z', event());
  await recordAt(
    db,
    '2026-10-12T08:00:00.000Z',
    event({ userId: OTHER, outcome: 'failed', postsOk: 0, failedCalls: 1, usage: FAILED_USAGE, okUsage: ZERO_USAGE }),
  );
  await recordAt(db, '2026-10-12T09:00:00.000Z', event({ userId: OTHER, model: 'mock-model' }));
  await recordAt(db, '2026-10-13T01:00:00.000Z', event({ model: 'mock-model' }));

  expect(await spendTodayMicros(db, new Date('2026-10-12T23:59:59.999Z'))).toBe(435 + 150);
  // A day whose only row has no price card, and a day with no rows at all.
  expect(await spendTodayMicros(db)).toBe(0);
  expect(await spendTodayMicros(db, new Date('2026-10-14T00:00:00.000Z'))).toBe(0);
}

/**
 * Rows on 12 and 13 October (UTC): Haiku at 435 and 150 micro-dollars on the 12th, the last at 23:59:59; a Haiku row
 * and an unpriced `mock-model` row at 00:00:00 on the 13th, and a priced `mock-model` row given its cost later that day.
 * A row on the 14th lies outside [12th, 14th).
 */
async function recordCostRows(db: Db): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  await recordAt(db, '2026-10-12T08:00:00.000Z', event());
  await recordAt(db, '2026-10-12T23:59:59.000Z', event({ outcome: 'failed', postsOk: 0, usage: FAILED_USAGE, userId: OTHER }));
  await recordAt(db, '2026-10-13T00:00:00.000Z', event());
  await recordAt(db, '2026-10-13T00:00:00.000Z', event({ model: 'mock-model' }));
  await recordAt(db, '2026-10-13T09:00:00.000Z', event({ model: 'mock-model', costMicros: 70, chargeableCostMicros: 70 }));
  await recordAt(db, '2026-10-14T00:00:00.000Z', event());
  vi.useRealTimers();
}

/** AC 6: one row per UTC day and model, failed calls counted, an unpriced row adding 0 and counted apart. */
async function costByDayCase(db: Db): Promise<void> {
  await recordCostRows(db);
  const rows = await costByDay(db, new Date('2026-10-12T00:00:00.000Z'), new Date('2026-10-14T00:00:00.000Z'));
  expect(rows).toEqual([
    { day: '2026-10-12', model: 'claude-haiku-5-5', costMicros: 585, unpricedRequests: 0, requests: 2 },
    { day: '2026-10-13', model: 'claude-haiku-5-5', costMicros: 435, unpricedRequests: 0, requests: 1 },
    { day: '2026-10-13', model: 'mock-model', costMicros: 70, unpricedRequests: 1, requests: 2 },
  ]);
  for (const row of rows) {
    expect(typeof row.costMicros).toBe('number');
    expect(typeof row.requests).toBe('number');
    expect(typeof row.unpricedRequests).toBe('number');
  }
}
