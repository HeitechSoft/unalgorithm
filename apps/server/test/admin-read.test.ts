// Before any Date is made: Toronto is never UTC, so a timestamp read as local time shows up as a wrong instant.
process.env.TZ = 'America/Toronto';

import { randomUUID } from 'node:crypto';
import {
  ADMIN_OVERVIEW_PATH,
  ADMIN_USERS_PATH,
  AdminOverviewSchema,
  AdminUsersSchema,
  MAX_ADMIN_USERS,
  USAGE_DAYS,
} from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, NOT_ADMIN } from '../src/admin/access.ts';
import { adminOverview, listAdminUsers } from '../src/admin/queries.ts';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { devices, signupInvites, usageEvents, user, userLimits } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { DEV_EXTENSION_ID, signInWeb } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ADA = 'ada@example.com';
const BEA = 'bea@example.com';

/** Databases and apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function pgliteDb(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle.db;
}

async function postgresDb(): Promise<Db> {
  const pg = await createPostgresTestDb('ua_admin_read');
  cleanup.push(() => pg.drop());
  const handle: DbHandle = openPostgres(pg.url);
  cleanup.push(() => handle.close());
  await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
  return handle.db;
}

const at = (iso: string) => new Date(iso);

async function addUser(db: Db, id: string, email: string, createdAt: Date, role: string | null = null, banned = false) {
  await db.insert(user).values({ id, name: '', email, emailVerified: true, createdAt, updatedAt: createdAt, role, banned });
}

/** One usage row of `postsOk` posts costing `cost` micro-dollars (null: no price card), created at `createdAt`. */
async function addUsage(db: Db, userId: string, createdAt: string, postsOk: number, cost: number | null) {
  await db.insert(usageEvents).values({
    requestId: randomUUID(),
    userId,
    task: 'classify',
    model: 'mock-model',
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
    costMicros: cost,
    chargeableCostMicros: cost,
    createdAt: at(createdAt),
  });
}

async function addDevice(db: Db, userId: string, lastUsedAt: string | null, revokedAt: string | null = null) {
  await db.insert(devices).values({
    userId,
    clientId: DEV_EXTENSION_ID,
    lastUsedAt: lastUsedAt ? at(lastUsedAt) : null,
    revokedAt: revokedAt ? at(revokedAt) : null,
    revokedReason: revokedAt ? 'sign-out' : null,
  });
}

/**
 * Three accounts inserted out of order: Cal (role `user`, nothing used), Bea (role null, removed, one unused device)
 * and Ada (admin, usage on both sides of today's and the 30-day window's edges, a revoked device used last).
 */
async function seedAccounts(db: Db) {
  await addUser(db, 'u-cal', 'Cal@example.com', at('2026-03-04T05:06:07.890Z'), 'user');
  await addUser(db, 'u-bea', BEA, at('2026-02-03T04:05:06.789Z'), null, true);
  await addUser(db, 'u-ada', ADA, at('2026-01-02T03:04:05.678Z'), ADMIN_ROLE);

  await addUsage(db, 'u-ada', '2026-10-14T00:00:00.000Z', 3, 100);
  await addUsage(db, 'u-ada', '2026-10-14T11:59:59.000Z', 2, null);
  await addUsage(db, 'u-ada', '2026-10-13T23:59:59.000Z', 5, 200);
  await addUsage(db, 'u-ada', '2026-09-15T00:00:00.000Z', 7, 300);
  await addUsage(db, 'u-ada', '2026-09-14T23:59:00.000Z', 11, 400);
  await addUsage(db, 'u-bea', '2026-10-01T10:00:00.000Z', 4, 50);

  await addDevice(db, 'u-ada', '2026-10-14T09:30:00.123Z');
  await addDevice(db, 'u-ada', '2026-10-14T10:45:00.456Z', '2026-10-14T11:00:00.000Z');
  await addDevice(db, 'u-ada', null);
  await addDevice(db, 'u-bea', null);

  await db.insert(userLimits).values([
    { userId: 'u-ada', dailyPostCap: 250 },
    { userId: 'u-bea', dailyPostCap: null },
  ]);
  await db.insert(signupInvites).values([
    { email: 'old@example.com', createdAt: at('2026-10-01T08:00:00.000Z') },
    { email: 'new@example.com', createdAt: at('2026-10-10T08:00:00.000Z') },
  ]);
}

