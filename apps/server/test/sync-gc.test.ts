import { randomUUID } from 'node:crypto';
import {
  compareHlc,
  formatHlc,
  SYNC_CHANGES_PATH,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  SyncChangesResponseSchema,
  type SyncItem,
  SyncSpacesResponseSchema,
} from '@unalgorithm/protocol';
import { SETTINGS_COLLECTION } from '@unalgorithm/sync';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main as newEpoch } from '../src/cli/sync-new-epoch.ts';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { syncItems, syncPushes, syncSpaces } from '../src/db/schema.ts';
import { createJobRegistry, type JobHandler, type JobRegistry, startJobs } from '../src/jobs/worker.ts';
import { collectSyncGarbage, PUSH_RECORD_TTL_MS, registerSyncJobs, SYNC_GC_SCHEDULE, SYNC_GC_TASK } from '../src/sync/gc.ts';
import { applyPush } from '../src/sync/push.ts';
import { ensureUserSpace, readChanges, type SpaceRow, type SyncPrincipal } from '../src/sync/spaces.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { postJson, signInDevice } from './support/sign-in.ts';
import { ALICE, BOB, refusal, seedPeople } from './support/sync.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** The clock of every push and cleanup below, except where a route or a job reads the real one. */
const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Ctx {
  db: Db;
  who: SyncPrincipal;
  space: SpaceRow;
}

/** Alice, her device and her empty personal space, on `h` (a fresh PGlite database by default). */
async function aliceSpace(h?: DbHandle): Promise<Ctx & { bob: SyncPrincipal }> {
  const handle = h ?? (await createTestDb());
  if (!h) cleanup.push(() => handle.close());
  const { alice, bob } = await seedPeople(handle.db);
  return { db: handle.db, who: alice, bob, space: await ensureUserSpace(handle.db, ALICE) };
}

/** A stamp `offsetMs` from `base`: in the past when negative. */
const at = (offsetMs: number, base = NOW) => formatHlc({ ms: base + offsetMs, counter: 0, device: 'alices-laptop' });

const live = (key: string, label: string, hlc: string): SyncItem =>
  ({ collection: SETTINGS_COLLECTION, key, hlc, deleted: false, value: { label, keywords: [], addedAt: 1 } }) as SyncItem;
const tombstone = (key: string, hlc: string): SyncItem => ({ collection: SETTINGS_COLLECTION, key, hlc, deleted: true });

/** Alice's push at `now`; every item must apply. */
async function push(ctx: Ctx, items: SyncItem[], now = NOW): Promise<void> {
  const req = { v: 1 as const, spaceId: ctx.space.id, epoch: ctx.space.epoch, pushId: randomUUID(), items };
  const out = await applyPush(ctx.db, ctx.who, ctx.space.id, req, { now });
  expect(out.applied).toBe(items.length);
}

/** Moves a key's `updated_at` to `days` before `now`. */
async function age(db: Db, key: string, days: number, now = NOW): Promise<void> {
  await db
    .update(syncItems)
    .set({ updatedAt: new Date(now - days * DAY_MS) })
    .where(eq(syncItems.key, key));
}

async function space(db: Db, id: string): Promise<SpaceRow> {
  const [row] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, id));
  if (!row) throw new Error('No space.');
  return row;
}

const items = (db: Db) =>
  db
    .select({ key: syncItems.key, seq: syncItems.seq, deleted: syncItems.deleted, bytes: syncItems.bytes })
    .from(syncItems)
    .orderBy(asc(syncItems.seq));

const bytesOf = async (db: Db, keys: string[]) =>
  (await db.select({ bytes: syncItems.bytes }).from(syncItems).where(inArray(syncItems.key, keys))).reduce(
    (n, r) => n + r.bytes,
    0,
  );

const H4 = at(-40_000);
const H5 = at(-45_000);
const H7 = at(-30_000);

