/**
 * Sync spaces (R14) and reading their changes (R16). Each account has one personal space, created on first use; who may
 * read or write a space is decided by an `AccessResolver`, the seam CL7's read-only org spaces plug into.
 *
 * Nothing here logs: keys and values are a person's own settings. The routes log counts and refusal reasons (CL3-08).
 */
import type { SyncChange, SyncChangesResponse, SyncErrorCode, SyncSpace, SyncValue } from '@unalgorithm/protocol';
import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { syncItems, syncSpaces } from '../db/schema.ts';

export type SpaceRow = typeof syncSpaces.$inferSelect;

/** The signed-in device a sync request comes from (`requireDevice`, CL1-10). */
export interface SyncPrincipal {
  userId: string;
  deviceId: string;
}

export type SpaceAccess = 'read-write' | 'read';

/** Who may do what in a space. CL3: the owner of a 'user' space. CL7 supplies org membership through this seam. */
export type AccessResolver = (space: SpaceRow, who: SyncPrincipal) => SpaceAccess | null;

export const userSpaceAccess: AccessResolver = (space, who) =>
  space.kind === 'user' && space.userId === who.userId ? 'read-write' : null;

/**
 * A sync request the server refuses, with the status the route answers (CL3-08). `reason` says why a cursor cannot be
 * trusted (`resync-required` only): another epoch, a cursor ahead of the server, or one older than cleaned-up tombstones.
 */
export class SyncRefusal extends Error {
  readonly code: SyncErrorCode;
  readonly status: 403 | 404 | 410 | 413;
  readonly reason: 'epoch' | 'rewound' | 'gc' | undefined;

  constructor(code: SyncErrorCode, status: 403 | 404 | 410 | 413, reason?: 'epoch' | 'rewound' | 'gc') {
    super(code);
    this.name = 'SyncRefusal';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

/** A uuid in any case, as Postgres reads one. Anything else names no space, and comparing it with a uuid column throws. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The account's personal space, created on first use. Requests that create it at once insert one row between them: the
 * unique `user_id` makes every other insert wait for the first and then do nothing, and each reads the row after.
 */
export async function ensureUserSpace(db: Db, userId: string): Promise<SpaceRow> {
  await db.insert(syncSpaces).values({ kind: 'user', userId }).onConflictDoNothing({ target: syncSpaces.userId });
  const [space] = await db.select().from(syncSpaces).where(eq(syncSpaces.userId, userId));
  if (!space) throw new Error('The personal sync space was not found after creating it.');
  return space;
}

/** The spaces this account can read. CL3 lists the personal space only; CL7 adds the org spaces a member can read. */
export async function listSpaces(db: Db, who: SyncPrincipal, resolve = userSpaceAccess): Promise<SyncSpace[]> {
  const space = await ensureUserSpace(db, who.userId);
  const access = resolve(space, who);
  return access ? [{ id: space.id, kind: 'user', access, epoch: space.epoch }] : [];
}

/**
 * A space and what `who` may do in it. Null both for an unknown id and for a space `resolve` denies, so callers answer
 * the same `404 not-found` and never reveal that another account's space exists.
 */
export async function findSpace(
  db: Db,
  spaceId: string,
  who: SyncPrincipal,
  resolve = userSpaceAccess,
): Promise<{ space: SpaceRow; access: SpaceAccess } | null> {
  if (!UUID_PATTERN.test(spaceId)) return null;
  const [space] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, spaceId));
  const access = space ? resolve(space, who) : null;
  return space && access ? { space, access } : null;
}

export interface ChangesQuery {
  epoch: string;
  /** The last seq the client has seen; 0 for a download from the start. */
  since: number;
  limit: number;
  /** The client is still paging through a download that began at `since = 0` (CL3-01). */
  snapshot: boolean;
}

/**
 * The changes after `since`, in seq order, a page at a time. The caller has checked access (`findSpace`). Throws
 * `SyncRefusal` `410 resync-required` when the cursor cannot be trusted, and `404 not-found` for an unknown space.
 *
 * The space's `seq` is read first and items are capped at it: pushes commit their items and the new `seq` together
 * (CL3-07), so a push that commits during the read is picked up by the next call, never skipped. Both reads share one
 * snapshot, so a tombstone cleanup (CL3-09) that commits between them cannot remove a tombstone the floor check
 * already let this client receive.
 */
export async function readChanges(db: Db, spaceId: string, q: ChangesQuery, now = Date.now()): Promise<SyncChangesResponse> {
  if (!UUID_PATTERN.test(spaceId)) throw new SyncRefusal('not-found', 404);
  return db.transaction(
    async (tx) => {
      const [space] = await tx.select().from(syncSpaces).where(eq(syncSpaces.id, spaceId));
      if (!space) throw new SyncRefusal('not-found', 404);
      if (q.epoch !== space.epoch) throw new SyncRefusal('resync-required', 410, 'epoch');
      // A cursor ahead of the server: the database went back in time.
      if (q.since > space.seq) throw new SyncRefusal('resync-required', 410, 'rewound');
      // The client may have missed a cleaned-up tombstone. A download from 0 holds no older state it could contradict.
      if (q.since > 0 && q.since < space.gcFloorSeq && !q.snapshot) throw new SyncRefusal('resync-required', 410, 'gc');

      // Tombstones are included from 0 too: a device starting over with local state must learn of deletions newer than
      // the floor, or it would push the deleted entry back, get `stale`, and do so on every run.
      const rows = await tx
        .select({
          collection: syncItems.collection,
          key: syncItems.key,
          value: syncItems.value,
          deleted: syncItems.deleted,
          hlc: syncItems.hlc,
          seq: syncItems.seq,
        })
        .from(syncItems)
        .where(
          and(
            eq(syncItems.spaceId, space.id),
            gt(syncItems.seq, q.since),
            lte(syncItems.seq, space.seq),
            or(isNull(syncItems.expiresAt), gt(syncItems.expiresAt, new Date(now))),
          ),
        )
        .orderBy(asc(syncItems.seq))
        .limit(q.limit + 1);

      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      return {
        v: 1,
        spaceId: space.id,
        epoch: space.epoch,
        cursor: more ? (page.at(-1)?.seq ?? space.seq) : space.seq,
        more,
        gcFloorHlc: space.gcFloorHlc,
        items: page.map(toChange),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** A stored item on the wire: the value only on live items. */
function toChange(row: {
  collection: string;
  key: string;
  value: unknown;
  deleted: boolean;
  hlc: string;
  seq: number;
}): SyncChange {
  const { collection, key, hlc, seq } = row;
  return row.deleted
    ? { collection, key, hlc, deleted: true, seq }
    : { collection, key, hlc, deleted: false, value: row.value as SyncValue, seq };
}
