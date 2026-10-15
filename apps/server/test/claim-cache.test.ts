import { CLAIM_CACHE_TTL_MS } from '@unalgorithm/protocol';
import { type CachedClaim, CLAIM_CACHE_TIME_UNIT_MS } from '@unalgorithm/research';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAIM_CACHE_PURGE_SCHEDULE,
  CLAIM_CACHE_PURGE_TASK,
  claimCacheSecret,
  pgClaimCache,
  purgeClaimCache,
  registerClaimCacheJobs,
} from '../src/ai/claim-cache.ts';
import type { DbHandle } from '../src/db/client.ts';
import { claimCache } from '../src/db/schema.ts';
import type { JobHandler, JobRegistry } from '../src/jobs/worker.ts';
import { createTestDb, queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createTestApp, TEST_ENV } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const HOUR_MS = 60 * 60_000;
const NOON = Date.parse('2026-10-15T12:00:00.000Z');
const SECRET = claimCacheSecret('test-only-auth-secret-0123456789abcdef');

const ENTRY: CachedClaim = {
  v: 1,
  verdict: 'disputed',
  checkedAt: '2026-10-15T12:00:00.000Z',
  citations: [
    { url: 'https://a.com/1', domain: 'a.com', title: 'A', quote: 'q a' },
    { url: 'https://b.org/1', domain: 'news.b.org', title: 'B', quote: 'q b' },
  ],
};
const OTHER: CachedClaim = {
  ...ENTRY,
  verdict: 'supported',
  citations: [ENTRY.citations[1], { url: 'https://c.net/1', domain: 'c.net', title: 'C', quote: 'q c' }].filter(
    (c) => c !== undefined,
  ),
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<DbHandle> {
  const h = await createTestDb();
  cleanup.push(() => h.close());
  return h;
}

/** A cache on `h` whose clock is `clock.now`. */
function cacheOn(h: DbHandle, clock: { now: number }, secret = SECRET) {
  return pgClaimCache(h.db, { secret, now: () => clock.now });
}

async function rows(h: DbHandle) {
  return h.db.select().from(claimCache);
}

describe('store', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_claim_cache_round_trip', async () => {
    const h = await testDb();
    const cache = cacheOn(h, { now: NOON + 40 * 60_000 });
    const key = await cache.key('The bridge is 2 km long.');
    await cache.put([{ key, entry: ENTRY }]);
    const got = await cache.get([key, key]);
    expect([...got.keys()]).toEqual([key]);
    expect(got.get(key)).toEqual(ENTRY);
    await expect(cache.get(Array.from({ length: 17 }, (_, i) => `k${i}`))).rejects.toThrow(TypeError);
  });

  it('test_claim_cache_not_found_and_expired', async () => {
    const h = await testDb();
    const clock = { now: NOON };
    const cache = cacheOn(h, clock);
    const key = await cache.key('claim');
    expect((await cache.get([key])).size).toBe(0);
    expect((await cache.get([])).size).toBe(0);
    await cache.put([{ key, entry: ENTRY }]);
    clock.now = NOON + CLAIM_CACHE_TTL_MS - 1;
    expect((await cache.get([key])).size).toBe(1);
    // Expired, though not purged yet: not served.
    clock.now = NOON + CLAIM_CACHE_TTL_MS;
    expect((await cache.get([key])).size).toBe(0);
    expect(await rows(h)).toHaveLength(1);
  });

  it('test_claim_cache_fresh_row_kept_expired_row_replaced', async () => {
    const h = await testDb();
    const clock = { now: NOON + 40 * 60_000 };
    const cache = cacheOn(h, clock);
    const key = await cache.key('claim');
    await cache.put([{ key, entry: ENTRY }]);
    // Unexpired: the first writer's row stays.
    await cache.put([{ key, entry: { ...OTHER, checkedAt: '2026-10-15T12:00:00.000Z' } }]);
    expect((await cache.get([key])).get(key)).toEqual(ENTRY);

    // Past its expiry but not purged: a new entry replaces it, expiring a TTL after its own checkedAt.
    clock.now = NOON + CLAIM_CACHE_TTL_MS + 30 * 60_000;
    const later = { ...OTHER, checkedAt: new Date(NOON + CLAIM_CACHE_TTL_MS + 20 * 60_000).toISOString() };
    await cache.put([{ key, entry: later }]);
    const stored = await rows(h);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.verdict).toBe('supported');
    expect(stored[0]?.citations).toEqual(OTHER.citations);
    expect(stored[0]?.checkedAt.getTime()).toBe(NOON + CLAIM_CACHE_TTL_MS);
    expect(stored[0]?.expiresAt.getTime()).toBe(NOON + 2 * CLAIM_CACHE_TTL_MS);

    // An entry already past its TTL is not written.
    const stale = await cache.key('stale claim');
    await cache.put([{ key: stale, entry: ENTRY }]);
    expect(await rows(h)).toHaveLength(1);
  });

  it('test_claim_cache_put_rejects_invalid_entry', async () => {
    const h = await testDb();
    const cache = cacheOn(h, { now: NOON });
    const [a, b] = [await cache.key('a'), await cache.key('b')];
    const one = { ...ENTRY, citations: ENTRY.citations.slice(0, 1) };
    await expect(
      cache.put([
        { key: a, entry: ENTRY },
        { key: b, entry: one },
      ]),
    ).rejects.toThrow();
    const unverifiable = { ...ENTRY, verdict: 'unverifiable' } as unknown as CachedClaim;
    await expect(cache.put([{ key: a, entry: unverifiable }])).rejects.toThrow();
    expect(await rows(h)).toHaveLength(0);

    // Two entries under one key in one put: the first is stored, without an error.
    await cache.put([
      { key: a, entry: ENTRY },
      { key: a, entry: OTHER },
    ]);
    expect((await cache.get([a])).get(a)).toEqual(ENTRY);
  });

  it('test_claim_cache_purge_deletes_expired_only', async () => {
    const h = await testDb();
    const cache = cacheOn(h, { now: NOON });
    const at = (hours: number) => new Date(NOON + hours * HOUR_MS).toISOString();
    for (const [name, checkedAt] of [
      ['old', at(-24)],
      ['older', at(-30)],
      ['fresh', at(-23)],
      ['now', at(0)],
    ] as const) {
      // Written while each was live.
      await pgClaimCache(h.db, { secret: SECRET, now: () => Date.parse(checkedAt) }).put([
        { key: await cache.key(name), entry: { ...ENTRY, checkedAt } },
      ]);
    }
    // 'old' expires exactly now (not before it), 'older' six hours ago.
    expect(await purgeClaimCache(h.db, NOON)).toBe(1);
    expect(await purgeClaimCache(h.db, NOON + 1)).toBe(1);
    expect(await purgeClaimCache(h.db, NOON + 1)).toBe(0);
    expect(await rows(h)).toHaveLength(2);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_claim_cache_columns_hold_no_ids_text_or_exact_times', async () => {
    const h = await testDb();
    const columns = await queryRows(
      h,
      sql`select column_name from information_schema.columns where table_name = 'claim_cache' order by ordinal_position`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(['key', 'verdict', 'citations', 'checked_at', 'expires_at']);

    const cache = cacheOn(h, { now: Date.parse('2026-10-15T12:40:00.000Z') });
    const key = await cache.key('claim');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    await cache.put([{ key, entry: { ...ENTRY, checkedAt: '2026-10-15T12:34:56.789Z' } }]);
    const [row] = await queryRows(
      h,
      sql`select to_char(checked_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as checked_at,
                 to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as expires_at from claim_cache`,
    );
    expect(row).toEqual({ checked_at: '2026-10-15 12:00:00.000', expires_at: '2026-10-16 12:00:00.000' });
    expect(CLAIM_CACHE_TIME_UNIT_MS).toBe(HOUR_MS);
  });

  it('test_claim_cache_isolated_by_server_secret', async () => {
    const h = await testDb();
    const clock = { now: NOON };
    const ours = cacheOn(h, clock);
    const theirs = cacheOn(h, clock, claimCacheSecret('another-servers-secret-0123456789abcdef'));
    const ourKey = await ours.key('claim');
    await ours.put([{ key: ourKey, entry: ENTRY }]);
    const theirKey = await theirs.key('claim');
    expect(theirKey).not.toBe(ourKey);
    expect((await theirs.get([theirKey])).size).toBe(0);

    const authSecret = TEST_ENV.BETTER_AUTH_SECRET ?? '';
    const derived = claimCacheSecret(authSecret);
    expect(derived.byteLength).toBe(32);
    expect(Buffer.from(derived)).toEqual(Buffer.from(claimCacheSecret(authSecret)));
    expect(Buffer.from(derived)).not.toEqual(Buffer.from(authSecret).subarray(0, 32));
    expect(Buffer.from(derived)).not.toEqual(Buffer.from(claimCacheSecret(`${authSecret}x`)));
  });
});

