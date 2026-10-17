/**
 * The server's price book (PA-03): until an admin first saves, the code defaults are used and nothing is written; each
 * save is checked with the price book's rules (PA-02) and kept in the append-only history with when and which admin;
 * the copy in memory follows at once. Function tests date their changes at `NOW`; route tests from the real clock
 * (`dayAhead(2)` is 00:00 UTC two days ahead), so none depends on today's date.
 */
import {
  ACCOUNT_DELETE_PATH,
  ADMIN_PRICES_PATH,
  type AdminPrices,
  AdminPricesSchema,
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceCard,
  DEFAULT_PRICE_BOOK,
  earliestRaise,
  MAX_PRICE_BOOK_ENTRIES,
  type PriceBook,
  type PriceChangeRequest,
} from '@unalgorithm/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, NOT_ADMIN } from '../src/admin/access.ts';
import { applyPriceChange, listPriceChanges, openPriceStore, PriceBookError } from '../src/admin/prices.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { priceChanges, user } from '../src/db/schema.ts';
import { startFailureMessage } from '../src/index.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { postJson, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const NOW = new Date('2026-11-02T12:00:00Z');
const DAY_MS = 86_400_000;
const PRICES_CHANGED = {
  code: 'bad-request',
  message: 'The prices changed since you opened this page. Reload it and try again.',
};
const NO_SUCH_CHANGE = { code: 'bad-request', message: 'That scheduled change is no longer on the list.' };

/** The code schedule's 2026-10-18 fact-check card: 2×, Sonnet 5.5, $0.12 a check, at most $0.40. */
const FC: CreditPriceCard = (() => {
  const card = CREDIT_PRICE_SCHEDULE.find((entry) => entry.effectiveFrom === '2026-10-18T00:00:00Z')?.cards.factcheck;
  if (!card) throw new Error('No 2026-10-18 fact-check card.');
  return card;
})();
/** A cut: the most a check can cost goes from $0.40 to $0.30. */
const CUT: CreditPriceCard = { ...FC, maxChargeMicros: 300_000 };
/** A raise: 3× ($0.36 a check), at most $0.50. */
const RAISE: CreditPriceCard = { ...FC, multiplier: 3, maxChargeMicros: 500_000 };
const PURCHASE = {
  minMicros: 10_000_000,
  maxMicros: 1_000_000_000,
  presetsMicros: [10_000_000, 25_000_000, 100_000_000],
  defaultMicros: 25_000_000,
};
const AUTO_RELOAD = { monthlyLimitMaxMicros: 500_000_000, perDay: 1 };

/** 00:00 UTC `days` days after today's, as a price date. */
const dayAhead = (days: number) =>
  new Date((Math.floor(Date.now() / DAY_MS) + days) * DAY_MS).toISOString().replace('.000Z', 'Z');
