import { randomUUID } from 'node:crypto';
import {
  formatHlc,
  HLC_ZERO,
  type SyncChange,
  SyncChangesResponseSchema,
  type SyncSpace,
  SyncSpacesResponseSchema,
} from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { devices, syncItems, syncPushes, syncSpaces, user } from '../src/db/schema.ts';
import {
  type AccessResolver,
  ensureUserSpace,
  findSpace,
  listSpaces,
  readChanges,
  type SpaceRow,
  type SyncPrincipal,
  SyncRefusal,
} from '../src/sync/spaces.ts';
import { createTestDb, queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { DEV_EXTENSION_ID } from './support/sign-in.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

const ALICE = 'alice-user-id';
const BOB = 'bob-user-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The clock `readChanges` compares `expires_at` against. */
const NOW = Date.parse('2026-10-14T12:00:00Z');

/** Databases a test opened, closed (or dropped) after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<DbHandle> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle;
}

/** A migrated database of its own on the Postgres server `TEST_DATABASE_URL` points at, dropped after the test. */
async function postgresDb(): Promise<Db> {
  const pg = await createPostgresTestDb('ua_sync');
  cleanup.push(() => pg.drop());
  const handle = openPostgres(pg.url);
  cleanup.push(() => handle.close());
  await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
  return handle.db;
}

interface People {
  alice: SyncPrincipal;
  bob: SyncPrincipal;
}

/** Two accounts with a device each, inserted directly (sign-in is not under test here). */
async function seedPeople(db: Db): Promise<People> {
  const now = new Date();
  await db
    .insert(user)
    .values([ALICE, BOB].map((id) => ({ id, name: '', email: `${id}@example.com`, createdAt: now, updatedAt: now })));
  const [a, b] = await db
    .insert(devices)
    .values([
      { userId: ALICE, clientId: DEV_EXTENSION_ID },
      { userId: BOB, clientId: DEV_EXTENSION_ID },
    ])
    .returning();
  if (!a || !b) throw new Error('The devices were not inserted.');
  return { alice: { userId: ALICE, deviceId: a.id }, bob: { userId: BOB, deviceId: b.id } };
}

/** One stored item: live unless `deleted`; `expiresAt` only for `ttl-cache` items. */
interface Stored {
  seq: number;
  deleted?: boolean;
  expiresAt?: Date;
}

const keyOf = (seq: number) => `display.k${seq}`;
const itemValue = (seq: number) => ({ on: seq % 2 === 0, n: seq });
const hlcOf = (seq: number, deviceId: string) => formatHlc({ ms: NOW - 60_000 + seq, counter: 0, device: deviceId });

/**
 * Writes items straight into a space (pushes arrive in CL3-07). The space's `seq` is raised to the highest stored seq
 * unless `bumpSeq` is false, which simulates a row committed after `readChanges` read the space.
 */
async function store(db: Db, space: SpaceRow, deviceId: string, items: Stored[], bumpSeq = true): Promise<void> {
  await db.insert(syncItems).values(
    items.map(({ seq, deleted = false, expiresAt }) => ({
      spaceId: space.id,
      collection: 'settings',
      key: keyOf(seq),
      value: deleted ? null : itemValue(seq),
      deleted,
      hlc: hlcOf(seq, deviceId),
      deviceId,
      seq,
      bytes: keyOf(seq).length + (deleted ? 0 : JSON.stringify(itemValue(seq)).length),
      expiresAt: expiresAt ?? null,
    })),
  );
  if (bumpSeq) {
    await db
      .update(syncSpaces)
      .set({ seq: Math.max(...items.map((i) => i.seq)) })
      .where(eq(syncSpaces.id, space.id));
  }
}

/** The change `readChanges` answers for an item `store` wrote: a value only on live items. */
function change(seq: number, deviceId: string, deleted = false): SyncChange {
  const base = { collection: 'settings', key: keyOf(seq), hlc: hlcOf(seq, deviceId), seq };
  return deleted ? { ...base, deleted: true } : { ...base, deleted: false, value: itemValue(seq) };
}

/** Alice's space with items at seq 1–5, seq 3 a tombstone. */
async function fiveItems(db: Db, people: People): Promise<SpaceRow> {
  const space = await ensureUserSpace(db, ALICE);
  await store(db, space, people.alice.deviceId, [{ seq: 1 }, { seq: 2 }, { seq: 3, deleted: true }, { seq: 4 }, { seq: 5 }]);
  return space;
}

const read = (db: Db, space: SpaceRow, q: { since: number; limit?: number; snapshot?: boolean; epoch?: string }) =>
  readChanges(
    db,
    space.id,
    { epoch: q.epoch ?? space.epoch, since: q.since, limit: q.limit ?? 500, snapshot: q.snapshot ?? false },
    NOW,
  );

/** The `SyncRefusal` a call threw; fails the test when it resolved or threw anything else. */
async function refusal(call: Promise<unknown>): Promise<Pick<SyncRefusal, 'code' | 'status' | 'reason'>> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncRefusal);
  const { code, status, reason } = err as SyncRefusal;
  return { code, status, reason };
}

