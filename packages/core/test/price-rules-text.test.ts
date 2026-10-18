import {
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceCard,
  type CreditPriceScheduleEntry,
  DEFAULT_PRICE_BOOK,
  FEATURE_NAMES,
  PRICE_ISSUE_CODES,
  type PriceIssue,
  priceBookChangeIssues,
  priceScheduleChangeIssues,
  priceScheduleIssues,
  withStarterCredit,
  withTaskCard,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { priceIssuesText, priceIssueText, TASK_PRICE_NAMES } from '../src/index.ts';

/** Fixed instants: no test here reads the clock. */
const NOW = new Date('2026-11-02T12:00:00Z');
const S = CREDIT_PRICE_SCHEDULE;
const FC = (S[1] as CreditPriceScheduleEntry).cards.factcheck as CreditPriceCard;
const NOV_3 = '2026-11-03T00:00:00Z';

/** The one issue the rules give for factcheck priced by `card` from `from` (the edit the Pricing page makes). */
function issueFor(from: string, card: CreditPriceCard): PriceIssue {
  const issues = priceScheduleChangeIssues(S, withTaskCard(S, 'factcheck', from, card), NOW);
  expect(issues).toHaveLength(1);
  return issues[0] as PriceIssue;
}

describe('the price rules in plain words', () => {
  it('test_price_issue_text_per_code', () => {
    expect(TASK_PRICE_NAMES).toEqual({ classify: 'Classifying posts', factcheck: 'Fact-check', perspectives: 'UnEcho Chamber' });
    expect(TASK_PRICE_NAMES.perspectives).toBe(FEATURE_NAMES.perspectives);
    expect(Object.isFrozen(TASK_PRICE_NAMES)).toBe(true);

    // The issues of the rule functions themselves (PA-01 AC 3 and AC 4).
    const raise = issueFor(NOV_3, { ...FC, multiplier: 2.5 });
    expect(raise.code).toBe('raise');
    expect(priceIssueText(raise)).toBe(
      "This raises the price of Fact-check, so it needs 30 days' notice. The earliest date is Dec 3, 2026.",
    );
    const longer = priceScheduleChangeIssues(S, withTaskCard(S, 'factcheck', NOV_3, { ...FC, multiplier: 2.5 }), NOW, 45);
    expect(priceIssueText(longer[0] as PriceIssue, 45)).toBe(
      "This raises the price of Fact-check, so it needs 45 days' notice. The earliest date is Dec 18, 2026.",
    );
    const capRaise = issueFor(NOV_3, { ...FC, maxChargeMicros: 500_000 });
    expect(capRaise.code).toBe('cap-raise');
    expect(priceIssueText(capRaise)).toBe(
      "This raises the most one check can cost, so it needs 30 days' notice. The earliest date is Dec 3, 2026.",
    );
    const cut = { ...FC, maxChargeMicros: 300_000 };
    const inEffect = issueFor('2026-10-18T00:00:00Z', cut);
    expect(inEffect.code).toBe('in-effect-changed');
    expect(priceIssueText(inEffect)).toBe(
      "The prices from Oct 18, 2026 are in effect, so they can't change. Schedule a new price instead.",
    );
    const past = issueFor('2026-11-02T00:00:00Z', cut);
    expect(past.code).toBe('starts-in-past');
    expect(priceIssueText(past)).toBe("A new price can't start in the past. The earliest date is Nov 3, 2026.");
    const removed = priceScheduleChangeIssues(S, [S[0] as CreditPriceScheduleEntry], NOW);
    expect(removed.map((issue) => issue.code)).toEqual(['in-effect-removed']);
    expect(priceIssueText(removed[0] as PriceIssue)).toBe(
      "The prices from Oct 18, 2026 are in effect, so they can't be removed.",
    );
    const cutThenEnded = withTaskCard(
      withTaskCard(S, 'factcheck', NOV_3, { ...FC, multiplier: 1.5 }),
      'factcheck',
      '2026-11-10T00:00:00Z',
      FC,
    );
    const rise = priceScheduleChangeIssues(S, cutThenEnded, NOW);
    expect(rise.map((issue) => issue.code)).toEqual(['rise']);
    expect(priceIssueText(rise[0] as PriceIssue)).toBe(
      "The price of Fact-check would go up on Nov 10, 2026 with less than 30 days' notice. The earliest date a rise can start is Dec 3, 2026.",
    );
    const empty = priceScheduleIssues([]);
    expect(empty.map((issue) => issue.code)).toEqual(['empty']);
    expect(priceIssueText(empty[0] as PriceIssue)).toBe("The price list isn't valid (the schedule is empty).");
    // A head's shape issue reads the same: the CI prefix `head: ` is not plain words.
    const emptyHead = priceScheduleChangeIssues(S, [], NOW);
    expect(emptyHead[0]?.text).toBe('head: the schedule is empty');
    expect(priceIssueText(emptyHead[0] as PriceIssue)).toBe("The price list isn't valid (the schedule is empty).");

    // The other codes, from their facts.
    const at = '2026-11-03T00:00:00Z';
    const text = (issue: Omit<PriceIssue, 'text'>, ci = 'ci line') => priceIssueText({ ...issue, text: ci });
    expect(text({ code: 'cap-below-typical', effectiveFrom: at, task: 'factcheck', typicalMicros: 240_000 })).toBe(
      'The most one check can cost must be at least its typical price, $0.24.',
    );
    expect(text({ code: 'cap-below-typical', effectiveFrom: at, task: 'perspectives', typicalMicros: 270_000 })).toBe(
      'The most one comparison can cost must be at least its typical price, $0.27.',
    );
    expect(text({ code: 'drops-task', effectiveFrom: at, task: 'factcheck' })).toBe(
      "Fact-check can't be taken off the price list once it has a price.",
    );
    expect(text({ code: 'drops-task', effectiveFrom: at, task: 'perspectives' })).toBe(
      "UnEcho Chamber can't be taken off the price list once it has a price.",
    );
    expect(text({ code: 'add-copies', effectiveFrom: at })).toBe(
      "A first price can't start on the same day as another price change. Pick another day.",
    );
    expect(text({ code: 'multiplier', effectiveFrom: at, task: 'factcheck' })).toBe(
      'The multiplier must be above 0, with at most four decimal places.',
    );
    expect(text({ code: 'reference-cost', effectiveFrom: at, task: 'factcheck' })).toBe('Our AI cost must be more than $0.');
    expect(text({ code: 'reference-model', effectiveFrom: at, task: 'factcheck' })).toBe('Pick a reference model.');
    expect(text({ code: 'classify-cap', effectiveFrom: at, task: 'classify' })).toBe('Classifying posts has no maximum charge.');
    expect(text({ code: 'date-format', effectiveFrom: '2026-11-03' })).toBe(
      'A price starts at 00:00 UTC on a real calendar day.',
    );
    for (const code of ['date-order', 'not-a-task', 'no-classify', 'unit'] as const) {
      expect(text({ code, effectiveFrom: at, task: 'summarize' }, `entry 2 (${at}): ${code}`), code).toBe(
        `The price list isn't valid (entry 2 (${at}): ${code}).`,
      );
    }
    // A task that is not a credit task is named as written.
    expect(text({ code: 'drops-task', effectiveFrom: at, task: 'summarize' })).toBe(
      "summarize can't be taken off the price list once it has a price.",
    );
  });

  it('test_price_issues_text_joins_first_three_distinct', () => {
    const issue = (code: PriceIssue['code'], task = 'factcheck'): PriceIssue => ({ code, task, effectiveFrom: NOV_3, text: '' });
    const multiplier = 'The multiplier must be above 0, with at most four decimal places.';
    const cost = 'Our AI cost must be more than $0.';
    const model = 'Pick a reference model.';
    expect(priceIssuesText([])).toBe('');
    expect(priceIssuesText([issue('multiplier')])).toBe(multiplier);
    // Two tasks with the same problem read once.
    expect(priceIssuesText([issue('multiplier'), issue('multiplier', 'perspectives'), issue('reference-cost')])).toBe(
      `${multiplier} ${cost}`,
    );
    // At most the first three issues: the fourth is left out.
    expect(priceIssuesText([issue('multiplier'), issue('reference-cost'), issue('reference-model'), issue('add-copies')])).toBe(
      `${multiplier} ${cost} ${model}`,
    );
    expect(priceIssuesText([issue('multiplier'), issue('multiplier'), issue('multiplier'), issue('reference-cost')])).toBe(
      multiplier,
    );
    // The notice reaches every text.
    const raise = priceScheduleChangeIssues(S, withTaskCard(S, 'factcheck', NOV_3, { ...FC, multiplier: 2.5 }), NOW, 45);
    expect(priceIssuesText(raise, 45)).toBe(
      "This raises the price of Fact-check, so it needs 45 days' notice. The earliest date is Dec 18, 2026.",
    );
  });

  it('test_book_issue_texts', () => {
    const text = (issue: Omit<PriceIssue, 'text'>) => priceIssueText({ ...issue, text: 'ci line' });
    const card = { effectiveFrom: NOV_3, task: 'factcheck' };
    expect(text({ code: 'reference-model-unknown', ...card })).toBe(
      'Pick Claude Haiku 5.5, Claude Sonnet 5.5 or Claude Opus 5.5 as the reference model.',
    );
    expect(text({ code: 'multiplier-range', ...card })).toBe('The multiplier must be from 1× to 10×: never below our AI cost.');
    expect(text({ code: 'cap-too-high', ...card })).toBe('The most one check can cost must be $5.00 or less.');
    expect(text({ code: 'cap-too-high', effectiveFrom: NOV_3, task: 'perspectives' })).toBe(
      'The most one comparison can cost must be $5.00 or less.',
    );
    expect(text({ code: 'starter-order' })).toBe("Past starter credit amounts can't change.");
    expect(text({ code: 'starter-history' })).toBe("Past starter credit amounts can't change.");
    expect(text({ code: 'starter-range' })).toBe('The starter credit must be from $0.10 to $10.00, in whole cents.');
    expect(text({ code: 'purchase-order' })).toBe(
      'The least amount must be at most the preselected one, and that at most the most, in whole dollars.',
    );
    expect(text({ code: 'purchase-default' })).toBe('The preselected amount must be one of the quick picks.');
    expect(text({ code: 'purchase-presets' })).toBe(
      'Quick picks: 1 to 4 whole-dollar amounts, smallest first, from the least to the most.',
    );
    expect(text({ code: 'purchase-range' })).toBe('Amounts must be whole dollars from $1 to $1,000.');
    expect(text({ code: 'auto-reload-per-day' })).toBe('Automatic top-ups a day must be from 1 to 4.');
    expect(text({ code: 'auto-reload-monthly' })).toBe(
      'The monthly limit must be whole dollars from the least amount people can buy to $5,000.',
    );
    expect(text({ code: 'schedule-full' })).toBe('The price list is full: it holds at most 500 dates.');
    expect(text({ code: 'starter-full' })).toBe("The starter credit can't change again: it keeps at most 500 amounts.");
    // Every code has its words.
    for (const code of PRICE_ISSUE_CODES) expect(text({ code, ...card }), code).toMatch(/^[A-Z].+\.$/);

    // The book's rules themselves, as the save refuses them.
    const book = DEFAULT_PRICE_BOOK;
    const head = { ...book, schedule: withTaskCard(book.schedule, 'factcheck', NOV_3, { ...FC, multiplier: 0.5 }) };
    expect(priceIssuesText(priceBookChangeIssues(book, head, NOW))).toBe(
      'The multiplier must be from 1× to 10×: never below our AI cost.',
    );
    const starter = priceBookChangeIssues(book, withStarterCredit(book, 50_000, NOW), NOW);
    expect(priceIssuesText(starter)).toBe('The starter credit must be from $0.10 to $10.00, in whole cents.');
  });
});
