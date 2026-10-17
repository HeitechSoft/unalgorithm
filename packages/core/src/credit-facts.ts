import {
  CREDIT_TASKS,
  type CreditPriceCard,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  type CreditTask,
  DEFAULT_PRICE_BOOK,
  estimatePosts,
  FEATURE_NAMES,
  jobPriceAt,
  type PriceBook,
  priceCardsAt,
  retailMicrosPer1000Posts,
  starterCreditAt,
  TASK_UNITS,
  taskPriceAt,
} from '@unalgorithm/protocol';
import type { CalculatorData } from './credit-calculator.ts';
import { serverJobPriceLabel } from './labs.ts';
import { balanceLine, formatBalance, formatPostsEstimate, formatPrice } from './usage.ts';

/**
 * "How credits work" on the website (R30, CL2-14): the figures its Markdown (`CREDITS_PAGE.source`) leaves as
 * `{{name}}` placeholders, computed from a price book (the Cloud's `/prices.json`, PA-10; `DEFAULT_PRICE_BOOK` when none
 * is given) so the page can only show what the Cloud charges. The site is static: every sentence about a scheduled
 * price is dated, so it stays true before and after the date (docs/release.md → Prices has the site redeployed around a
 * change).
 */

/** The credit amounts of the examples table, in micro-dollars. */
export const EXAMPLE_AMOUNTS_MICROS: readonly number[] = Object.freeze([1_000_000, 5_000_000, 10_000_000, 25_000_000]);

/**
 * The published name of each price card's reference model. Kept here because `@unalgorithm/ai` (whose `modelLabel` has
 * the same names) depends on this package; a test keeps every `referenceModel` in the schedule labelled, and another,
 * in `@unalgorithm/ai`, keeps the two in agreement.
 */
export const REFERENCE_MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
});

export const CREDITS_PLACEHOLDERS = [
  'classifyMultiplier',
  'classifyPer1000',
  'referenceModel',
  'priceChange',
  'labsPrices',
  'examples',
  'starterAmount',
  'starterDays',
  'amountMin',
  'amountMax',
  'amounts',
] as const;
export type CreditFacts = Record<(typeof CREDITS_PLACEHOLDERS)[number], string>;

const MICROS_PER_DOLLAR = 1_000_000;
const GROUPED_DOLLARS = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
/** Whole dollars, as the amount rules have them: "$5", "$500". */
const wholeDollars = (micros: number): string => `$${GROUPED_DOLLARS.format(micros / MICROS_PER_DOLLAR)}`;

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
/** "Nov 15, 2026". */
const day = (effectiveFrom: string): string => DATE.format(new Date(effectiveFrom));
const times = (card: Readonly<CreditPriceCard>): string => `${card.multiplier}×`; // U+00D7
const modelName = (model: string): string => REFERENCE_MODEL_LABELS[model] ?? model;

/** What a person is charged: the same multiplier, reference cost, reference model and hold cap. */
function samePrice(a: Readonly<CreditPriceCard> | undefined, b: Readonly<CreditPriceCard> | undefined): boolean {
  return (
    a?.multiplier === b?.multiplier &&
    a?.referenceCostMicrosPer1000 === b?.referenceCostMicrosPer1000 &&
    a?.referenceModel === b?.referenceModel &&
    a?.maxChargeMicros === b?.maxChargeMicros
  );
}

/** The first entry after `at` whose card for `task` differs from the one in effect at `at` (or first prices it). */
function nextCardChange(
  at: Date,
  task: CreditTask,
  schedule: CreditPriceSchedule,
): { entry: Readonly<CreditPriceScheduleEntry>; card: Readonly<CreditPriceCard> } | null {
  const now = priceCardsAt(at, schedule).cards[task];
  for (const entry of schedule) {
    const card = entry.cards[task];
    if (Date.parse(entry.effectiveFrom) > at.getTime() && card && !samePrice(card, now)) return { entry, card };
  }
  return null;
}

/**
 * The website's sentence for a job task's price at `at`: "2× our AI cost, typically about $0.24 per check on Claude
 * Sonnet 5.5, and never more than $0.40 for one check." (`withModel` false leaves out "on Claude Sonnet 5.5"); '' when
 * the task is not offered at `at`.
 */
