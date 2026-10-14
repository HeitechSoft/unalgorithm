/**
 * Sync cleanup (R16, R14): tombstones older than `TOMBSTONE_TTL_DAYS` are deleted and raise their space's floor, so a
 * device whose cursor is older than a deleted tombstone is told `410 resync-required` (reason `gc`, `readChanges`).
 * Lapsed `ttl-cache` items and push records older than `PUSH_RECORD_TTL_MS` go too.
 *
 * It runs as the `sync.gc` task on the server's job registry (R7, CL2-03), so from CL3 on graphile-worker runs, and
 * creates its `graphile_worker` schema, on every server backed by Postgres, with a billing module or without one. On
 * PGlite the jobs do not start; tests call `collectSyncGarbage` directly.
 *
 * Its log line holds counts only: never a key, a value, a space id or a stamp.
 */
import { maxHlc, TOMBSTONE_TTL_DAYS } from '@unalgorithm/protocol';
import { and, eq, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { syncItems, syncPushes, syncSpaces } from '../db/schema.ts';
import type { JobRegistry } from '../jobs/worker.ts';

export const SYNC_GC_TASK = 'sync.gc';
/** Every 6 hours, at minute 17 (UTC). */
export const SYNC_GC_SCHEDULE = '17 */6 * * *';
/** How long a push's answer is kept for a retry. A retry after that is still harmless: its stamps come back `stale`. */
export const PUSH_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 86_400_000;
/** Spaces cleaned per round; rounds repeat until no space has anything left to clean. */
const SPACE_BATCH = 100;

/** What one cleanup deleted. */
export interface SyncGarbage {
  tombstones: number;
  /** Lapsed `ttl-cache` items. */
  expired: number;
  pushRecords: number;
}

/** Deletes old tombstones, lapsed items and old push records, space by space, keeping each space's counters exact. */
export async function collectSyncGarbage(db: Db, now = Date.now()): Promise<SyncGarbage> {
  const cutoff = new Date(now - TOMBSTONE_TTL_DAYS * DAY_MS);
  const at = new Date(now);
  // Tombstones past their days, and lapsed items (only `ttl-cache` items have an expiry, and they are never deleted).
  const garbage = sql`((${eq(syncItems.deleted, true)} and ${lt(syncItems.updatedAt, cutoff)}) or ${lte(syncItems.expiresAt, at)})`;

  const total: SyncGarbage = { tombstones: 0, expired: 0, pushRecords: 0 };
  for (;;) {
    const spaces = await db.selectDistinct({ id: syncItems.spaceId }).from(syncItems).where(garbage).limit(SPACE_BATCH);
    let deleted = 0;
    for (const { id } of spaces) {
      const cleaned = await cleanSpace(db, id, garbage);
      total.tombstones += cleaned.tombstones;
      total.expired += cleaned.expired;
      deleted += cleaned.tombstones + cleaned.expired;
    }
    // A round that deleted nothing would find the same spaces again.
    if (spaces.length < SPACE_BATCH || deleted === 0) break;
  }

  const pushes = await db
    .delete(syncPushes)
    .where(lt(syncPushes.createdAt, new Date(now - PUSH_RECORD_TTL_MS)))
    .returning({ id: syncPushes.pushId });
  total.pushRecords = pushes.length;
  return total;
}

/**
 * One space, in one transaction under the row lock pushes take (CL3-07). The floor moves to the highest seq and stamp
 * among the deleted tombstones (by `maxHlc`, never SQL `max()`, whose collation may order stamps otherwise); lapsed
 * items lower the counters but never move it. `item_count` counts live rows, so only lapsed items lower it.
 */
async function cleanSpace(db: Db, spaceId: string, garbage: SQL): Promise<Omit<SyncGarbage, 'pushRecords'>> {
  return db.transaction(async (tx) => {
    const [space] = await tx.select().from(syncSpaces).where(eq(syncSpaces.id, spaceId)).for('update');
    // Deleted meanwhile, its items with it.
    if (!space) return { tombstones: 0, expired: 0 };
    const rows = await tx
      .delete(syncItems)
      .where(and(eq(syncItems.spaceId, spaceId), garbage))
      .returning({ seq: syncItems.seq, hlc: syncItems.hlc, bytes: syncItems.bytes, deleted: syncItems.deleted });
    if (rows.length === 0) return { tombstones: 0, expired: 0 };

    let floorSeq = space.gcFloorSeq;
    let floorHlc = space.gcFloorHlc;
    let tombstones = 0;
    let bytes = 0;
    for (const row of rows) {
      bytes += row.bytes;
      if (!row.deleted) continue;
      tombstones += 1;
      floorSeq = Math.max(floorSeq, row.seq);
      floorHlc = maxHlc(floorHlc, row.hlc);
    }
    const expired = rows.length - tombstones;
    await tx
      .update(syncSpaces)
      .set({
        gcFloorSeq: floorSeq,
        gcFloorHlc: floorHlc,
        itemCount: space.itemCount - expired,
        bytesUsed: space.bytesUsed - bytes,
      })
      .where(eq(syncSpaces.id, spaceId));
    return { tombstones, expired };
  });
}

/** Registers the cleanup every 6 hours. Its payload is empty, and its log line holds the counts only. */
export function registerSyncJobs(jobs: JobRegistry, deps: { db: Db }): void {
  jobs.task(SYNC_GC_TASK, async (_payload, { log }) => {
    const counts = await collectSyncGarbage(deps.db);
    log.info('sync.gc', { tombstones: counts.tombstones, expired: counts.expired, push_records: counts.pushRecords });
  });
  jobs.cron(SYNC_GC_TASK, SYNC_GC_SCHEDULE);
}