describe('schema', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sync_tables_created_by_migrations', async () => {
    const h = await testDb();
    const SYNC_TABLES = sql`('sync_spaces', 'sync_items', 'sync_pushes')`;

    const tables = await queryRows(
      h,
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_name like 'sync%' order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['sync_items', 'sync_pushes', 'sync_spaces']);

    const columns = await queryRows(
      h,
      sql`select table_name, column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name in ${SYNC_TABLES} order by table_name, ordinal_position`,
    );
    expect(
      columns.map((c) => `${c.table_name}.${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? ' null' : ''}`),
    ).toEqual([
      'sync_items.space_id uuid',
      'sync_items.collection text',
      'sync_items.key text',
      'sync_items.value jsonb null',
      'sync_items.deleted boolean',
      'sync_items.hlc text',
      'sync_items.device_id uuid null',
      'sync_items.seq bigint',
      'sync_items.bytes integer',
      'sync_items.expires_at timestamp with time zone null',
      'sync_items.updated_at timestamp with time zone',
      'sync_pushes.space_id uuid',
      'sync_pushes.push_id uuid',
      'sync_pushes.device_id uuid null',
      'sync_pushes.response jsonb',
      'sync_pushes.created_at timestamp with time zone',
      'sync_spaces.id uuid',
      'sync_spaces.kind text',
      'sync_spaces.user_id text null',
      'sync_spaces.epoch uuid',
      'sync_spaces.seq bigint',
      'sync_spaces.item_count integer',
      'sync_spaces.bytes_used integer',
      'sync_spaces.gc_floor_seq bigint',
      'sync_spaces.gc_floor_hlc text',
      'sync_spaces.created_at timestamp with time zone',
    ]);

    const keys = await queryRows(
      h,
      sql`select tc.table_name, tc.constraint_type,
                 string_agg(k.column_name, ',' order by k.ordinal_position) as columns
          from information_schema.table_constraints tc
          join information_schema.key_column_usage k
            on k.constraint_schema = tc.constraint_schema and k.constraint_name = tc.constraint_name
          where tc.table_schema = 'public' and tc.table_name in ${SYNC_TABLES}
            and tc.constraint_type in ('PRIMARY KEY', 'UNIQUE')
          group by tc.table_name, tc.constraint_name, tc.constraint_type
          order by tc.table_name, tc.constraint_type`,
    );
    expect(keys).toEqual([
      { table_name: 'sync_items', constraint_type: 'PRIMARY KEY', columns: 'space_id,collection,key' },
      { table_name: 'sync_pushes', constraint_type: 'PRIMARY KEY', columns: 'space_id,push_id' },
      { table_name: 'sync_spaces', constraint_type: 'PRIMARY KEY', columns: 'id' },
      { table_name: 'sync_spaces', constraint_type: 'UNIQUE', columns: 'user_id' },
    ]);

    const references = await queryRows(
      h,
      sql`select k.table_name, k.column_name, rc.delete_rule
          from information_schema.referential_constraints rc
          join information_schema.key_column_usage k
            on k.constraint_schema = rc.constraint_schema and k.constraint_name = rc.constraint_name
          where k.table_schema = 'public' and k.table_name in ${SYNC_TABLES}
          order by k.table_name, k.column_name`,
    );
    expect(references.map((r) => `${r.table_name}.${r.column_name} ${r.delete_rule}`)).toEqual([
      'sync_items.device_id SET NULL',
      'sync_items.space_id CASCADE',
      'sync_pushes.device_id SET NULL',
      'sync_pushes.space_id CASCADE',
      'sync_spaces.user_id CASCADE',
    ]);

    const indexes = await queryRows(
      h,
      sql`select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename in ${SYNC_TABLES} order by indexname`,
    );
    // The keys' own indexes, then the three the queries use.
    expect(indexes.map((i) => i.indexname)).toEqual([
      'sync_items_space_id_collection_key_pk',
      'sync_items_space_seq',
      'sync_items_tombstones',
      'sync_pushes_created',
      'sync_pushes_space_id_push_id_pk',
      'sync_spaces_pkey',
      'sync_spaces_user_id_unique',
    ]);
    const def = (name: string) => String(indexes.find((i) => i.indexname === name)?.indexdef);
    expect(def('sync_items_space_seq')).toMatch(/\(space_id, seq\)$/);
    expect(def('sync_items_tombstones')).toMatch(/\(updated_at\) WHERE deleted$/);
    expect(def('sync_pushes_created')).toMatch(/\(created_at\)$/);
  });
});

