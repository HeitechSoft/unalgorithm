/**
 * The server's source list for UnEcho Chamber (P3-73, decisions D92–D95): the outlets as published now (`outlets`) and
 * every change to them (`outlet_changes`). The list's version is the seq of its latest change. Admins change one outlet
 * at a time, published at once; a lean needs evidence (`OutletInputSchema`). The candidate list can be imported only
 * into an empty list, with no lean: nothing here sets a lean but an admin's own change.
 *
 * Every write is one transaction that first takes the list's advisory lock, so the version check and the whole-list
 * rules see the same list the write changes, and seqs follow the order changes commit in. Nothing here logs: the routes
 * write the ids-only lines.
 */
import { type Candidates, listProblems, listProblemText } from '@unalgorithm/outlets';
import {
  type AdminOutletChange,
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_LISTED_CHANGES,
  type OfficialList,
  type OfficialOutlet,
  OfficialOutletSchema,
  OUTLET_CHANGE_ACTIONS,
  type OutletChange,
  type OutletChangeAction,
  type OutletChangeRequest,
  type OutletInput,
  type WireError,
} from '@unalgorithm/protocol';
import { and, count, desc, eq, gte, lt, max, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { outletChanges, outlets, user } from '../db/schema.ts';
import { NOT_FOUND } from '../routes/openapi.ts';

/**
 * The advisory lock every change to the list takes: "UNOL" read as a 32-bit integer (migrations hold "UNAL", route sync
 * "UNAR", setup claims "UNAS"). Any fixed constant works, as long as it never changes.
 */
const OUTLETS_LOCK_KEY = 1431195468;

const LIST_CHANGED: WireError = {
  code: 'bad-request',
  message: 'The list changed since you opened it. Reload it and try again.',
};
const ID_TAKEN: WireError = { code: 'bad-request', message: 'An outlet with this id already exists.' };
const NOT_EMPTY: WireError = { code: 'bad-request', message: "The source list isn't empty." };

/** One read-only snapshot, so a list's version always matches its outlets. */
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

/** A change's answer: the list's version now, or a refusal (`S`: the statuses it can have; an import's only 400). */
export type ChangeOutcome<S extends 400 | 404 | 409 = 400 | 404 | 409> =
  | { ok: true; version: string }
  | { ok: false; status: S; error: WireError };

const refused = <S extends 400 | 404 | 409>(status: S, error: WireError): ChangeOutcome<S> => ({ ok: false, status, error });
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** The latest change: its seq and time, or undefined for a list never changed. */
async function latestChange(db: Db): Promise<{ seq: number; changedAt: Date } | undefined> {
  const [row] = await db
    .select({ seq: outletChanges.seq, changedAt: outletChanges.changedAt })
    .from(outletChanges)
    .orderBy(desc(outletChanges.seq))
    .limit(1);
  return row;
}

/** The latest change's seq as text, '0' for a list never changed. */
export async function listVersion(db: Db): Promise<string> {
  return String((await latestChange(db))?.seq ?? 0);
}

/** Every outlet as published, sorted by id (by code unit, as every list is: never the database's collation). */
async function currentOutlets(db: Db): Promise<OfficialOutlet[]> {
  const rows = await db.select().from(outlets);
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      domains: row.domains,
      country: row.country,
      lean: row.bucket === null ? null : { bucket: row.bucket, evidence: row.evidence.map(({ url, note }) => ({ url, note })) },
      changedOn: utcDay(row.changedAt),
    }))
    .sort(byId);
}

/** The published shape: outlets sorted by id, `changedOn` = UTC day of `changed_at`, `updatedAt` = latest change's time. */
export async function readOfficialList(db: Db): Promise<OfficialList> {
  return db.transaction(async (tx) => {
    const latest = await latestChange(tx);
    return {
      v: 1,
      version: String(latest?.seq ?? 0),
      updatedAt: latest?.changedAt.toISOString() ?? null,
      license: 'CC-BY-4.0',
      outlets: await currentOutlets(tx),
    };
  }, SNAPSHOT);
}

/** A history row as read, before its time is formatted and its outlets are checked. */
interface ChangeRow {
  seq: number;
  changedAt: Date;
  action: OutletChangeAction;
  outletId: string;
  before: unknown;
  after: unknown;
}