describe('jobs and wiring', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_claim_cache_purge_registered_counts_only', async () => {
    const h = await testDb();
    // One row expired a day ago, one live: the task purges by the real clock.
    const now = Date.now();
    for (const [name, at] of [
      ['gone', now - 2 * CLAIM_CACHE_TTL_MS],
      ['live', now],
    ] as const) {
      const checkedAt = new Date(at).toISOString();
      const cache = pgClaimCache(h.db, { secret: SECRET, now: () => at });
      await cache.put([{ key: await cache.key(name), entry: { ...ENTRY, checkedAt } }]);
    }
    const tasks = new Map<string, JobHandler>();
    const schedules: [string, string][] = [];
    const recording: JobRegistry = {
      task: (name, handler) => tasks.set(name, handler),
      cron: (task, match) => schedules.push([task, match]),
    };
    registerClaimCacheJobs(recording, { db: h.db });
    expect([...tasks.keys()]).toEqual(['factcheck.purge-claim-cache']);
    expect(schedules).toEqual([[CLAIM_CACHE_PURGE_TASK, '41 * * * *']]);
    expect(CLAIM_CACHE_PURGE_SCHEDULE).toBe('41 * * * *');

    const { log, events } = captureLog();
    await tasks.get(CLAIM_CACHE_PURGE_TASK)?.({}, { signal: new AbortController().signal, log });
    const lines = events();
    expect(lines).toHaveLength(1);
    const { t: _t, level: _level, event, ...fields } = lines[0] ?? {};
    expect(event).toBe('factcheck.claim_cache_purged');
    expect(fields).toEqual({ count: 1 });
    expect(await rows(h)).toHaveLength(1);
  });

  it('test_app_default_claim_cache', async () => {
    const t = await createTestApp();
    cleanup.push(() => t.close());
    const cache = t.deps.claimCache;
    if (!cache) throw new Error('No default claim cache.');
    const key = await cache.key('claim');
    const entry = { ...ENTRY, checkedAt: new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString() };
    await cache.put([{ key, entry }]);
    expect((await cache.get([key])).get(key)).toEqual(entry);
    // Over the app's own database, keyed by its server's secret.
    expect(await t.deps.db.db.select({ key: claimCache.key }).from(claimCache)).toEqual([{ key }]);
    expect(key).toBe(await pgClaimCache(t.deps.db.db, { secret: claimCacheSecret(t.deps.config.authSecret) }).key('claim'));
  });
});
