import { CACHE_MAX_ENTRIES, type CachedClassification, isFresh } from '@unalgorithm/core';

/**
 * IndexedDB in the extension's own origin. Content scripts run in the page's origin, so they cannot open this
 * database: API keys stored here are unreachable from LinkedIn or Facebook pages (unlike chrome.storage.local).
 */
const DB_NAME = 'unalgorithm';
const DB_VERSION = 1;

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

async function store(name: 'secrets' | 'classifications', mode: IDBTransactionMode) {
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
