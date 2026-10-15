import { CACHE_MAX_ENTRIES, type CachedClassification, isFresh } from '@unalgorithm/core';
import type { CachedClaim } from '@unalgorithm/research';

/**
 * IndexedDB in the extension's own origin. Content scripts run in the page's origin, so they cannot open this
 * database: API keys stored here are unreachable from LinkedIn or Facebook pages (unlike chrome.storage.local).
 */
const DB_NAME = 'unalgorithm';
/** 2 adds `claimChecks` (P3-60); a version 1 database keeps its stores. */
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets');
      if (!db.objectStoreNames.contains('classifications')) {
        const store = db.createObjectStore('classifications', { keyPath: 'key' });
        store.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('claimChecks')) {
        const store = db.createObjectStore('claimChecks', { keyPath: 'key' });
        store.createIndex('expiresAt', 'expiresAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type StoreName = 'secrets' | 'classifications' | 'claimChecks';

async function store(name: StoreName, mode: IDBTransactionMode) {
  return (await open()).transaction(name, mode).objectStore(name);
}

// ---------- secrets (API keys, endpoint tokens): never synced, never exported ----------

export async function getSecret(id: string): Promise<string | undefined> {
  return (await done((await store('secrets', 'readonly')).get(id))) as string | undefined;
}

export async function setSecret(id: string, value: string | undefined): Promise<void> {
  const s = await store('secrets', 'readwrite');
  if (value) await done(s.put(value, id));
  else await done(s.delete(id));
}

export async function clearSecrets(): Promise<void> {
  await done((await store('secrets', 'readwrite')).clear());
}

// ---------- classification cache (no post text, no names) ----------

export async function getCached(keys: string[]): Promise<Map<string, CachedClassification>> {
  const s = await store('classifications', 'readonly');
  const out = new Map<string, CachedClassification>();
  await Promise.all(
    keys.map(async (k) => {
      const v = (await done(s.get(k))) as CachedClassification | undefined;
      if (v && isFresh(v)) out.set(k, v);
    }),
  );
  return out;
}

let writes = 0;

export async function putCached(entries: CachedClassification[]): Promise<void> {
  if (!entries.length) return;
  const s = await store('classifications', 'readwrite');
  const tx = s.transaction;
  for (const e of entries) s.put(e);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  writes += entries.length;
  if (writes > 200) {
    writes = 0;
    await prune();
  }
}

/** Keep the newest entries only. */
async function prune(): Promise<void> {
  const s = await store('classifications', 'readwrite');
  const count = await done(s.count());
  if (count <= CACHE_MAX_ENTRIES) return;
  let excess = count - CACHE_MAX_ENTRIES;
  await new Promise<void>((resolve) => {
    const cursor = s.index('at').openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || excess <= 0) return resolve();
      c.delete();
      excess--;
      c.continue();
    };
    cursor.onerror = () => resolve();
  });
}

export async function clearCache(): Promise<void> {
  await done((await store('classifications', 'readwrite')).clear());
}

// ---------- claim cache (P3-60): a keyed claim hash, its verdict, explanation and citations; no post or claim text ----

export interface ClaimCheckRow {
  /** HMAC of the normalized claim under this device's own secret. */
  key: string;
  entry: CachedClaim;
  /** Epoch ms: the entry's `checkedAt` + CLAIM_CACHE_TTL_MS. */
  expiresAt: number;
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The rows under `keys` that expire after `now`. */
export async function getClaimChecks(keys: readonly string[], now: number): Promise<Map<string, ClaimCheckRow>> {
  const s = await store('claimChecks', 'readonly');
  const out = new Map<string, ClaimCheckRow>();
  await Promise.all(
    [...new Set(keys)].map(async (k) => {
      const row = (await done(s.get(k))) as ClaimCheckRow | undefined;
      if (row && row.expiresAt > now) out.set(k, row);
    }),
  );
  return out;
}

/**
 * Writes each row unless an unexpired row holds its key (an expired one is replaced), then deletes every row that
 * expired by `now`. One transaction.
 */
export async function putClaimChecks(rows: readonly ClaimCheckRow[], now: number): Promise<void> {
  const s = await store('claimChecks', 'readwrite');
  const result = committed(s.transaction);
  for (const row of rows) {
    if (row.expiresAt <= now) continue;
    const get = s.get(row.key);
    get.onsuccess = () => {
      const existing = get.result as ClaimCheckRow | undefined;
      if (!existing || existing.expiresAt <= now) s.put(row);
    };
  }
  const cursor = s.index('expiresAt').openCursor(IDBKeyRange.upperBound(now));
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    // A row written above expires after `now`, so the cursor never reaches it.
    c.delete();
    c.continue();
  };
  await result;
}

export async function clearClaimChecks(): Promise<void> {
  await done((await store('claimChecks', 'readwrite')).clear());
}
