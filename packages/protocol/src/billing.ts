import { z } from 'zod';
import { CREDIT_PRICE_SCHEDULE, PRICE_NOTICE_DAYS } from './price-schedule.ts';
import { OriginPathSchema } from './server.ts';

export { CREDIT_PRICE_SCHEDULE, PRICE_NOTICE_DAYS };

/**
 * Tasks a server may charge credit for. Only ever added to (docs/release.md → Adding a task): a task is offered from the
 * first schedule entry that prices it (`taskPriceAt`).
 */
export const CREDIT_TASKS = ['classify', 'factcheck', 'perspectives'] as const;
export type CreditTask = (typeof CREDIT_TASKS)[number];
export const CREDIT_UNITS = ['post', 'check', 'comparison'] as const;
export type CreditUnit = (typeof CREDIT_UNITS)[number];
/** What each task is priced per: `referenceCostMicrosPer1000` is per 1,000 of these. */
export const TASK_UNITS: Readonly<Record<CreditTask, CreditUnit>> = Object.freeze({
  classify: 'post',
  factcheck: 'check',
  perspectives: 'comparison',
});

export interface CreditPriceCard {
  /**
   * Retail = our AI cost × multiplier, rounded up to a whole micro-dollar per request. Published on unalgorithm.app.
   * Whole basis points only (at most four decimal places, e.g. 1.15): `retailMicros` refuses anything finer.
   */
  multiplier: number;
  /** The model the published "about N posts" estimates assume; a key of PRICE_CARDS. */
  referenceModel: string;
  /** Our cost of 1,000 units of the task (posts classified, checks, comparisons) on that model, in micro-dollars. */
  referenceCostMicrosPer1000: number;
  /** Optional; when set it must be TASK_UNITS[task]. */
  unit?: CreditUnit;
  /** The most one job of the task is charged: the hold cap. Required for factcheck and perspectives, absent for classify. */
  maxChargeMicros?: number;
}

export interface CreditPriceScheduleEntry {
  /** 00:00:00 UTC of the first day the cards apply, written exactly `YYYY-MM-DDT00:00:00Z`. */
  effectiveFrom: string;
  /** Every entry prices classify; a task, once priced, is priced by every later entry. */
  cards: Readonly<{ classify: Readonly<CreditPriceCard> } & Partial<Record<CreditTask, Readonly<CreditPriceCard>>>>;
}

/**
 * The dated credit prices (`CREDIT_PRICE_SCHEDULE`, in price-schedule.ts): oldest first, strictly ascending; an entry
 * applies from its effectiveFrom until the next entry's. The only place a multiplier is stated: the Cloud, the account
 * page, the website and the extension all read the entry in effect at an instant from here.
 */
export type CreditPriceSchedule = readonly Readonly<CreditPriceScheduleEntry>[];

/** $1 of promotional credit, once per verified account, expiring 90 days after it is granted (R29). */
export const STARTER_CREDIT = Object.freeze({ amountMicros: 1_000_000, expiresAfterDays: 90 });
/** Under this (and above 0) a balance is "low": the extension may show its once-a-day banner (R31). */
export const LOW_BALANCE_MICROS = 200_000;
export const MAX_CREDIT_HISTORY = 200;

/** GET with the device's bearer token (extension). */
export const CREDIT_BALANCE_PATH = '/v1/billing/balance';
/** GET with the web session (account page). */
export const CREDIT_ACCOUNT_PATH = '/v1/billing/account';
/** The account page (apps/web) every server serves. */
export const ACCOUNT_PAGE_PATH = '/account';

const BASIS_POINTS = 10_000;

/**
 * Retail price of a request in micro-dollars: `costMicros × multiplier`, rounded up to a whole micro-dollar. Integer
 * arithmetic in basis points, never `Math.ceil(costMicros * multiplier)`: 1.1 is not exact in binary floating point, so
 * that would charge 111 for a cost of 100. Throws `RangeError` for a negative or fractional cost, a multiplier that is
 * not a positive whole number of basis points, or a product too large to compute exactly.
 */
