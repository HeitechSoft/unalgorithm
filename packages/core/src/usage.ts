import {
  addUsage,
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceSchedule,
  costMicros,
  estimatePosts,
  MAX_MODEL_CHARS,
  type NormalizedUsage,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { clipText, dateKey } from './util.ts';

export interface ModelUsage {
  calls: number;
  usage: NormalizedUsage;
}

export interface DayUsage {
  /** Posts classified by sources that count toward the daily cap. */
  posts: number;
  calls: number;
  failedCalls: number;
  byModel: Record<string, ModelUsage>;
  /** Sum of the day's batch charges, in micro-dollars; absent on a day without one. */
  chargedMicros?: number;
  /** The day's charged batches, newest first, at most `MAX_DAY_BATCHES`; absent on a day without one. */
  batches?: BatchCharge[];
}

/** What a billing server charged for the batch a post was classified in (the ledger's amount, to the micro-dollar). */
export interface PostCharge {
  batchPosts: number;
  chargedMicros: number;
}

/** One charged batch in the day's usage. `at`: ISO time the answer arrived; `posts`: posts the server classified. */
export interface BatchCharge {
  at: string;
  posts: number;
  chargedMicros: number;
}

export const MAX_DAY_BATCHES = 50;

/** date (YYYY-MM-DD) → usage. Kept for 30 days. */
export type UsageLedger = Record<string, DayUsage>;

const KEEP_DAYS = 30;

export function emptyDay(): DayUsage {
  return { posts: 0, calls: 0, failedCalls: 0, byModel: {} };
}

/**
 * Record one AI call, including failed ones (tokens were still spent). The model name comes from a provider or a server,
 * so it is cut to `MAX_MODEL_CHARS` here, for every source: a long one cannot fill the extension's storage.
 */
export function recordUsage(
  ledger: UsageLedger,
  entry: { model: string; usage: NormalizedUsage; posts: number; failed?: boolean; chargedMicros?: number; now?: Date },
): UsageLedger {
  const now = entry.now ?? new Date();
  const date = dateKey(now);
  const day = ledger[date] ?? emptyDay();
  const model = clipText(entry.model, MAX_MODEL_CHARS);
  const prev = day.byModel[model] ?? { calls: 0, usage: ZERO_USAGE };
  const next: UsageLedger = {
    ...ledger,
    [date]: {
      posts: day.posts + entry.posts,
      calls: day.calls + 1,
      failedCalls: day.failedCalls + (entry.failed ? 1 : 0),
      byModel: { ...day.byModel, [model]: { calls: prev.calls + 1, usage: addUsage(prev.usage, entry.usage) } },
      ...charges(day, entry.chargedMicros, entry.posts, now),
    },
  };
  const keep = new Set(Array.from({ length: KEEP_DAYS }, (_, i) => dateKey(new Date(now.getTime() - i * 86_400_000))));
  for (const d of Object.keys(next)) if (!keep.has(d)) delete next[d];
  return next;
}

/**
 * The day's charge fields after a call: carried over unchanged when the call has no valid charge (a failed or own-key
 * call keeps the day's batches), and absent on a day that never had one. The server is not trusted: only a safe
 * integer >= 0 counts.
 */
function charges(
  day: DayUsage,
  charged: number | undefined,
  posts: number,
  now: Date,
): Pick<DayUsage, 'chargedMicros' | 'batches'> {
  const kept = {
    ...(day.chargedMicros !== undefined ? { chargedMicros: day.chargedMicros } : {}),
    ...(day.batches !== undefined ? { batches: day.batches } : {}),
  };
  if (charged === undefined || !Number.isSafeInteger(charged) || charged < 0) return kept;
  return {
    chargedMicros: (day.chargedMicros ?? 0) + charged,
    batches: [{ at: now.toISOString(), posts, chargedMicros: charged }, ...(day.batches ?? [])].slice(0, MAX_DAY_BATCHES),
  };
}

export function dayUsage(ledger: UsageLedger, now = new Date()): DayUsage {
  return ledger[dateKey(now)] ?? emptyDay();
}

/** Estimated spend for a day in micro-dollars; undefined when a model has no known price. */
export function dayCostMicros(day: DayUsage): number | undefined {
  let total = 0;
  for (const [model, m] of Object.entries(day.byModel)) {
    const c = costMicros(model, m.usage);
    if (c === undefined) return undefined;
    total += c;
  }
  return total;
}

/** "about 4¢", "about $1.20", "less than 1¢". */
export function formatApproxCost(micros: number): string {
  const cents = micros / 10_000;
  if (cents < 1) return 'less than 1¢';
  if (cents < 100) return `about ${Math.round(cents)}¢`;
  return `about $${(cents / 100).toFixed(2)}`;
}

const MICROS_PER_CENT = 10_000;
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Whole cents in a non-negative whole number of micro-dollars, rounded down, without floating-point division. */
function wholeCents(micros: number): number {
  return (micros - (micros % MICROS_PER_CENT)) / MICROS_PER_CENT;
}

/** "$0.97", "$1,234.56". */
function dollars(cents: number): string {
  return `$${GROUPED.format(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, '0')}`;
}

/** A credit balance, floored to the cent so it is never overstated: "$0.00", "<$0.01", "$1,234.56". */
export function formatBalance(micros: number): string {
  if (!(micros > 0)) return '$0.00';
  if (micros < MICROS_PER_CENT) return '<$0.01';
  return dollars(wholeCents(Math.floor(micros)));
}

/** A price, rounded half up to the cent: "$0.15" for 146,000; "<$0.01" when above 0 but under half a cent; "$0.00" for 0 or less. */
export function formatPrice(micros: number): string {
  if (!(micros > 0)) return '$0.00';
  const cents = wholeCents(Math.floor(micros) + MICROS_PER_CENT / 2);
  return cents === 0 ? '<$0.01' : dollars(cents);
}

/** A batch's charge: "$0.15" from one cent up; "$0.0018" under a cent; "<$0.0001" above 0 and under 50 micro-dollars; "$0.00" for 0 or less. */
export function formatCharge(micros: number): string {
  if (!(micros > 0)) return '$0.00';
  const r = Math.floor((Math.floor(micros) + 50) / 100);
  if (r === 0) return '<$0.0001';
  if (r < 100) return `$0.${String(r).padStart(4, '0')}`;
  return formatPrice(micros);
}

/** A history amount, rounded half up to the cent: "+$1.00", "−$0.06", "−<$0.01", "$0.00". */
export function formatCreditAmount(micros: number): string {
  if (micros === 0) return '$0.00';
  const sign = micros > 0 ? '+' : '−'; // MINUS SIGN, not a hyphen
  return `${sign}${formatPrice(Math.abs(micros))}`;
}

/** "no posts", "about 1 post", "about 6,600 posts". */
export function formatPostsEstimate(posts: number): string {
  if (posts <= 0) return 'no posts';
  if (posts === 1) return 'about 1 post';
  return `about ${GROUPED.format(posts)} posts`;
}

/**
 * The balance wording every surface shows: "$0.97 left · about 6,600 posts", or "$0.00 left". The estimate uses the
 * price card in effect at `at` (the surface passes the time it shows the line).
 */
export function balanceLine(balanceMicros: number, at: Date, schedule: CreditPriceSchedule = CREDIT_PRICE_SCHEDULE): string {
  if (!(balanceMicros > 0)) return '$0.00 left';
  return `${formatBalance(balanceMicros)} left · ${formatPostsEstimate(estimatePosts(balanceMicros, at, 'classify', schedule))}`;
}