export function jobPriceText(
  task: Exclude<CreditTask, 'classify'>,
  at: Date,
  schedule: CreditPriceSchedule,
  withModel: boolean,
): string {
  const card = priceCardsAt(at, schedule).cards[task];
  const price = jobPriceAt(at, task, schedule);
  if (!card || !price) return '';
  const unit = TASK_UNITS[task];
  const model = withModel ? ` on ${modelName(card.referenceModel)}` : '';
  return `${times(card)} our AI cost, typically about ${formatPrice(price.typicalMicros)} per ${unit}${model}, and never more than ${formatPrice(price.maxMicros)} for one ${unit}.`;
}

/** The balance the Pricing page's preview prices for classify: the extension's balance line for $5. */
const PREVIEW_BALANCE_MICROS = 5_000_000;

/**
 * What people are shown for `task`'s price at `at` under `schedule`, in the published wording, never a copy (the Pricing
 * page's preview, PA-05). Classify: the account page's line, "AI costs about $0.15 per 1,000 posts.", and the
 * extension's balance line for $5, "$5.00 left · about 34,000 posts". A job task: the website's sentence
 * (`jobPriceText`) and the extension's price label (`serverJobPriceLabel`), "About $0.24, at most $0.40". `[]` when
 * the task is not offered at `at`.
 */
export function taskPriceLines(schedule: CreditPriceSchedule, task: CreditTask, at: Date): string[] {
  if (!taskPriceAt(at, task, schedule).offered) return [];
  if (task === 'classify') {
    return [
      `AI costs about ${formatPrice(retailMicrosPer1000Posts(at, 'classify', schedule))} per 1,000 posts.`,
      balanceLine(PREVIEW_BALANCE_MICROS, at, schedule),
    ];
  }
  const price = jobPriceAt(at, task, schedule);
  return price ? [jobPriceText(task, at, schedule, true), serverJobPriceLabel(price)] : [];
}

/**
 * One bullet per job task (Fact-check, UnEcho Chamber) priced at `at` or by a later entry; each dated where it is not
 * yet in effect. The name `labsPrices` is kept from when both were Labs features (it is the page's placeholder).
 */
function labsPrices(at: Date, schedule: CreditPriceSchedule): string {
  const lines: string[] = [];
  for (const task of CREDIT_TASKS) {
    if (task === 'classify') continue;
    const label = `- **${FEATURE_NAMES[task]}**:`;
    const next = nextCardChange(at, task, schedule);
    if (!priceCardsAt(at, schedule).cards[task]) {
      if (next) {
        const from = new Date(next.entry.effectiveFrom);
        lines.push(`${label} from ${day(next.entry.effectiveFrom)} (UTC), ${jobPriceText(task, from, schedule, true)}`);
      }
      continue;
    }
    let line = `${label} ${jobPriceText(task, at, schedule, true)}`;
    if (next) {
      const d = day(next.entry.effectiveFrom);
      const later = jobPriceText(task, new Date(next.entry.effectiveFrom), schedule, false);
      line += ` That price applies until ${d} (UTC). From ${d} (UTC): ${later}`;
    }
    lines.push(line);
  }
  return lines.length > 0
    ? lines.join('\n')
    : `${FEATURE_NAMES.factcheck} and ${FEATURE_NAMES.perspectives} are not offered on unAlgorithm Cloud yet.`;
}

/**
 * The page's figures at `at` (the build time) from `prices`: all computed, none typed by hand. The task prices come from
 * its schedule, where only the next change of a card is shown, dated (an entry that only adds a task leaves classify's
 * sentence and the examples undated); the starter credit is the one an account created at `at` gets; the amounts are
 * its buying credit rules.
 */
