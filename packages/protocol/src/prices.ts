/**
 * The price book (decision PD1): a server's task prices (the dated schedule), starter credit, buying credit amounts and
 * auto-reload caps in one shape. Its admins set it on the Pricing page (`ADMIN_PRICES_PAGE_PATH`) and the server
 * publishes it at `PRICES_JSON_PATH`; until an admin first saves, the server uses `DEFAULT_PRICE_BOOK`, today's
 * constants. Every save passes `priceBookChangeIssues`: the schedule's own rules (billing.ts), the soundness of the other
 * parts, and the typing-slip bounds on what the change sets. One rule implementation: the server's save and the Pricing
 * page both call these functions.
 */
import { z } from 'zod';
import {
  CREDIT_AMOUNT_MAX_MICROS,
  CREDIT_AMOUNT_MIN_MICROS,
  CREDIT_AMOUNT_PRESETS,
  CREDIT_AMOUNT_STEP_MICROS,
  CREDIT_PRICE_SCHEDULE,
  CREDIT_TASKS,
  CREDIT_UNITS,
  type CreditPriceCard,
  type CreditPriceSchedule,
  creditAmount,
  DEFAULT_CREDIT_AMOUNT,
  isPriceDate,
  PRICE_NOTICE_DAYS,
  type PriceIssue,
  priceScheduleChangeIssues,
  priceScheduleIssues,
  STARTER_CREDIT,
} from './billing.ts';

/** Served outside `/v1`, public and cacheable, as `/outlets.json` (decision PD8). */
export const PRICES_JSON_PATH = '/prices.json';

/** `value`, with every object and array in it frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The models a card may name as its reference: Claude models with a cost card (`PRICE_CARDS`) and a published label
 * (`REFERENCE_MODEL_LABELS` in `@unalgorithm/core`). Tests keep both.
 */
export const REFERENCE_MODELS = Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const);
export type ReferenceModel = (typeof REFERENCE_MODELS)[number];

/**
 * Typing-slip bounds on what a change sets (decisions PD4–PD7). They only ever widen: a stored book is never re-checked
 * against them, and `priceBookIssues` never reads them.
 */
export const PRICE_BOUNDS = deepFreeze({
  multiplier: { min: 1, max: 10 },
  maxChargeMicros: { max: 5_000_000 },
  starterMicros: { min: 100_000, max: 10_000_000, step: 10_000 },
  purchaseMicros: { min: 1_000_000, max: 1_000_000_000, step: CREDIT_AMOUNT_STEP_MICROS },
  presets: { min: 1, max: 4 },
  perDay: { min: 1, max: 4 },
  monthlyLimitMaxMicros: { max: 5_000_000_000, step: CREDIT_AMOUNT_STEP_MICROS },
} as const);

const Micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** `YYYY-MM-DDT00:00:00Z` on a real calendar day. */
const PriceDate = z.string().refine(isPriceDate, { message: 'Expected YYYY-MM-DDT00:00:00Z on a real calendar day' });
const Version = z.string().regex(/^\d{1,15}$/);

export const CreditPriceCardSchema = z.strictObject({
  multiplier: z.number().positive().max(1_000),
  referenceModel: z.string().min(1).max(80),
  referenceCostMicrosPer1000: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  unit: z.enum(CREDIT_UNITS).optional(),
  maxChargeMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}) satisfies z.ZodType<CreditPriceCard>;