async function checkUserList(db: Db) {
  await seedAccounts(db);
  const result = await listAdminUsers(db, testConfig({ USER_DAILY_POST_CAP: '400' }), NOW);
  expect(AdminUsersSchema.parse(result)).toEqual(result);
  expect(result.users).toEqual([
    {
      id: 'u-ada',
      email: ADA,
      role: 'admin',
      access: 'active',
      createdAt: '2026-01-02T03:04:05.678Z',
      lastActiveAt: '2026-10-14T10:45:00.456Z',
      activeDevices: 2,
      postsToday: 5,
      posts30Days: 17,
      costMicros30Days: 600,
      dailyPostCap: 250,
    },
    {
      id: 'u-bea',
      email: BEA,
      role: 'user',
      access: 'removed',
      createdAt: '2026-02-03T04:05:06.789Z',
      lastActiveAt: null,
      activeDevices: 1,
      postsToday: 0,
      posts30Days: 4,
      costMicros30Days: 50,
      dailyPostCap: null,
    },
    {
      id: 'u-cal',
      email: 'Cal@example.com',
      role: 'user',
      access: 'active',
      createdAt: '2026-03-04T05:06:07.890Z',
      lastActiveAt: null,
      activeDevices: 0,
      postsToday: 0,
      posts30Days: 0,
      costMicros30Days: 0,
      dailyPostCap: null,
    },
  ]);
  expect(result.truncated).toBe(false);
  expect(result.invites).toEqual([
    { email: 'new@example.com', createdAt: '2026-10-10T08:00:00.000Z' },
    { email: 'old@example.com', createdAt: '2026-10-01T08:00:00.000Z' },
  ]);
  expect(result.defaultDailyPostCap).toBe(400);
}

async function checkOverview(db: Db) {
  await seedAccounts(db);
  const config = testConfig({ DAILY_SPEND_LIMIT_USD: '5' });
  const overview = await adminOverview(db, config, NOW);
  expect(AdminOverviewSchema.parse(overview)).toEqual(overview);

  const days = overview.last30Days;
  expect(days).toHaveLength(USAGE_DAYS);
  expect(days[0]?.day).toBe('2026-09-15');
  expect(days.at(-1)?.day).toBe('2026-10-14');
  expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort());
  const byDay = new Map(days.map((d) => [d.day, d]));
  expect(byDay.get('2026-10-14')).toEqual({ day: '2026-10-14', posts: 5, requests: 2, costMicros: 100 });
  expect(byDay.get('2026-10-13')).toEqual({ day: '2026-10-13', posts: 5, requests: 1, costMicros: 200 });
  expect(byDay.get('2026-10-01')).toEqual({ day: '2026-10-01', posts: 4, requests: 1, costMicros: 50 });
  expect(byDay.get('2026-09-15')).toEqual({ day: '2026-09-15', posts: 7, requests: 1, costMicros: 300 });
  expect(byDay.get('2026-09-20')).toEqual({ day: '2026-09-20', posts: 0, requests: 0, costMicros: 0 });
  expect(days.filter((d) => d.requests > 0)).toHaveLength(4);
  expect(overview.today).toEqual(days.at(-1));

  expect(overview.users).toBe(3);
  expect(overview.ops).toBeNull();
  expect(overview.version).toBe(config.version);
  expect(overview.spendLimitMicros).toBe(5_000_000);
  expect(overview.defaultDailyPostCap).toBe(config.userDailyPostCap);
  expect(overview.breakerTripped).toBe(false);
}

