import { describe, expect, it } from 'vitest';
import {
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_PRICES_PATH,
  AdminPricesSchema,
  CREDIT_AMOUNT_MAX_MICROS,
  CREDIT_AMOUNT_MIN_MICROS,
  CREDIT_AMOUNT_PRESETS,
  CREDIT_AMOUNT_STEP_MICROS,
  CREDIT_PRICE_SCHEDULE,
  CREDIT_TASKS,
  type CreditPriceCard,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  CreditPriceScheduleEntrySchema,
  DEFAULT_CREDIT_AMOUNT,
  DEFAULT_PRICE_BOOK,
  MAX_LISTED_PRICE_CHANGES,
  MAX_PRICE_BOOK_ENTRIES,
  PRICE_BOUNDS,
  PRICE_CHANGE_ACTIONS,
  PRICES_JSON_PATH,
  type PriceBook,
  PriceBookSchema,
  PriceChangedSchema,
  PriceChangeRequestSchema,
  PriceChangeSchema,
  type PriceIssue,
  PublishedPricesSchema,
  priceBookChangeIssues,
  priceBookIssues,
  REFERENCE_MODELS,
  STARTER_CREDIT,
  starterCreditAt,
  withStarterCredit,
  withTaskCard,
} from '../src/index.ts';

/** Fixed instants: no test here reads the clock. Both entries of the default schedule are in effect at NOW. */
const NOW = new Date('2026-11-02T12:00:00Z');
const D = DEFAULT_PRICE_BOOK;
const CLASSIFY = (CREDIT_PRICE_SCHEDULE[0] as CreditPriceScheduleEntry).cards.classify;
const OCT_18_ENTRY = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;
const FC = OCT_18_ENTRY.cards.factcheck as CreditPriceCard;
const NOV_3 = '2026-11-03T00:00:00Z';
const EPOCH = '1970-01-01T00:00:00Z';

const $ = (dollars: number) => dollars * 1_000_000;
const codes = (issues: readonly PriceIssue[]) => issues.map((issue) => issue.code);
/** The codes a save from `base` to `head` at NOW gets. */
const changeCodes = (head: PriceBook, base: PriceBook = D) => codes(priceBookChangeIssues(base, head, NOW));
/** D with factcheck priced by `card` from 2026-11-03 (the edit the Pricing page makes, PA-01). */
const scheduling = (card: CreditPriceCard): PriceBook => ({ ...D, schedule: withTaskCard(D.schedule, 'factcheck', NOV_3, card) });
const withPurchase = (rules: Partial<PriceBook['purchase']>): PriceBook => ({ ...D, purchase: { ...D.purchase, ...rules } });
const withAutoReload = (caps: Partial<PriceBook['autoReload']>): PriceBook => ({
  ...D,
  autoReload: { ...D.autoReload, ...caps },
});

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

