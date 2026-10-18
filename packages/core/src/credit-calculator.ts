/**
 * The website's credit calculator (CL5-09): "how long does $N of credit last at my usage", for any amount a purchase may
 * be. Its data is computed at build time by `calculatorData` (`credit-facts.ts`, with the protocol); this module is what
 * runs in the browser, so it has no runtime import (the island imports `@unalgorithm/core/credit-calculator`, never the
 * protocol, which would bundle zod).
 */
export interface CalculatorData {
  /** The amount rules (`creditAmount` in the protocol), in whole US dollars. */
  amount: {
    minDollars: number;
    maxDollars: number;
    /** The quick picks, smallest first: examples, not the only amounts. */
    presetDollars: number[];
    /** The amount preselected in the field. */
    defaultDollars: number;
  };
  /**
   * The retail price of 1,000 classified posts, in micro-dollars, under each card the page covers: the one in effect at
   * build, then each later change, if any (`retailMicrosPer1000Posts`).
   */
  prices: { from: string; microsPer1000Posts: number }[];
}

/** The field's default: the spec's heavy user, 4,500 posts a month. */
export const CALCULATOR_DEFAULT_POSTS_PER_DAY = 150;
export const CALCULATOR_MIN_POSTS_PER_DAY = 1;
export const CALCULATOR_MAX_POSTS_PER_DAY = 5_000;
export const CALCULATOR_INPUT_ERROR = 'Enter a number from 1 to 5,000.';

export type CalculatorResult =
  | { ok: true; days: number; posts: number; text: string }
  | { ok: false; field: 'amount' | 'posts'; error: string };

const GROUPED = new Intl.NumberFormat('en-US');
const MICROS_PER_DOLLAR = 1_000_000;
const DIGITS = /^\d+$/;
/** Whole dollars as `creditAmount` (protocol) takes them: no leading zero. */
const DOLLARS = /^[1-9]\d{0,5}$/;

/** "Enter a whole-dollar amount from $5 to $500.": the amount field's error, from the data's rules. */
export function calculatorAmountError(data: CalculatorData): string {
  const { minDollars, maxDollars } = data.amount;
  return `Enter a whole-dollar amount from $${GROUPED.format(minDollars)} to $${GROUPED.format(maxDollars)}.`;
}

/** The price at `now`: the entry whose `from` is the latest not after `now` (the first if none is). */
function priceAt(prices: CalculatorData['prices'], now: Date): number {
  let current = prices[0];
  for (const entry of prices) if (Date.parse(entry.from) <= now.getTime()) current = entry;
  return current?.microsPer1000Posts ?? 0;
}

/** `estimatePosts` (protocol) for `micros` at this price: rounded down, to two significant digits from 100 up. */
function postsFor(micros: number, microsPer1000Posts: number): number {
  if (!(micros > 0) || !(microsPer1000Posts > 0)) return 0;
  let n = Math.floor((micros * 1000) / microsPer1000Posts);
  if (n >= 100) {
    const p = 10 ** (String(n).length - 2);
    n = Math.floor(n / p) * p;
  }
  return n;
}

/**
 * The calculator's output for `amount` dollars of credit (the amount field's raw text, an optional leading "$") at
 * `input` posts a day (the posts field's raw text), using the card in effect at `now` (the browser's clock, so the page
 * stays right after a scheduled change without a rebuild). A whole-dollar amount within the rules and a whole number of
 * posts from 1 to 5,000 give "$10 of credit lasts about 453 days at 150 posts a day."; anything else gives the error of
 * the first field that is wrong.
 */
export function calculatorResult(data: CalculatorData, amount: string, input: string, now: Date): CalculatorResult {
  const dollarsText = amount.trim().replace(/^\$/, '');
  const dollars = DOLLARS.test(dollarsText) ? Number(dollarsText) : Number.NaN;
  if (!(Number.isSafeInteger(dollars) && dollars >= data.amount.minDollars && dollars <= data.amount.maxDollars)) {
    return { ok: false, field: 'amount', error: calculatorAmountError(data) };
  }
  const trimmed = input.trim();
  const perDay = DIGITS.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!(perDay >= CALCULATOR_MIN_POSTS_PER_DAY && perDay <= CALCULATOR_MAX_POSTS_PER_DAY)) {
    return { ok: false, field: 'posts', error: CALCULATOR_INPUT_ERROR };
  }
  const posts = postsFor(dollars * MICROS_PER_DOLLAR, priceAt(data.prices, now));
  const days = Math.floor(posts / perDay);
  const span = days === 1 ? '1 day' : `${GROUPED.format(days)} days`;
  return {
    ok: true,
    days,
    posts,
    text: `$${GROUPED.format(dollars)} of credit lasts about ${span} at ${GROUPED.format(perDay)} posts a day.`,
  };
}
