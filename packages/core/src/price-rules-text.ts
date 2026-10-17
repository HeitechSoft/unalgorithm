import {
  CREDIT_TASKS,
  type CreditTask,
  FEATURE_NAMES,
  PRICE_BOUNDS,
  PRICE_NOTICE_DAYS,
  type PriceIssue,
  type PriceIssueCode,
  REFERENCE_MODELS,
  TASK_UNITS,
} from '@unalgorithm/protocol';
import { REFERENCE_MODEL_LABELS } from './credit-facts.ts';
import { formatPrice } from './usage.ts';

/**
 * The price rules in plain words (decision PD14: draft copy for Tom). `@unalgorithm/protocol` gives each rule failure a
 * code and its facts (`PriceIssue`); the server's save and the Pricing page say why they refuse a price change with
 * these sentences, never with the CI line.
 */

/** Each task as the Pricing page names its price. */
export const TASK_PRICE_NAMES: Readonly<Record<CreditTask, string>> = Object.freeze({
  classify: 'Classifying posts',
  factcheck: FEATURE_NAMES.factcheck,
  perspectives: FEATURE_NAMES.perspectives,
});

/** Dates as the account page writes them: "Dec 3, 2026" (UTC, so a 00:00 UTC start is that day everywhere). */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const day = (value: string | undefined): string => {
  const t = Date.parse(value ?? '');
  return Number.isNaN(t) ? String(value ?? '') : DATE.format(t);
};

const isCreditTask = (task: string | undefined): task is CreditTask =>
  task !== undefined && (CREDIT_TASKS as readonly string[]).includes(task);
/** A task that is not a credit task (only `not-a-task` has one) is named as written. */
const taskName = (task: string | undefined): string => (isCreditTask(task) ? TASK_PRICE_NAMES[task] : (task ?? ''));
const unitOf = (task: string | undefined): string => (isCreditTask(task) ? TASK_UNITS[task] : 'job');

/** The CI line without the `head: ` the change rules put before a shape problem of the schedule checked. */
const ciLine = (text: string): string => text.replace(/^head: /, '');

/** Whole dollars as a bound reads: "$1", "$1,000"; cents only when there are any ("$0.10"). */
const usd = (micros: number): string => formatPrice(micros).replace(/\.00$/, '');
const MODEL_NAMES = REFERENCE_MODELS.map((model) => REFERENCE_MODEL_LABELS[model] ?? model);
/** "Claude Haiku 5.5, Claude Sonnet 5.5 or Claude Opus 5.5". */
const referenceModels = `${MODEL_NAMES.slice(0, -1).join(', ')} or ${MODEL_NAMES.at(-1)}`;
const { multiplier, maxChargeMicros, starterMicros, purchaseMicros, presets, perDay, monthlyLimitMaxMicros } = PRICE_BOUNDS;
const pastStarter = () => "Past starter credit amounts can't change.";

const SENTENCES: Readonly<Record<PriceIssueCode, (issue: PriceIssue, n: number) => string>> = {
  'in-effect-changed': (i) =>
    `The prices from ${day(i.effectiveFrom)} are in effect, so they can't change. Schedule a new price instead.`,
  'in-effect-removed': (i) => `The prices from ${day(i.effectiveFrom)} are in effect, so they can't be removed.`,
  'starts-in-past': (i) => `A new price can't start in the past. The earliest date is ${day(i.earliest)}.`,
  raise: (i, n) =>
    `This raises the price of ${taskName(i.task)}, so it needs ${n} days' notice. The earliest date is ${day(i.earliest)}.`,
  'cap-raise': (i, n) =>
    `This raises the most one ${unitOf(i.task)} can cost, so it needs ${n} days' notice. The earliest date is ${day(i.earliest)}.`,
  rise: (i, n) =>
    `The price of ${taskName(i.task)} would go up on ${day(i.effectiveFrom)} with less than ${n} days' notice. The earliest date a rise can start is ${day(i.earliest)}.`,
  'drops-task': (i) => `${taskName(i.task)} can't be taken off the price list once it has a price.`,
  'add-copies': () => "A first price can't start on the same day as another price change. Pick another day.",
  multiplier: () => 'The multiplier must be above 0, with at most four decimal places.',
  'reference-cost': () => 'Our AI cost must be more than $0.',
  'reference-model': () => 'Pick a reference model.',
  'cap-below-typical': (i) =>
    `The most one ${unitOf(i.task)} can cost must be at least its typical price, ${formatPrice(i.typicalMicros ?? 0)}.`,
  'classify-cap': () => `${TASK_PRICE_NAMES.classify} has no maximum charge.`,
  'date-format': () => 'A price starts at 00:00 UTC on a real calendar day.',
  // Only a broken stored or code schedule reaches these: the Pricing page's edits never make one.
  empty: (i) => `The price list isn't valid (${ciLine(i.text)}).`,
  'date-order': (i) => `The price list isn't valid (${ciLine(i.text)}).`,
  'not-a-task': (i) => `The price list isn't valid (${ciLine(i.text)}).`,
  'no-classify': (i) => `The price list isn't valid (${ciLine(i.text)}).`,
  unit: (i) => `The price list isn't valid (${ciLine(i.text)}).`,
  // The price book: the bounds on what a change sets (decisions PD4–PD7) and the soundness of its other parts.
  'reference-model-unknown': () => `Pick ${referenceModels} as the reference model.`,
  'multiplier-range': () => `The multiplier must be from ${multiplier.min}× to ${multiplier.max}×: never below our AI cost.`, // U+00D7
  'cap-too-high': (i) => `The most one ${unitOf(i.task)} can cost must be ${formatPrice(maxChargeMicros.max)} or less.`,
  'starter-order': pastStarter,
  'starter-history': pastStarter,
  'starter-range': () =>
    `The starter credit must be from ${formatPrice(starterMicros.min)} to ${formatPrice(starterMicros.max)}, in whole cents.`,
  'purchase-order': () => 'The least amount must be at most the preselected one, and that at most the most, in whole dollars.',
  'purchase-default': () => 'The preselected amount must be one of the quick picks.',
  'purchase-presets': () =>
    `Quick picks: ${presets.min} to ${presets.max} whole-dollar amounts, smallest first, from the least to the most.`,
  'purchase-range': () => `Amounts must be whole dollars from ${usd(purchaseMicros.min)} to ${usd(purchaseMicros.max)}.`,
  'auto-reload-per-day': () => `Automatic top-ups a day must be from ${perDay.min} to ${perDay.max}.`,
  'auto-reload-monthly': () =>
    `The monthly limit must be whole dollars from the least amount people can buy to ${usd(monthlyLimitMaxMicros.max)}.`,
};

/** Why the rules refuse a price change, in plain words. `noticeDays` is the notice a raise needs (`{n}`). */
export function priceIssueText(issue: PriceIssue, noticeDays: number = PRICE_NOTICE_DAYS): string {
  return SENTENCES[issue.code](issue, noticeDays);
}

/** The distinct texts of the first three issues, joined with a space; '' for none. */
export function priceIssuesText(issues: readonly PriceIssue[], noticeDays: number = PRICE_NOTICE_DAYS): string {
  return [...new Set(issues.slice(0, 3).map((issue) => priceIssueText(issue, noticeDays)))].join(' ');
}