export const CreditPriceScheduleEntrySchema = z.strictObject({
  effectiveFrom: PriceDate,
  // One key per CREDIT_TASKS member; a test keeps them equal.
  cards: z.strictObject({
    classify: CreditPriceCardSchema,
    factcheck: CreditPriceCardSchema.optional(),
    perspectives: CreditPriceCardSchema.optional(),
  }),
});
/** Read-only, so a parsed schedule is a `CreditPriceSchedule` every schedule helper takes as it is. */
export const CreditPriceScheduleSchema = z.array(CreditPriceScheduleEntrySchema).min(1).max(500).readonly();
/** Oldest first. A grant uses the step in effect when the account was created (`starterCreditAt`, decision PD4). */
export const StarterCreditStepSchema = z.strictObject({ from: z.iso.datetime(), amountMicros: Micros });
/** The amounts one purchase may add (`creditAmount`'s limits), the quick picks beside the field and the one preselected. */
export const PurchaseRulesSchema = z.strictObject({
  minMicros: Micros,
  maxMicros: Micros,
  presetsMicros: z.array(Micros).min(1).max(10).readonly(),
  defaultMicros: Micros,
});
/** Caps a billing module applies to automatic purchases: the most a person may set a month, and top-ups a UTC day. */
export const AutoReloadCapsSchema = z.strictObject({ monthlyLimitMaxMicros: Micros, perDay: z.number().int().min(1).max(100) });
export const PriceBookSchema = z.strictObject({
  schedule: CreditPriceScheduleSchema,
  starterCredit: z.array(StarterCreditStepSchema).min(1).max(500).readonly(),
  purchase: PurchaseRulesSchema,
  autoReload: AutoReloadCapsSchema,
});
/** What `/prices.json` answers: the book, its version ('0' for the code defaults) and the time of its newest change. */
export const PublishedPricesSchema = PriceBookSchema.extend({
  v: z.literal(1),
  version: Version,
  updatedAt: z.iso.datetime().nullable(),
});

export type StarterCreditStep = z.infer<typeof StarterCreditStepSchema>;
export type PurchaseRules = z.infer<typeof PurchaseRulesSchema>;
export type AutoReloadCaps = z.infer<typeof AutoReloadCapsSchema>;
/** Its `schedule` is a `CreditPriceSchedule` (a test assigns one to the other). */
export type PriceBook = z.infer<typeof PriceBookSchema>;
export type PublishedPrices = z.infer<typeof PublishedPricesSchema>;

/**
 * Today's constants as a book (deep-frozen): the code schedule itself, $1 of starter credit since 1970, purchases from
 * $5 to $500 with quick picks $5, $10 and $25 and $10 preselected, and auto-reload at most $1,000 a month and two
 * top-ups a UTC day (the billing module's CL6-05 caps, Tom 2026-10-17).
 */
export const DEFAULT_PRICE_BOOK: PriceBook = deepFreeze({
  schedule: CREDIT_PRICE_SCHEDULE,
  starterCredit: [{ from: '1970-01-01T00:00:00Z', amountMicros: STARTER_CREDIT.amountMicros }],
  purchase: {
    minMicros: CREDIT_AMOUNT_MIN_MICROS,
    maxMicros: CREDIT_AMOUNT_MAX_MICROS,
    presetsMicros: CREDIT_AMOUNT_PRESETS,
    defaultMicros: DEFAULT_CREDIT_AMOUNT,
  },
  autoReload: { monthlyLimitMaxMicros: 1_000_000_000, perDay: 2 },
});

/** The starter credit an account created at `at` gets. `RangeError` for an invalid Date or a book without a step. */
export function starterCreditAt(
  at: Date,
  book: Pick<PriceBook, 'starterCredit'>,
): { amountMicros: number; expiresAfterDays: number } {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new RangeError('The instant must be a valid Date.');
  // The last step that started at or before `at`; the first for an earlier instant.
  let found = book.starterCredit[0];
  if (found === undefined) throw new RangeError('The price book has no starter credit.');
  for (const step of book.starterCredit) if (Date.parse(step.from) <= t) found = step;
  return { amountMicros: found.amountMicros, expiresAfterDays: STARTER_CREDIT.expiresAfterDays };
}

/** `book` with the starter credit set to `amountMicros` from `now` (decision PD4), or `book` itself when it already is. */
export function withStarterCredit(book: PriceBook, amountMicros: number, now: Date): PriceBook {
  if (starterCreditAt(now, book).amountMicros === amountMicros) return book;
  const step = Object.freeze({ from: now.toISOString(), amountMicros });
  return Object.freeze({ ...book, starterCredit: Object.freeze([...book.starterCredit, step]) });
}

