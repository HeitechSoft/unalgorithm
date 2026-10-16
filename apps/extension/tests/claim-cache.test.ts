/**
 * The per-device claim cache (P3-60): the IndexedDB upgrade that adds `claimChecks`, the device's own key, and the
 * round trip with its expiry. Storage is fake-indexeddb; crypto is Node's Web Crypto. Nothing is sent anywhere.
 */
import { CLAIM_CACHE_TTL_MS } from '@unalgorithm/protocol';
import type { CachedClaim } from '@unalgorithm/research';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAIM_CACHE_SECRET_ID, deviceClaimCache } from '../src/background/claim-cache.ts';
import { clearClaimChecks, clearSecrets, getSecret } from '../src/background/idb.ts';

const CHECKED_AT = '2026-10-15T09:00:00.000Z';
const T0 = Date.parse(CHECKED_AT) + 10 * 60_000;
const CLAIM = 'The bridge opened in 1932.';

const entry = (checkedAt = CHECKED_AT): CachedClaim => ({
  v: 1,
  verdict: 'supported',
  explanation: 'Two records give the same opening year.',
  citations: [
    {
      url: 'https://news.example.org/a',
      domain: 'news.example.org',
      title: 'Span history',
      quote: 'Traffic first crossed in 1932',
    },
    {
      url: 'https://records.example.net/b',
      domain: 'records.example.net',
      title: 'City records',
      quote: 'Opened to traffic, 1932',
    },
  ],
  checkedAt,
});

/** Every row of a store, read on a connection of its own. */
async function rows(name: string, factory: IDBFactory = indexedDB): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open('unalgorithm');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(name, 'readonly').objectStore(name).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  expect(globalThis.crypto?.subtle, 'Web Crypto (crypto.subtle) is missing').toBeDefined();
  await clearSecrets();
  await clearClaimChecks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('store', () => {
  it('test_idb_upgrade_keeps_secrets_and_classifications', async () => {
    // A fresh database at version 1, as the previous build left it.
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const req = factory.open('unalgorithm', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('secrets');
        db.createObjectStore('classifications', { keyPath: 'key' }).createIndex('at', 'at');
      };
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['secrets', 'classifications'], 'readwrite');
        tx.objectStore('secrets').put('sk-ant-old', 'anthropic');
        tx.objectStore('classifications').put({ key: 'k1', at: 1, label: 'kept' });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    vi.stubGlobal('indexedDB', factory);
    vi.resetModules();
    const idb = await import('../src/background/idb.ts');
    expect(await idb.getSecret('anthropic')).toBe('sk-ant-old');
    expect(await rows('classifications', factory)).toStrictEqual([{ key: 'k1', at: 1, label: 'kept' }]);
    expect(await rows('claimChecks', factory)).toStrictEqual([]);
    const row = { key: 'a'.repeat(64), entry: entry(), expiresAt: Date.parse(CHECKED_AT) + CLAIM_CACHE_TTL_MS };
    await idb.putClaimChecks([row], T0);
    expect([...(await idb.getClaimChecks([row.key], T0)).values()]).toStrictEqual([row]);
  });

  it('test_device_claim_key_created_once', async () => {
    const first = deviceClaimCache();
    const second = deviceClaimCache();
    // Two caches asking at once still create one key.
    const [a, b] = await Promise.all([first.key(CLAIM), second.key(CLAIM)]);
    const stored = await getSecret(CLAIM_CACHE_SECRET_ID);
    expect(stored).toBeDefined();
    expect(Uint8Array.from(atob(stored ?? ''), (c) => c.charCodeAt(0)).byteLength).toBe(32);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(await deviceClaimCache().key(CLAIM)).toBe(a);
    expect(await getSecret(CLAIM_CACHE_SECRET_ID)).toBe(stored);
    expect(await deviceClaimCache().key('The bridge opened in 1933.')).not.toBe(a);
  });

  it('test_device_claim_cache_round_trip_and_expiry', async () => {
    let now = T0;
    const cache = deviceClaimCache({ now: () => now });
    const key = await cache.key(CLAIM);
    const other = entry('2026-10-15T08:00:00.000Z');
    // The first entry of a key is the one stored.
    await cache.put([
      { key, entry: entry() },
      { key, entry: other },
    ]);
    expect(await cache.get([key])).toStrictEqual(new Map([[key, entry()]]));
    // An unexpired row is kept, not replaced.
    await cache.put([{ key, entry: other }]);
    expect((await cache.get([key])).get(key)).toStrictEqual(entry());
    expect(await rows('claimChecks')).toStrictEqual([
      { key, entry: entry(), expiresAt: Date.parse(CHECKED_AT) + CLAIM_CACHE_TTL_MS },
    ]);

    now = Date.parse(CHECKED_AT) + CLAIM_CACHE_TTL_MS;
    expect(await cache.get([key])).toStrictEqual(new Map());
    // Still on disk until the next write, which deletes every expired row.
    expect(await rows('claimChecks')).toHaveLength(1);
    const otherKey = await cache.key('The tunnel opened in 1950.');
    const fresh = entry(new Date(now).toISOString());
    await cache.put([{ key: otherKey, entry: fresh }]);
    expect(await rows('claimChecks')).toStrictEqual([{ key: otherKey, entry: fresh, expiresAt: now + CLAIM_CACHE_TTL_MS }]);
    // An expired row's key takes a new entry.
    await cache.put([{ key, entry: fresh }]);
    expect((await cache.get([key])).get(key)).toStrictEqual(fresh);
  });
});
