/**
 * Usage metering (R21). Every AI request leaves one `usage_events` row, written from the gateway's `finally` whether it
 * succeeded, partly failed or threw, because tokens are spent either way. A row holds counts and token numbers only,
 * never post content (ADR 0007). Costs come from the price cards in `@unalgorithm/protocol`, the same ones the
 * extension estimates with, so there is no second price table. Failed calls are the operator's cost: they count toward
 * `cost_micros`, which the daily spend breaker sums, and never toward `chargeable_cost_micros`.
 *
 * Days are UTC. A row's `created_at` is taken from the server's clock, the clock `utcDayStart` reads, so the daily
 * queries and the rows they count always agree on where a day starts.
 */
import { type CreditTask, costMicros, type NormalizedUsage } from '@unalgorithm/protocol';
import { and, asc, count, eq, gt, gte, inArray, lt, type SQL, sql } from 'drizzle-orm';
import { type Db, queryErrorFields } from '../db/client.ts';
import { usageEvents } from '../db/schema.ts';
import type { Logger } from '../log.ts';

/**
 * How a request ended: `ok` when every requested post succeeded, `partial` when some did, `failed` when none did after
 * at least one call, `refused-before-call` when billing or a limit stopped it before any call (zero usage).
 */
export type UsageOutcome = 'ok' | 'partial' | 'failed' | 'refused-before-call';

export interface UsageEventInput {
  /** The request's `rid`. A second event with the same id is refused by the database and logged. */
  requestId: string;
  userId: string;
  deviceId: string | null;
  /** Null when no route served the request. */
  routeId: string | null;
  /** The task charged for: a job (`factcheck`, `perspectives`) records `postsRequested: 1, postsOk: 0`. */
  task: CreditTask;
  /** The route's model, whose price card prices the row unless the costs are given below. */
  model: string;
  outcome: UsageOutcome;
  postsRequested: number;
  postsOk: number;
  calls: number;
  failedCalls: number;
  /** Every token spent, failed calls included (`ClassifyOutcome.usage`). */
  usage: NormalizedUsage;
  /** The tokens of calls that returned a valid answer (`ClassifyOutcome.okUsage`). */
  okUsage: NormalizedUsage;
  /** A job spanning models: the sum of its calls' costs as measured (null: a model without a price card). */
  costMicros?: number | null;
  /** A job: the cost of the calls that answered when it finished, 0 when it failed or was cancelled. */
  chargeableCostMicros?: number | null;
}

/**
 * Writes one request's usage row. Never throws: it runs in a `finally` block, where an error would replace the
 * request's own. A failure (the database is down, the request was already recorded) is logged as
 * `usage.record_failed` with the request id and the error's name, code and stack frames, never its message.
 */
export async function recordUsageEvent(db: Db, e: UsageEventInput, log: Logger): Promise<void> {
  try {
    const { usage } = e;
    await db.insert(usageEvents).values({
      requestId: e.requestId,
      userId: e.userId,
      deviceId: e.deviceId,
      routeId: e.routeId,
      task: e.task,
      model: e.model,
      outcome: e.outcome,
      postsRequested: e.postsRequested,
      postsOk: e.postsOk,
      calls: e.calls,
      failedCalls: e.failedCalls,
      uncachedInput: usage.uncachedInput,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      webSearches: usage.webSearches,
      estimated: usage.estimated,
      // A cost given (even null) is stored as given; a job's calls may span models no single price card covers.
      costMicros: 'costMicros' in e ? (e.costMicros ?? null) : (costMicros(e.model, usage) ?? null),
      chargeableCostMicros:
        'chargeableCostMicros' in e
          ? (e.chargeableCostMicros ?? null)
          : e.postsOk === 0
            ? 0
            : (costMicros(e.model, e.okUsage) ?? null),
      createdAt: new Date(),
    });
  } catch (err) {
    log.error('usage.record_failed', { rid: e.requestId, ...queryErrorFields(err) });
  }
}

