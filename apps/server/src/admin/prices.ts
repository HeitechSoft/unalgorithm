/**
 * The server's price book (PA-03, decisions PD2, PD3, PD9, PD13): the prices its admins set on the Pricing page, kept in
 * `price_changes`, whose newest row's book is the one in use. The book's version is that row's seq ('0' with none).
 * Until an admin first saves, the server uses its code defaults (the store's `seed`) and writes nothing; the first save
 * stores them as a `seed` row, then the change, so the history shows what the defaults were.
 *
 * `PriceStore` keeps the book in memory, so every reader gets it without awaiting: loaded at start, and again after
 * each save this process makes. The server is one process by design (its jobs and limits already live in its memory),
 * so there is no timer; another process (the billing CLI) reads the book at its own start.
 *
 * Every save is one transaction that first takes the book's advisory lock, so the version check and the rules see the
 * book the save changes. The edits are PA-01's and the rules PA-02's `priceBookChangeIssues`, refused in PA-01's plain
 * words: no rule is written here. Rows are only ever inserted. Nothing here logs: the route writes the ids-only line.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { priceIssuesText } from '@unalgorithm/core';
import {
  cancelTaskChange,
  MAX_LISTED_PRICE_CHANGES,
  moveTaskChange,
  type PriceBook,
  PriceBookSchema,
  type PriceChange,
  type PriceChangeRequest,
  type PriceChangeValue,
  PriceChangeValueSchema,
  type PublishedPrices,
  priceBookChangeIssues,
  priceBookIssues,
  scheduledTaskChanges,
  starterCreditAt,
  taskPriceAt,
  type WireError,
  withStarterCredit,
  withTaskCard,
} from '@unalgorithm/protocol';
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { priceChanges, user } from '../db/schema.ts';

/**
 * The advisory lock every save takes: "UNPR" read as a 32-bit integer (the source list holds "UNOL", migrations "UNAL",
 * route sync "UNAR", setup claims "UNAS"). Any fixed constant works, as long as it never changes.
 */
const PRICES_LOCK_KEY = 1431195730;

const PRICES_CHANGED: WireError = {
  code: 'bad-request',
  message: 'The prices changed since you opened this page. Reload it and try again.',
};
const NO_SUCH_CHANGE: WireError = { code: 'bad-request', message: 'That scheduled change is no longer on the list.' };
const STORED = 'The stored price book';

/** The stored book fails PriceBookSchema or priceBookIssues: the server does not start (fail closed, as BillingLoadError). */
export class PriceBookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceBookError';
  }
}

export interface PriceStore {
  /** The book in use: the newest stored row's, or `seed` while none is stored. Deep-frozen; never awaits. */
  current(): PriceBook;
  /** `/prices.json`'s body ({ v: 1, version, updatedAt, ...book }) and its ETag, computed when the copy is (re)loaded. */
  published(): { body: PublishedPrices; etag: string };
  /** Reads the newest row again. Rejects (and keeps the copy it had) when the read fails or the book is not sound. */
  refresh(): Promise<void>;
  readonly seed: PriceBook;
}

/** `value`, with every object and array in it frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * `value` as a book the store keeps: parsed by PriceBookSchema (so its key order is the schema's, whatever jsonb kept)
 * and sound (`priceBookIssues`), deep-frozen; else a PriceBookError naming the first problem. Soundness only: a stored
 * book is never held to the bounds of a new change.
 */
function soundBook(value: unknown, what: string): PriceBook {
  const parsed = PriceBookSchema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const text = issue ? `${issue.path.map(String).join('.') || 'book'}: ${issue.message}` : 'it does not parse';
    throw new PriceBookError(`${what} is not valid: ${text}`);
  }
  const [problem] = priceBookIssues(parsed.data);
  if (problem) throw new PriceBookError(`${what} is not valid: ${problem.text}`);
  return deepFreeze(parsed.data);
}