/**
 * Seqs 1-3 live `a`, `b`, `c`; then tombstones `a` (seq 4, H4) and `b` (seq 5, H5), live `d` (seq 6) and tombstone `c`
 * (seq 7, H7). `a` and `c` are 91 days old, `b` 30 days and `d` 200 days.
 */
async function sevenSeqs(ctx: Ctx, now = NOW): Promise<void> {
  const old = at(-60_000, now);
  await push(
    ctx,
    [live('interests.more.a', 'A', old), live('interests.more.b', 'B', old), live('interests.more.c', 'C', old)],
    now,
  );
  await push(
    ctx,
    [
      tombstone('interests.more.a', at(-40_000, now)),
      tombstone('interests.more.b', at(-45_000, now)),
      live('interests.more.d', 'D', old),
      tombstone('interests.more.c', at(-30_000, now)),
    ],
    now,
  );
  await age(ctx.db, 'interests.more.a', 91, now);
  await age(ctx.db, 'interests.more.c', 91, now);
  await age(ctx.db, 'interests.more.b', 30, now);
  await age(ctx.db, 'interests.more.d', 200, now);
}

describe('cleanup', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_gc_removes_tombstones_after_90_days', async () => {
    const ctx = await aliceSpace();
    const old = at(-60_000);
    await push(ctx, [live('interests.more.a', 'A', old), live('interests.more.b', 'B', old), live('interests.more.c', 'C', old)]);
    await push(ctx, [tombstone('interests.more.a', at(-30_000)), tombstone('interests.more.b', at(-30_000))]);
    await age(ctx.db, 'interests.more.a', 91);
    await age(ctx.db, 'interests.more.b', 89);
    // Live items of any age stay.
    await age(ctx.db, 'interests.more.c', 400);

    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 1, expired: 0, pushRecords: 0 });
    expect((await items(ctx.db)).map((r) => [r.key, r.deleted])).toEqual([
      ['interests.more.c', false],
      ['interests.more.b', true],
    ]);
  });

  it('test_gc_raises_floor_with_max_hlc', async () => {
    const ctx = await aliceSpace();
    await sevenSeqs(ctx);
    expect(compareHlc(H4, H7)).toBeLessThan(0);
    expect(compareHlc(H5, H7)).toBeLessThan(0);
    const before = await space(ctx.db, ctx.space.id);
    const gone = await bytesOf(ctx.db, ['interests.more.a', 'interests.more.c']);

    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 2, expired: 0, pushRecords: 0 });
    const after = await space(ctx.db, ctx.space.id);
    expect(after).toMatchObject({
      gcFloorSeq: 7,
      gcFloorHlc: H7,
      bytesUsed: before.bytesUsed - gone,
      // Tombstones were never counted as items.
      itemCount: before.itemCount,
      seq: 7,
    });
    expect(after.itemCount).toBe(1);

    // A later cleanup of an older tombstone leaves the floor where it is.
    const b = await bytesOf(ctx.db, ['interests.more.b']);
    await age(ctx.db, 'interests.more.b', 91);
    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 1, expired: 0, pushRecords: 0 });
    expect(await space(ctx.db, ctx.space.id)).toMatchObject({
      gcFloorSeq: 7,
      gcFloorHlc: H7,
      bytesUsed: after.bytesUsed - b,
      itemCount: 1,
    });
  });

  it('test_gc_floor_answers_410', async () => {
    const TOM = 'tom@example.com';
    const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }) });
    cleanup.push(t.close);
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    const listed = SyncSpacesResponseSchema.parse(await (await t.app.request(SYNC_SPACES_PATH, { headers: auth })).json());
    const s = listed.spaces[0];
    if (!s) throw new Error('No space.');

    // The route stamps with the real clock, so the pushes and the cleanup do too.
    const now = Date.now();
    const routePush = async (pushed: SyncItem[]) => {
      const res = await postJson(
        t.app,
        SYNC_PUSH_PATH,
        { v: 1, spaceId: s.id, epoch: s.epoch, pushId: randomUUID(), items: pushed },
        auth,
      );
      expect(res.status).toBe(200);
    };
    const old = at(-60_000, now);
    await routePush([live('interests.more.a', 'A', old), live('interests.more.b', 'B', old), live('interests.more.c', 'C', old)]);
    await routePush([
      tombstone('interests.more.a', at(-40_000, now)),
      tombstone('interests.more.b', at(-45_000, now)),
      live('interests.more.d', 'D', old),
      tombstone('interests.more.c', at(-30_000, now)),
    ]);
    const db = t.deps.db.db;
    await age(db, 'interests.more.a', 91, now);
    await age(db, 'interests.more.c', 91, now);
    await age(db, 'interests.more.b', 30, now);
    expect(await collectSyncGarbage(db, now)).toMatchObject({ tombstones: 2 });

    const changes = (since: number) =>
      Promise.resolve(
        t.app.request(`${SYNC_CHANGES_PATH}?${new URLSearchParams({ spaceId: s.id, epoch: s.epoch, since: String(since) })}`, {
          headers: auth,
        }),
      );
    const behind = await changes(5);
    expect(behind.status).toBe(410);
    expect(await behind.json()).toMatchObject({ code: 'resync-required' });
    expect(t.events().filter((e) => e.event === 'sync.resync')).toEqual([
      expect.objectContaining({ rid: behind.headers.get('x-request-id'), reason: 'gc' }),
    ]);

    const current = await changes(7);
    expect(current.status).toBe(200);
    expect(SyncChangesResponseSchema.parse(await current.json())).toMatchObject({ cursor: 7, items: [] });

    // From 0: the live items and the tombstone not yet cleaned up.
    const fresh = await changes(0);
    expect(fresh.status).toBe(200);
    const body = SyncChangesResponseSchema.parse(await fresh.json());
    expect(body.items.map((i) => [i.key, i.deleted, i.seq])).toEqual([
      ['interests.more.b', true, 5],
      ['interests.more.d', false, 6],
    ]);
    expect(body.gcFloorHlc).toBe(at(-30_000, now));
  });

  it('test_gc_expires_ttl_items_without_floor', async () => {
    const ctx = await aliceSpace();
    await push(ctx, [live('interests.more.a', 'A', at(-60_000))]);
    // Two ttl-cache items, inserted directly with the space's counters raised to match.
    const cached = (key: string, seq: number, expiresAt: number) => ({
      spaceId: ctx.space.id,
      collection: 'cache',
      key,
      value: { n: seq },
      deleted: false,
      hlc: at(-10_000),
      deviceId: ctx.who.deviceId,
      seq,
      bytes: key.length + 7,
      expiresAt: new Date(expiresAt),
      updatedAt: new Date(NOW - DAY_MS),
    });
    await ctx.db.insert(syncItems).values([cached('lapsed', 2, NOW - 1), cached('fresh', 3, NOW + 60_000)]);
    const s1 = await space(ctx.db, ctx.space.id);
    await ctx.db
      .update(syncSpaces)
      .set({ seq: 3, itemCount: s1.itemCount + 2, bytesUsed: s1.bytesUsed + 'lapsed'.length + 7 + 'fresh'.length + 7 })
      .where(eq(syncSpaces.id, ctx.space.id));
    const before = await space(ctx.db, ctx.space.id);

    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 0, expired: 1, pushRecords: 0 });
    expect(await space(ctx.db, ctx.space.id)).toMatchObject({
      itemCount: before.itemCount - 1,
      bytesUsed: before.bytesUsed - ('lapsed'.length + 7),
      gcFloorSeq: 0,
      gcFloorHlc: before.gcFloorHlc,
    });
    expect((await items(ctx.db)).map((r) => r.key)).toEqual(['interests.more.a', 'fresh']);
  });

  it('test_gc_drops_old_push_records', async () => {
    const ctx = await aliceSpace();
    await push(ctx, [live('interests.more.a', 'A', at(-60_000))]);
    await push(ctx, [live('interests.more.b', 'B', at(-60_000))]);
    await push(ctx, [live('interests.more.c', 'C', at(-60_000))]);
    const ids = (await ctx.db.select({ id: syncPushes.pushId }).from(syncPushes)).map((r) => r.id);
    const [old, recent, kept] = ids;
    if (!old || !recent || !kept) throw new Error('Three pushes were recorded.');
    const setAge = (id: string, ms: number) =>
      ctx.db
        .update(syncPushes)
        .set({ createdAt: new Date(NOW - ms) })
        .where(eq(syncPushes.pushId, id));
    await setAge(old, PUSH_RECORD_TTL_MS + HOUR_MS);
    await setAge(recent, PUSH_RECORD_TTL_MS - HOUR_MS);

    expect(PUSH_RECORD_TTL_MS).toBe(24 * HOUR_MS);
    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 0, expired: 0, pushRecords: 1 });
    expect((await ctx.db.select({ id: syncPushes.pushId }).from(syncPushes)).map((r) => r.id).sort()).toEqual(
      [recent, kept].sort(),
    );
  });

  it('test_gc_counts', async () => {
    const ctx = await aliceSpace();
    await sevenSeqs(ctx);
    await age(ctx.db, 'interests.more.a', 10);
    await age(ctx.db, 'interests.more.c', 10);
    const snapshot = async () => ({
      spaces: await ctx.db.select().from(syncSpaces),
      items: await ctx.db.select().from(syncItems).orderBy(asc(syncItems.seq)),
      pushes: await ctx.db.select().from(syncPushes).orderBy(asc(syncPushes.createdAt)),
    });
    const before = await snapshot();

    // Nothing old enough: zeros, and no row changes.
    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 0, expired: 0, pushRecords: 0 });
    expect(await snapshot()).toEqual(before);

    // One of each, and Bob's space cleaned in the same run.
    const bobSpace = await ensureUserSpace(ctx.db, BOB);
    const bob = { db: ctx.db, who: ctx.bob, space: bobSpace };
    await push(bob, [live('interests.more.z', 'Z', at(-60_000))]);
    await push(bob, [tombstone('interests.more.z', at(-30_000))]);
    await age(ctx.db, 'interests.more.z', 100);
    await age(ctx.db, 'interests.more.a', 91);
    await ctx.db
      .update(syncPushes)
      .set({ createdAt: new Date(NOW - 2 * DAY_MS) })
      .where(eq(syncPushes.spaceId, bobSpace.id));
    expect(await collectSyncGarbage(ctx.db, NOW)).toEqual({ tombstones: 2, expired: 0, pushRecords: 2 });
    expect(await space(ctx.db, bobSpace.id)).toMatchObject({ gcFloorSeq: 2, bytesUsed: 0, itemCount: 0 });
    expect(await space(ctx.db, ctx.space.id)).toMatchObject({ gcFloorSeq: 4, gcFloorHlc: H4 });
  });
});