/** AC 2: one personal space per account, also when several requests create it at once. */
async function ensureOnceCase(db: Db): Promise<void> {
  await seedPeople(db);
  const first = await ensureUserSpace(db, ALICE);
  expect(await ensureUserSpace(db, ALICE)).toEqual(first);
  const together = await Promise.all([1, 2, 3, 4].map(() => ensureUserSpace(db, BOB)));
  expect(new Set(together.map((s) => s.id)).size).toBe(1);

  const rows = await db.select().from(syncSpaces);
  expect(rows.map((r) => r.userId).sort()).toEqual([ALICE, BOB]);
  for (const row of rows) {
    expect(row).toMatchObject({ kind: 'user', seq: 0, itemCount: 0, bytesUsed: 0, gcFloorSeq: 0, gcFloorHlc: HLC_ZERO });
    expect(row.epoch).toMatch(UUID);
  }
  expect(rows.find((r) => r.userId === ALICE)).toEqual(first);
  expect(rows[0]?.epoch).not.toBe(rows[1]?.epoch);
}

/** AC 5: every item after the cursor in seq order, tombstones included, a page at a time. */
async function pagesCase(db: Db): Promise<void> {
  const people = await seedPeople(db);
  const space = await fiveItems(db, people);
  const d = people.alice.deviceId;

  const all = await read(db, space, { since: 0 });
  expect(SyncChangesResponseSchema.parse(all)).toEqual(all);
  expect(all).toStrictEqual({
    v: 1,
    spaceId: space.id,
    epoch: space.epoch,
    cursor: 5,
    more: false,
    gcFloorHlc: HLC_ZERO,
    items: [change(1, d), change(2, d), change(3, d, true), change(4, d), change(5, d)],
  });

  const after2 = await read(db, space, { since: 2 });
  expect(after2).toMatchObject({ cursor: 5, more: false });
  expect(after2.items).toStrictEqual([change(3, d, true), change(4, d), change(5, d)]);

  const first = await read(db, space, { since: 0, limit: 2 });
  expect(first).toMatchObject({ cursor: 2, more: true });
  expect(first.items).toStrictEqual([change(1, d), change(2, d)]);
  const second = await read(db, space, { since: first.cursor, limit: 2 });
  expect(second).toMatchObject({ cursor: 4, more: true });
  expect(second.items).toStrictEqual([change(3, d, true), change(4, d)]);
  const last = await read(db, space, { since: second.cursor, limit: 2 });
  expect(last).toMatchObject({ cursor: 5, more: false });
  expect(last.items).toStrictEqual([change(5, d)]);
  const none = await read(db, space, { since: last.cursor, limit: 2 });
  expect(none).toMatchObject({ cursor: 5, more: false, items: [] });
}

