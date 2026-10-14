import { compareHlc } from '@unalgorithm/protocol';
import type { MergeStrategy } from './registry.ts';

/**
 * The server's rule for one pushed item: write it, call it stale, or refuse it. Every route decides with this one
 * function, and the extension applies the same last-writer-wins order with `compareHlc`. Pure: the clock and the
 * pushing device come in through `DecideContext`.
 */

/** What the server holds for a key. */
export interface StoredState {
  hlc: string;
  deleted: boolean;
  /** The device that wrote it. */
  deviceId: string | null;
  /** ttl-cache only: when it lapses, in epoch milliseconds. */
  expiresAt: number | null;
}

/** The parts of a pushed `SyncItem` a decision reads. */
export interface Incoming {
  key: string;
  hlc: string;
  deleted: boolean;
}

export interface DecideContext {
  /** The pushing device's server device id. */
  deviceId: string;
  now: number;
  /** ttl-cache only: the collection's `ttlMs`. */
  ttlMs?: number;
}

export type Decision =
  | { kind: 'write'; expiresAt: number | null }
  | { kind: 'stale' }
  | { kind: 'reject'; reason: 'invalid' | 'not-own-device' };

/**
 * Last writer wins for values and tombstones alike: a delete with a newer HLC beats an older edit, and an edit with a
 * newer HLC beats an older delete. An equal HLC is the same edit arriving twice, so it is stale.
 */
function lastWriterWins(stored: StoredState | undefined, incoming: Incoming): Decision {
  if (stored === undefined || compareHlc(incoming.hlc, stored.hlc) > 0) return { kind: 'write', expiresAt: null };
  return { kind: 'stale' };
}

export function decide(
  strategy: MergeStrategy,
  stored: StoredState | undefined,
  incoming: Incoming,
  ctx: DecideContext,
): Decision {
  switch (strategy) {
    // The two decide alike; they differ in what one item holds, which the collection's `validate` enforces.
    case 'lww-map':
    case 'lww-doc':
      return lastWriterWins(stored, incoming);
    case 'per-device':
      if (incoming.key !== ctx.deviceId) return { kind: 'reject', reason: 'not-own-device' };
      return lastWriterWins(stored, incoming);
    case 'ttl-cache': {
      // Cached items lapse; they are never deleted.
      if (incoming.deleted) return { kind: 'reject', reason: 'invalid' };
      const { ttlMs } = ctx;
      if (ttlMs === undefined || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new TypeError('ttl-cache needs a positive integer ttlMs');
      }
      if (stored === undefined || isExpired(stored, ctx.now) || compareHlc(incoming.hlc, stored.hlc) > 0) {
        return { kind: 'write', expiresAt: ctx.now + ttlMs };
      }
      return { kind: 'stale' };
    }
    default: {
      const unknown: never = strategy;
      throw new TypeError(`unknown merge strategy: ${String(unknown)}`);
    }
  }
}

const encoder = new TextEncoder();

/** UTF-8 bytes of `JSON.stringify(value)`, as quotas and `SYNC_MAX_ITEM_BYTES` count them; 0 for `undefined`. */
export function itemBytes(value: unknown): number {
  if (value === undefined) return 0;
  return encoder.encode(JSON.stringify(value)).length;
}

/** True once a ttl-cache item's `expiresAt` has come; items without one never expire. */
export function isExpired(stored: Pick<StoredState, 'expiresAt'>, now: number): boolean {
  return stored.expiresAt !== null && stored.expiresAt <= now;
}
