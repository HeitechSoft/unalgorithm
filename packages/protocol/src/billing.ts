import { z } from 'zod';
import { OriginPathSchema } from './server.ts';

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

/**
 * Spec → Monetization: classify 1,000 posts on Haiku 5.5 ≈ $0.073, multiplier 2.0×, retail ≈ $0.15. The only place a
 * multiplier is stated: the Cloud, the account page, the website and the extension all read it from here.
 */
export const CREDIT_PRICE_CARDS: Readonly<Record<CreditTask, Readonly<CreditPriceCard>>> = Object.freeze({
  classify: Object.freeze({ multiplier: 2, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73_000 }),
});

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

/** What 1,000 posts of the task cost a person on the reference model (146,000 micro-dollars for classify). */
export function retailMicrosPer1000Posts(task: CreditTask = 'classify'): number {
  const card = CREDIT_PRICE_CARDS[task];
  return retailMicros(card.referenceCostMicrosPer1000, card.multiplier);
}

/**
 * "About N posts" a balance buys, rounded down (to two significant digits from 100 up) so it never promises more posts
 * than the balance pays for. Exact for balances under about $9 million.
 */
export function estimatePosts(balanceMicros: number, task: CreditTask = 'classify'): number {
  if (!Number.isFinite(balanceMicros) || balanceMicros <= 0) return 0;
  let n = Math.floor((balanceMicros * 1000) / retailMicrosPer1000Posts(task));
  if (n >= 100) {
    const p = 10 ** (String(n).length - 2);
    n = Math.floor(n / p) * p;
  }
  return n;
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