export function retailMicros(costMicros: number, multiplier: number): number {
  const bp = Math.round(multiplier * BASIS_POINTS);
  if (!Number.isSafeInteger(bp) || bp <= 0 || Math.abs(multiplier * BASIS_POINTS - bp) >= 1e-6) {
    throw new RangeError('The multiplier must be positive, in whole basis points.');
  }
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
    throw new RangeError('The cost must be a whole number of micro-dollars, 0 or more.');
  }
  const scaled = costMicros * bp + (BASIS_POINTS - 1);
  if (!Number.isSafeInteger(scaled)) throw new RangeError('The cost is too large to price exactly.');
  return Math.floor(scaled / BASIS_POINTS);
}

const DAY_MS = 86_400_000;
const MIDNIGHT_UTC = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;

type Cards = Readonly<Record<string, Readonly<CreditPriceCard> | undefined>>;
/** An entry's cards by task name: the schedule helpers read whatever tasks the cards they are given price. */
const cardsOf = (entry: Readonly<CreditPriceScheduleEntry>): Cards => entry.cards;

/** `at` in epoch milliseconds; a `RangeError` for an invalid Date. `packages/protocol` never reads the clock itself. */
function instant(at: Date): number {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new RangeError('The instant must be a valid Date.');
  return t;
}