describe('scheduling', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_register_sync_jobs', async () => {
    const ctx = await aliceSpace();
    const tasks = new Map<string, JobHandler>();
    const schedules: [string, string][] = [];
    const recording: JobRegistry = {
      task: (name, handler) => tasks.set(name, handler),
      cron: (task, match) => schedules.push([task, match]),
    };
    registerSyncJobs(recording, { db: ctx.db });
    expect([...tasks.keys()]).toEqual(['sync.gc']);
    expect(schedules).toEqual([['sync.gc', '17 */6 * * *']]);
    expect([SYNC_GC_TASK, SYNC_GC_SCHEDULE]).toEqual(['sync.gc', '17 */6 * * *']);

    const jobs = createJobRegistry();
    registerSyncJobs(jobs, { db: ctx.db });
    expect(() => registerSyncJobs(jobs, { db: ctx.db })).toThrow(TypeError);
  });

  describe.skipIf(!TEST_DATABASE_URL)('postgres', () => {
    it('test_sync_gc_job_runs_on_postgres', async () => {
      const pg = await createPostgresTestDb('ua_gc');
      cleanup.push(() => pg.drop());
      const handle = openPostgres(pg.url);
      cleanup.push(() => handle.close());
      const { log, events } = captureLog();
      await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log });
      const ctx = await aliceSpace(handle);
      // The job cleans up by the real clock.
      const now = Date.now();
      await push(ctx, [live('interests.more.a', 'A', at(-60_000, now))], now);
      await push(ctx, [tombstone('interests.more.a', at(-30_000, now))], now);
      await age(ctx.db, 'interests.more.a', 91, now);

      const jobs = createJobRegistry();
      registerSyncJobs(jobs, { db: handle.db });
      const running = await startJobs(handle, jobs, log);
      cleanup.push(() => running.stop());
      await running.addJob(SYNC_GC_TASK, {});
      await vi.waitFor(() => expect(events().filter((e) => e.event === 'sync.gc' && e.tombstones === 1)).toHaveLength(1), {
        timeout: 5_000,
        interval: 20,
      });
      expect(await items(ctx.db)).toEqual([]);
      expect(events().find((e) => e.event === 'sync.gc')).toMatchObject({ task: 'sync.gc', expired: 0 });
    });
  });
});