/** A price date as the plain-words rules write it: "Dec 3, 2026". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function userId(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No account.');
  return row.id;
}

/** A test server where Ada is the admin and Bea a member, both signed in on the page (as `outlets-admin.test.ts`). */
async function priceApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` }) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  const member = await signInWeb(t.app, t.outbox, BEA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const adaId = await userId(t, ADA);
  const db = t.deps.db.db;
  /** A POST from the page (or from `origin`, or with no `Origin` when null) with this session cookie (none when null). */
  const post = (body: unknown, cookie: string | null = admin, origin: string | null = TEST_PUBLIC_URL) =>
    postJson(t.app, ADMIN_PRICES_PATH, body, {
      ...(origin === null ? {} : { Origin: origin }),
      ...(cookie ? { Cookie: cookie } : {}),
    });
  const get = (cookie: string | null = admin) => t.app.request(ADMIN_PRICES_PATH, { headers: cookie ? { Cookie: cookie } : {} });
  /** What the Pricing page reads, after checking that the contract parses it unchanged. */
  const page = async (cookie = admin): Promise<AdminPrices> => {
    const res = await get(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(AdminPricesSchema.parse(body)).toEqual(body);
    return body as AdminPrices;
  };
  /** How many rows the history holds. */
  const rows = async () => (await db.select({ seq: priceChanges.seq }).from(priceChanges)).length;
  /** `applyPriceChange` as Ada, at `NOW`. */
  const apply = (req: PriceChangeRequest, at: Date = NOW) => applyPriceChange(db, t.prices, adaId, req, at);
  return { t, db, admin, member, adaId, post, get, page, rows, apply };
}

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
}

const ok = (version: string) => ({ ok: true, version });
const refusal = (message: string) => ({ code: 'bad-request', message });
const schedule = (baseVersion: string, effectiveFrom: string, card: CreditPriceCard) =>
  ({ action: 'schedule', baseVersion, task: 'factcheck', effectiveFrom, card }) as const;
const starter = (baseVersion: string, amountMicros: number) => ({ action: 'starter', baseVersion, amountMicros }) as const;

describe('store and saves', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_store_uses_seed_until_first_save', async () => {
    const { t, db, page, rows } = await priceApp();
    const start = Date.now();
    const body = await page();
    const end = Date.now();

    expect(body.prices).toEqual({ v: 1, version: '0', updatedAt: null, ...DEFAULT_PRICE_BOOK });
    expect(body.changes).toEqual([]);
    expect(Date.parse(body.now)).toBeGreaterThanOrEqual(start - 1000);
    expect(Date.parse(body.now)).toBeLessThanOrEqual(end + 1000);
    expect(body.billing).toBe(false);
    expect(await rows()).toBe(0);

    // The copy in memory is the seed, deep-frozen.
    const book = t.prices.current();
    expect(book).toEqual(DEFAULT_PRICE_BOOK);
    expect(t.prices.seed).toEqual(DEFAULT_PRICE_BOOK);
    expect(Object.isFrozen(book.schedule.at(-1)?.cards.factcheck)).toBe(true);
    expect(Object.isFrozen(book.purchase.presetsMicros)).toBe(true);
    expect(t.prices.published().etag).toMatch(/^"prices-[0-9a-f]{16}"$/);

    // A release whose code seed differs never reuses a tag, though both are version '0'.
    const other = await openPriceStore(db, { seed: { ...DEFAULT_PRICE_BOOK, schedule: TEST_PRICE_SCHEDULE } });
    expect(other.published().body.version).toBe('0');
    expect(other.published().etag).not.toBe(t.prices.published().etag);
    expect(await rows()).toBe(0);
  });

  it('test_schedule_change_saved_with_seed_row', async () => {
    const { t, db, apply, page } = await priceApp();
    const outcome = await apply(schedule('0', '2026-11-03T00:00:00Z', CUT));
    expect(outcome).toEqual({ ok: true, version: '2', changed: true });

    const at = NOW.toISOString();
    const expected = [
      {
        seq: 2,
        at,
        action: 'schedule',
        task: 'factcheck',
        effectiveFrom: '2026-11-03T00:00:00Z',
        movedTo: null,
        before: FC,
        after: CUT,
        by: ADA,
      },
      { seq: 1, at, action: 'seed', task: null, effectiveFrom: null, movedTo: null, before: null, after: null, by: ADA },
    ];
    expect(await listPriceChanges(db)).toEqual(expected);
    const shown = await page();
    expect(shown.changes).toEqual(expected);

    // The seed row keeps the defaults the server used until then.
    const [seed] = await db.select({ book: priceChanges.book }).from(priceChanges).where(eq(priceChanges.seq, 1));
    expect(seed?.book).toEqual(DEFAULT_PRICE_BOOK);

    // The copy in memory follows without a restart.
    const entry = t.prices.current().schedule.find((e) => e.effectiveFrom === '2026-11-03T00:00:00Z');
    expect(entry?.cards.factcheck).toEqual(CUT);
    expect(shown.prices).toMatchObject({ version: '2', updatedAt: at });
    expect(shown.prices.schedule).toEqual(t.prices.current().schedule);
  });

  it('test_raise_without_notice_refused_in_plain_words', async () => {
    const { apply, rows } = await priceApp();
    const raise = { ...CUT, multiplier: 2.5 };
    expect(await apply(schedule('0', '2026-11-03T00:00:00Z', raise))).toEqual({
      ok: false,
      status: 400,
      error: refusal("This raises the price of Fact-check, so it needs 30 days' notice. The earliest date is Dec 3, 2026."),
    });
    expect(await rows()).toBe(0);

    expect(await apply(schedule('0', '2026-12-03T00:00:00Z', raise))).toEqual({ ok: true, version: '2', changed: true });
    expect(await rows()).toBe(2);
  });

  it('test_in_effect_and_unknown_changes_refused', async () => {
    const { apply, rows } = await priceApp();
    expect(await apply(schedule('0', '2026-10-18T00:00:00Z', CUT))).toEqual({
      ok: false,
      status: 400,
      error: refusal("The prices from Oct 18, 2026 are in effect, so they can't change. Schedule a new price instead."),
    });

    const unknown: PriceChangeRequest[] = [
      // No entry at that date.
      { action: 'cancel', baseVersion: '0', task: 'factcheck', effectiveFrom: '2026-12-01T00:00:00Z' },
      // An entry that does not change that task.
      { action: 'cancel', baseVersion: '0', task: 'classify', effectiveFrom: '2026-10-18T00:00:00Z' },
      {
        action: 'move',
        baseVersion: '0',
        task: 'perspectives',
        effectiveFrom: '2026-11-03T00:00:00Z',
        to: '2026-11-05T00:00:00Z',
      },
    ];
    for (const req of unknown) expect(await apply(req)).toEqual({ ok: false, status: 404, error: NO_SUCH_CHANGE });
    expect(await rows()).toBe(0);
  });

  it('test_cancel_and_move_follow_notice_rule', async () => {
    const { t, post, page } = await priceApp();
    const [t2, t40, t45] = [dayAhead(2), dayAhead(40), dayAhead(45)];

    // A raise forty days ahead: moved, then cancelled.
    await expectAnswer(await post(schedule('0', t40, RAISE)), 200, ok('2'));
    await expectAnswer(
      await post({ action: 'move', baseVersion: '2', task: 'factcheck', effectiveFrom: t40, to: t45 }),
      200,
      ok('3'),
    );
    expect(t.prices.current().schedule.map((e) => e.effectiveFrom)).toContain(t45);
    await expectAnswer(await post({ action: 'cancel', baseVersion: '3', task: 'factcheck', effectiveFrom: t45 }), 200, ok('4'));
    expect(t.prices.current().schedule).toEqual(DEFAULT_PRICE_BOOK.schedule);

    const { changes } = await page();
    expect(
      changes.slice(0, 3).map(({ seq, action, effectiveFrom, movedTo, before, after }) => ({
        seq,
        action,
        effectiveFrom,
        movedTo,
        before,
        after,
      })),
    ).toEqual([
      { seq: 4, action: 'cancel', effectiveFrom: t45, movedTo: null, before: RAISE, after: FC },
      { seq: 3, action: 'move', effectiveFrom: t40, movedTo: t45, before: RAISE, after: RAISE },
      { seq: 2, action: 'schedule', effectiveFrom: t40, movedTo: null, before: FC, after: RAISE },
    ]);

    // A cut two days ahead stays: cancelling it would raise the price with less than 30 days' notice.
    await expectAnswer(await post(schedule('4', t2, CUT)), 200, ok('5'));
    const start = new Date();
    const res = await post({ action: 'cancel', baseVersion: '5', task: 'factcheck', effectiveFrom: t2 });
    const end = new Date();
    expect(res.status).toBe(400);
    const { message } = (await res.json()) as { message: string };
    const earliest = [start, end].map((at) => DATE.format(Date.parse(earliestRaise(at))));
    const texts = earliest.flatMap((day) => [
      `This raises the price of Fact-check, so it needs 30 days' notice. The earliest date is ${day}.`,
      `This raises the most one check can cost, so it needs 30 days' notice. The earliest date is ${day}.`,
    ]);
    expect(texts).toContain(message);
    expect((await page()).prices.version).toBe('5');
  });

  it('test_starter_purchase_and_auto_reload_saves', async () => {
    const { t, post, page, rows } = await priceApp();
    await expectAnswer(await post(starter('0', 2_000_000)), 200, ok('2'));
    await expectAnswer(await post({ action: 'purchase', baseVersion: '2', purchase: PURCHASE }), 200, ok('3'));
    await expectAnswer(await post({ action: 'auto-reload', baseVersion: '3', autoReload: AUTO_RELOAD }), 200, ok('4'));
    await expectAnswer(
      await post(starter('4', 50_000)),
      400,
      refusal('The starter credit must be from $0.10 to $10.00, in whole cents.'),
    );
    expect(await rows()).toBe(4);

    const { prices, changes } = await page();
    const pick = ({ seq, action, task, before, after }: AdminPrices['changes'][number]) => ({ seq, action, task, before, after });
    expect(changes.map(pick)).toEqual([
      { seq: 4, action: 'auto-reload', task: null, before: DEFAULT_PRICE_BOOK.autoReload, after: AUTO_RELOAD },
      { seq: 3, action: 'purchase', task: null, before: DEFAULT_PRICE_BOOK.purchase, after: PURCHASE },
      { seq: 2, action: 'starter', task: null, before: 1_000_000, after: 2_000_000 },
      { seq: 1, action: 'seed', task: null, before: null, after: null },
    ]);
    const starterAt = changes.find((c) => c.action === 'starter')?.at;
    expect(prices).toEqual({
      ...DEFAULT_PRICE_BOOK,
      v: 1,
      version: '4',
      updatedAt: changes[0]?.at,
      starterCredit: [...DEFAULT_PRICE_BOOK.starterCredit, { from: starterAt, amountMicros: 2_000_000 }],
      purchase: PURCHASE,
      autoReload: AUTO_RELOAD,
    });
    expect(t.prices.published().body).toEqual(prices);
  });

  it('test_stale_version_and_noop', async () => {
    const { t, post, rows, page } = await priceApp();
    // A change equal to the book in use writes nothing, not even the seed row.
    await expectAnswer(await post(starter('0', 1_000_000)), 200, ok('0'));
    expect(await rows()).toBe(0);

    await expectAnswer(await post(starter('0', 2_000_000)), 200, ok('2'));
    const etag = t.prices.published().etag;
    await expectAnswer(await post(starter('0', 3_000_000)), 409, PRICES_CHANGED);
    await expectAnswer(await post(starter('3', 3_000_000)), 409, PRICES_CHANGED);
    // Checked first: a stale change is a 409 even when it would also be refused for another reason.
    await expectAnswer(
      await post({ action: 'cancel', baseVersion: '1', task: 'factcheck', effectiveFrom: dayAhead(9) }),
      409,
      PRICES_CHANGED,
    );
    await expectAnswer(await post(starter('0', 50_000)), 409, PRICES_CHANGED);
    expect(await rows()).toBe(2);

    await expectAnswer(await post(starter('2', 2_000_000)), 200, ok('2'));
    await expectAnswer(await post({ action: 'purchase', baseVersion: '2', purchase: DEFAULT_PRICE_BOOK.purchase }), 200, ok('2'));
    await expectAnswer(await post(schedule('2', '2026-10-18T00:00:00Z', FC)), 200, ok('2'));
    expect(await rows()).toBe(2);
    expect(t.prices.published().etag).toBe(etag);
    expect((await page()).prices.version).toBe('2');
  });

  it('test_full_list_refused_and_nothing_written', async () => {
    const { t, db, apply, rows } = await priceApp();
    // A book whose starter credit holds the most steps PriceBookSchema allows: an hour apart, $1 and $2 in turn.
    const steps = Array.from({ length: MAX_PRICE_BOOK_ENTRIES }, (_, i) => ({
      from: new Date(Date.UTC(2020, 0, 1, i)).toISOString(),
      amountMicros: (1 + (i % 2)) * 1_000_000,
    }));
    await db.insert(priceChanges).values({ action: 'starter', book: { ...DEFAULT_PRICE_BOOK, starterCredit: steps } });
    await t.prices.refresh();
    expect(t.prices.published().body.version).toBe('1');

    // One step more would make a book the server cannot load again: refused in plain words, nothing written.
    expect(await apply(starter('1', 3_000_000))).toEqual({
      ok: false,
      status: 400,
      error: refusal("The starter credit can't change again: it keeps at most 500 amounts."),
    });
    expect(await rows()).toBe(1);

    // The other parts still change, and the server still opens on what it stored.
    expect(await apply({ action: 'auto-reload', baseVersion: '1', autoReload: AUTO_RELOAD })).toEqual({
      ok: true,
      version: '2',
      changed: true,
    });
    const again = await openPriceStore(db, { seed: DEFAULT_PRICE_BOOK });
    expect(again.published()).toEqual(t.prices.published());
    expect(again.current().starterCredit).toHaveLength(MAX_PRICE_BOOK_ENTRIES);
  });

  it('test_copy_follows_save_without_reading_again', async () => {
    const { t, db, adaId, apply } = await priceApp();
    const behind = await openPriceStore(db, { seed: DEFAULT_PRICE_BOOK });

    // The copy is the book the save committed: it follows even when the database cannot be read again after the commit.
    const noRead = { ...t.prices, refresh: () => Promise.reject(new Error('The database is not answering.')) };
    expect(await applyPriceChange(db, noRead, adaId, starter('0', 2_000_000), NOW)).toEqual({
      ok: true,
      version: '2',
      changed: true,
    });
    expect(t.prices.published().body).toMatchObject({ version: '2', updatedAt: NOW.toISOString() });
    expect(t.prices.current().starterCredit.at(-1)).toEqual({ from: NOW.toISOString(), amountMicros: 2_000_000 });
    // The same copy, tag and all, as the server loads at its next start.
    const reopened = await openPriceStore(db, { seed: DEFAULT_PRICE_BOOK });
    expect(t.prices.published()).toEqual(reopened.published());
    expect(Object.isFrozen(t.prices.current().starterCredit.at(-1))).toBe(true);

    // A copy that fell behind (here, another store on the same database) catches up on the save the 409 refuses,
    // so the page the admin reloads shows the version to change.
    expect(behind.published().body.version).toBe('0');
    expect(await applyPriceChange(db, behind, adaId, starter('0', 3_000_000), NOW)).toEqual({
      ok: false,
      status: 409,
      error: PRICES_CHANGED,
    });
    expect(behind.published()).toEqual(t.prices.published());
    const purchase = { action: 'purchase', baseVersion: behind.published().body.version, purchase: PURCHASE } as const;
    expect(await applyPriceChange(db, behind, adaId, purchase, NOW)).toMatchObject({ ok: true, version: '3' });
    expect(await apply({ action: 'auto-reload', baseVersion: '3', autoReload: AUTO_RELOAD })).toMatchObject({ version: '4' });
    expect(t.prices.published().body.version).toBe('4');
  });

  it('test_store_reopens_and_refuses_broken_book', async () => {
    const { t, db, apply } = await priceApp();
    expect(await apply(schedule('0', '2026-11-03T00:00:00Z', CUT))).toMatchObject({ ok: true, version: '2' });
    expect(await apply(starter('2', 2_000_000))).toMatchObject({ ok: true, version: '3' });

    const again = await openPriceStore(db, { seed: DEFAULT_PRICE_BOOK });
    expect(again.current()).toEqual(t.prices.current());
    expect(again.published()).toEqual(t.prices.published());
    expect(again.published().body).toMatchObject({ version: '3', updatedAt: NOW.toISOString() });

    // A seed that is not sound stops the start too.
    const unsound: PriceBook = { ...DEFAULT_PRICE_BOOK, purchase: { ...DEFAULT_PRICE_BOOK.purchase, defaultMicros: 7_000_000 } };
    const seedErr = await openPriceStore(db, { seed: unsound }).catch((err: unknown) => err);
    expect(seedErr).toBeInstanceOf(PriceBookError);

    // A row whose book fails the schema, written outside the server: no store opens on it, and the open one keeps its copy.
    const kept = t.prices.published();
    await db.insert(priceChanges).values({ action: 'schedule', book: { schedule: [] } });
    const err = await openPriceStore(db, { seed: DEFAULT_PRICE_BOOK }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PriceBookError);
    expect((err as Error).name).toBe('PriceBookError');
    expect((err as Error).message).toMatch(/^The stored price book is not valid: /);
    // Printed at start, as a BillingLoadError is.
    expect(startFailureMessage(err)).toBe((err as Error).message);
    await expect(t.prices.refresh()).rejects.toBeInstanceOf(PriceBookError);
    expect(t.prices.published()).toBe(kept);

    // One that parses but is not sound: refused with its first issue.
    await db.insert(priceChanges).values({ action: 'purchase', book: unsound });
    await expect(openPriceStore(db, { seed: DEFAULT_PRICE_BOOK })).rejects.toThrow(
      'The stored price book is not valid: purchase: defaultMicros must be one of presetsMicros',
    );
    const stored = await db.select({ seq: priceChanges.seq }).from(priceChanges).orderBy(asc(priceChanges.seq));
    expect(stored.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('guards and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_price_routes_need_origin_session_and_role', async () => {
    const { admin, member, post, get, rows } = await priceApp();
    const body = starter('0', 2_000_000);
    const nonsense = { nonsense: true };

    await expectAnswer(await post(body, admin, null), 403, REFUSED);
    await expectAnswer(await post(body, admin, 'https://elsewhere.example'), 403, REFUSED);
    // The body is never read before the checks: a nonsense one gets the same refusals, never a 400.
    await expectAnswer(await post(nonsense, admin, null), 403, REFUSED);
    expect((await post(body, null)).status).toBe(401);
    expect((await post(nonsense, null)).status).toBe(401);
    await expectAnswer(await post(body, member), 403, NOT_ADMIN);
    await expectAnswer(await post(nonsense, member), 403, NOT_ADMIN);
    expect((await get(null)).status).toBe(401);
    await expectAnswer(await get(member), 403, NOT_ADMIN);

    // None of them wrote anything.
    expect(await rows()).toBe(0);
  });

  it('test_deleted_admin_leaves_price_history_without_identity', async () => {
    const { t, db, admin, member, adaId, post, page } = await priceApp();
    await expectAnswer(await post(starter('0', 2_000_000)), 200, ok('2'));
    await expectAnswer(await post({ action: 'purchase', baseVersion: '2', purchase: PURCHASE }), 200, ok('3'));
    const before = await page();
    expect(before.changes.map((c) => c.by)).toEqual([ADA, ADA, ADA]);
    await db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, BEA));

    const deleted = await postJson(t.app, ACCOUNT_DELETE_PATH, { confirm: ADA }, { Cookie: admin, Origin: TEST_PUBLIC_URL });
    expect(deleted.status).toBe(200);

    // Every change keeps its data, with no one named.
    const after = await page(member);
    expect(after.prices).toEqual(before.prices);
    expect(after.changes).toEqual(before.changes.map((c) => ({ ...c, by: null })));
    const stored = await db.select({ by: priceChanges.changedBy }).from(priceChanges);
    expect(stored).toEqual([{ by: null }, { by: null }, { by: null }]);

    // No table holds the deleted admin's id.
    const holding = [...(await scanAllTables(t.deps.db))].filter(([, json]) => json.includes(adaId)).map(([table]) => table);
    expect(holding).toEqual([]);
  });

  it('test_price_change_logs_ids_only', async () => {
    const { t, adaId, post } = await priceApp();
    const t40 = dayAhead(40);
    await expectAnswer(await post(schedule('0', t40, RAISE)), 200, ok('2'));
    // A no-op, a stale change and a refused one log nothing.
    await expectAnswer(await post(starter('2', 1_000_000)), 200, ok('2'));
    await expectAnswer(await post(starter('0', 2_000_000)), 409, PRICES_CHANGED);
    expect((await post(starter('2', 50_000))).status).toBe(400);
    await expectAnswer(await post(starter('2', 2_000_000)), 200, ok('3'));

    const lines = t.events().filter((e) => typeof e.event === 'string' && e.event.startsWith('admin.price'));
    expect(lines.map(({ rid, t: time, ...rest }) => (typeof rid === 'string' && typeof time === 'string' ? rest : null))).toEqual(
      [
        { level: 'info', event: 'admin.price_changed', admin_id: adaId, action: 'schedule', task: 'factcheck', version: '2' },
        { level: 'info', event: 'admin.price_changed', admin_id: adaId, action: 'starter', version: '3' },
      ],
    );

    // No amount, date or address in any line (read without its random request id and its own time).
    const words = ['@', t40.slice(0, 10), '2000000', '500000', '50000'];
    const read = t.events().map(({ rid: _rid, t: _time, ...rest }) => JSON.stringify(rest));
    expect(read.filter((line) => words.some((w) => line.includes(w)))).toEqual([]);
    expect(t.lines.filter((line) => line.includes('@'))).toEqual([]);
  });
});
