/**
 * Pushes (R14): a device writes its changed items to a space. The collection's merge strategy decides each item
 * (`decide`, `packages/sync`), every write takes the space's next seq, and the answer is recorded under the push's id,
 * so a retried push writes nothing and gets the same answer. What may be stored comes from the registry alone:
 * registered collections and the items their `validate` accepts. On top of it the server refuses anything that looks
 * like an AI provider key (R17), stamps far ahead of its own clock, and pushes that would take the space over its
 * quota.
 *
 * Nothing here logs: keys and values are a person's own settings. `SyncRefusal` propagates; the route maps it and logs
 * counts (CL3-08).
 */
import {
  hlcMs,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_SPACE_MAX_BYTES,
  SYNC_SPACE_MAX_ITEMS,
  type SyncItem,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncPushResult,
  type SyncRejectReason,
} from '@unalgorithm/protocol';
import {
  type CollectionDef,
  containsCredential,
  decide,
  itemBytes,
  type Registry,
  type StoredState,
  SYNC_COLLECTIONS,
} from '@unalgorithm/sync';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { syncItems, syncPushes, syncSpaces } from '../db/schema.ts';
import { type SyncPrincipal, SyncRefusal, UUID_PATTERN } from './spaces.ts';

export interface PushLimits {
  /** Live items in the space. */
  maxItems: number;
  /** Bytes of every row, tombstones included (`sync_items.bytes`). */
  maxBytes: number;
}

export const DEFAULT_PUSH_LIMITS: Readonly<PushLimits> = Object.freeze({
  maxItems: SYNC_SPACE_MAX_ITEMS,
  maxBytes: SYNC_SPACE_MAX_BYTES,
});

export interface PushOptions {
  /** Default: `SYNC_COLLECTIONS`. */
  registry?: Registry;
  /** The server's clock, in epoch milliseconds. Default: `Date.now()`. */
  now?: number;
  /** Default: `DEFAULT_PUSH_LIMITS`. */
  limits?: PushLimits;
}

export interface PushOutcome {
  response: SyncPushResponse;
  applied: number;
  stale: number;
  rejected: number;
  /** The answer recorded for this `pushId` the first time; nothing was decided or written now. */
  replayed: boolean;
}

/** A key's state while a push is decided: the stored row, then each write of this push in turn. */
interface Held extends StoredState {
  bytes: number;
}

type ItemRow = typeof syncItems.$inferInsert;

/** Collection and key in one string: neither can hold U+0000 (`SyncCollectionSchema`, `SyncKeySchema`). */
const heldKey = (collection: string, key: string) => `${collection}\u0000${key}`;

type Rejected = Extract<SyncPushResult, { status: 'rejected' }>;

/**
 * What `sync_pushes.response` keeps of an answer: every result, without a refused item's collection and key. The server
 * never stores a refused item, and its key or collection may be the very thing refused (a provider key as a field name,
 * R17), so the record does not hold them either. Values never reach it.
 */
interface PushRecord {
  v: 1;
  results: (Exclude<SyncPushResult, Rejected> | Omit<Rejected, 'collection' | 'key'>)[];
}

/** Names a refused item in a replayed answer when the retry has no item at its place; valid as a collection and a key. */
const WITHHELD = 'withheld';

/**
 * Applies a push in one transaction and answers one result per item, in order. The caller has checked that `who` may
 * write the space (`findSpace(...).access === 'read-write'`, CL3-08) and parsed `req` with `SyncPushRequestSchema`, so
 * every value is within `SYNC_MAX_VALUE_DEPTH` before the walks below.
 *
 * Throws `SyncRefusal`: `404 not-found` for an unknown space, `410 resync-required` for another epoch, and
 * `413 quota-exceeded` when the push would take the space over a limit; then nothing is written.
 */