describe('the book', () => {
  it('test_default_price_book_matches_constants', () => {
    expect(PriceBookSchema.parse(D)).toEqual(D);
    expect(priceBookIssues(D)).toEqual([]);
    expect(isDeepFrozen(D)).toBe(true);

    // Today's constants, the only place each default is typed.
    expect(D.schedule).toBe(CREDIT_PRICE_SCHEDULE);
    expect(D.starterCredit).toEqual([{ from: EPOCH, amountMicros: $(1) }]);
    expect(D.starterCredit[0]?.amountMicros).toBe(STARTER_CREDIT.amountMicros);
    expect(D.purchase).toEqual({ minMicros: $(5), maxMicros: $(500), presetsMicros: [$(5), $(10), $(25)], defaultMicros: $(10) });
    expect(D.purchase).toEqual({
      minMicros: CREDIT_AMOUNT_MIN_MICROS,
      maxMicros: CREDIT_AMOUNT_MAX_MICROS,
      presetsMicros: CREDIT_AMOUNT_PRESETS,
      defaultMicros: DEFAULT_CREDIT_AMOUNT,
    });
    expect(D.autoReload).toEqual({ monthlyLimitMaxMicros: $(1000), perDay: 2 });
    expect(starterCreditAt(NOW, D)).toEqual({ amountMicros: $(1), expiresAfterDays: 90 });

    // A parsed book's schedule is a CreditPriceSchedule: every schedule helper reads it as it is.
    const schedule: CreditPriceSchedule = PriceBookSchema.parse(D).schedule;
    expect(schedule).toEqual(CREDIT_PRICE_SCHEDULE);
    // Every card of the default names a reference model, and the bounds hold it.
    for (const entry of D.schedule) {
      for (const card of Object.values(entry.cards)) expect(REFERENCE_MODELS).toContain(card.referenceModel);
    }
    expect(PRICE_BOUNDS.purchaseMicros.step).toBe(CREDIT_AMOUNT_STEP_MICROS);
    expect(isDeepFrozen(PRICE_BOUNDS)).toBe(true);
    expect(PRICES_JSON_PATH).toBe('/prices.json');
  });

  it('test_price_book_schema_is_strict', () => {
    const refused = (value: unknown, why: string) => expect(PriceBookSchema.safeParse(value).success, why).toBe(false);
    const entry = OCT_18_ENTRY;
    const step = D.starterCredit[0];
    refused({ ...D, extra: 1 }, 'the book');
    refused({ ...D, schedule: [{ ...entry, note: 'x' }] }, 'an entry');
    refused({ ...D, schedule: [{ ...entry, cards: { ...entry.cards, factcheck: { ...FC, label: 'x' } } }] }, 'a card');
    refused({ ...D, starterCredit: [{ ...step, expiresAfterDays: 90 }] }, 'a starter step');
    refused({ ...D, purchase: { ...D.purchase, currency: 'usd' } }, 'the purchase rules');
    refused({ ...D, autoReload: { ...D.autoReload, perMonth: 1 } }, 'the auto-reload caps');
    // A card key outside CREDIT_TASKS, and a day the calendar does not have.
    refused({ ...D, schedule: [{ ...entry, cards: { ...entry.cards, summarize: CLASSIFY } }] }, 'a task');
    refused({ ...D, schedule: [{ ...entry, effectiveFrom: '2026-02-30T00:00:00Z' }] }, '30 February');
    refused({ ...D, schedule: [{ ...entry, effectiveFrom: '2026-11-03T01:00:00Z' }] }, 'not midnight');
    refused({ ...D, schedule: [] }, 'no entry');
    refused({ ...D, starterCredit: [] }, 'no starter step');
    refused({ ...D, starterCredit: [{ from: '1970-01-01', amountMicros: $(1) }] }, 'a starter date');
    refused({ ...D, purchase: { ...D.purchase, presetsMicros: [] } }, 'no quick pick');
    refused({ ...D, autoReload: { ...D.autoReload, perDay: 1.5 } }, 'a fraction');
    const { autoReload: _autoReload, ...withoutCaps } = D;
    refused(withoutCaps, 'a missing part');

    // The card schema's keys are the credit tasks.
    expect(Object.keys(CreditPriceScheduleEntrySchema.shape.cards.shape).sort()).toEqual([...CREDIT_TASKS].sort());
    // The same book written as `toISOString` writes an instant parses too.
    const step2 = { from: '2026-11-02T12:00:00.000Z', amountMicros: $(2) };
    expect(PriceBookSchema.parse({ ...D, starterCredit: [step, step2] }).starterCredit).toEqual([step, step2]);
  });

  it('test_price_book_soundness_issues', () => {
    const steps = [
      { from: '2026-11-02T12:00:00Z', amountMicros: $(2) },
      { from: EPOCH, amountMicros: $(1) },
    ];
    expect(codes(priceBookIssues({ ...D, starterCredit: steps }))).toEqual(['starter-order']);
    expect(codes(priceBookIssues({ ...D, starterCredit: [steps[1], steps[1]] as PriceBook['starterCredit'] }))).toEqual([
      'starter-order',
    ]);

    // A $50 least above the $10 preselected: the $5 and $10 quick picks are under the least as well.
    expect(codes(priceBookIssues(withPurchase({ minMicros: $(50) })))).toEqual(['purchase-order', 'purchase-presets']);
    expect(codes(priceBookIssues(withPurchase({ defaultMicros: $(15) })))).toEqual(['purchase-default']);
    expect(codes(priceBookIssues(withPurchase({ presetsMicros: [$(10), $(5)] })))).toEqual(['purchase-presets']);
    expect(codes(priceBookIssues(withPurchase({ presetsMicros: [$(5), $(5), $(10)] })))).toEqual(['purchase-presets']);
    expect(codes(priceBookIssues(withPurchase({ maxMicros: $(500) + 1 })))).toEqual(['purchase-order']);
    expect(codes(priceBookIssues(withPurchase({ maxMicros: $(20) })))).toEqual(['purchase-presets']);
    expect(codes(priceBookIssues(withAutoReload({ monthlyLimitMaxMicros: $(3) })))).toEqual(['auto-reload-monthly']);
    expect(codes(priceBookIssues(withAutoReload({ monthlyLimitMaxMicros: $(5) + 500_000 })))).toEqual(['auto-reload-monthly']);
    expect(codes(priceBookIssues(withAutoReload({ monthlyLimitMaxMicros: $(5) })))).toEqual([]);
    // The schedule's own shape issues come first.
    expect(codes(priceBookIssues({ ...D, schedule: [], autoReload: { ...D.autoReload, monthlyLimitMaxMicros: $(3) } }))).toEqual([
      'empty',
      'auto-reload-monthly',
    ]);

    // Soundness only, never the bounds: a release that changes a bound never breaks a stored book.
    const wide: PriceBook = {
      ...D,
      purchase: { minMicros: $(1), maxMicros: $(2000), presetsMicros: [$(1), $(5), $(10), $(25), $(50)], defaultMicros: $(10) },
      autoReload: { monthlyLimitMaxMicros: $(10_000), perDay: 50 },
    };
    expect(priceBookIssues(wide)).toEqual([]);
  });
});

