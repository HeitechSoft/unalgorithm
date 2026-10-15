/**
 * The guards in front of every classify call (R24). Whoever runs a server pays its AI bill, so before a request reaches
 * a model it passes three checks, the cheap one first: a per-user rate limit, the daily spend breaker over everyone's
 * cost, and the per-user daily post cap. A refusal is an `AIError` that the app answers with 429 and `describeError`
 * text; the gateway meters it as `refused-before-call`. A fact-check passes the same rate limit (one bucket) and
 * breaker, then a per-user daily check cap instead of the post cap (`checkFactcheckLimits`).
 *
 * Days are UTC, as in metering (CL1-13). The rate buckets and the posts in flight live in memory: a deployment runs one
 * server process in CL1, so memory is enough. A shared store is needed only once the server runs as several processes.
 */
import { AIError } from '@unalgorithm/ai';
import { eq } from 'drizzle-orm';
import type { DeviceAccount } from '../auth/bearer.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { userLimits } from '../db/schema.ts';
import type { Logger } from '../log.ts';
import { checksToday, postsToday, spendTodayMicros, utcDayStart } from './metering.ts';

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

export interface RateLimiter {
  /** Takes one request from `key`'s bucket at `now` (ms since the epoch), or says how long until one is there. */
  take(key: string, now?: number): RateDecision;
  /** Gives one request back to `key`'s bucket, up to its maximum (a bucket full again is dropped); nothing when it has none. */
  refund(key: string, now?: number): void;
  /** How many buckets are held. */
  readonly size: number;
}

/**
 * A bucket untouched this long, or its whole window when that is longer, is dropped. It has refilled by then, so dropping
 * it changes no answer.
 */
export const IDLE_BUCKET_MS = 10 * 60_000;

/** `max` requests at once, refilled evenly over `windowMs`; `{ perMinute }` is `{ max: perMinute, windowMs: 60_000 }`. */
export type Rate = { perMinute: number } | { max: number; windowMs: number };

interface Bucket {
  units: number;
  /** When the bucket was last refilled: its last request. */
  at: number;
}

/**
 * An in-memory token bucket per user (or any key): `max` requests at once, refilled evenly over `windowMs`. Buckets are
 * kept in the order of their last request, so each request drops the idle ones from the front and memory stays bounded
 * by the keys active in the last 10 minutes (or the last window, when that is longer).
 */
export function createRateLimiter(rate: Rate): RateLimiter {
  const { max, windowMs } = 'perMinute' in rate ? { max: rate.perMinute, windowMs: 60_000 } : rate;
  // One request is `windowMs` units and a bucket gains `max` units a millisecond, so the arithmetic stays in integers.
  const capacity = max * windowMs;
  const idleMs = Math.max(IDLE_BUCKET_MS, windowMs);
  const buckets = new Map<string, Bucket>();

  /** `key`'s bucket refilled to `now`, moved to the back (the most recent request is last), or undefined. */
  function refill(key: string, now: number): Bucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    bucket.units = Math.min(capacity, bucket.units + Math.max(0, now - bucket.at) * max);
    bucket.at = Math.max(bucket.at, now);
    buckets.delete(key);
    buckets.set(key, bucket);
    return bucket;
  }

  return {
    take(key, now = Date.now()) {
      for (const [id, b] of buckets) {
        if (now - b.at < idleMs) break;
        buckets.delete(id);
      }

      const bucket = refill(key, now) ?? { units: capacity, at: now };
      buckets.set(key, bucket);
      if (bucket.units < windowMs) return { ok: false, retryAfterMs: Math.ceil((windowMs - bucket.units) / max) };
      bucket.units -= windowMs;
      return { ok: true };
    },
    refund(key, now = Date.now()) {
      const bucket = refill(key, now);
      if (!bucket) return;
      bucket.units = Math.min(capacity, bucket.units + windowMs);
      // Full again: the same as no bucket, so it is dropped. Keys whose requests were all given back hold no memory.
      if (bucket.units >= capacity) buckets.delete(key);
    },
    get size() {
      return buckets.size;
    },
  };
}

export type LimitConfig = Pick<Config, 'userDailyPostCap' | 'dailySpendLimitMicros' | 'factcheck'>;

export interface LimitDeps {
  db: Db;
  config: LimitConfig;
  /** One per server process, made with `config.userRequestsPerMinute`. */
  limiter: RateLimiter;
  log: Logger;
  /** Kept by the spend breaker: the UTC day (its start, in ms) whose breaker trip was logged, so it is logged once a day. */
  breakerLoggedDay?: number;
  /** Kept by `checkLimits`: each user's posts in flight, let through but not yet in a usage row. */
  inFlight?: Map<string, number>;
  /** Kept by `checkFactcheckLimits`: each user's checks in flight, let through but not yet in a usage row. */
  checksInFlight?: Map<string, number>;
}

/**
 * Refuses the request with an `AIError` when a limit is reached, in this order:
 * 1. the user's rate limit: `rate-limit` with `retryAfterMs`;
 * 2. the spend breaker, when everyone's AI cost today has reached `DAILY_SPEND_LIMIT_USD`: `cap-reached` for everyone,
 *    and `limits.spend_breaker` is logged once per UTC day per process;
 * 3. the user's daily cap (`effectiveDailyCap`): `cap-reached` once the posts classified today, plus the user's posts in
 *    flight, reach it. A batch that starts below the cap is served in full and never split, so a day ends at most 11
 *    posts over it (12 posts sent at one below), however many requests run at once.
 *
 * `postCount` is the number of posts the request sends to a model, after the Facebook audience filter. Call it only
 * when there is at least one: a request with none spends no token and counts nothing. It resolves to `release`, which
 * the caller calls once the request's usage row is written; until then the posts count as in flight. The spend breaker
 * sums metered cost only, so requests in flight when it trips still finish. The messages are internal: the app answers
 * every `AIError` with `describeError` text for its code.
 */