export function creditFacts(prices: PriceBook = DEFAULT_PRICE_BOOK, at: Date = new Date()): CreditFacts {
  const { schedule, purchase } = prices;
  const starter = starterCreditAt(at, prices);
  const card = priceCardsAt(at, schedule).cards.classify;
  const next = nextCardChange(at, 'classify', schedule);
  const until = next ? day(next.entry.effectiveFrom) : '';
  const per1000 = (when: Date) => formatPrice(retailMicrosPer1000Posts(when, 'classify', schedule));
  const rows = EXAMPLE_AMOUNTS_MICROS.map(
    (amount) => `| ${formatBalance(amount)} | ${formatPostsEstimate(estimatePosts(amount, at, 'classify', schedule))} |`,
  );
  const table = ['| Credit | Classifies |', '|---|---|', ...rows].join('\n');
  /** A table at the card in effect at `at`, dated when classify's card changes later. */
  const dated = (md: string): string => (next ? `At the price until ${until} (UTC).\n\n${md}` : md);
  return {
    classifyMultiplier: times(card),
    classifyPer1000: per1000(at),
    referenceModel: modelName(card.referenceModel),
    priceChange: next
      ? `That price applies until ${until} (UTC). From ${until} (UTC): ${times(next.card)} our AI cost, about ${per1000(new Date(next.entry.effectiveFrom))} per thousand posts.`
      : '',
    labsPrices: labsPrices(at, schedule),
    examples: dated(table),
    starterAmount: formatBalance(starter.amountMicros),
    starterDays: String(starter.expiresAfterDays),
    amountMin: wholeDollars(purchase.minMicros),
    amountMax: wholeDollars(purchase.maxMicros),
    amounts: dated(amountsTable(at, schedule, purchase.presetsMicros)),
  };
}

/**
 * Examples of a purchase (R32): the quick picks (`presetsMicros`), smallest first, at the card in effect at `at`: what
 * each costs, adds and buys. Any whole-dollar amount within the rules may be bought; these are examples. Like the
 * examples table, it is dated by the caller when classify's card changes later (one table, never a second column set).
 */
function amountsTable(at: Date, schedule: CreditPriceSchedule, presetsMicros: readonly number[]): string {
  const rows = presetsMicros.map((micros) => {
    const posts = formatPostsEstimate(estimatePosts(micros, at, 'classify', schedule));
    return `| ${formatBalance(micros)} + tax where it applies | ${formatBalance(micros)} | ${posts} |`;
  });
  return ['| You pay | Credit added | About |', '|---|---|---|', ...rows].join('\n');
}

/**
 * The calculator's data (CL5-09), computed at build time so the island ships no pricing code: `prices`' buying credit
 * rules in whole dollars, and the price of 1,000 classified posts under the classify card in effect at `at`, then under
 * its next change, if any, from that change's `effectiveFrom`.
 */
export function calculatorData(prices: PriceBook = DEFAULT_PRICE_BOOK, at: Date = new Date()): CalculatorData {
  const { schedule, purchase } = prices;
  const cards = [{ from: priceCardsAt(at, schedule).effectiveFrom, at }];
  const next = nextCardChange(at, 'classify', schedule);
  if (next) cards.push({ from: next.entry.effectiveFrom, at: new Date(next.entry.effectiveFrom) });
  return {
    amount: {
      minDollars: purchase.minMicros / MICROS_PER_DOLLAR,
      maxDollars: purchase.maxMicros / MICROS_PER_DOLLAR,
      presetDollars: purchase.presetsMicros.map((micros) => micros / MICROS_PER_DOLLAR),
      defaultDollars: purchase.defaultMicros / MICROS_PER_DOLLAR,
    },
    prices: cards.map((card) => ({
      from: card.from,
      microsPer1000Posts: retailMicrosPer1000Posts(card.at, 'classify', schedule),
    })),
  };
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/**
 * `template` with each `{{name}}` replaced by `values[name]`, inserted as written. Throws when a placeholder has no
 * value, or when a `{{` or `}}` is left over (a malformed placeholder), so a page never shows one.
 */
export function fillPlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  const unknown = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((name) => !Object.hasOwn(values, name ?? ''));
  if (unknown.length > 0) throw new Error(`Unknown placeholder: ${unknown.map((name) => `{{${name}}}`).join(', ')}`);
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, ''))) throw new Error('A placeholder is left over: a stray {{ or }}.');
  return template.replace(PLACEHOLDER, (_, name: string) => values[name] ?? '');
}

/** The "How credits work" Markdown (`CREDITS_PAGE.source`) filled with `creditFacts(prices, at)`. */
export function creditsMarkdown(template: string, prices: PriceBook = DEFAULT_PRICE_BOOK, at: Date = new Date()): string {
  return fillPlaceholders(template, creditFacts(prices, at));
}