describe('epoch command', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sync_new_epoch_forces_resync', async () => {
    const h = await createTestDb();
    cleanup.push(() => h.close());
    const ctx = await aliceSpace(h);
    const bobSpace = await ensureUserSpace(h.db, BOB);
    await push(ctx, [live('interests.more.a', 'A', at(-60_000))]);
    const lines: string[] = [];
    const deps = { db: h, config: testConfig(), out: (line: string) => lines.push(line) };

    expect(await newEpoch(['--all'], deps)).toBe(1);
    expect(lines).toEqual([expect.stringMatching(/^usage: /)]);
    expect((await space(h.db, ctx.space.id)).epoch).toBe(ctx.space.epoch);

    lines.length = 0;
    expect(await newEpoch([], deps)).toBe(0);
    expect(lines).toEqual(["new sync epoch for 2 spaces: every device starts its sync again from this server's copy"]);
    const alice = await space(h.db, ctx.space.id);
    expect(alice.epoch).not.toBe(ctx.space.epoch);
    expect((await space(h.db, bobSpace.id)).epoch).not.toBe(bobSpace.epoch);
    // Nothing else changes.
    expect(alice).toMatchObject({ seq: 1, itemCount: 1 });

    const q = { since: 1, limit: 500, snapshot: false };
    expect(await refusal(readChanges(h.db, ctx.space.id, { ...q, epoch: ctx.space.epoch }, NOW))).toEqual({
      code: 'resync-required',
      status: 410,
      reason: 'epoch',
    });
    await expect(readChanges(h.db, ctx.space.id, { ...q, epoch: alice.epoch }, NOW)).resolves.toMatchObject({ cursor: 1 });
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_gc_logs_hold_no_content', async () => {
    const ctx = await aliceSpace();
    // The job reads the real clock.
    const now = Date.now();
    await sevenSeqs(ctx, now);
    const tasks = new Map<string, JobHandler>();
    registerSyncJobs({ task: (name, handler) => tasks.set(name, handler), cron: () => {} }, { db: ctx.db });
    const { log, lines, events } = captureLog();
    await tasks.get(SYNC_GC_TASK)?.({}, { signal: new AbortController().signal, log });

    expect(events()).toEqual([
      { t: expect.any(String), level: 'info', event: 'sync.gc', tombstones: 2, expired: 0, push_records: 0 },
    ]);
    const text = lines.join('');
    for (const secret of [ctx.space.id, 'interests.more', '"A"', at(-30_000, now), at(-40_000, now), ALICE])
      expect(text).not.toContain(secret);
  });
});