export async function checkLimits(
  deps: LimitDeps,
  account: Pick<DeviceAccount, 'userId'>,
  postCount: number,
  now: Date = new Date(),
): Promise<() => void> {
  const { db, config } = deps;
  const { userId } = account;

  takeRate(deps, userId, now);
  await checkSpendBreaker(deps, now);

  // The posts join the user's in flight before the reads, so of two requests checked at once the later one counts the
  // earlier one. A request whose row is written during the reads is counted twice: that can refuse early, never late.
  const { ahead, release } = join((deps.inFlight ??= new Map()), userId, postCount);

  try {
    const cap = await effectiveDailyCap(db, userId, config);
    if ((await postsToday(db, userId, now)) + ahead >= cap) {
      throw new AIError('cap-reached', "This account has reached today's post limit. AI resumes tomorrow.");
    }
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

/**
 * The guards in front of a check, cheap first: the user's rate limit (the same bucket classify uses), the spend
 * breaker, then the daily check cap: `cap-reached` once checks today plus the user's checks in flight reach
 * `USER_DAILY_CHECK_CAP` (0 refuses every check). Resolves to `release`, called once the job's usage row is written.
 */
export async function checkFactcheckLimits(
  deps: LimitDeps,
  account: Pick<DeviceAccount, 'userId'>,
  now: Date = new Date(),
): Promise<() => void> {
  const { userId } = account;
  takeRate(deps, userId, now);
  await checkSpendBreaker(deps, now);

  // Joined before the read, as in `checkLimits`, so two checks made at once count each other.
  const { ahead, release } = join((deps.checksInFlight ??= new Map()), userId, 1);
  try {
    if ((await checksToday(deps.db, userId, now)) + ahead >= deps.config.factcheck.userDailyCheckCap) {
      throw new AIError('cap-reached', "This account has reached today's fact-check limit. Checks resume tomorrow.");
    }
  } catch (err) {
    release();
    throw err;
  }
  return release;
}

/** Takes one request from the user's rate bucket, or throws `rate-limit` with `retryAfterMs`. */
function takeRate(deps: LimitDeps, userId: string, now: Date): void {
  const rate = deps.limiter.take(userId, now.getTime());
  if (!rate.ok) {
    throw new AIError('rate-limit', 'Too many requests this minute.', { retryAfterMs: rate.retryAfterMs });
  }
}

/**
 * Throws `cap-reached` once everyone's AI cost today has reached `DAILY_SPEND_LIMIT_USD`, logging
 * `limits.spend_breaker` once per UTC day per process.
 */
async function checkSpendBreaker(deps: LimitDeps, now: Date): Promise<void> {
  const { db, config, log } = deps;
  const spend = await spendTodayMicros(db, now);
  if (spend < config.dailySpendLimitMicros) return;
  const day = utcDayStart(now).getTime();
  if (deps.breakerLoggedDay !== day) {
    deps.breakerLoggedDay = day;
    log.warn('limits.spend_breaker', { spend_micros: spend, limit_micros: config.dailySpendLimitMicros });
  }
  throw new AIError('cap-reached', "This server has reached today's AI spending limit. AI resumes tomorrow.");
}

/**
 * Adds `n` to `userId`'s count in `inFlight`. `ahead` is the count before; `release` takes the `n` back once, however
 * often it is called.
 */
function join(inFlight: Map<string, number>, userId: string, n: number): { ahead: number; release: () => void } {
  const ahead = inFlight.get(userId) ?? 0;
  inFlight.set(userId, ahead + n);
  let held = true;
  const release = () => {
    if (!held) return;
    held = false;
    const left = (inFlight.get(userId) ?? 0) - n;
    if (left > 0) inFlight.set(userId, left);
    else inFlight.delete(userId);
  };
  return { ahead, release };
}

/**
 * Whether the spend breaker is tripped: everyone's AI cost today (UTC) has reached `DAILY_SPEND_LIMIT_USD`. The
 * comparison `checkLimits` makes, for the admin page and the `spend-breaker` alert (CL4-15); `checkLimits` keeps its own
 * read, since it logs the amount.
 */
export async function spendBreakerTripped(
  db: Db,
  config: Pick<Config, 'dailySpendLimitMicros'>,
  now: Date = new Date(),
): Promise<boolean> {
  return (await spendTodayMicros(db, now)) >= config.dailySpendLimitMicros;
}

/** The user's daily post cap: their own, set with `user-cap`, else the server's `USER_DAILY_POST_CAP`. */
export async function effectiveDailyCap(db: Db, userId: string, config: Pick<Config, 'userDailyPostCap'>): Promise<number> {
  const [row] = await db.select({ cap: userLimits.dailyPostCap }).from(userLimits).where(eq(userLimits.userId, userId)).limit(1);
  return row?.cap ?? config.userDailyPostCap;
}

/** Sets the user's own daily post cap, or removes it (`null`) so the server's default applies. */
export async function setDailyCap(db: Db, userId: string, cap: number | null): Promise<void> {
  if (cap === null) {
    await db.delete(userLimits).where(eq(userLimits.userId, userId));
    return;
  }
  const updatedAt = new Date();
  await db
    .insert(userLimits)
    .values({ userId, dailyPostCap: cap, updatedAt })
    .onConflictDoUpdate({ target: userLimits.userId, set: { dailyPostCap: cap, updatedAt } });
}