describe('change rules', () => {
  it('test_bounds_apply_to_future_cards_only', () => {
    expect(changeCodes(scheduling({ ...FC, multiplier: 0.5 }))).toEqual(['multiplier-range']);
    // 11× on a lower AI cost, so the $0.40 hold cap still covers its typical price ($0.33): a raise within the notice.
    expect(changeCodes(scheduling({ ...FC, multiplier: 11, referenceCostMicrosPer1000: 30_000_000 }))).toEqual([
      'raise',
      'multiplier-range',
    ]);
    expect(changeCodes(scheduling({ ...FC, referenceModel: 'gpt-5' }))).toEqual(['reference-model-unknown']);
    expect(changeCodes(scheduling({ ...FC, maxChargeMicros: 6_000_000 }))).toEqual(['cap-raise', 'cap-too-high']);
    // The edges pass.
    expect(changeCodes(scheduling({ ...FC, multiplier: 1 }))).toEqual([]);
    expect(changeCodes(scheduling({ ...FC, referenceModel: 'claude-opus-5-5' }))).toEqual([]);
    const later = withTaskCard(D.schedule, 'factcheck', '2026-12-03T00:00:00Z', {
      ...FC,
      multiplier: 10,
      maxChargeMicros: 5_000_000,
    });
    expect(changeCodes({ ...D, schedule: later })).toEqual([]);

    // The issue names the card it is about.
    const [issue] = priceBookChangeIssues(D, scheduling({ ...FC, multiplier: 0.5 }), NOW);
    expect(issue).toMatchObject({ code: 'multiplier-range', task: 'factcheck', effectiveFrom: NOV_3 });
    const [cap] = priceBookChangeIssues(D, scheduling({ ...FC, maxChargeMicros: 6_000_000 }), NOW).slice(1);
    expect(cap).toMatchObject({ code: 'cap-too-high', task: 'factcheck', effectiveFrom: NOV_3 });

    // A card in effect at now is not checked: the bounds apply only to entries after now.
    const B: PriceBook = {
      ...D,
      schedule: [{ effectiveFrom: '2026-10-01T00:00:00Z', cards: { classify: { ...CLASSIFY, multiplier: 0.5 } } }],
    };
    expect(priceBookChangeIssues(B, B, NOW)).toEqual([]);
    expect(priceBookChangeIssues(B, withStarterCredit(B, $(2), NOW), NOW)).toEqual([]);

    // A head whose schedule is not sound gets its shape issues once, without the change rules' copy of them.
    const unsound = scheduling({ ...FC, multiplier: 11 }); // $1.32 a check, above its $0.40 hold cap
    expect(changeCodes(unsound)).toEqual(['cap-below-typical', 'multiplier-range']);
    expect(priceBookChangeIssues(D, unsound, NOW)[0]?.text).not.toMatch(/^head: /);
    expect(() => priceBookChangeIssues(D, D, new Date(Number.NaN))).toThrow(RangeError);
    expect(() => priceBookChangeIssues(D, D, NOW, 1.5)).toThrow(RangeError);
  });

  it('test_starter_credit_changes_append_only', () => {
    const head = withStarterCredit(D, $(2), NOW);
    expect(head.starterCredit).toEqual([...D.starterCredit, { from: NOW.toISOString(), amountMicros: $(2) }]);
    expect(head.schedule).toBe(D.schedule);
    expect(head.purchase).toBe(D.purchase);
    expect(isDeepFrozen(head)).toBe(true);
    expect(PriceBookSchema.parse(head)).toEqual(head);
    expect(priceBookChangeIssues(D, head, NOW)).toEqual([]);

    for (const amount of [50_000, 10_000_001, 105_000, 0]) {
      expect(changeCodes(withStarterCredit(D, amount, NOW)), String(amount)).toEqual(['starter-range']);
    }
    for (const amount of [100_000, 10_000_000, 1_230_000]) {
      expect(changeCodes(withStarterCredit(D, amount, NOW)), String(amount)).toEqual([]);
    }

    // Past amounts never change: an edited, removed or backdated step, or two at once.
    expect(changeCodes({ ...D, starterCredit: [{ from: EPOCH, amountMicros: $(2) }] })).toEqual(['starter-history']);
    expect(changeCodes(D, head)).toEqual(['starter-history']);
    const two = withStarterCredit(head, $(3), new Date('2026-11-02T13:00:00Z'));
    expect(changeCodes(two)).toEqual(['starter-history']);
    expect(changeCodes(withStarterCredit(D, $(2), new Date('2026-11-01T00:00:00Z')))).toEqual(['starter-history']);
    // A step out of order is a soundness issue of the head.
    const before = { ...D, starterCredit: [...D.starterCredit, { from: '1960-01-01T00:00:00Z', amountMicros: $(2) }] };
    expect(changeCodes(before)).toContain('starter-order');

    // The amount in effect already: nothing to add.
    expect(withStarterCredit(D, $(1), NOW)).toBe(D);
    expect(withStarterCredit(head, $(2), new Date('2026-12-01T00:00:00Z'))).toBe(head);
    // An earlier amount again is a new step.
    expect(withStarterCredit(head, $(1), new Date('2026-12-01T00:00:00Z')).starterCredit).toHaveLength(3);
  });

  it('test_starter_credit_at_account_creation', () => {
    const book: PriceBook = {
      ...D,
      starterCredit: [
        { from: EPOCH, amountMicros: $(1) },
        { from: '2026-11-02T12:00:00Z', amountMicros: $(2) },
      ],
    };
    expect(priceBookIssues(book)).toEqual([]);
    expect(starterCreditAt(new Date('2026-11-02T11:59:59Z'), book)).toEqual({ amountMicros: $(1), expiresAfterDays: 90 });
    expect(starterCreditAt(new Date('2026-11-02T12:00:00Z'), book)).toEqual({ amountMicros: $(2), expiresAfterDays: 90 });
    expect(starterCreditAt(new Date('2027-01-01T00:00:00Z'), book).amountMicros).toBe($(2));
    // An instant before the first step gets the first step.
    expect(starterCreditAt(new Date('1960-01-01T00:00:00Z'), book).amountMicros).toBe($(1));
    expect(starterCreditAt(NOW, book).expiresAfterDays).toBe(STARTER_CREDIT.expiresAfterDays);
    expect(() => starterCreditAt(new Date(Number.NaN), book)).toThrow(RangeError);
    // withStarterCredit reads the same step.
    expect(withStarterCredit(book, $(2), NOW)).toBe(book);
    expect(withStarterCredit(book, $(1), NOW)).not.toBe(book);
  });

  it('test_full_lists_refused_at_schema_limits', () => {
    const M = MAX_PRICE_BOOK_ENTRIES;
    expect(M).toBe(500);
    /** `n` entries a day apart from 2020-01-01, all in effect at NOW, each with the 2026-10-18 cards. */
    const days = (n: number): CreditPriceSchedule =>
      Array.from({ length: n }, (_, i) => ({
        effectiveFrom: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().replace('.000Z', 'Z'),
        cards: OCT_18_ENTRY.cards,
      }));
    /** `n` starter steps an hour apart from 2020-01-01, $1 and $2 in turn. */
    const steps = (n: number): PriceBook['starterCredit'] =>
      Array.from({ length: n }, (_, i) => ({
        from: new Date(Date.UTC(2020, 0, 1, i)).toISOString(),
        amountMicros: $(1 + (i % 2)),
      }));
    const scheduleOf = (n: number): PriceBook => ({ ...D, schedule: days(n) });
    const starterOf = (n: number): PriceBook => ({ ...D, starterCredit: steps(n) });

    // At the limit: sound, and the schema parses it. One more: not sound, as the schema refuses it.
    for (const book of [scheduleOf(M), starterOf(M)]) {
      expect(priceBookIssues(book)).toEqual([]);
      expect(PriceBookSchema.safeParse(book).success).toBe(true);
    }
    expect(codes(priceBookIssues(scheduleOf(M + 1)))).toEqual(['schedule-full']);
    expect(codes(priceBookIssues(starterOf(M + 1)))).toEqual(['starter-full']);
    expect(PriceBookSchema.safeParse(scheduleOf(M + 1)).success).toBe(false);
    expect(PriceBookSchema.safeParse(starterOf(M + 1)).success).toBe(false);
    expect(priceBookIssues(scheduleOf(M + 1))[0]?.text).toBe('schedule: at most 500 entries');
    expect(priceBookIssues(starterOf(M + 1))[0]?.text).toBe('starterCredit: at most 500 steps');

    // A save that would add the one more is refused, so no save stores a book the server cannot load again.
    const cut = { ...FC, maxChargeMicros: 300_000 };
    const scheduled = (base: PriceBook): PriceBook => ({
      ...base,
      schedule: withTaskCard(base.schedule, 'factcheck', NOV_3, cut),
    });
    expect(changeCodes(scheduled(scheduleOf(M - 1)), scheduleOf(M - 1))).toEqual([]);
    expect(changeCodes(scheduled(scheduleOf(M)), scheduleOf(M))).toEqual(['schedule-full']);
    expect(changeCodes(withStarterCredit(starterOf(M - 1), $(3), NOW), starterOf(M - 1))).toEqual([]);
    expect(changeCodes(withStarterCredit(starterOf(M), $(3), NOW), starterOf(M))).toEqual(['starter-full']);
    // A full list does not stop a change to another part.
    const full = starterOf(M);
    expect(changeCodes({ ...full, autoReload: { monthlyLimitMaxMicros: $(500), perDay: 1 } }, full)).toEqual([]);
  });

  it('test_purchase_and_auto_reload_bounds', () => {
    const widest = { minMicros: $(1), maxMicros: $(1000), presetsMicros: [$(1), $(10), $(100), $(1000)], defaultMicros: $(10) };
    expect(changeCodes({ ...D, purchase: widest })).toEqual([]);
    expect(changeCodes(withPurchase({ maxMicros: $(1001) }))).toEqual(['purchase-range']);
    expect(changeCodes(withPurchase({ minMicros: 0 }))).toEqual(['purchase-range']);
    expect(changeCodes(withPurchase({ presetsMicros: [$(5), $(10), $(25), $(50), $(100)] }))).toEqual(['purchase-presets']);
    // A purchase change has no date rule: it applies at once.
    expect(changeCodes(withPurchase({ minMicros: $(10), presetsMicros: [$(10), $(20)], defaultMicros: $(20) }))).toEqual([]);

    for (const perDay of [0, 5]) expect(changeCodes(withAutoReload({ perDay })), String(perDay)).toEqual(['auto-reload-per-day']);
    expect(changeCodes(withAutoReload({ monthlyLimitMaxMicros: $(5001) }))).toEqual(['auto-reload-monthly']);
    expect(changeCodes({ ...D, autoReload: { monthlyLimitMaxMicros: $(500), perDay: 1 } })).toEqual([]);
    expect(changeCodes({ ...D, autoReload: { monthlyLimitMaxMicros: $(5000), perDay: 4 } })).toEqual([]);

    // The bounds check a part only when it changes: a stored part outside them stays until it is edited.
    const stored: PriceBook = { ...D, autoReload: { monthlyLimitMaxMicros: $(6000), perDay: 6 } };
    expect(priceBookChangeIssues(stored, withStarterCredit(stored, $(2), NOW), NOW)).toEqual([]);
    expect(changeCodes({ ...stored, autoReload: { monthlyLimitMaxMicros: $(6000), perDay: 5 } }, stored)).toEqual([
      'auto-reload-per-day',
      'auto-reload-monthly',
    ]);
  });
});

