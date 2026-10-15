/**
 * Token usage normalized across vendors. `uncachedInput` never includes cache reads or writes:
 * Anthropic's `input_tokens` already excludes them, OpenAI's includes cached tokens (subtract them).
 */
export interface NormalizedUsage {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  /** Includes any thinking tokens the vendor bills as output. */
  output: number;
  webSearches: number;
  /** True when the vendor reported nothing and the numbers were estimated from characters. */
  estimated: boolean;
}

export const ZERO_USAGE: NormalizedUsage = {
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  webSearches: 0,
  estimated: false,
};

export function addUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    webSearches: a.webSearches + b.webSearches,
    estimated: a.estimated || b.estimated,
  };
}

export function totalTokens(u: NormalizedUsage): number {
  return u.uncachedInput + u.cacheRead + u.cacheWrite + u.output;
}

/** List prices in US dollars per million tokens (and per web search). */
export interface PriceCard {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  webSearch?: number;
}

/**
 * Anthropic and OpenAI list prices. Used for estimates shown to users. Anthropic: as of October 2026 (prompts up to 100K
 * tokens). OpenAI (decision D43): the decision's values, recorded 2026-10-15; openai.com/api/pricing could not be read
 * that day (HTTP 403), so they are still to be confirmed there. OpenAI has no cache-write charge; a web search call is
 * $10 per 1,000.
 */
export const PRICE_CARDS: Record<string, PriceCard> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, webSearch: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, webSearch: 0.01 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, webSearch: 0.01 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, webSearch: 0.01 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0, webSearch: 0.01 },
};

/**
 * Own-key OpenAI estimates shown before a run (D44): the eval's reference usage at these cards, rounded up to the cent;
 * the first live trust-eval run replaces them with measured means. Fact-check: claims on gpt-5-mini 1,000 in / 100 out
 * (450), research on gpt-5 30,000 in / 1,500 out / 3 searches (82,500), verdict on gpt-5 2,000 in / 400 out (6,500):
 * 89,450 micro-dollars.
 */
export const OPENAI_FACTCHECK_TYPICAL_COST_MICROS = 90_000;
export const OPENAI_PERSPECTIVES_TYPICAL_COST_MICROS = 95_000;

/**
 * A $/MTok price as whole thousandths of a micro-dollar per token. List prices have at most 3 decimals, so the
 * rounding only removes binary floating-point noise and the result is exact.
 */
const milliMicrosPerToken = (dollarsPerMTok: number) => Math.round(dollarsPerMTok * 1000);

/**
 * Cost in micro-dollars (1e-6 USD), rounded up, or undefined when the model has no known price card. Computed in
 * integer thousandths of a micro-dollar so an exact whole cost is never rounded up by float error.
 */
export function costMicros(model: string, u: NormalizedUsage): number | undefined {
  const p = PRICE_CARDS[model];
  if (!p) return undefined;
  const milli =
    u.uncachedInput * milliMicrosPerToken(p.input) +
    u.output * milliMicrosPerToken(p.output) +
    u.cacheRead * milliMicrosPerToken(p.cacheRead) +
    u.cacheWrite * milliMicrosPerToken(p.cacheWrite) +
    u.webSearches * Math.round((p.webSearch ?? 0) * 1e9);
  return Math.ceil(milli / 1000);
}