export async function applyPush(
  db: Db,
  who: SyncPrincipal,
  spaceId: string,
  req: SyncPushRequest,
  opts: PushOptions = {},
): Promise<PushOutcome> {
  const { registry = SYNC_COLLECTIONS, now = Date.now(), limits = DEFAULT_PUSH_LIMITS } = opts;
  if (!UUID_PATTERN.test(spaceId)) throw new SyncRefusal('not-found', 404);
  return db.transaction(async (tx) => {
    // The row lock serialises pushes to a space: seqs are handed out in order with no gap, and the counters stay exact.
    const [space] = await tx.select().from(syncSpaces).where(eq(syncSpaces.id, spaceId)).for('update');
    if (!space) throw new SyncRefusal('not-found', 404);

    // Before the epoch: a retry of a push that landed just before a new epoch still gets its answer.
    const [recorded] = await tx
      .select({ response: syncPushes.response })
      .from(syncPushes)
      .where(and(eq(syncPushes.spaceId, space.id), eq(syncPushes.pushId, req.pushId)));
    if (recorded) {
      const response = fromRecord(recorded.response as PushRecord, req.items);
      return { response, applied: 0, stale: 0, rejected: 0, replayed: true };
    }
    if (req.epoch !== space.epoch) throw new SyncRefusal('resync-required', 410, 'epoch');

    const held = await loadHeld(tx, space.id, req.items);
    // One row per key: a key written twice in this push keeps its last write (and that write's seq).
    const writes = new Map<string, ItemRow>();
    const results: SyncPushResult[] = [];
    let seq = space.seq;
    let dItems = 0;
    let dBytes = 0;
    for (const item of req.items) {
      const { collection, key } = item;
      const def = registry.get(collection);
      if (!def) {
        results.push({ collection, key, status: 'rejected', reason: 'unknown-collection' });
        continue;
      }
      const refused = guard(def, item, now);
      if (refused) {
        results.push({ collection, key, status: 'rejected', reason: refused });
        continue;
      }
      const id = heldKey(collection, key);
      const stored = held.get(id);
      const decision = decide(def.strategy, stored, item, { deviceId: who.deviceId, now, ttlMs: def.ttlMs });
      if (decision.kind !== 'write') {
        results.push(
          decision.kind === 'stale'
            ? { collection, key, status: 'stale' }
            : { collection, key, status: 'rejected', reason: decision.reason },
        );
        continue;
      }

      seq += 1;
      const bytes = key.length + itemBytes(item.deleted ? undefined : item.value);
      // `item_count` counts live rows: +1 into live, -1 out of it, 0 for a new tombstone.
      dItems += Number(!item.deleted) - Number(stored !== undefined && !stored.deleted);
      dBytes += bytes - (stored?.bytes ?? 0);
      held.set(id, { hlc: item.hlc, deleted: item.deleted, deviceId: who.deviceId, expiresAt: decision.expiresAt, bytes });
      writes.set(id, {
        spaceId: space.id,
        collection,
        key,
        value: item.deleted ? null : item.value,
        deleted: item.deleted,
        hlc: item.hlc,
        deviceId: who.deviceId,
        seq,
        bytes,
        expiresAt: decision.expiresAt === null ? null : new Date(decision.expiresAt),
        updatedAt: new Date(now),
      });
      results.push({ collection, key, status: 'applied', seq });
    }

    const itemCount = space.itemCount + dItems;
    const bytesUsed = space.bytesUsed + dBytes;
    // A push that only shrinks the space always passes, so a person over a limit can delete their way back under it.
    if ((dItems > 0 || dBytes > 0) && (itemCount > limits.maxItems || bytesUsed > limits.maxBytes)) {
      throw new SyncRefusal('quota-exceeded', 413);
    }

    if (writes.size > 0) {
      await tx
        .insert(syncItems)
        .values([...writes.values()])
        .onConflictDoUpdate({
          target: [syncItems.spaceId, syncItems.collection, syncItems.key],
          set: {
            value: sql`excluded.value`,
            deleted: sql`excluded.deleted`,
            hlc: sql`excluded.hlc`,
            deviceId: sql`excluded.device_id`,
            seq: sql`excluded.seq`,
            bytes: sql`excluded.bytes`,
            expiresAt: sql`excluded.expires_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      await tx.update(syncSpaces).set({ seq, itemCount, bytesUsed }).where(eq(syncSpaces.id, space.id));
    }
    const response: SyncPushResponse = { v: 1, results };
    await tx.insert(syncPushes).values({
      spaceId: space.id,
      pushId: req.pushId,
      deviceId: who.deviceId,
      response: toRecord(response),
      createdAt: new Date(now),
    });
    return { response, ...count(results), replayed: false };
  });
}

function toRecord({ v, results }: SyncPushResponse): PushRecord {
  return { v, results: results.map((r) => (r.status === 'rejected' ? { status: r.status, reason: r.reason } : r)) };
}

/** The recorded answer again. A retry carries the same items, so each refused item is named by the item at its place. */
function fromRecord({ v, results }: PushRecord, items: readonly SyncItem[]): SyncPushResponse {
  return {
    v,
    results: results.map((r, i) =>
      r.status === 'rejected'
        ? { collection: items[i]?.collection ?? WITHHELD, key: items[i]?.key ?? WITHHELD, status: r.status, reason: r.reason }
        : r,
    ),
  };
}

/**
 * Why the server refuses an item before its strategy sees it, or null. The first failing check decides; `validate`
 * comes first, so the credential walk only reads values the collection accepts. Keys are checked by their segments,
 * tombstones too: an unknown field's key segment can hold a whole provider key (CL3-04).
 */
function guard(def: CollectionDef, item: SyncItem, now: number): SyncRejectReason | null {
  if (!def.validate(item)) return 'invalid';
  if (containsCredential(item.key.split('.')) || (!item.deleted && containsCredential(item.value))) return 'credential';
  // The server's own clock: the extension restamps clocks that ran ahead once its clock is right again (CL3-19).
  if (hlcMs(item.hlc) > now + SYNC_MAX_HLC_AHEAD_MS) return 'clock-ahead';
  return null;
}

/** What the space holds for the pushed keys, in one query. */
async function loadHeld(db: Db, spaceId: string, items: readonly SyncItem[]): Promise<Map<string, Held>> {
  const keys = [...new Set(items.map((i) => i.key))];
  const rows = await db
    .select({
      collection: syncItems.collection,
      key: syncItems.key,
      hlc: syncItems.hlc,
      deleted: syncItems.deleted,
      deviceId: syncItems.deviceId,
      expiresAt: syncItems.expiresAt,
      bytes: syncItems.bytes,
    })
    .from(syncItems)
    .where(and(eq(syncItems.spaceId, spaceId), inArray(syncItems.key, keys)));
  return new Map(
    rows.map(({ collection, key, expiresAt, ...row }) => [
      heldKey(collection, key),
      { ...row, expiresAt: expiresAt?.getTime() ?? null },
    ]),
  );
}

function count(results: readonly SyncPushResult[]): Pick<PushOutcome, 'applied' | 'stale' | 'rejected'> {
  const tally = { applied: 0, stale: 0, rejected: 0 };
  for (const r of results) tally[r.status] += 1;
  return tally;
}