describe('contract', () => {
  it('test_published_and_admin_shapes', () => {
    const published = { v: 1, version: '0', updatedAt: null, ...D };
    expect(PublishedPricesSchema.parse(published)).toEqual(published);
    const saved = { ...published, version: '12', updatedAt: '2026-11-02T12:00:00.000Z' };
    expect(PublishedPricesSchema.parse(saved)).toEqual(saved);
    // No history and no admin in what is published.
    expect(PublishedPricesSchema.safeParse({ ...published, changes: [] }).success).toBe(false);
    expect(PublishedPricesSchema.safeParse({ ...published, version: 'v1' }).success).toBe(false);
    expect(PublishedPricesSchema.safeParse({ ...published, v: 2 }).success).toBe(false);

    const baseVersion = '3';
    const requests = [
      { action: 'schedule', baseVersion, task: 'factcheck', effectiveFrom: NOV_3, card: FC },
      { action: 'cancel', baseVersion, task: 'factcheck', effectiveFrom: NOV_3 },
      { action: 'move', baseVersion, task: 'factcheck', effectiveFrom: NOV_3, to: '2026-11-10T00:00:00Z' },
      { action: 'starter', baseVersion, amountMicros: $(2) },
      { action: 'purchase', baseVersion, purchase: D.purchase },
      { action: 'auto-reload', baseVersion, autoReload: D.autoReload },
    ];
    expect(requests.map((request) => request.action)).toEqual(PRICE_CHANGE_ACTIONS.filter((action) => action !== 'seed'));
    for (const request of requests) expect(PriceChangeRequestSchema.parse(request)).toEqual(request);
    const refused = (value: unknown, why: string) => expect(PriceChangeRequestSchema.safeParse(value).success, why).toBe(false);
    const { baseVersion: _baseVersion, ...withoutVersion } = requests[3] as { baseVersion: string };
    refused({ ...requests[0], action: 'delete' }, 'an unknown action');
    refused({ action: 'seed', baseVersion }, 'seed is never sent');
    refused(withoutVersion, 'a missing baseVersion');
    refused({ ...requests[0], effectiveFrom: '2026-11-03T12:00:00Z' }, 'not midnight');
    refused({ ...requests[2], to: '2026-11-10' }, 'a move to a day without a time');
    refused({ ...requests[3], note: 'x' }, 'an extra field');
    refused({ ...requests[0], card: { ...FC, label: 'x' } }, 'an extra card field');
    refused({ ...requests[0], task: 'summarize' }, 'not a task');
    refused({ ...requests[3], baseVersion: '3a' }, 'a version that is not digits');

    const change = (seq: number) => ({
      seq,
      at: '2026-11-02T12:00:00.000Z',
      action: 'schedule',
      task: 'factcheck',
      effectiveFrom: NOV_3,
      movedTo: null,
      before: FC,
      after: { ...FC, multiplier: 1.5 },
      by: 'admin@example.com',
    });
    const seed = { ...change(1), action: 'seed', task: null, effectiveFrom: null, before: null, after: null };
    const values = [
      { ...change(2), action: 'starter', task: null, effectiveFrom: null, before: $(1), after: $(2) },
      { ...change(3), action: 'purchase', task: null, effectiveFrom: null, before: D.purchase, after: D.purchase },
      {
        ...change(4),
        action: 'auto-reload',
        task: null,
        effectiveFrom: null,
        before: D.autoReload,
        after: D.autoReload,
        by: null,
      },
    ];
    for (const value of [seed, change(5), ...values]) expect(PriceChangeSchema.parse(value)).toEqual(value);

    const admin = { prices: published, changes: [seed], now: '2026-11-02T12:00:00.000Z', billing: true };
    expect(AdminPricesSchema.parse(admin)).toEqual(admin);
    const most = Array.from({ length: MAX_LISTED_PRICE_CHANGES }, (_, i) => change(i + 1));
    expect(AdminPricesSchema.safeParse({ ...admin, changes: most }).success).toBe(true);
    expect(AdminPricesSchema.safeParse({ ...admin, changes: [...most, change(201)] }).success).toBe(false);
    expect(MAX_LISTED_PRICE_CHANGES).toBe(200);
    expect(PriceChangedSchema.parse({ ok: true, version: '4' })).toEqual({ ok: true, version: '4' });

    expect(ADMIN_PRICES_PATH).toBe('/v1/admin/prices');
    expect(ADMIN_PRICES_PAGE_PATH).toBe('/admin/prices');
    expect(PRICE_CHANGE_ACTIONS).toEqual(['seed', 'schedule', 'cancel', 'move', 'starter', 'purchase', 'auto-reload']);
  });
});
