/**
 * What the admin page reads (R38): every account with its caps and usage, and the server's own usage against the daily
 * spend limit. Built on the rows metering already writes (`usage_events`, CL1-13) and the caps CL1-21 stores; there is no
 * second usage table and no cache. Days are UTC, as in metering. Costs are the operator's AI cost (`cost_micros`, failed
 * calls included), the number the spend breaker sums: on a self-hosted server, the admin's own bill.
 *
 * Timestamps are read through Drizzle's column mapping (a column, or `mapWith` a column) and answered with
 * `toISOString()`: both drivers return them as raw text, and `user.created_at` has no time zone, so text parsed by
 * `new Date` would be read as local time. Days are selected as `to_char` text and never parsed.
 */
import { type AdminOverview, type AdminUsers, MAX_ADMIN_USERS, USAGE_DAYS, type UsageDay } from '@unalgorithm/protocol';
import { asc, count, eq, gte, type SQL, sql } from 'drizzle-orm';
import { spendBreakerTripped } from '../ai/limits.ts';
import { utcDayStart } from '../ai/metering.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { devices, usageEvents, user, userLimits } from '../db/schema.ts';
import { type OpsDeps, readOpsStatus } from '../ops/status.ts';
import { ADMIN_ROLE } from './access.ts';
import { listInvites } from './invites.ts';

const DAY_MS = 86_400_000;

type QueryConfig = Pick<Config, 'userDailyPostCap' | 'dailySpendLimitMicros' | 'version'>;

/** 00:00 UTC of the first of the `USAGE_DAYS` days that end with `now`'s. */
function windowStart(now: Date): Date {
  return new Date(utcDayStart(now).getTime() - (USAGE_DAYS - 1) * DAY_MS);
}

/** A bigint aggregate of a left-joined subquery as a number; 0 for an account without rows. */
const total = (field: SQL.Aliased) => sql<number>`coalesce(${field}, 0)`.mapWith(Number);

/**
 * Accounts ordered by address, at most `MAX_ADMIN_USERS` (`truncated` says more exist), with today's and the last
 * `USAGE_DAYS` days' usage, devices signed in and the account's own cap; the invites and the server's default cap.
 */
export async function listAdminUsers(db: Db, config: QueryConfig, now: Date = new Date()): Promise<AdminUsers> {
  const today = gte(usageEvents.createdAt, utcDayStart(now));
  const usage = db
    .select({
      userId: usageEvents.userId,
      postsToday: sql`sum(${usageEvents.postsOk}) filter (where ${today})`.as('posts_today'),
      posts30Days: sql`sum(${usageEvents.postsOk})`.as('posts_30_days'),
      costMicros30Days: sql`sum(coalesce(${usageEvents.costMicros}, 0))`.as('cost_micros_30_days'),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, windowStart(now)))
    .groupBy(usageEvents.userId)
    .as('usage');
  const deviceStats = db
    .select({
      userId: devices.userId,
      activeDevices: sql`count(*) filter (where ${devices.revokedAt} is null)`.as('active_devices'),
      lastActiveAt: sql<Date | null>`max(${devices.lastUsedAt})`.mapWith(devices.lastUsedAt).as('last_active_at'),
    })
    .from(devices)
    .groupBy(devices.userId)
    .as('device_stats');

  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
      lastActiveAt: deviceStats.lastActiveAt,
      activeDevices: total(deviceStats.activeDevices),
      postsToday: total(usage.postsToday),
      posts30Days: total(usage.posts30Days),
      costMicros30Days: total(usage.costMicros30Days),
      dailyPostCap: userLimits.dailyPostCap,
    })
    .from(user)
    .leftJoin(usage, eq(usage.userId, user.id))
    .leftJoin(deviceStats, eq(deviceStats.userId, user.id))
    .leftJoin(userLimits, eq(userLimits.userId, user.id))
    .orderBy(sql`lower(${user.email})`, asc(user.id))
    .limit(MAX_ADMIN_USERS + 1);

  const invites = await listInvites(db);
  return {
    users: rows.slice(0, MAX_ADMIN_USERS).map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role === ADMIN_ROLE ? 'admin' : 'user',
      access: r.banned === true ? 'removed' : 'active',
      createdAt: r.createdAt.toISOString(),
      lastActiveAt: r.lastActiveAt?.toISOString() ?? null,
      activeDevices: r.activeDevices,
      postsToday: r.postsToday,
      posts30Days: r.posts30Days,
      costMicros30Days: r.costMicros30Days,
      dailyPostCap: r.dailyPostCap,
    })),
    truncated: rows.length > MAX_ADMIN_USERS,
    invites: invites.map((i) => ({ email: i.email, createdAt: i.createdAt.toISOString() })),
    defaultDailyPostCap: config.userDailyPostCap,
  };
}

/**
 * The server's usage for each of the last `USAGE_DAYS` UTC days (oldest first, ending with today, days without usage as
 * zeros), the account count and the spend breaker's state. `ops` is null here: `fullOverview` adds the server's status.
 */
export async function adminOverview(db: Db, config: QueryConfig, now: Date = new Date()): Promise<AdminOverview> {
  const start = windowStart(now);
  const day = sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      posts: sql`coalesce(sum(${usageEvents.postsOk}), 0)`.mapWith(Number),
      requests: count(),
      costMicros: sql`coalesce(sum(coalesce(${usageEvents.costMicros}, 0)), 0)`.mapWith(Number),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, start))
    .groupBy(day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const last30Days: UsageDay[] = Array.from({ length: USAGE_DAYS }, (_, i) => {
    const key = new Date(start.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    const r = byDay.get(key);
    return { day: key, posts: r?.posts ?? 0, requests: r?.requests ?? 0, costMicros: r?.costMicros ?? 0 };
  });
  const [accounts] = await db.select({ n: count() }).from(user);
  const breakerTripped = await spendBreakerTripped(db, config, now);
  const today = last30Days.at(-1);
  if (!today) throw new Error('USAGE_DAYS is 0.');

  return {
    version: config.version,
    users: accounts?.n ?? 0,
    today,
    last30Days,
    spendLimitMicros: config.dailySpendLimitMicros,
    breakerTripped,
    defaultDailyPostCap: config.userDailyPostCap,
    ops: null,
  };
}

/**
 * What `GET /v1/admin/overview` answers: `adminOverview` with the server's status (`readOpsStatus`, CL4-14) as `ops`,
 * both read at once. CL4-17's metrics reuse it.
 */
export async function fullOverview(deps: OpsDeps & { config: Config }, now: Date = new Date()): Promise<AdminOverview> {
  const [overview, ops] = await Promise.all([
    adminOverview(deps.db, deps.config, now),
    readOpsStatus({ ...deps, now: now.getTime() }),
  ]);
  return { ...overview, ops };
}