/** Whether `micros` is an amount one purchase may add under `rules`: `creditAmount` decides. */
const buys = (micros: number, rules: { minMicros: number; maxMicros: number }) => creditAmount({ micros }, rules) !== null;

/** The soundness of the starter credit, the purchase rules and the auto-reload caps. */
function partIssues(book: PriceBook): PriceIssue[] {
  const issues: PriceIssue[] = [];
  const starts = book.starterCredit.map((step) => Date.parse(step.from));
  if (starts.length === 0 || starts.some((t, i) => Number.isNaN(t) || (i > 0 && !(t > (starts[i - 1] as number))))) {
    issues.push({ code: 'starter-order', text: 'starterCredit: each step must start after the one before it' });
  }
  const { minMicros, maxMicros, presetsMicros, defaultMicros } = book.purchase;
  const rules = { minMicros, maxMicros };
  if (![minMicros, defaultMicros, maxMicros].every((micros) => buys(micros, rules))) {
    const text = 'purchase: minMicros ≤ defaultMicros ≤ maxMicros, each a whole number of dollars';
    issues.push({ code: 'purchase-order', text });
  }
  if (!presetsMicros.includes(defaultMicros)) {
    issues.push({ code: 'purchase-default', text: 'purchase: defaultMicros must be one of presetsMicros' });
  }
  const ascending = presetsMicros.every((micros, i) => i === 0 || micros > (presetsMicros[i - 1] as number));
  if (presetsMicros.length === 0 || !ascending || !presetsMicros.every((micros) => buys(micros, rules))) {
    const text = 'purchase: presetsMicros must be strictly ascending, each a whole number of dollars from minMicros to maxMicros';
    issues.push({ code: 'purchase-presets', text });
  }
  if (!buys(book.autoReload.monthlyLimitMaxMicros, { minMicros, maxMicros: Number.MAX_SAFE_INTEGER })) {
    const text = 'autoReload: monthlyLimitMaxMicros must be a whole number of dollars, at least purchase.minMicros';
    issues.push({ code: 'auto-reload-monthly', text });
  }
  return issues;
}

/** Every problem with the book on its own, as issues; `[]` when it is sound. Soundness only, never the bounds. */
export function priceBookIssues(book: PriceBook): PriceIssue[] {
  return [...priceScheduleIssues(book.schedule), ...partIssues(book)];
}

/** The bounds on every card of every head entry after `t`: a card in effect is never re-checked. */
function cardBoundIssues(schedule: CreditPriceSchedule, t: number): PriceIssue[] {
  const { multiplier, maxChargeMicros } = PRICE_BOUNDS;
  const issues: PriceIssue[] = [];
  schedule.forEach((entry, i) => {
    const e = entry.effectiveFrom;
    if (!(Date.parse(e) > t)) return;
    const at = `entry ${i} (${e})`;
    for (const [task, card] of Object.entries(entry.cards as Readonly<Record<string, CreditPriceCard | undefined>>)) {
      if (!card) continue;
      const about = { effectiveFrom: e, task };
      if (!(REFERENCE_MODELS as readonly string[]).includes(card.referenceModel)) {
        const text = `${at}: ${task} referenceModel must be one of ${REFERENCE_MODELS.join(', ')}`;
        issues.push({ code: 'reference-model-unknown', ...about, text });
      }
      if (!(card.multiplier >= multiplier.min && card.multiplier <= multiplier.max)) {
        const text = `${at}: ${task} multiplier must be from ${multiplier.min} to ${multiplier.max}`;
        issues.push({ code: 'multiplier-range', ...about, text });
      }
      if (card.maxChargeMicros !== undefined && card.maxChargeMicros > maxChargeMicros.max) {
        const text = `${at}: ${task} maxChargeMicros must be at most ${maxChargeMicros.max}`;
        issues.push({ code: 'cap-too-high', ...about, text });
      }
    }
  });
  return issues;
}