describe('spaces', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_ensure_user_space_once', async () => {
    await ensureOnceCase((await testDb()).db);
  });

  it('test_list_spaces_creates_personal_space', async () => {
    const { db } = await testDb();
    const { alice, bob } = await seedPeople(db);
    expect(await db.select().from(syncSpaces)).toEqual([]);

    const spaces = await listSpaces(db, alice);
    const [row] = await db.select().from(syncSpaces);
    expect(row).toBeDefined();
    expect(spaces).toStrictEqual<SyncSpace[]>([
      { id: String(row?.id), kind: 'user', access: 'read-write', epoch: String(row?.epoch) },
    ]);
    expect(SyncSpacesResponseSchema.parse({ v: 1, spaces })).toEqual({ v: 1, spaces });
    // The second call finds the space the first created.
    expect(await listSpaces(db, alice)).toEqual(spaces);

    const bobs = await listSpaces(db, bob);
    expect(bobs).toHaveLength(1);
    expect(bobs[0]?.id).not.toBe(spaces[0]?.id);
    expect(await db.select().from(syncSpaces)).toHaveLength(2);
  });

  it('test_find_space_isolates_accounts', async () => {
    const { db } = await testDb();
    const { alice, bob } = await seedPeople(db);
    const a = await ensureUserSpace(db, ALICE);
    const b = await ensureUserSpace(db, BOB);

    // Another account's space answers exactly like a space that does not exist.
    expect(await findSpace(db, a.id, bob)).toBeNull();
    expect(await findSpace(db, randomUUID(), bob)).toBeNull();
    expect(await findSpace(db, randomUUID(), alice)).toBeNull();
    expect(await findSpace(db, 'not-a-space-id', alice)).toBeNull();

    expect(await findSpace(db, a.id, alice)).toEqual({ space: a, access: 'read-write' });
    expect(await findSpace(db, b.id, bob)).toEqual({ space: b, access: 'read-write' });

    // The seam CL7's org spaces use: whatever the resolver allows.
    const readOnly: AccessResolver = () => 'read';
    expect(await findSpace(db, a.id, bob, readOnly)).toEqual({ space: a, access: 'read' });
    expect(await listSpaces(db, alice, readOnly)).toEqual([{ id: a.id, kind: 'user', access: 'read', epoch: a.epoch }]);
    const nobody: AccessResolver = () => null;
    expect(await findSpace(db, a.id, alice, nobody)).toBeNull();
  });

  it('test_space_cascades_with_user', async () => {
    const { db } = await testDb();
    const people = await seedPeople(db);
    const a = await fiveItems(db, people);
    const b = await ensureUserSpace(db, BOB);
    await store(db, b, people.bob.deviceId, [{ seq: 1 }]);
    await db.insert(syncPushes).values([
      { spaceId: a.id, pushId: randomUUID(), deviceId: people.alice.deviceId, response: { v: 1, results: [] } },
      { spaceId: b.id, pushId: randomUUID(), deviceId: people.bob.deviceId, response: { v: 1, results: [] } },
    ]);

    await db.delete(user).where(eq(user.id, ALICE));

    expect((await db.select().from(syncSpaces)).map((s) => s.id)).toEqual([b.id]);
    expect((await db.select().from(syncItems)).map((i) => i.spaceId)).toEqual([b.id]);
    expect((await db.select().from(syncPushes)).map((p) => p.spaceId)).toEqual([b.id]);
  });
});