/** An instant as an entry writes it: `2026-11-15T00:00:00Z`, never `.000Z`. */
function iso(t: number): string {
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

/**
 * The entry in effect at `at`: the last whose effectiveFrom is at or before it. An instant before the first entry gets
 * the first (only a device clock set far back reaches it, and the pill and the account page must not crash on one).
 * Throws `RangeError` for an invalid Date or an empty schedule.
 */
export function priceCardsAt(
  at: Date,
  schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE,
): Readonly<CreditPriceScheduleEntry> {
  const t = instant(at);
  let found = schedule[0];
  if (found === undefined) throw new RangeError('The price schedule is empty.');
  for (const entry of schedule) if (Date.parse(entry.effectiveFrom) <= t) found = entry;
  return found;
}

/** The first entry that starts after `at`, or null when no change is scheduled. */
export function nextPriceChange(
  at: Date,
  schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE,
): Readonly<CreditPriceScheduleEntry> | null {
  const t = instant(at);
  return schedule.find((entry) => Date.parse(entry.effectiveFrom) > t) ?? null;
}

export type TaskPrice = { offered: false } | { offered: true; card: Readonly<CreditPriceCard>; effectiveFrom: string };

/** The card in effect for `task` at `at`, or "not offered" before the task's first entry. RangeError for an invalid Date. */
export function taskPriceAt(at: Date, task: CreditTask, schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE): TaskPrice {
  const entry = priceCardsAt(at, schedule);
  const card = cardsOf(entry)[task];
  return card ? { offered: true, card, effectiveFrom: entry.effectiveFrom } : { offered: false };
}

export interface JobPrice {
  typicalMicros: number;
  maxMicros: number;
}

/** The retail price of one unit (a check, a comparison) at the card's reference cost. */
function typicalMicros(card: Readonly<CreditPriceCard>): number {
  return retailMicros(Math.ceil(card.referenceCostMicrosPer1000 / 1000), card.multiplier);
}

/**
 * typicalMicros = retailMicros(ceil(referenceCostMicrosPer1000 / 1000), multiplier); maxMicros = maxChargeMicros. Null
 * when not offered (or, on a schedule that fails the shape check, when the card has no hold cap).
 */
export function jobPriceAt(
  at: Date,
  task: Exclude<CreditTask, 'classify'>,
  schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE,
): JobPrice | null {
  const price = taskPriceAt(at, task, schedule);
  if (!price.offered || price.card.maxChargeMicros === undefined) return null;
  return { typicalMicros: typicalMicros(price.card), maxMicros: price.card.maxChargeMicros };
}

/** What 1,000 posts of the task cost a person on the reference model at `at` (146,000 micro-dollars at launch). */
export function retailMicrosPer1000Posts(
  at: Date,
  task: 'classify' = 'classify',
  schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE,
): number {
  const card = priceCardsAt(at, schedule).cards[task];
  return retailMicros(card.referenceCostMicrosPer1000, card.multiplier);
}

/**
 * "About N posts" a balance buys at `at`, rounded down (to two significant digits from 100 up) so it never promises
 * more posts than the balance pays for. Exact for balances under about $9 million. $0 reads neither `at` nor the
 * schedule.
 */
export function estimatePosts(
  balanceMicros: number,
  at: Date,
  task: 'classify' = 'classify',
  schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE,
): number {
  if (!Number.isFinite(balanceMicros) || balanceMicros <= 0) return 0;
  let n = Math.floor((balanceMicros * 1000) / retailMicrosPer1000Posts(at, task, schedule));
  if (n >= 100) {
    const p = 10 ** (String(n).length - 2);
    n = Math.floor(n / p) * p;
  }
  return n;
}

function isMidnightUtc(e: string): boolean {
  if (typeof e !== 'string' || !MIDNIGHT_UTC.test(e)) return false;
  const t = Date.parse(e);
  // Rejects a day the calendar does not have (2026-02-30 would roll over to 2 March).
  return !Number.isNaN(t) && new Date(t).toISOString() === e.replace('Z', '.000Z');
}

const isCreditTask = (task: string): task is CreditTask => (CREDIT_TASKS as readonly string[]).includes(task);

/**
 * One string per problem with the schedule's shape, entries numbered from 0; `[]` when it is sound. Tasks are only ever
 * added: every entry prices classify and every task the entry before it priced, and an entry that adds a task copies
 * the other cards unchanged. There is deliberately no rule that the last entry prices every task.
 */
export function priceScheduleProblems(schedule: CreditPriceSchedule): string[] {
  if (schedule.length === 0) return ['the schedule is empty'];
  const problems: string[] = [];
  let previous: number | undefined; // the previous entry's start, when its date passed the format check
  let before: Cards | undefined; // the previous entry's cards
  schedule.forEach((entry, i) => {
    const e = entry.effectiveFrom;
    const at = `entry ${i} (${e})`;
    const valid = isMidnightUtc(e);
    if (!valid) problems.push(`${at}: effectiveFrom must be YYYY-MM-DDT00:00:00Z on a real calendar day`);
    else if (previous !== undefined && Date.parse(e) <= previous) {
      problems.push(`${at}: effectiveFrom must be later than entry ${i - 1}'s`);
    }
    previous = valid ? Date.parse(e) : undefined;

    const cards = cardsOf(entry);
    // A task key whose card is missing (null, undefined) prices nothing.
    const priced = (c: Cards, task: string) => Object.hasOwn(c, task) && typeof c[task] === 'object' && c[task] !== null;
    for (const task of Object.keys(cards)) if (!isCreditTask(task)) problems.push(`${at}: ${task} is not a credit task`);
    if (!priced(cards, 'classify')) problems.push(`${at}: cards must price classify`);
    if (before !== undefined) {
      const was = before;
      // A missing classify is reported once, above.
      for (const task of Object.keys(was)) {
        if (task !== 'classify' && priced(was, task) && !priced(cards, task))
          problems.push(`${at}: drops ${task}, which entry ${i - 1} priced`);
      }
      const added = Object.keys(cards).filter((task) => priced(cards, task) && !priced(was, task));
      const kept = Object.keys(was).filter((task) => priced(was, task) && priced(cards, task));
      if (added.length > 0 && !kept.every((task) => sameCard(was[task], cards[task]))) {
        problems.push(`${at}: adds ${added.join(', ')}, so its other cards must equal entry ${i - 1}'s`);
      }
    }
    before = cards;
    for (const [task, card] of Object.entries(cards)) {
      if (!card) continue;
      try {
        retailMicros(1, card.multiplier);
      } catch {
        problems.push(`${at}: ${task} multiplier must be positive, in whole basis points`);
      }
      if (!Number.isSafeInteger(card.referenceCostMicrosPer1000) || card.referenceCostMicrosPer1000 <= 0) {
        problems.push(`${at}: ${task} referenceCostMicrosPer1000 must be a whole number above 0`);
      }
      if (typeof card.referenceModel !== 'string' || card.referenceModel.trim() === '') {
        problems.push(`${at}: ${task} referenceModel must be a non-empty model id`);
      }
      if (!isCreditTask(task)) continue;
      const unit = TASK_UNITS[task];
      if (card.unit !== unit && (card.unit !== undefined || task !== 'classify')) {
        problems.push(`${at}: ${task} unit must be ${unit}`);
      }
      if (task === 'classify') {
        if (card.maxChargeMicros !== undefined) problems.push(`${at}: classify has no maxChargeMicros`);
        continue;
      }
      let typical = 1;
      try {
        typical = typicalMicros(card);
      } catch {
        // The multiplier or the cost is already reported above.
      }
      const cap = card.maxChargeMicros;
      if (cap === undefined || !Number.isSafeInteger(cap) || cap <= 0 || cap < typical) {
        problems.push(
          `${at}: ${task} maxChargeMicros must be a whole number of micro-dollars, at least its typical price of ${typical}`,
        );
      }
    }
  });
  return problems;
}

/** The same multiplier, reference model, reference cost, unit and hold cap. */
function sameCard(p: Readonly<CreditPriceCard> | undefined, q: Readonly<CreditPriceCard> | undefined): boolean {
  return (
    p !== undefined &&
    q !== undefined &&
    p !== null &&
    q !== null &&
    p.multiplier === q.multiplier &&
    p.referenceModel === q.referenceModel &&
    p.referenceCostMicrosPer1000 === q.referenceCostMicrosPer1000 &&
    p.unit === q.unit &&
    p.maxChargeMicros === q.maxChargeMicros
  );
}

/** The same task keys, and per task the same card (`sameCard`). */
function sameCards(a: Readonly<CreditPriceScheduleEntry>, b: Readonly<CreditPriceScheduleEntry>): boolean {
  const x = cardsOf(a);
  const y = cardsOf(b);
  const tasks = Object.keys(x);
  return tasks.length === Object.keys(y).length && tasks.every((task) => sameCard(x[task], y[task]));
}

function checkNotice(noticeDays: number): void {
  if (!Number.isInteger(noticeDays) || noticeDays < 0) {
    throw new RangeError('The notice must be a whole number of days, 0 or more.');
  }
}

/**
 * The CI rule for a change from `base` to `head` at `now` (docs/release.md → Changing a price card). Problems, or `[]`
 * when the change is allowed. The head's shape comes first and alone. Rule 1: a base entry in effect stays on the head
 * unchanged. Rule 2a: a new or changed entry starts after `now`. Rule 2b (`priceRaisesWithinNotice`, only when nothing
 * else failed): no raise within `noticeDays`. A base entry not yet in effect may be removed (a cancellation), which 2b
 * still compares. `rules: 'in-effect'` reports rule 1 only: the release check, which cannot see when a change merged.
 * Throws `RangeError` unless `noticeDays` is a whole number, 0 or more.
 */
export function checkPriceScheduleChange(
  base: CreditPriceSchedule,
  head: CreditPriceSchedule,
  now: Date,
  noticeDays: number = PRICE_NOTICE_DAYS,
  rules: 'all' | 'in-effect' = 'all',
): string[] {
  checkNotice(noticeDays);
  const t = instant(now);
  const shape = priceScheduleProblems(head);
  if (shape.length > 0) return shape.map((problem) => `head: ${problem}`);

  const problems: string[] = [];
  const changed = new Set<string>();
  for (const entry of base) {
    const e = entry.effectiveFrom;
    if (!(Date.parse(e) <= t)) continue;
    const kept = head.find((h) => h.effectiveFrom === e);
    if (!kept) problems.push(`${e}: this price is in effect and cannot be removed`);
    else if (!sameCards(entry, kept)) {
      problems.push(`${e}: this price is in effect and cannot change; add a new dated entry instead`);
      changed.add(e);
    }
  }
  if (rules === 'in-effect') return problems;

  const tomorrow = iso(Math.floor(t / DAY_MS) * DAY_MS + DAY_MS);
  for (const entry of head) {
    const e = entry.effectiveFrom;
    if (changed.has(e) || Date.parse(e) > t) continue;
    if (base.some((b) => b.effectiveFrom === e && sameCards(b, entry))) continue;
    problems.push(`${e}: a new or changed price cannot start in the past; the earliest effectiveFrom allowed now is ${tomorrow}`);
  }
  return problems.length > 0 ? problems : priceRaisesWithinNotice(base, head, now, noticeDays);
}

/**
 * Rule 2b alone, for schedules already checked: inside the notice window no task charges or publishes more than on the
 * base, or rises where the base does not. Throws RangeError unless noticeDays is a whole number, 0 or more.
 *
 * The window is `[now, now + noticeDays)`. Prices only change at an effectiveFrom, so the two schedules are compared at
 * `now` and at every effectiveFrom of either inside the window. Tasks are compared one by one, each on its multiplier
 * (what is charged), its price per 1,000 units (what is published) and its hold cap (`maxChargeMicros`, the most one
 * job is charged). A task's first card is not a raise.
 */
export function priceRaisesWithinNotice(
  base: CreditPriceSchedule,
  head: CreditPriceSchedule,
  now: Date,
  noticeDays: number = PRICE_NOTICE_DAYS,
): string[] {
  checkNotice(noticeDays);
  const t0 = instant(now);
  if (base.length === 0 || head.length === 0) return [];
  const end = t0 + noticeDays * DAY_MS;
  const earliest = iso(Math.ceil(end / DAY_MS) * DAY_MS);
  const notice = `a price raise needs ${noticeDays} days' notice: the earliest effectiveFrom allowed now for it is ${earliest}`;
  const starts = [...base, ...head].map((entry) => Date.parse(entry.effectiveFrom)).filter((t) => t > t0 && t < end);
  const instants = [...new Set([t0, ...starts])].sort((a, b) => a - b);
  const retail = (card: Readonly<CreditPriceCard>) => retailMicros(card.referenceCostMicrosPer1000, card.multiplier);
  const higherCap = (x: Readonly<CreditPriceCard> | undefined, y: Readonly<CreditPriceCard> | undefined) =>
    !!x && !!y && x.maxChargeMicros !== undefined && y.maxChargeMicros !== undefined && x.maxChargeMicros > y.maxChargeMicros;

  const problems: string[] = [];
  for (const t of instants) {
    const at = iso(t);
    const baseCards = cardsOf(priceCardsAt(new Date(t), base));
    const baseBefore = cardsOf(priceCardsAt(new Date(t - 1), base));
    const headBefore = cardsOf(priceCardsAt(new Date(t - 1), head));
    for (const [task, h] of Object.entries(cardsOf(priceCardsAt(new Date(t), head)))) {
      if (!h) continue;
      // b: the base's card at t; p: the head's just before t; q: the base's just before t. A missing one is the task not
      // yet offered there. A task's first card is no raise, but once either side has a card for it, a higher one is: the
      // head is compared with the base's card when there is one, and with its own card just before t when there is one.
      const b = baseCards[task] || undefined;
      const p = t === t0 ? undefined : headBefore[task] || undefined;
      const q = baseBefore[task] || undefined;
      const capRaisedFrom = higherCap(h, b) ? b : higherCap(h, p) && !higherCap(b, q) ? p : undefined;
      if (capRaisedFrom) {
        problems.push(
          `${at}: ${task} would raise its maximum charge from ${capRaisedFrom.maxChargeMicros} to ${h.maxChargeMicros} micro-dollars; ${notice}`,
        );
      }
      const hRetail = retail(h);
      const bRetail = b ? retail(b) : undefined;
      if (b && bRetail !== undefined && (h.multiplier > b.multiplier || hRetail > bRetail)) {
        problems.push(
          `${at}: ${task} would go from multiplier ${b.multiplier} and ${bRetail} micro-dollars per 1,000 posts to multiplier ${h.multiplier} and ${hRetail}; ${notice}`,
        );
        continue;
      }
      if (!p) continue;
      const pRetail = retail(p);
      const baseRisesMultiplier = !!b && !!q && b.multiplier > q.multiplier;
      const baseRisesRetail = bRetail !== undefined && !!q && bRetail > retail(q);
      if ((h.multiplier > p.multiplier && !baseRisesMultiplier) || (hRetail > pRetail && !baseRisesRetail)) {
        problems.push(
          `${at}: ${task} would rise from multiplier ${p.multiplier} and ${pRetail} micro-dollars per 1,000 posts just before it to multiplier ${h.multiplier} and ${hRetail}, a rise the base does not have then; ${notice}`,
        );
      }
    }
  }
  return problems;
}

const Micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SignedMicros = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/** Whether the person's one starter credit is still held, used up, expired, or not on offer to them. */
export const STARTER_STATUSES = ['active', 'spent', 'expired', 'unavailable'] as const;
export type StarterStatus = (typeof STARTER_STATUSES)[number];

/** Promotional credit is reported apart from purchased credit (R28); the two always add up to the balance. */
export const CreditBalanceSchema = z
  .object({
    v: z.literal(1),
    balanceMicros: Micros,
    promoMicros: Micros,
    purchasedMicros: Micros,
    /** Expiry of the earliest-expiring promotional credit still held; null when none expires. */
    promoExpiresAt: z.iso.datetime().nullable(),
    starter: z.enum(STARTER_STATUSES),
  })
  .refine((b) => b.balanceMicros === b.promoMicros + b.purchasedMicros, { path: ['balanceMicros'] });
export type CreditBalance = z.infer<typeof CreditBalanceSchema>;

export const CREDIT_ENTRY_KINDS = ['grant', 'usage', 'adjustment'] as const;
export type CreditEntryKind = (typeof CREDIT_ENTRY_KINDS)[number];
export const CREDIT_ENTRY_REASONS = [
  'starter-credit',
  'classify',
  'factcheck',
  'perspectives',
  'promo-expired',
  'correction',
  'goodwill',
] as const;
export type CreditEntryReason = (typeof CREDIT_ENTRY_REASONS)[number];

const REASONS_BY_KIND: Readonly<Record<CreditEntryKind, readonly CreditEntryReason[]>> = {
  grant: ['starter-credit'],
  usage: CREDIT_TASKS,
  adjustment: ['promo-expired', 'correction', 'goodwill'],
};

function reasonFitsKind(item: { kind: CreditEntryKind; reason: CreditEntryReason }): boolean {
  return REASONS_BY_KIND[item.kind].includes(item.reason);
}

/** One line of the account page's history: a grant, an adjustment, or one day's usage of a task. */
export const CreditHistoryItemSchema = z
  .object({
    kind: z.enum(CREDIT_ENTRY_KINDS),
    reason: z.enum(CREDIT_ENTRY_REASONS),
    amountMicros: SignedMicros,
    /** The entry's time; for usage, 00:00 UTC of the day the line sums. */
    at: z.iso.datetime(),
    /** Usage lines only: units used that day (posts classified, checks or comparisons). */
    posts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine(reasonFitsKind, { path: ['reason'] })
  .refine((item) => item.kind !== 'usage' || item.posts !== undefined, { path: ['posts'] });
export type CreditHistoryItem = z.infer<typeof CreditHistoryItemSchema>;

/** What the account page shows: the balance and the history, newest first. */
export const CreditAccountSchema = z.object({
  v: z.literal(1),
  balance: CreditBalanceSchema,
  history: z.array(CreditHistoryItemSchema).max(MAX_CREDIT_HISTORY),
  /** Where the server explains its prices; https only. */
  pricingUrl: z.url({ protocol: /^https$/ }).optional(),
  /** A page on this server where credit can be added; absent while adding credit is not offered (all of CL2). */
  addCreditPath: OriginPathSchema.optional(),
});
export type CreditAccount = z.infer<typeof CreditAccountSchema>;