/** Steps are only ever added, one per save and never before `t` (decision PD4); the step added is held to the bounds. */
function starterIssues(base: PriceBook, head: PriceBook, t: number): PriceIssue[] {
  const was = base.starterCredit;
  const is = head.starterCredit;
  const kept = was.every((step, i) => step.from === is[i]?.from && step.amountMicros === is[i]?.amountMicros);
  const added = is.slice(was.length);
  if (!kept || added.length > 1 || added.some((step) => Date.parse(step.from) < t)) {
    const text = 'starterCredit: steps are only added, at most one per change, and none before now';
    return [{ code: 'starter-history', text }];
  }
  const amount = added[0]?.amountMicros;
  const { min, max, step } = PRICE_BOUNDS.starterMicros;
  if (amount === undefined || (Number.isSafeInteger(amount) && amount >= min && amount <= max && amount % step === 0)) return [];
  return [{ code: 'starter-range', text: `starterCredit: amountMicros must be from ${min} to ${max}, in steps of ${step}` }];
}

const samePurchase = (a: PurchaseRules, b: PurchaseRules) =>
  a.minMicros === b.minMicros &&
  a.maxMicros === b.maxMicros &&
  a.defaultMicros === b.defaultMicros &&
  a.presetsMicros.length === b.presetsMicros.length &&
  a.presetsMicros.every((micros, i) => micros === b.presetsMicros[i]);

/** Purchase and auto-reload changes apply at once (decisions PD5, PD6): the bounds only, when the part changes. */
function purchaseAndAutoReloadIssues(base: PriceBook, head: PriceBook): PriceIssue[] {
  const issues: PriceIssue[] = [];
  if (!samePurchase(base.purchase, head.purchase)) {
    const { purchaseMicros, presets } = PRICE_BOUNDS;
    const { minMicros, maxMicros, presetsMicros, defaultMicros } = head.purchase;
    if (
      ![minMicros, maxMicros, defaultMicros, ...presetsMicros].every((m) => m >= purchaseMicros.min && m <= purchaseMicros.max)
    ) {
      const text = `purchase: every amount must be from ${purchaseMicros.min} to ${purchaseMicros.max}`;
      issues.push({ code: 'purchase-range', text });
    }
    if (presetsMicros.length < presets.min || presetsMicros.length > presets.max) {
      issues.push({ code: 'purchase-presets', text: `purchase: from ${presets.min} to ${presets.max} presetsMicros` });
    }
  }
  const was = base.autoReload;
  const is = head.autoReload;
  if (was.perDay !== is.perDay || was.monthlyLimitMaxMicros !== is.monthlyLimitMaxMicros) {
    const { perDay, monthlyLimitMaxMicros } = PRICE_BOUNDS;
    if (!(Number.isInteger(is.perDay) && is.perDay >= perDay.min && is.perDay <= perDay.max)) {
      issues.push({ code: 'auto-reload-per-day', text: `autoReload: perDay must be from ${perDay.min} to ${perDay.max}` });
    }
    if (is.monthlyLimitMaxMicros > monthlyLimitMaxMicros.max) {
      const text = `autoReload: monthlyLimitMaxMicros must be at most ${monthlyLimitMaxMicros.max}`;
      issues.push({ code: 'auto-reload-monthly', text });
    }
  }
  return issues;
}

/**
 * What a save from `base` to `head` at `now` must pass, as issues; `[]` when it is allowed. In order: the head's
 * soundness (`priceBookIssues`); the schedule's change rules (`priceScheduleChangeIssues`), only for a sound head
 * schedule, since they would repeat its shape issues; the bounds on every card of every head entry after `now`; the
 * starter credit's history and the bounds on its new amount; and the bounds on the purchase rules and the auto-reload
 * caps when they change. Throws `RangeError` for an invalid Date, or unless `noticeDays` is a whole number, 0 or more.
 */
