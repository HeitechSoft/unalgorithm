import { z } from 'zod';
import { CREDIT_PRICE_SCHEDULE, PRICE_NOTICE_DAYS } from './price-schedule.ts';
import { OriginPathSchema } from './server.ts';

export { CREDIT_PRICE_SCHEDULE, PRICE_NOTICE_DAYS };

/** Tasks the Cloud charges credit for. Phase 3 adds fact-check and perspectives (additive). */
export const CREDIT_TASKS = ['classify'] as const;
export type CreditTask = (typeof CREDIT_TASKS)[number];

export interface CreditPriceCard {
  /**
   * Retail = our AI cost × multiplier, rounded up to a whole micro-dollar per request. Published on unalgorithm.app.
   * Whole basis points only (at most four decimal places, e.g. 1.15): `retailMicros` refuses anything finer.
   */
  multiplier: number;
  /** The model the published "about N posts" estimates assume; a key of PRICE_CARDS. */
  referenceModel: string;
  /** Our cost of classifying 1,000 posts on that model, warm cache, in micro-dollars. */
  referenceCostMicrosPer1000: number;
}

export interface CreditPriceScheduleEntry {
  /** 00:00:00 UTC of the first day the cards apply, written exactly `YYYY-MM-DDT00:00:00Z`. */
  effectiveFrom: string;
  cards: Readonly<Record<CreditTask, Readonly<CreditPriceCard>>>;
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

/** What 1,000 posts of the task cost a person on the reference model at `at` (146,000 micro-dollars at launch). */
export function retailMicrosPer1000Posts(
  at: Date,
  task: CreditTask = 'classify',
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
  task: CreditTask = 'classify',
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

/** One string per problem with the schedule's shape, entries numbered from 0; `[]` when it is sound. */
export function priceScheduleProblems(schedule: CreditPriceSchedule): string[] {
  if (schedule.length === 0) return ['the schedule is empty'];
  const problems: string[] = [];
  let previous: number | undefined; // the previous entry's start, when its date passed the format check
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
    const tasks = Object.keys(cards);
    // A task key whose card is missing (null, undefined) prices nothing: the readers would crash on it.
    const priced = (task: string) => Object.hasOwn(cards, task) && typeof cards[task] === 'object' && cards[task] !== null;
    if (tasks.length !== CREDIT_TASKS.length || !CREDIT_TASKS.every(priced)) {
      problems.push(`${at}: cards must price exactly ${CREDIT_TASKS.join(', ')}`);
    }
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
    }
  });
  return problems;
}

/** The same task keys, and per task the same multiplier, reference model and reference cost. */
function sameCards(a: Readonly<CreditPriceScheduleEntry>, b: Readonly<CreditPriceScheduleEntry>): boolean {
  const x = cardsOf(a);
  const y = cardsOf(b);
  const tasks = Object.keys(x);
  return (
    tasks.length === Object.keys(y).length &&
    tasks.every((task) => {
      const p = x[task];
      const q = y[task];
      return (
        p !== undefined &&
        q !== undefined &&
        p.multiplier === q.multiplier &&
        p.referenceModel === q.referenceModel &&
        p.referenceCostMicrosPer1000 === q.referenceCostMicrosPer1000
      );
    })
  );
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
 * (what is charged) and its price per 1,000 posts (what is published).
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

  const problems: string[] = [];
  for (const t of instants) {
    const at = iso(t);
    const baseCards = cardsOf(priceCardsAt(new Date(t), base));
    const baseBefore = cardsOf(priceCardsAt(new Date(t - 1), base));
    const headBefore = cardsOf(priceCardsAt(new Date(t - 1), head));
    for (const [task, h] of Object.entries(cardsOf(priceCardsAt(new Date(t), head)))) {
      const b = baseCards[task];
      const p = headBefore[task];
      if (!h || !b || !p) continue; // no earlier price to raise
      const [hRetail, bRetail, pRetail] = [retail(h), retail(b), retail(p)];
      if (h.multiplier > b.multiplier || hRetail > bRetail) {
        problems.push(
          `${at}: ${task} would go from multiplier ${b.multiplier} and ${bRetail} micro-dollars per 1,000 posts to multiplier ${h.multiplier} and ${hRetail}; ${notice}`,
        );
        continue;
      }
      if (t === t0) continue;
      const q = baseBefore[task];
      const baseRisesMultiplier = q !== undefined && b.multiplier > q.multiplier;
      const baseRisesRetail = q !== undefined && bRetail > retail(q);
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
export const CREDIT_ENTRY_REASONS = ['starter-credit', 'classify', 'promo-expired', 'correction', 'goodwill'] as const;
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
    /** Usage lines only: posts classified that day. */
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
