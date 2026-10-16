/**
 * The server's shared claim cache (F27, decisions D59–D61): the `claim_cache` table behind P3-57's `ClaimCache`. A row is
 * a keyed hash of a normalized public claim, the verdict, its explanation unless it repeats the post, its validated
 * citations and two whole-hour times, nothing else. The key's secret is derived from this server's BETTER_AUTH_SECRET and never stored, so no other server can find
 * a row, and changing that secret makes every row unreachable until the hourly purge removes it.
 * `docs/privacy-model.md` → *What a server stores* gives the retention.
 */
import { hkdfSync } from 'node:crypto';
import { CLAIM_CACHE_TTL_MS } from '@unalgorithm/protocol';
import { CachedClaimSchema, CLAIM_CACHE_TIME_UNIT_MS, type ClaimCache, hmacClaimKeyer } from '@unalgorithm/research';
import { and, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { claimCache } from '../db/schema.ts';
import type { JobRegistry } from '../jobs/worker.ts';

export const CLAIM_CACHE_PURGE_TASK = 'factcheck.purge-claim-cache';
/** Every hour, at 41 minutes past (UTC). */
export const CLAIM_CACHE_PURGE_SCHEDULE = '41 * * * *';
/** Keys one `get` may ask for: a check has at most 3 claims. */
const MAX_GET_KEYS = 16;

/** 32 bytes: HKDF-SHA-256 over BETTER_AUTH_SECRET, salt 'unalgorithm', info 'claim-cache v1'. */
export function claimCacheSecret(authSecret: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', authSecret, 'unalgorithm', 'claim-cache v1', 32));
}

const floorToUnit = (t: number): number => Math.floor(t / CLAIM_CACHE_TIME_UNIT_MS) * CLAIM_CACHE_TIME_UNIT_MS;

/**
 * The claim cache over `db`. `get` serves rows whose expiry is after `now()`, unparsed; `put` validates every entry
 * first (one invalid entry writes nothing), keeps the first entry of each key, and replaces a row only once it expired.
 */
export function pgClaimCache(db: Db, o: { secret: Uint8Array; now?: () => number; ttlMs?: number }): ClaimCache {
  const key = hmacClaimKeyer(o.secret);
  const now = o.now ?? (() => Date.now());
  const ttl = o.ttlMs ?? CLAIM_CACHE_TTL_MS;
  return {
    key,
    async get(keys) {
      const unique = [...new Set(keys)];
      if (unique.length > MAX_GET_KEYS) throw new TypeError(`A claim cache lookup takes at most ${MAX_GET_KEYS} keys.`);
      const out = new Map<string, unknown>();
      if (unique.length === 0) return out;
      const rows = await db
        .select({
          key: claimCache.key,
          verdict: claimCache.verdict,
          explanation: claimCache.explanation,
          citations: claimCache.citations,
          checkedAt: claimCache.checkedAt,
        })
        .from(claimCache)
        .where(and(inArray(claimCache.key, unique), gt(claimCache.expiresAt, new Date(now()))));
      for (const row of rows) {
        out.set(row.key, {
          v: 1,
          verdict: row.verdict,
          ...(row.explanation === null ? {} : { explanation: row.explanation }),
          citations: row.citations,
          checkedAt: row.checkedAt.toISOString(),
        });
      }
      return out;
    },
    async put(entries) {
      const parsed = entries.map(({ key: k, entry }) => ({ key: k, entry: CachedClaimSchema.parse(entry) }));
      const at = now();
      const seen = new Set<string>();
      const rows: (typeof claimCache.$inferInsert)[] = [];
      for (const { key: k, entry } of parsed) {
        // Postgres refuses an upsert that touches one row twice: the first entry of a key is the one stored.
        if (seen.has(k)) continue;
        seen.add(k);
        const checkedAt = floorToUnit(Date.parse(entry.checkedAt));
        if (checkedAt + ttl <= at) continue;
        rows.push({
          key: k,
          verdict: entry.verdict,
          explanation: entry.explanation ?? null,
          citations: entry.citations,
          checkedAt: new Date(checkedAt),
          expiresAt: new Date(checkedAt + ttl),
        });
      }
      if (rows.length === 0) return;
      await db
        .insert(claimCache)
        .values(rows)
        .onConflictDoUpdate({
          target: claimCache.key,
          set: {
            verdict: sql.raw('excluded.verdict'),
            explanation: sql.raw('excluded.explanation'),
            citations: sql.raw('excluded.citations'),
            checkedAt: sql.raw('excluded.checked_at'),
            expiresAt: sql.raw('excluded.expires_at'),
          },
          // First writer wins until its row expires; an expired row not yet purged is replaced.
          setWhere: lte(claimCache.expiresAt, new Date(at)),
        });
    },
  };
}

/** Deletes rows whose expiry is before `now`; returns how many. */
export async function purgeClaimCache(db: Db, now = Date.now()): Promise<number> {
  const deleted = await db
    .delete(claimCache)
    .where(lt(claimCache.expiresAt, new Date(now)))
    .returning({ key: claimCache.key });
  return deleted.length;
}

/** Registers the hourly purge. Its payload is empty, and its log line holds the count only. */
export function registerClaimCacheJobs(jobs: JobRegistry, deps: { db: Db }): void {
  jobs.task(CLAIM_CACHE_PURGE_TASK, async (_payload, { log }) => {
    log.info('factcheck.claim_cache_purged', { count: await purgeClaimCache(deps.db) });
  });
  jobs.cron(CLAIM_CACHE_PURGE_TASK, CLAIM_CACHE_PURGE_SCHEDULE);
}