/** The newest row: its seq, book and time, or undefined while none is stored. */
async function newestRow(db: Db) {
  const [row] = await db
    .select({ seq: priceChanges.seq, book: priceChanges.book, changedAt: priceChanges.changedAt })
    .from(priceChanges)
    .orderBy(desc(priceChanges.seq))
    .limit(1);
  return row;
}

interface Copy {
  book: PriceBook;
  published: { body: PublishedPrices; etag: string };
}

/**
 * The book's published body and its strong ETag, a hash of that body: a release whose code defaults differ never
 * reuses a tag, though both are version '0'.
 */
function copyOf(book: PriceBook, version: string, updatedAt: string | null): Copy {
  const body: PublishedPrices = deepFreeze({ v: 1 as const, version, updatedAt, ...book });
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { book, published: Object.freeze({ body, etag: `"prices-${hash}"` }) };
}

async function load(db: Db, seed: PriceBook): Promise<Copy> {
  const row = await newestRow(db);
  if (!row) return copyOf(seed, '0', null);
  return copyOf(soundBook(row.book, STORED), String(row.seq), row.changedAt.toISOString());
}

/**
 * The store on `db`, with `seed` as the book while none is stored. Rejects with PriceBookError when the seed or the
 * newest stored book is not sound, so the server does not start on prices it cannot read.
 */
export async function openPriceStore(db: Db, opts: { seed: PriceBook }): Promise<PriceStore> {
  const seed = soundBook(opts.seed, 'The default price book');
  let copy = await load(db, seed);
  return Object.freeze({
    seed,
    current: () => copy.book,
    published: () => copy.published,
    async refresh() {
      const next = await load(db, seed);
      // Two saves' refreshes can end out of order: the copy never goes back to an older version.
      if (Number(next.published.body.version) > Number(copy.published.body.version)) copy = next;
    },
  });
}

/** A save's answer: the book's version now and whether it changed, or a refusal. */
export type PriceChangeOutcome =
  | { ok: true; version: string; changed: boolean }
  | { ok: false; status: 400 | 404 | 409; error: WireError };

const refused = (status: 400 | 404 | 409, error: WireError): PriceChangeOutcome => ({ ok: false, status, error });

/** The book a change makes from `base`, and what it changed (the history's `before` and `after`). */
interface Edit {
  head: PriceBook;
  before: PriceChangeValue;
  after: PriceChangeValue;
  movedTo: string | null;
}

/**
 * The edit `req` makes to `base` at `now` (PA-01's schedule edits, PA-02's starter credit step, or the part replaced),
 * without any rule; null when a cancel or a move names a change of the task that `base` does not schedule.
 */
function editOf(base: PriceBook, req: PriceChangeRequest, now: Date): Edit | null {
  switch (req.action) {
    case 'schedule': {
      const price = taskPriceAt(new Date(req.effectiveFrom), req.task, base.schedule);
      const schedule = withTaskCard(base.schedule, req.task, req.effectiveFrom, req.card);
      return { head: { ...base, schedule }, before: price.offered ? price.card : null, after: req.card, movedTo: null };
    }
    case 'cancel':
    case 'move': {
      const schedule =
        req.action === 'cancel'
          ? cancelTaskChange(base.schedule, req.task, req.effectiveFrom)
          : moveTaskChange(base.schedule, req.task, req.effectiveFrom, req.to);
      // The change as the page lists it: its card, and the card in effect just before it.
      const since = new Date(Date.parse(req.effectiveFrom) - 1);
      const change = scheduledTaskChanges(base.schedule, req.task, since).find((c) => c.effectiveFrom === req.effectiveFrom);
      if (schedule === null || change === undefined) return null;
      const head = { ...base, schedule };
      if (req.action === 'cancel') return { head, before: change.card, after: change.before, movedTo: null };
      return { head, before: change.card, after: change.card, movedTo: req.to };
    }
    case 'starter': {
      const before = starterCreditAt(now, base).amountMicros;
      return { head: withStarterCredit(base, req.amountMicros, now), before, after: req.amountMicros, movedTo: null };
    }
    case 'purchase':
      return { head: { ...base, purchase: req.purchase }, before: base.purchase, after: req.purchase, movedTo: null };
    case 'auto-reload':
      return { head: { ...base, autoReload: req.autoReload }, before: base.autoReload, after: req.autoReload, movedTo: null };
  }
}

