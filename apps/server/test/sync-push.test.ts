import { randomUUID } from 'node:crypto';
import {
  formatHlc,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_SPACE_MAX_BYTES,
  SYNC_SPACE_MAX_ITEMS,
  type SyncItem,
  type SyncPushRequest,
  SyncPushResponseSchema,
  type SyncPushResult,
  type SyncRejectReason,
} from '@unalgorithm/protocol';
import { createRegistry, defineCollection, SETTINGS_COLLECTION } from '@unalgorithm/sync';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { devices, syncItems, syncPushes, syncSpaces } from '../src/db/schema.ts';
import { applyPush, DEFAULT_PUSH_LIMITS, type PushOptions, type PushOutcome } from '../src/sync/push.ts';
import { ensureUserSpace, readChanges, type SpaceRow, type SyncPrincipal } from '../src/sync/spaces.ts';
import { createTestDb, queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { DEV_EXTENSION_ID } from './support/sign-in.ts';
import { ALICE, refusal, seedPeople } from './support/sync.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** The server's clock in every push. */
const NOW = Date.parse('2026-10-14T12:00:00Z');

/** Databases a test opened, closed (or dropped) after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Ctx {
  h: DbHandle;
  db: Db;
  who: SyncPrincipal;
  space: SpaceRow;
}

/** Alice, her device and her empty personal space, on a fresh PGlite database. */
async function aliceSpace(): Promise<Ctx> {
  const h = await createTestDb();
  cleanup.push(() => h.close());
  const { alice } = await seedPeople(h.db);
  return { h, db: h.db, who: alice, space: await ensureUserSpace(h.db, ALICE) };
}

/** A stamp `offsetMs` from `NOW`: in the past when negative. */
const at = (offsetMs: number) => formatHlc({ ms: NOW + offsetMs, counter: 0, device: 'alices-laptop' });

function live(key: string, value: unknown, hlc = at(-60_000), collection = SETTINGS_COLLECTION): SyncItem {
  return { collection, key, hlc, deleted: false, value } as SyncItem;
}

function tombstone(key: string, hlc = at(-30_000), collection = SETTINGS_COLLECTION): SyncItem {
  return { collection, key, hlc, deleted: true };
}

/** An interest entry's value (`TopicSchema`). */
const topic = (label: string) => ({ label, keywords: [], addedAt: 1 });

/** UTF-8 bytes of a value as JSON. */
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function pushRequest(space: Pick<SpaceRow, 'id' | 'epoch'>, items: SyncItem[], pushId: string = randomUUID()): SyncPushRequest {
  return { v: 1, spaceId: space.id, epoch: space.epoch, pushId, items };
}

interface PushArgs extends Omit<PushOptions, 'now'> {
  pushId?: string;
  epoch?: string;
}

/** Alice's push to her space at `NOW`. */
function push(ctx: Ctx, items: SyncItem[], { pushId, epoch, ...opts }: PushArgs = {}): Promise<PushOutcome> {
  const req = pushRequest({ id: ctx.space.id, epoch: epoch ?? ctx.space.epoch }, items, pushId);
  return applyPush(ctx.db, ctx.who, ctx.space.id, req, { ...opts, now: NOW });
}

const applied = (key: string, seq: number, collection = SETTINGS_COLLECTION): SyncPushResult => ({
  collection,
  key,
  status: 'applied',
  seq,
});
const stale = (key: string, collection = SETTINGS_COLLECTION): SyncPushResult => ({ collection, key, status: 'stale' });
const rejected = (key: string, reason: SyncRejectReason, collection = SETTINGS_COLLECTION): SyncPushResult => ({
  collection,
  key,
  status: 'rejected',
  reason,
});

/** The space's rows in seq order. */
const rows = (ctx: Ctx) => ctx.db.select().from(syncItems).where(eq(syncItems.spaceId, ctx.space.id)).orderBy(asc(syncItems.seq));

async function counters(ctx: Ctx) {
  const [row] = await ctx.db
    .select({ seq: syncSpaces.seq, itemCount: syncSpaces.itemCount, bytesUsed: syncSpaces.bytesUsed })
    .from(syncSpaces)
    .where(eq(syncSpaces.id, ctx.space.id));
  return row;
}

/** Everything a push can change: the space row, its items and the push records. */
async function state(ctx: Ctx) {
  return {
    space: await ctx.db.select().from(syncSpaces).where(eq(syncSpaces.id, ctx.space.id)),
    items: await rows(ctx),
    pushes: await ctx.db.select().from(syncPushes).orderBy(asc(syncPushes.pushId)),
  };
}

const QUOTA_EXCEEDED = { code: 'quota-exceeded', status: 413, reason: undefined };

describe('writes', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_push_applies_and_counts', async () => {
    const ctx = await aliceSpace();
    const pushId = randomUUID();
    const climate = topic('Climate');

    const out = await push(ctx, [live('display.mode', 'hide'), live('interests.more.climate', climate)], { pushId });

    expect(out).toStrictEqual<PushOutcome>({
      response: { v: 1, results: [applied('display.mode', 1), applied('interests.more.climate', 2)] },
      applied: 2,
      stale: 0,
      rejected: 0,
      replayed: false,
    });
    expect(SyncPushResponseSchema.parse(out.response)).toEqual(out.response);

    const base = { spaceId: ctx.space.id, collection: SETTINGS_COLLECTION, deleted: false, hlc: at(-60_000) };
    const more = { deviceId: ctx.who.deviceId, expiresAt: null, updatedAt: new Date(NOW) };
    const stored = await rows(ctx);
    expect(stored).toStrictEqual([
      { ...base, key: 'display.mode', value: 'hide', seq: 1, bytes: 'display.mode'.length + 6, ...more },
      {
        ...base,
        key: 'interests.more.climate',
        value: climate,
        seq: 2,
        bytes: 'interests.more.climate'.length + jsonBytes(climate),
        ...more,
      },
    ]);
    expect(await counters(ctx)).toEqual({ seq: 2, itemCount: 2, bytesUsed: stored.reduce((n, r) => n + r.bytes, 0) });

    expect(await ctx.db.select().from(syncPushes)).toStrictEqual([
      { spaceId: ctx.space.id, pushId, deviceId: ctx.who.deviceId, response: out.response, createdAt: new Date(NOW) },
    ]);

    // Items and the space's seq commit together, so a reader sees both.
    const changes = await readChanges(ctx.db, ctx.space.id, { epoch: ctx.space.epoch, since: 0, limit: 500, snapshot: false });
    expect(changes).toMatchObject({ cursor: 2, more: false });
    expect(changes.items.map((i) => [i.key, i.seq])).toEqual([
      ['display.mode', 1],
      ['interests.more.climate', 2],
    ]);
  });

  it('test_push_is_idempotent_by_push_id', async () => {
    const ctx = await aliceSpace();
    const pushId = randomUUID();
    const items = [live('display.mode', 'hide'), live('interests.more.climate', topic('Climate'))];
    const first = await push(ctx, items, { pushId });
    const before = await state(ctx);

    const again = await push(ctx, items, { pushId });
    expect(again).toStrictEqual<PushOutcome>({ response: first.response, applied: 0, stale: 0, rejected: 0, replayed: true });
    expect(await state(ctx)).toStrictEqual(before);

    // The recorded answer wins whatever the retry holds: nothing is decided again.
    const changed = await push(ctx, [live('display.mode', 'dim', at(-1_000))], { pushId });
    expect(changed).toMatchObject({ response: first.response, replayed: true });
    expect(await state(ctx)).toStrictEqual(before);

    // The same items under a new pushId: the server already holds these stamps.
    const fresh = await push(ctx, items);
    expect(fresh).toStrictEqual<PushOutcome>({
      response: { v: 1, results: [stale('display.mode'), stale('interests.more.climate')] },
      applied: 0,
      stale: 2,
      rejected: 0,
      replayed: false,
    });
    const after = await state(ctx);
    expect(after.space).toStrictEqual(before.space);
    expect(after.items).toStrictEqual(before.items);
    expect(after.pushes).toHaveLength(2);

    // A retry of a push that landed just before a new epoch still gets its answer.
    await ctx.db.update(syncSpaces).set({ epoch: randomUUID() }).where(eq(syncSpaces.id, ctx.space.id));
    expect(await push(ctx, items, { pushId })).toMatchObject({ response: first.response, replayed: true });
  });

  it('test_push_lww_per_key', async () => {
    const ctx = await aliceSpace();
    await push(ctx, [live('display.mode', 'hide', at(-60_000))]);

    const older = await push(ctx, [live('display.mode', 'dim', at(-120_000))]);
    expect(older).toMatchObject({ applied: 0, stale: 1 });
    expect(older.response.results).toStrictEqual([stale('display.mode')]);
    expect((await rows(ctx)).map((r) => [r.value, r.seq, r.hlc])).toEqual([['hide', 1, at(-60_000)]]);

    const newer = await push(ctx, [live('display.mode', 'collapse', at(-30_000))]);
    expect(newer.response.results).toStrictEqual([applied('display.mode', 2)]);
    expect((await rows(ctx)).map((r) => [r.value, r.seq, r.hlc])).toEqual([['collapse', 2, at(-30_000)]]);
    expect(await counters(ctx)).toEqual({ seq: 2, itemCount: 1, bytesUsed: 'display.mode'.length + jsonBytes('collapse') });
  });

  it('test_push_tombstones', async () => {
    const ctx = await aliceSpace();
    const key = 'interests.more.climate';
    await push(ctx, [live('display.mode', 'hide'), live(key, topic('Climate'))]);

    const out = await push(ctx, [tombstone(key, at(-30_000)), tombstone('display.mode', at(-30_000))]);
    expect(out.response.results).toStrictEqual([applied(key, 3), rejected('display.mode', 'invalid')]);
    expect((await rows(ctx)).map((r) => [r.key, r.deleted, r.value, r.seq, r.bytes])).toEqual([
      ['display.mode', false, 'hide', 1, 'display.mode'.length + jsonBytes('hide')],
      [key, true, null, 3, key.length],
    ]);
    // A tombstone keeps its key's bytes but frees its item slot.
    expect(await counters(ctx)).toEqual({
      seq: 3,
      itemCount: 1,
      bytesUsed: 'display.mode'.length + jsonBytes('hide') + key.length,
    });
    const changes = await readChanges(ctx.db, ctx.space.id, { epoch: ctx.space.epoch, since: 2, limit: 500, snapshot: false });
    expect(changes.items).toStrictEqual([{ collection: SETTINGS_COLLECTION, key, hlc: at(-30_000), deleted: true, seq: 3 }]);

    // An edit older than the deletion stays deleted; a newer one brings the entry back.
    expect((await push(ctx, [live(key, topic('Climate'), at(-45_000))])).response.results).toStrictEqual([stale(key)]);
    expect((await push(ctx, [live(key, topic('Weather'), at(-10_000))])).response.results).toStrictEqual([applied(key, 4)]);
    expect(await counters(ctx)).toMatchObject({ seq: 4, itemCount: 2 });
  });

  it('test_push_same_key_twice', async () => {
    const ctx = await aliceSpace();

    // Older first, newer second: both written, the newer value stays.
    const climbing = await push(ctx, [live('display.mode', 'dim', at(-120_000)), live('display.mode', 'hide', at(-60_000))]);
    expect(climbing.response.results).toStrictEqual([applied('display.mode', 1), applied('display.mode', 2)]);
    expect((await rows(ctx)).map((r) => [r.key, r.value, r.seq])).toEqual([['display.mode', 'hide', 2]]);
    expect(await counters(ctx)).toEqual({ seq: 2, itemCount: 1, bytesUsed: 'display.mode'.length + jsonBytes('hide') });

    // Newer first, older second: the second sees the first's result.
    const falling = await push(ctx, [live('display.forYou', 'label', at(-30_000)), live('display.forYou', 'off', at(-90_000))]);
    expect(falling.response.results).toStrictEqual([applied('display.forYou', 3), stale('display.forYou')]);
    expect((await rows(ctx)).map((r) => [r.key, r.value, r.seq])).toEqual([
      ['display.mode', 'hide', 2],
      ['display.forYou', 'label', 3],
    ]);
    expect(await counters(ctx)).toMatchObject({ seq: 3, itemCount: 2 });
  });

  it('test_push_follows_each_collections_strategy', async () => {
    const ctx = await aliceSpace();
    const ttlMs = 60_000;
    const otherDevice = randomUUID();
    const registry = createRegistry([
      defineCollection({ name: 'cache', strategy: 'ttl-cache', ttlMs, validate: () => true }),
      defineCollection({ name: 'device-state', strategy: 'per-device', validate: () => true }),
    ]);

    const out = await push(
      ctx,
      [
        live('k1', 1, at(-1_000), 'cache'),
        tombstone('k1', at(-500), 'cache'),
        live(ctx.who.deviceId, { on: true }, at(-1_000), 'device-state'),
        live(otherDevice, { on: true }, at(-1_000), 'device-state'),
        live('display.mode', 'hide'),
      ],
      { registry },
    );
    expect(out.response.results).toStrictEqual([
      applied('k1', 1, 'cache'),
      rejected('k1', 'invalid', 'cache'),
      applied(ctx.who.deviceId, 2, 'device-state'),
      rejected(otherDevice, 'not-own-device', 'device-state'),
      rejected('display.mode', 'unknown-collection'),
    ]);
    expect((await rows(ctx)).map((r) => [r.collection, r.expiresAt])).toEqual([
      ['cache', new Date(NOW + ttlMs)],
      ['device-state', null],
    ]);
  });
});

