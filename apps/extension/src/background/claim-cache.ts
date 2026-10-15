import { CLAIM_CACHE_TTL_MS } from '@unalgorithm/protocol';
import { type ClaimCache, hmacClaimKeyer } from '@unalgorithm/research';
import { type ClaimCheckRow, getClaimChecks, getSecret, putClaimChecks, setSecret } from './idb.ts';

/** The `secrets` id of this device's claim-cache key: 32 random bytes, base64. Never synced or exported. */
export const CLAIM_CACHE_SECRET_ID = 'claim-cache-key';
const SECRET_BYTES = 32;

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

let creating: Promise<Uint8Array> | undefined;

function decode(stored: string | undefined): Uint8Array | null {
  const bytes = stored ? fromBase64(stored) : null;
  return bytes?.byteLength === SECRET_BYTES ? bytes : null;
}

/** Reads the device's secret, creating it on first use (once, even when two checks start together). */
async function deviceSecret(): Promise<Uint8Array> {
  const stored = decode(await getSecret(CLAIM_CACHE_SECRET_ID));
  if (stored) return stored;
  creating ??= (async () => {
    const again = decode(await getSecret(CLAIM_CACHE_SECRET_ID));
    if (again) return again;
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
    await setSecret(CLAIM_CACHE_SECRET_ID, toBase64(bytes));
    return bytes;
  })().finally(() => {
    creating = undefined;
  });
  return creating;
}

/** The device's claim cache (P3-57's rules): IndexedDB in the extension's origin, keyed with this device's own secret. */
export function deviceClaimCache(deps?: { now?: () => number }): ClaimCache {
  const now = deps?.now ?? (() => Date.now());
  // The secret is read per cache, so "Erase everything" (which deletes it) gives the next check a new one.
  let keyer: Promise<(claimText: string) => Promise<string>> | undefined;
  const keyFor = () => {
    keyer ??= deviceSecret().then(hmacClaimKeyer);
    return keyer;
  };
  return {
    async key(claimText) {
      return (await keyFor())(claimText);
    },
    async get(keys) {
      const rows = await getClaimChecks(keys, now());
      return new Map([...rows].map(([k, row]) => [k, row.entry]));
    },
    async put(entries) {
      const rows: ClaimCheckRow[] = [];
      for (const { key, entry } of entries) {
        if (rows.some((r) => r.key === key)) continue;
        rows.push({ key, entry, expiresAt: Date.parse(entry.checkedAt) + CLAIM_CACHE_TTL_MS });
      }
      await putClaimChecks(rows, now());
    },
  };
}