describe('queries', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_list_admin_users_counts_and_order', async () => {
    // The time zone took: a timestamp read as local time would be hours off.
    expect(NOW.getTimezoneOffset()).not.toBe(0);
    await checkUserList(await pgliteDb());
  });

  it('test_list_admin_users_truncates_at_1000', async () => {
    const db = await pgliteDb();
    const created = at('2026-05-06T07:08:09.000Z');
    const rows = Array.from({ length: MAX_ADMIN_USERS + 1 }, (_, i) => {
      const n = String(i).padStart(4, '0');
      return { id: `u-${n}`, name: '', email: `p${n}@example.com`, emailVerified: true, createdAt: created, updatedAt: created };
    });
    await db.insert(user).values(rows);

    const result = await listAdminUsers(db, testConfig(), NOW);
    expect(result.users).toHaveLength(MAX_ADMIN_USERS);
    expect(result.truncated).toBe(true);
    expect(result.users[0]?.email).toBe('p0000@example.com');
    expect(result.users.at(-1)?.email).toBe('p0999@example.com');
    expect(AdminUsersSchema.safeParse(result).success).toBe(true);
  });

  it('test_admin_overview_days_zero_filled', async () => {
    await checkOverview(await pgliteDb());
  });

  it('test_admin_overview_breaker_matches_limits', async () => {
    const db = await pgliteDb();
    await addUser(db, 'u-ada', ADA, NOW, ADMIN_ROLE);
    // Yesterday's spend never counts toward today's limit.
    await addUsage(db, 'u-ada', '2026-10-13T23:59:59.999Z', 1, 9_000_000);
    await addUsage(db, 'u-ada', '2026-10-14T01:00:00.000Z', 1, 4_999_999);
    const config = testConfig({ DAILY_SPEND_LIMIT_USD: '5' });

    expect((await adminOverview(db, config, NOW)).breakerTripped).toBe(false);
    await addUsage(db, 'u-ada', '2026-10-14T02:00:00.000Z', 0, 1);
    const tripped = await adminOverview(db, config, NOW);
    expect(tripped.breakerTripped).toBe(true);
    expect(tripped.today.costMicros).toBe(5_000_000);
  });

  it('test_admin_usage_days_are_utc', async () => {
    const db = await pgliteDb();
    await addUser(db, 'u-ada', ADA, NOW, ADMIN_ROLE);
    await addUsage(db, 'u-ada', '2026-10-13T23:59:59.000Z', 2, 20);
    // 22:00 on the 13th in Toronto, but the 14th in UTC.
    await addUsage(db, 'u-ada', '2026-10-14T02:00:00.000Z', 3, 30);

    const overview = await adminOverview(db, testConfig(), NOW);
    expect(overview.last30Days.at(-2)).toEqual({ day: '2026-10-13', posts: 2, requests: 1, costMicros: 20 });
    expect(overview.today).toEqual({ day: '2026-10-14', posts: 3, requests: 1, costMicros: 30 });
    const [ada] = (await listAdminUsers(db, testConfig(), NOW)).users;
    expect(ada?.postsToday).toBe(3);
    expect(ada?.posts30Days).toBe(5);
  });
});

/** The same queries on Postgres, whose driver returns timestamps as text as PGlite's does; skipped without a server. */
describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_list_admin_users_counts_and_order_postgres', async () => {
    await checkUserList(await postgresDb());
  });

  it('test_admin_overview_days_zero_filled_postgres', async () => {
    await checkOverview(await postgresDb());
  });
});

/** A test server where Ada is the admin and Bea a user, both signed in on the page. */
async function adminApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` }) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  const member = await signInWeb(t.app, t.outbox, BEA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const get = (path: string, cookie?: string) => t.app.request(path, { headers: cookie ? { Cookie: cookie } : {} });
  return { t, admin, member, get };
}

describe('routes', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_read_routes_need_admin', async () => {
    const { admin, member, get } = await adminApp();
    for (const path of [ADMIN_USERS_PATH, ADMIN_OVERVIEW_PATH]) {
      const none = await get(path);
      expect(none.status).toBe(401);
      expect(none.headers.get('Cache-Control')).toBe('no-store');

      const user = await get(path, member);
      expect(user.status).toBe(403);
      expect(await user.json()).toEqual(NOT_ADMIN);
      expect(user.headers.get('Cache-Control')).toBe('no-store');

      const ok = await get(path, admin);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Cache-Control')).toBe('no-store');
      const body: unknown = await ok.json();
      if (path === ADMIN_USERS_PATH) {
        const users = AdminUsersSchema.parse(body);
        expect(users.users.map((u) => [u.email, u.role])).toEqual([
          [ADA, 'admin'],
          [BEA, 'user'],
        ]);
      } else {
        const overview = AdminOverviewSchema.parse(body);
        expect(overview.users).toBe(2);
        // Problem reports' line (ADR 0009 §7): off on this server, and none kept.
        expect(overview.reports).toEqual({ enabled: false, open: 0, last24h: 0 });
      }
    }
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_read_logs_hold_no_address', async () => {
    const { t, admin, member, get } = await adminApp();
    for (const path of [ADMIN_USERS_PATH, ADMIN_OVERVIEW_PATH]) {
      for (const cookie of [undefined, member, admin]) await get(path, cookie);
    }
    const http = t.events().filter((e) => e.path === ADMIN_USERS_PATH || e.path === ADMIN_OVERVIEW_PATH);
    expect(http).toHaveLength(6);
    // The 401s' `http.error` lines hold stack frames, whose package directories have an `@` (`hono@4.13.13`): those
    // are checked for the addresses themselves, and every other field for any `@`.
    expect(t.lines.filter((line) => [ADA, BEA].some((address) => line.includes(address)))).toEqual([]);
    const withoutStacks = t.events().map(({ err_stack: _stack, ...fields }) => JSON.stringify(fields));
    expect(withoutStacks.filter((line) => line.includes('@'))).toEqual([]);
  });
});