describe('reading changes', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_read_changes_pages_by_seq', async () => {
    await pagesCase((await testDb()).db);
  });

  it('test_read_changes_refuses_untrusted_cursors', async () => {
    const { db } = await testDb();
    const people = await seedPeople(db);
    const space = await fiveItems(db, people);
    const resync = (reason: SyncRefusal['reason']) => ({ code: 'resync-required', status: 410, reason });

    // Another epoch (a restore, CL3-09), checked before anything else.
    expect(await refusal(read(db, space, { since: 2, epoch: randomUUID() }))).toEqual(resync('epoch'));
    expect(await refusal(read(db, space, { since: 6, epoch: randomUUID() }))).toEqual(resync('epoch'));
    // A cursor ahead of the server: the database went back in time.
    expect(await refusal(read(db, space, { since: 6 }))).toEqual(resync('rewound'));

    // Tombstones up to seq 4 cleaned up: a client at 2 may have missed one.
    await db.update(syncSpaces).set({ gcFloorSeq: 4 }).where(eq(syncSpaces.id, space.id));
    expect(await refusal(read(db, space, { since: 2 }))).toEqual(resync('gc'));
    expect(await refusal(read(db, space, { since: 3, limit: 1 }))).toEqual(resync('gc'));

    // Still paging through a download that began at 0, or at the floor: nothing older to contradict.
    const d = people.alice.deviceId;
    const snapshot = await read(db, space, { since: 2, snapshot: true });
    expect(snapshot.items).toStrictEqual([change(3, d, true), change(4, d), change(5, d)]);
    const atFloor = await read(db, space, { since: 4 });
    expect(atFloor.items).toStrictEqual([change(5, d)]);
    expect((await read(db, space, { since: 0 })).items).toHaveLength(5);

    // An unknown space: the same 404 a route answers for another account's space.
    const unknown = readChanges(db, randomUUID(), { epoch: space.epoch, since: 0, limit: 500, snapshot: false }, NOW);
    expect(await refusal(unknown)).toEqual({ code: 'not-found', status: 404, reason: undefined });
  });

  it('test_read_changes_skips_expired', async () => {
    const { db } = await testDb();
    const people = await seedPeople(db);
    const space = await ensureUserSpace(db, ALICE);
    const d = people.alice.deviceId;
    await store(db, space, d, [
      { seq: 1, expiresAt: new Date(NOW - 1_000) },
      { seq: 2, expiresAt: new Date(NOW + 60_000) },
      { seq: 3 },
      { seq: 4, expiresAt: new Date(NOW) },
    ]);

    const res = await read(db, space, { since: 0 });
    expect(res.items).toStrictEqual([change(2, d), change(3, d)]);
    expect(res).toMatchObject({ cursor: 4, more: false });

    // Later, the second one has expired too.
    const later = await readChanges(db, space.id, { epoch: space.epoch, since: 0, limit: 500, snapshot: false }, NOW + 120_000);
    expect(later.items).toStrictEqual([change(3, d)]);
  });

  it('test_read_changes_caps_at_space_seq', async () => {
    const { db } = await testDb();
    const people = await seedPeople(db);
    const space = await fiveItems(db, people);
    // A push still committing: its row is there, the space's seq not yet raised.
    await store(db, space, people.alice.deviceId, [{ seq: 6 }], false);

    const all = await read(db, space, { since: 0 });
    expect(all.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all).toMatchObject({ cursor: 5, more: false });
    const paged = await read(db, space, { since: 3, limit: 2 });
    expect(paged.items.map((i) => i.seq)).toEqual([4, 5]);
    expect(paged).toMatchObject({ cursor: 5, more: false });
    expect(await read(db, space, { since: 5 })).toMatchObject({ cursor: 5, more: false, items: [] });
  });

  it('test_read_changes_reports_gc_floor', async () => {
    const { db } = await testDb();
    const people = await seedPeople(db);
    const space = await fiveItems(db, people);
    expect((await read(db, space, { since: 0 })).gcFloorHlc).toBe(HLC_ZERO);

    const floor = hlcOf(2, people.alice.deviceId);
    await db.update(syncSpaces).set({ gcFloorSeq: 2, gcFloorHlc: floor }).where(eq(syncSpaces.id, space.id));
    const answers = [
      await read(db, space, { since: 0 }),
      await read(db, space, { since: 0, limit: 1 }),
      await read(db, space, { since: 1, snapshot: true }),
      await read(db, space, { since: 3 }),
      await read(db, space, { since: 5 }),
    ];
    for (const answer of answers) expect(answer.gcFloorHlc).toBe(floor);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_spaces_and_changes_on_postgres', async () => {
    await ensureOnceCase(await postgresDb());
    await pagesCase(await postgresDb());
  });
});
