/**
 * What the Pricing page's fields read and write (PA-05, PA-06): amounts in dollars as whole micro-dollars, a multiplier,
 * and a price's start as a UTC day. Amounts are read by string arithmetic, never `Number(text) * 1e6`, so "0.29" is
 * exactly 290,000 micro-dollars; anything the patterns refuse is null, and the page then keeps "Save" disabled.
 */

const DOLLARS = /^\$?(\d{1,6})(?:\.(\d{1,6}))?$/;
const MULTIPLIER = /^\d{1,2}(\.\d{1,4})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "0.073" → 73,000; "$12.5" → 12,500,000: whole micro-dollars, or null for anything else ("1e3", "-1", "0.0000001"). */
export function parseDollars(text: string): number | null {
  const match = DOLLARS.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0'));
}

/** "2" → 2, "1.15" → 1.15: up to two digits, and up to four decimal places (whole basis points); null otherwise. */
export function parseMultiplier(text: string): number | null {
  const typed = text.trim();
  return MULTIPLIER.test(typed) ? Number(typed) : null;
}

/**
 * An amount as a field shows it, exactly, with no "$": `units` of 10^-`decimals` dollars (micro-dollars by default; a
 * job's cost per 1,000 units in micro-dollars is its cost per unit in nano-dollars, `decimals` 9), with at least two
 * decimal places: 73,000 → "0.073", 400,000 → "0.40".
 */
export function dollarsInput(units: number, decimals = 6): string {
  const digits = String(Math.trunc(Math.abs(units))).padStart(decimals + 1, '0');
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/** A price's start as a date field holds it: "2026-11-03T00:00:00Z" → "2026-11-03" (the UTC day). */
export function utcDayInput(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * A date field's day as a price's start, 00:00 UTC: "2026-12-10" → "2026-12-10T00:00:00Z"; null for an empty field or
 * a day the calendar doesn't have (a browser without a date picker lets any text through).
 */
export function fromUtcDayInput(value: string): string | null {
  if (!DAY.test(value)) return null;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value ? `${value}T00:00:00Z` : null;
}