/**
 * One admin's change, in one transaction. In order: the lock; 409 when the book changed since `baseVersion`; 404 for a
 * cancel or a move of a change that is not scheduled; 400 with the rules' plain words (`priceBookChangeIssues`); a
 * change that leaves the book as it is writes nothing; else, the first time, a `seed` row with the defaults, then the
 * change's row with the whole book after it. The store's copy is refreshed after the commit.
 */
export async function applyPriceChange(
  db: Db,
  store: PriceStore,
  adminId: string,
  req: PriceChangeRequest,
  now: Date = new Date(),
): Promise<PriceChangeOutcome> {
  const outcome = await db.transaction(async (tx): Promise<PriceChangeOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${PRICES_LOCK_KEY})`);
    const row = await newestRow(tx);
    const version = String(row?.seq ?? 0);
    if (req.baseVersion !== version) return refused(409, PRICES_CHANGED);

    const base = row ? soundBook(row.book, STORED) : store.seed;
    const edit = editOf(base, req, now);
    if (!edit) return refused(404, NO_SUCH_CHANGE);
    const issues = priceBookChangeIssues(base, edit.head, now);
    if (issues.length > 0) return refused(400, { code: 'bad-request', message: priceIssuesText(issues) });
    if (isDeepStrictEqual(edit.head, base)) return { ok: true, version, changed: false };

    if (!row) await tx.insert(priceChanges).values({ action: 'seed', book: store.seed, changedBy: adminId, changedAt: now });
    const scheduled = req.action === 'schedule' || req.action === 'cancel' || req.action === 'move';
    const [saved] = await tx
      .insert(priceChanges)
      .values({
        action: req.action,
        task: scheduled ? req.task : null,
        effectiveFrom: scheduled ? req.effectiveFrom : null,
        movedTo: edit.movedTo,
        before: edit.before,
        after: edit.after,
        book: edit.head,
        changedBy: adminId,
        changedAt: now,
      })
      .returning({ seq: priceChanges.seq });
    if (!saved) throw new Error('The change was not recorded.');
    return { ok: true, version: String(saved.seq), changed: true };
  });
  if (outcome.ok && outcome.changed) await store.refresh();
  return outcome;
}

/** Newest first, at most MAX_LISTED_PRICE_CHANGES, each with the admin's address (null once that account is deleted). */
export async function listPriceChanges(db: Db): Promise<PriceChange[]> {
  const rows = await db
    .select({
      seq: priceChanges.seq,
      changedAt: priceChanges.changedAt,
      action: priceChanges.action,
      task: priceChanges.task,
      effectiveFrom: priceChanges.effectiveFrom,
      movedTo: priceChanges.movedTo,
      before: priceChanges.before,
      after: priceChanges.after,
      by: user.email,
    })
    .from(priceChanges)
    .leftJoin(user, eq(user.id, priceChanges.changedBy))
    .orderBy(desc(priceChanges.seq))
    .limit(MAX_LISTED_PRICE_CHANGES);
  return rows.map((row) => ({
    seq: row.seq,
    at: row.changedAt.toISOString(),
    action: row.action,
    task: row.task,
    effectiveFrom: row.effectiveFrom,
    movedTo: row.movedTo,
    // In the contract's shape and key order (jsonb keeps neither its writer's order).
    before: PriceChangeValueSchema.parse(row.before),
    after: PriceChangeValueSchema.parse(row.after),
    by: row.by,
  }));
}