/** One item the server refuses while the items around it in the same push apply. */
const REJECTIONS: { name: string; item: SyncItem; reason: SyncRejectReason }[] = [
  {
    name: 'a collection the server does not sync',
    item: live('topics.ai', true, at(-60_000), 'learned'),
    reason: 'unknown-collection',
  },
  { name: 'a non-canonical key', item: live('interests.more.X.label', 'AI'), reason: 'invalid' },
  { name: 'a value its setting refuses', item: live('display.mode', 'shout'), reason: 'invalid' },
  {
    name: 'a provider key in an interest',
    item: live('interests.about', `my key is sk-ant-api03-${'A'.repeat(20)}`),
    reason: 'credential',
  },
  { name: 'a provider key as a field name', item: live(`display.gsk_${'A'.repeat(52)}`, true), reason: 'credential' },
  { name: 'a stamp 11 minutes ahead', item: live('display.tips', false, at(11 * 60_000)), reason: 'clock-ahead' },
];

describe('guards', { timeout: PGLITE_TIMEOUT }, () => {
  it.each(REJECTIONS)('test_push_rejections_per_item: $name', async ({ item, reason }) => {
    const ctx = await aliceSpace();
    const out = await push(ctx, [live('display.showReason', false), item, live('display.groupRuns', false)]);
    expect(out.response.results).toStrictEqual([
      applied('display.showReason', 1),
      rejected(item.key, reason, item.collection),
      applied('display.groupRuns', 2),
    ]);
    expect(out).toMatchObject({ applied: 2, stale: 0, rejected: 1, replayed: false });
    expect((await rows(ctx)).map((r) => r.key)).toEqual(['display.showReason', 'display.groupRuns']);
    expect(await counters(ctx)).toMatchObject({ seq: 2, itemCount: 2 });
  });

  it('test_push_guard_order_and_edges', async () => {
    const ctx = await aliceSpace();
    const key = `sk-ant-api03-${'A'.repeat(20)}`;
    const out = await push(ctx, [
      // The first failing check decides.
      live('topics.ai', key, at(-60_000), 'learned'),
      live('display.mode', key),
      live('interests.about', key, at(11 * 60_000)),
      // Tombstones are checked by their key too.
      tombstone(`display.gsk_${'A'.repeat(52)}`),
      // Exactly the allowed lead is accepted.
      live('display.tips', false, at(SYNC_MAX_HLC_AHEAD_MS)),
      live('display.badgeCount', false, at(SYNC_MAX_HLC_AHEAD_MS + 1)),
    ]);
    expect(out.response.results).toStrictEqual([
      rejected('topics.ai', 'unknown-collection', 'learned'),
      rejected('display.mode', 'invalid'),
      rejected('interests.about', 'credential'),
      rejected(`display.gsk_${'A'.repeat(52)}`, 'credential'),
      applied('display.tips', 1),
      rejected('display.badgeCount', 'clock-ahead'),
    ]);
  });

  it('test_push_quota_items', async () => {
    const ctx = await aliceSpace();
    const limits = { maxItems: 3, maxBytes: SYNC_SPACE_MAX_BYTES };
    await push(ctx, [live('interests.more.a', topic('A')), live('interests.more.b', topic('B'))], { limits });
    const before = await state(ctx);

    const tooMany = push(ctx, [live('interests.more.c', topic('C')), live('interests.more.d', topic('D'))], { limits });
    expect(await refusal(tooMany)).toEqual(QUOTA_EXCEEDED);
    // Nothing written: no item, no counter, no push record.
    expect(await state(ctx)).toStrictEqual(before);

    // Deleting always goes through.
    const out = await push(ctx, [tombstone('interests.more.a'), tombstone('interests.more.b')], { limits });
    expect(out.response.results).toStrictEqual([applied('interests.more.a', 3), applied('interests.more.b', 4)]);
    expect(await counters(ctx)).toMatchObject({ seq: 4, itemCount: 0 });

    // Without `limits`, a push is held to the protocol's limits.
    expect(DEFAULT_PUSH_LIMITS).toEqual({ maxItems: SYNC_SPACE_MAX_ITEMS, maxBytes: SYNC_SPACE_MAX_BYTES });
    const full = async (set: { itemCount?: number; bytesUsed?: number }) => {
      await ctx.db.update(syncSpaces).set(set).where(eq(syncSpaces.id, ctx.space.id));
      return push(ctx, [live('interests.more.e', topic('E'))]);
    };
    expect(await refusal(full({ itemCount: SYNC_SPACE_MAX_ITEMS }))).toEqual(QUOTA_EXCEEDED);
    expect(await refusal(full({ itemCount: 0, bytesUsed: SYNC_SPACE_MAX_BYTES }))).toEqual(QUOTA_EXCEEDED);
    expect(await full({ itemCount: SYNC_SPACE_MAX_ITEMS - 1, bytesUsed: 0 })).toMatchObject({ applied: 1 });
  });

  it('test_push_quota_counts_live_items_only', async () => {
    const ctx = await aliceSpace();
    const limits = { maxItems: 3, maxBytes: SYNC_SPACE_MAX_BYTES };
    const keys = ['interests.more.a', 'interests.more.b', 'interests.more.c'];
    await push(
      ctx,
      keys.map((k) => live(k, topic(k))),
      { limits },
    );
    expect(await counters(ctx)).toMatchObject({ itemCount: 3 });

    const deleted = await push(ctx, [tombstone('interests.more.a'), tombstone('interests.more.b')], { limits });
    expect(deleted).toMatchObject({ applied: 2 });
    expect(await counters(ctx)).toMatchObject({ seq: 5, itemCount: 1 });

    const added = await push(ctx, [live('interests.more.d', topic('D'))], { limits });
    expect(added.response.results).toStrictEqual([applied('interests.more.d', 6)]);
    const before = await counters(ctx);
    expect(before).toMatchObject({ seq: 6, itemCount: 2 });

    // A tombstone for a key the space never held: no item, only its key's bytes.
    const ghost = 'interests.more.never';
    expect((await push(ctx, [tombstone(ghost)], { limits })).response.results).toStrictEqual([applied(ghost, 7)]);
    expect(await counters(ctx)).toEqual({ seq: 7, itemCount: 2, bytesUsed: (before?.bytesUsed ?? 0) + ghost.length });
  });

  it('test_push_quota_bytes', async () => {
    const ctx = await aliceSpace();
    const climate = topic('Climate');
    const items = [live('display.mode', 'hide'), live('interests.more.climate', climate)];
    const added = 'display.mode'.length + jsonBytes('hide') + 'interests.more.climate'.length + jsonBytes(climate);
    const before = await state(ctx);

    const over = push(ctx, items, { limits: { maxItems: SYNC_SPACE_MAX_ITEMS, maxBytes: added - 1 } });
    expect(await refusal(over)).toEqual(QUOTA_EXCEEDED);
    expect(await state(ctx)).toStrictEqual(before);

    const exact = await push(ctx, items, { limits: { maxItems: SYNC_SPACE_MAX_ITEMS, maxBytes: added } });
    expect(exact).toMatchObject({ applied: 2 });
    expect(await counters(ctx)).toMatchObject({ bytesUsed: added });

    // A smaller value goes through even under a limit the space is already over.
    const smaller = await push(ctx, [live('interests.more.climate', topic('C'), at(-30_000))], {
      limits: { maxItems: SYNC_SPACE_MAX_ITEMS, maxBytes: 10 },
    });
    expect(smaller).toMatchObject({ applied: 1 });
    expect(await counters(ctx)).toMatchObject({ bytesUsed: added - (jsonBytes(climate) - jsonBytes(topic('C'))) });
  });

  it('test_push_refusals_epoch_and_space', async () => {
    const ctx = await aliceSpace();
    await push(ctx, [live('display.mode', 'hide')]);
    const before = await state(ctx);
    const items = [live('display.mode', 'dim', at(-1_000))];

    expect(await refusal(push(ctx, items, { epoch: randomUUID() }))).toEqual({
      code: 'resync-required',
      status: 410,
      reason: 'epoch',
    });
    const notFound = { code: 'not-found', status: 404, reason: undefined };
    expect(await refusal(push({ ...ctx, space: { ...ctx.space, id: randomUUID() } }, items))).toEqual(notFound);
    const req = pushRequest(ctx.space, items);
    expect(await refusal(applyPush(ctx.db, ctx.who, 'not-a-space-id', req, { now: NOW }))).toEqual(notFound);
    expect(await state(ctx)).toStrictEqual(before);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_push_record_holds_no_values', async () => {
    const ctx = await aliceSpace();
    const MARKER = 'UA-SYNC-VALUE-5d2e9f';
    const items = [
      live('interests.about', `remember ${MARKER}`),
      live('interests.more.climate', { label: MARKER, keywords: [MARKER], addedAt: 1 }),
      live('interests.more.x.label', MARKER),
      live('display.newField', MARKER, at(11 * 60_000)),
      live('interests.highlightWords.w1', { label: `${MARKER} sk-ant-api03-${'A'.repeat(20)}`, addedAt: 1 }),
    ];
    const first = await push(ctx, items);
    expect(first).toMatchObject({ applied: 2, rejected: 3 });
    expect(await push(ctx, items)).toMatchObject({ stale: 2, rejected: 3 });

    const records = await queryRows(ctx.h, sql`select response::text as text from sync_pushes`);
    expect(records).toHaveLength(2);
    for (const record of records) expect(String(record.text)).not.toContain(MARKER);
    // The same search finds the marker where values belong.
    const values = await queryRows(ctx.h, sql`select value::text as text from sync_items`);
    expect(values.filter((v) => String(v.text).includes(MARKER))).toHaveLength(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_concurrent_pushes_get_distinct_seqs', async () => {
    const pg = await createPostgresTestDb('ua_push');
    cleanup.push(() => pg.drop());
    const handle = openPostgres(pg.url);
    cleanup.push(() => handle.close());
    await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
    const { db } = handle;
    const { alice } = await seedPeople(db);
    const [phone] = await db.insert(devices).values({ userId: ALICE, clientId: DEV_EXTENSION_ID }).returning();
    if (!phone) throw new Error('The second device was not inserted.');
    const space = await ensureUserSpace(db, ALICE);
    const entries = (device: string) =>
      Array.from({ length: 50 }, (_, i) => live(`interests.more.${device}-${i}`, topic(`${device} ${i}`)));

    const outcomes = await Promise.all([
      applyPush(db, alice, space.id, pushRequest(space, entries('laptop')), { now: NOW }),
      applyPush(db, { userId: ALICE, deviceId: phone.id }, space.id, pushRequest(space, entries('phone')), { now: NOW }),
    ]);

    for (const outcome of outcomes) expect(outcome).toMatchObject({ applied: 50, stale: 0, rejected: 0 });
    const seqs = await db
      .select({ seq: syncItems.seq })
      .from(syncItems)
      .where(eq(syncItems.spaceId, space.id))
      .orderBy(asc(syncItems.seq));
    expect(seqs.map((r) => r.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    // The row lock ran the two one after the other: each push holds one unbroken run of seqs.
    for (const { response } of outcomes) {
      const own = response.results.map((r) => (r.status === 'applied' ? r.seq : 0));
      expect(own).toEqual(Array.from({ length: 50 }, (_, i) => (own[0] ?? 0) + i));
    }
    const [row] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, space.id));
    expect(row).toMatchObject({ seq: 100, itemCount: 100 });
  });
});