/** A stored `before` or `after`, in the published shape and key order (jsonb keeps neither its writer's order). */
const storedOutlet = (value: unknown): OfficialOutlet | null => (value === null ? null : OfficialOutletSchema.parse(value));

/** Newest first, at most MAX_LISTED_CHANGES; `withBy` adds the admin's address (admin page only). */
export async function listChanges(db: Db, opts: { withBy: true }): Promise<AdminOutletChange[]>;
export async function listChanges(db: Db, opts: { withBy: false }): Promise<OutletChange[]>;
export async function listChanges(db: Db, opts: { withBy: boolean }): Promise<AdminOutletChange[] | OutletChange[]>;
export async function listChanges(db: Db, { withBy }: { withBy: boolean }): Promise<AdminOutletChange[] | OutletChange[]> {
  const columns = {
    seq: outletChanges.seq,
    changedAt: outletChanges.changedAt,
    action: outletChanges.action,
    outletId: outletChanges.outletId,
    before: outletChanges.before,
    after: outletChanges.after,
  };
  const change = (row: ChangeRow): OutletChange => ({
    seq: row.seq,
    at: row.changedAt.toISOString(),
    action: row.action,
    outletId: row.outletId,
    before: storedOutlet(row.before),
    after: storedOutlet(row.after),
  });
  const newest = desc(outletChanges.seq);
  // Who only for the admin page: the public history never reads the `user` table.
  if (!withBy) {
    const rows = await db.select(columns).from(outletChanges).orderBy(newest).limit(MAX_LISTED_CHANGES);
    return rows.map(change);
  }
  const rows = await db
    .select({ ...columns, by: user.email })
    .from(outletChanges)
    .leftJoin(user, eq(user.id, outletChanges.changedBy))
    .orderBy(newest)
    .limit(MAX_LISTED_CHANGES);
  return rows.map((row) => ({ ...change(row), by: row.by }));
}

/** The list as a quarter ended, for P3-70's transparency report (decision D108): a public list's numbers, no one's. */
export interface ListAtQuarterEnd {
  /** The list's version at `to` (the last change before it), '0' when none. */
  version: string;
  /** Outlets with a lean at `to`, per bucket, from each outlet's last change before `to`. */
  counts: Record<LeanBucket, number>;
  /** Changes made in [from, to), by action. */
  changes: Record<OutletChangeAction, number>;
}

/**
 * The list at `to` and its changes in [from, to), from the history alone (never `outlets`, which is the list now), so
 * a report printed later still describes the quarter. A removed outlet's last `after` is null: no lean. No admin id is
 * read.
 */
export async function listAtQuarterEnd(db: Db, from: Date, to: Date): Promise<ListAtQuarterEnd> {
  const before = lt(outletChanges.changedAt, to);
  const [latest] = await db
    .select({ seq: max(outletChanges.seq) })
    .from(outletChanges)
    .where(before);
  const last = await db
    .selectDistinctOn([outletChanges.outletId], { bucket: sql<string | null>`${outletChanges.after} -> 'lean' ->> 'bucket'` })
    .from(outletChanges)
    .where(before)
    .orderBy(outletChanges.outletId, desc(outletChanges.seq));
  const byAction = await db
    .select({ action: outletChanges.action, n: count() })
    .from(outletChanges)
    .where(and(gte(outletChanges.changedAt, from), before))
    .groupBy(outletChanges.action);

  const counts = Object.fromEntries(LEAN_BUCKETS.map((b) => [b, 0])) as Record<LeanBucket, number>;
  const isBucket = (b: string | null): b is LeanBucket => (LEAN_BUCKETS as readonly (string | null)[]).includes(b);
  for (const { bucket } of last) {
    if (isBucket(bucket)) counts[bucket]++;
  }
  const changes = Object.fromEntries(
    OUTLET_CHANGE_ACTIONS.map((a) => [a, byAction.find((r) => r.action === a)?.n ?? 0]),
  ) as Record<OutletChangeAction, number>;
  return { version: String(latest?.seq ?? 0), counts, changes };
}

/** Whether an edit changes anything an admin sends: everything but `changedOn`, domain and evidence order included. */
function sameOutlet(a: OutletInput, b: OutletInput): boolean {
  const key = (o: OutletInput) =>
    JSON.stringify([o.id, o.name, o.domains, o.country, o.lean && [o.lean.bucket, o.lean.evidence.map((e) => [e.url, e.note])]]);
  return key(a) === key(b);
}