/** 00:00:00.000 UTC of the day `now` falls on. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The posts classified for `userId` since 00:00 UTC: the sum of `posts_ok`, for the per-user daily cap. */
export async function postsToday(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  return sumSince(db, usageEvents.postsOk, now, eq(usageEvents.userId, userId));
}

/**
 * Checks and comparisons that reached a model for `userId` since 00:00 UTC, for the cap they share: rows with task
 * 'factcheck' or 'perspectives' and calls > 0.
 */
export async function checksToday(db: Db, userId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count().mapWith(Number) })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.createdAt, utcDayStart(now)),
        eq(usageEvents.userId, userId),
        inArray(usageEvents.task, ['factcheck', 'perspectives']),
        gt(usageEvents.calls, 0),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Everyone's AI cost since 00:00 UTC in micro-dollars, failed calls included, for the daily spend breaker. Rows of a
 * model without a price card count as 0.
 */
export async function spendTodayMicros(db: Db, now: Date = new Date()): Promise<number> {
  return sumSince(db, usageEvents.costMicros, now);
}

/** One UTC day's AI cost on one model: counts and amounts only, never a user, request or token count. */
export interface DayModelCost {
  /** 'YYYY-MM-DD', the UTC day. */
  day: string;
  model: string;
  /** Sum of cost_micros: every call, failed ones included (what the vendor bills). Rows without a price card add 0. */
  costMicros: number;
  /** Requests whose model had no price card (cost_micros null). */
  unpricedRequests: number;
  requests: number;
}

const DAY_MS = 86_400_000;
/** The longest range `costByDay` answers, in days. */
const COST_BY_DAY_MAX_DAYS = 62;

/**
 * Per UTC day and model, for days in [from, to): both must be 00:00 UTC, `to` after `from`, at most 62 days apart,
 * else a `RangeError` (whose message never holds the dates). Sorted by day, then model. Sums are converted with
 * `Number()`, as `sumSince` does.
 */
export async function costByDay(db: Db, from: Date, to: Date): Promise<DayModelCost[]> {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start % DAY_MS !== 0 || end % DAY_MS !== 0) {
    throw new RangeError('costByDay takes days that start at 00:00 UTC');
  }
  if (end <= start) throw new RangeError('costByDay needs to after from');
  if (end - start > COST_BY_DAY_MAX_DAYS * DAY_MS) {
    throw new RangeError(`costByDay answers at most ${COST_BY_DAY_MAX_DAYS} days`);
  }
  const day = sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      model: usageEvents.model,
      costMicros: sql`coalesce(sum(${usageEvents.costMicros}), 0)`.mapWith(Number),
      unpricedRequests: sql`count(*) filter (where ${usageEvents.costMicros} is null)`.mapWith(Number),
      requests: count().mapWith(Number),
    })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, from), lt(usageEvents.createdAt, to)))
    .groupBy(day, usageEvents.model)
    .orderBy(asc(day), asc(usageEvents.model));
  return rows.map((r) => ({
    day: String(r.day),
    model: r.model,
    costMicros: r.costMicros,
    unpricedRequests: r.unpricedRequests,
    requests: r.requests,
  }));
}

/**
 * The sum of an integer column over the rows created since 00:00 UTC of `now`, 0 when there are none. Postgres sums
 * integers as bigint, which node-postgres returns as a string, so the result is converted to a number.
 */
async function sumSince(
  db: Db,
  column: typeof usageEvents.postsOk | typeof usageEvents.costMicros,
  now: Date,
  filter?: SQL,
): Promise<number> {
  const [row] = await db
    .select({ total: sql`coalesce(sum(${column}), 0)`.mapWith(Number) })
    .from(usageEvents)
    .where(and(gte(usageEvents.createdAt, utcDayStart(now)), filter));
  return row?.total ?? 0;
}
