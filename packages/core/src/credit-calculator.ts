import type { CreditPackId } from '@unalgorithm/protocol';

/**
 * The website's credit calculator (CL5-09): "how long does a pack last at my usage". Its data is computed at build time
 * by `calculatorData` (`credit-facts.ts`, with the protocol); this module is what runs in the browser, so it has no
 * runtime import (the island imports `@unalgorithm/core/credit-calculator`, never the protocol, which would bundle zod).
 */
export interface CalculatorData {
  packs: {
    id: CreditPackId;
    /** `formatBalance(pack.creditMicros)`: "$10.00". */
    label: string;
    isDefault: boolean;
    /** Posts the pack buys under each card the page covers: the one in effect at build, then the next change if any. */
    posts: { from: string; posts: number }[];
  }[];
}

/** The field's default: the spec's heavy user, 4,500 posts a month. */
export const CALCULATOR_DEFAULT_POSTS_PER_DAY = 150;
export const CALCULATOR_MIN_POSTS_PER_DAY = 1;
export const CALCULATOR_MAX_POSTS_PER_DAY = 5_000;
export const CALCULATOR_INPUT_ERROR = 'Enter a number from 1 to 5,000.';

export type CalculatorResult = { ok: true; days: number; text: string } | { ok: false; error: string };

const GROUPED = new Intl.NumberFormat('en-US');

/** The posts a pack buys at `now`: the entry whose `from` is the latest not after `now` (the first if none is). */
function postsAt(posts: readonly { from: string; posts: number }[], now: Date): number {
  let current = posts[0];
  for (const entry of posts) if (Date.parse(entry.from) <= now.getTime()) current = entry;
  return current?.posts ?? 0;
}

/**
 * The calculator's output for `pack` at `input` posts a day (the field's raw text), using the card in effect at `now`
 * (the browser's clock, so the page stays right after a scheduled change without a rebuild). A whole number from 1 to
 * 5,000 gives "A $10.00 pack lasts about 453 days at 150 posts a day."; anything else gives the error text.
 */
export function calculatorResult(data: CalculatorData, pack: CreditPackId, input: string, now: Date): CalculatorResult {
  const trimmed = input.trim();
  const perDay = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const chosen = data.packs.find((p) => p.id === pack);
  if (!chosen || !(perDay >= CALCULATOR_MIN_POSTS_PER_DAY && perDay <= CALCULATOR_MAX_POSTS_PER_DAY)) {
    return { ok: false, error: CALCULATOR_INPUT_ERROR };
  }
  const days = Math.floor(postsAt(chosen.posts, now) / perDay);
  const span = days === 1 ? '1 day' : `${GROUPED.format(days)} days`;
  return {
    ok: true,
    days,
    text: `A ${chosen.label} pack lasts about ${span} at ${GROUPED.format(perDay)} posts a day.`,
  };
}