/** The columns of an outlet's row. */
const outletRow = (o: OutletInput, changedAt: Date) => ({
  id: o.id,
  name: o.name,
  domains: o.domains,
  country: o.country,
  bucket: o.lean?.bucket ?? null,
  evidence: o.lean?.evidence ?? [],
  changedAt,
});

/** Takes the list's lock for the rest of the transaction `tx`. */
async function lockList(tx: Db): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${OUTLETS_LOCK_KEY})`);
}

/**
 * One admin's change. In order: the lock; 409 when the list changed since `baseVersion`; 404 for an edit or a removal of
 * an unknown id; 400 for an add of an id already listed; 400 with the first problem of the list the change would make
 * (`listProblems`); then the outlet's row and one history row. An edit that changes nothing writes nothing.
 */
export async function applyOutletChange(
  db: Db,
  adminId: string,
  req: OutletChangeRequest,
  now: Date = new Date(),
): Promise<ChangeOutcome> {
  return db.transaction(async (tx) => {
    await lockList(tx);
    if ((await listVersion(tx)) !== req.baseVersion) return refused(409, LIST_CHANGED);

    const current = await currentOutlets(tx);
    const id = req.action === 'remove' ? req.id : req.outlet.id;
    const before = current.find((o) => o.id === id) ?? null;
    if (req.action === 'add' && before) return refused(400, ID_TAKEN);
    if (req.action !== 'add' && !before) return refused(404, NOT_FOUND);
    if (req.action === 'edit' && before && sameOutlet(before, req.outlet)) return { ok: true, version: req.baseVersion };

    const after: OfficialOutlet | null = req.action === 'remove' ? null : { ...req.outlet, changedOn: utcDay(now) };
    // The changed outlet last, so a clash names it rather than the outlet it clashes with.
    const rest = current.filter((o) => o.id !== id);
    const [problem] = listProblems(after ? [...rest, after] : rest);
    if (problem) return refused(400, { code: 'bad-request', message: listProblemText(problem) });

    if (req.action === 'add') await tx.insert(outlets).values(outletRow(req.outlet, now));
    else if (req.action === 'edit') await tx.update(outlets).set(outletRow(req.outlet, now)).where(eq(outlets.id, id));
    else await tx.delete(outlets).where(eq(outlets.id, id));
    const [change] = await tx
      .insert(outletChanges)
      .values({ action: req.action, outletId: id, before, after, changedBy: adminId, changedAt: now })
      .returning({ seq: outletChanges.seq });
    if (!change) throw new Error('The change was not recorded.');
    return { ok: true, version: String(change.seq) };
  });
}

/**
 * Only into an empty list: every candidate with `bucket` null, one `import` change each, in id order. Candidates carry
 * no lean by their schema, and nothing here sets one.
 */
export async function importCandidates(
  db: Db,
  adminId: string,
  candidates: Candidates,
  now: Date = new Date(),
): Promise<ChangeOutcome<400>> {
  return db.transaction(async (tx) => {
    await lockList(tx);
    const [listed] = await tx.select({ id: outlets.id }).from(outlets).limit(1);
    if (listed) return refused(400, NOT_EMPTY);

    const imported: OfficialOutlet[] = candidates.outlets
      .map((c) => ({ id: c.id, name: c.name, domains: c.domains, country: c.country, lean: null, changedOn: utcDay(now) }))
      .sort(byId);
    const [problem] = listProblems(imported);
    if (problem) return refused(400, { code: 'bad-request', message: listProblemText(problem) });
    if (imported.length === 0) return { ok: true, version: await listVersion(tx) };

    await tx.insert(outlets).values(imported.map((o) => outletRow(o, now)));
    const changes = await tx
      .insert(outletChanges)
      .values(
        imported.map((o) => ({
          action: 'import' as const,
          outletId: o.id,
          before: null,
          after: o,
          changedBy: adminId,
          changedAt: now,
        })),
      )
      .returning({ seq: outletChanges.seq });
    return { ok: true, version: String(Math.max(...changes.map((c) => c.seq))) };
  });
}