export function priceBookChangeIssues(
  base: PriceBook,
  head: PriceBook,
  now: Date,
  noticeDays: number = PRICE_NOTICE_DAYS,
): PriceIssue[] {
  const t = now.getTime();
  if (Number.isNaN(t)) throw new RangeError('The instant must be a valid Date.');
  if (!Number.isInteger(noticeDays) || noticeDays < 0) {
    throw new RangeError('The notice must be a whole number of days, 0 or more.');
  }
  const shape = priceScheduleIssues(head.schedule);
  const issues = [...shape, ...partIssues(head)];
  if (shape.length === 0) issues.push(...priceScheduleChangeIssues(base.schedule, head.schedule, now, noticeDays));
  issues.push(...cardBoundIssues(head.schedule, t), ...starterIssues(base, head, t));
  issues.push(...purchaseAndAutoReloadIssues(base, head));
  return issues;
}

/**
 * The admin contract (decision PD1): admins change a server's book one change at a time, each kept in its history.
 * The page is `ADMIN_PRICES_PAGE_PATH` (admin.ts). `baseVersion`: the version the admin's page showed (409 when the book
 * changed since).
 */
export const ADMIN_PRICES_PATH = '/v1/admin/prices';
/** `seed` is the server's own row: the defaults it stored before the first change (decision PD2). */
export const PRICE_CHANGE_ACTIONS = ['seed', 'schedule', 'cancel', 'move', 'starter', 'purchase', 'auto-reload'] as const;
export type PriceChangeAction = (typeof PRICE_CHANGE_ACTIONS)[number];
/** Newest first; the admin page shows at most this many. */
export const MAX_LISTED_PRICE_CHANGES = 200;
const Task = z.enum(CREDIT_TASKS);
export const PriceChangeRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('schedule'),
    baseVersion: Version,
    task: Task,
    effectiveFrom: PriceDate,
    card: CreditPriceCardSchema,
  }),
  z.strictObject({ action: z.literal('cancel'), baseVersion: Version, task: Task, effectiveFrom: PriceDate }),
  z.strictObject({ action: z.literal('move'), baseVersion: Version, task: Task, effectiveFrom: PriceDate, to: PriceDate }),
  z.strictObject({ action: z.literal('starter'), baseVersion: Version, amountMicros: Micros }),
  z.strictObject({ action: z.literal('purchase'), baseVersion: Version, purchase: PurchaseRulesSchema }),
  z.strictObject({ action: z.literal('auto-reload'), baseVersion: Version, autoReload: AutoReloadCapsSchema }),
]);
/** What a change changed: a card (schedule, cancel, move), an amount (starter), the purchase rules or the caps; null for seed. */
export const PriceChangeValueSchema = z
  .union([CreditPriceCardSchema, Micros, PurchaseRulesSchema, AutoReloadCapsSchema])
  .nullable();
export const PriceChangeSchema = z.object({
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  action: z.enum(PRICE_CHANGE_ACTIONS),
  task: Task.nullable(),
  effectiveFrom: PriceDate.nullable(),
  movedTo: PriceDate.nullable(),
  before: PriceChangeValueSchema,
  after: PriceChangeValueSchema,
  /** The admin's address; null once that account is deleted. The admin page only: never published (PD9). */
  by: z.string().max(254).nullable(),
});
export const AdminPricesSchema = z.object({
  prices: PublishedPricesSchema,
  changes: z.array(PriceChangeSchema).max(MAX_LISTED_PRICE_CHANGES),
  /** The server's clock when it answered: the page dates its checks and previews with it. */
  now: z.iso.datetime(),
  /** Whether this server charges (BILLING=module). */
  billing: z.boolean(),
});
/** The answer to a change: the book's version now. */
export const PriceChangedSchema = z.object({ ok: z.literal(true), version: Version });
export type PriceChangeRequest = z.infer<typeof PriceChangeRequestSchema>;
export type PriceChangeValue = z.infer<typeof PriceChangeValueSchema>;
export type PriceChange = z.infer<typeof PriceChangeSchema>;
export type AdminPrices = z.infer<typeof AdminPricesSchema>;
export type PriceChanged = z.infer<typeof PriceChangedSchema>;
