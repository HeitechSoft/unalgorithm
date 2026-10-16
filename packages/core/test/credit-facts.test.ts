import { readFileSync } from 'node:fs';
import {
  CREDIT_AMOUNT_MAX_MICROS,
  CREDIT_AMOUNT_MIN_MICROS,
  CREDIT_AMOUNT_PRESETS,
  CREDIT_PRICE_SCHEDULE,
  CREDITS_PAGE,
  type CreditPriceSchedule,
  creditAmount,
  DEFAULT_CREDIT_AMOUNT,
  estimatePosts,
  FEATURE_NAMES,
  priceCardsAt,
  retailMicrosPer1000Posts,
  STARTER_CREDIT,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  CALCULATOR_INPUT_ERROR,
  CREDITS_PLACEHOLDERS,
  calculatorAmountError,
  calculatorData,
  calculatorResult,
  creditFacts,
  creditsMarkdown,
  EXAMPLE_AMOUNTS_MICROS,
  fillPlaceholders,
  REFERENCE_MODEL_LABELS,
} from '../src/index.ts';

/**
 * "How credits work" (CL2-14, R30): every figure on the page comes from the dated price schedule. No test reads the real
 * schedule at the real clock (CL2-26 "Tests and the clock"): the instants are fixed.
 */
const OCT_14 = new Date('2026-10-14T12:00:00Z');
const NOV_15 = new Date('2026-11-15T00:00:00Z');
const LAUNCH = priceCardsAt(new Date('2026-10-01T00:00:00Z'));
const LAUNCH_CLASSIFY = LAUNCH.cards.classify;
const at25 = (effectiveFrom: string) =>
  Object.freeze({ effectiveFrom, cards: { classify: { ...LAUNCH_CLASSIFY, multiplier: 2.5 } } });
/** The ticket's stub `S`: the launch entry, plus 2.5× from 2026-11-15. */
const S: CreditPriceSchedule = [LAUNCH, at25('2026-11-15T00:00:00Z')];

const REPO_ROOT = new URL('../../../', import.meta.url);
const template = readFileSync(new URL(CREDITS_PAGE.source, REPO_ROOT), 'utf8').replace(/\r\n/g, '\n');
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const EXAMPLE_LINES = ['about 6,800 posts', 'about 34,000 posts', 'about 68,000 posts', 'about 170,000 posts'];

describe('credit facts', () => {
  it('test_credit_facts_from_protocol', () => {
    const facts = creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14);
    expect(facts.classifyMultiplier).toBe('2×');
    expect(facts.classifyPer1000).toBe('$0.15');
    expect(facts.referenceModel).toBe('Claude Haiku 5.5');
    expect(facts.starterAmount).toBe('$1.00');
    expect(facts.starterDays).toBe('90');
    expect(EXAMPLE_AMOUNTS_MICROS).toEqual([1_000_000, 5_000_000, 10_000_000, 25_000_000]);
    const rows = facts.examples.split('\n').filter((line) => /^\| \$/.test(line));
    expect(rows).toEqual([
      '| $1.00 | about 6,800 posts |',
      '| $5.00 | about 34,000 posts |',
      '| $10.00 | about 68,000 posts |',
      '| $25.00 | about 170,000 posts |',
    ]);
    for (const line of EXAMPLE_LINES) expect(facts.examples).toContain(line);
  });

  it('test_credit_facts_follow_price_card', () => {
    const facts = creditFacts([at25('2026-10-01T00:00:00Z')], OCT_14);
    expect(facts.classifyMultiplier).toBe('2.5×');
    expect(facts.classifyPer1000).toBe('$0.18');
    expect(facts.examples).toContain('| $1.00 | about 5,400 posts |');
    expect(facts.priceChange).toBe('');
  });

  it('test_credit_facts_scheduled_change', () => {
    const before = creditFacts(S, OCT_14);
    expect(before.classifyMultiplier).toBe('2×');
    expect(before.classifyPer1000).toBe('$0.15');
    expect(before.priceChange).toBe(
      'That price applies until Nov 15, 2026 (UTC). From Nov 15, 2026 (UTC): 2.5× our AI cost, about $0.18 per thousand posts.',
    );
    expect(before.examples.split('\n')[0]).toBe('At the price until Nov 15, 2026 (UTC).');

    const after = creditFacts(S, NOV_15);
    expect(after.classifyMultiplier).toBe('2.5×');
    expect(after.classifyPer1000).toBe('$0.18');
    expect(after.priceChange).toBe('');
    expect(after.examples.startsWith('|')).toBe(true);

    // The real schedule: priceChange is empty exactly when no later entry changes the classify card (entries that only
    // add a task copy it unchanged).
    const later = CREDIT_PRICE_SCHEDULE.filter((entry) => Date.parse(entry.effectiveFrom) > OCT_14.getTime());
    const now = priceCardsAt(OCT_14).cards.classify;
    const classifyChanges = later.some(
      ({ cards: { classify: c } }) =>
        c.multiplier !== now.multiplier ||
        c.referenceCostMicrosPer1000 !== now.referenceCostMicrosPer1000 ||
        c.referenceModel !== now.referenceModel,
    );
    expect(creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14).priceChange === '').toBe(!classifyChanges);
  });

  it('test_credit_facts_labs_prices', () => {
    // Before perspectives (2026-11-01) and fact-check (2026-12-01): both dated, at cost × 2 with their hold caps.
    expect(creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14).labsPrices.split('\n')).toEqual([
      '- **Fact-check**: from Dec 1, 2026 (UTC), 2× our AI cost, typically about $0.24 per check on Claude Sonnet 5.5, and never more than $0.40 for one check.',
      '- **UnEcho Chamber**: from Nov 1, 2026 (UTC), 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison.',
    ]);
    // Once in effect, the same line without its date.
    expect(creditFacts(CREDIT_PRICE_SCHEDULE, new Date('2026-11-01T00:00:00Z')).labsPrices.split('\n')[1]).toBe(
      '- **UnEcho Chamber**: 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison.',
    );
    // A change to a card in effect is dated like classify's.
    const pv = priceCardsAt(new Date('2026-11-01T00:00:00Z'));
    const cut = { ...(pv.cards.perspectives ?? LAUNCH_CLASSIFY), multiplier: 1.5 };
    const changed: CreditPriceSchedule = [
      pv,
      { effectiveFrom: '2027-01-01T00:00:00Z', cards: { ...pv.cards, perspectives: cut } },
    ];
    expect(creditFacts(changed, NOV_15).labsPrices).toBe(
      '- **UnEcho Chamber**: 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison. That price applies until Jan 1, 2027 (UTC). From Jan 1, 2027 (UTC): 1.5× our AI cost, typically about $0.20 per comparison, and never more than $0.50 for one comparison.',
    );
    // Only classify priced, now and later.
    expect(creditFacts([LAUNCH], OCT_14).labsPrices).toBe(
      'Fact-check and UnEcho Chamber are not offered on UnAlgorithm Cloud yet.',
    );
  });

  it('test_reference_model_has_label', () => {
    for (const entry of CREDIT_PRICE_SCHEDULE) {
      for (const card of Object.values(entry.cards)) expect(REFERENCE_MODEL_LABELS[card.referenceModel]).toBeTruthy();
    }
  });

  it('test_starter_facts_follow_protocol', () => {
    const facts = creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14);
    expect(facts.starterDays).toBe(String(STARTER_CREDIT.expiresAfterDays));
  });
});

describe('credits page copy', () => {
  it('test_credits_markdown_has_no_numbers', () => {
    expect(template).not.toMatch(/\$\d/);
    expect(template).not.toContain('×');
    expect(template).not.toMatch(/\d[\d,.]*\s+posts/);
    expect(template).toContain('per\nthousand posts');
    expect(template).toContain('## When the balance is empty');
    expect(template).toContain('{{classifyMultiplier}} our AI cost');
    expect(template).not.toMatch(/^\|/m); // the examples table comes only from {{examples}}
    expect(template).toContain('{{examples}}');
    // Every placeholder the copy uses is a fact, and every fact is used.
    const used = [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(CREDITS_PLACEHOLDERS));
  });

  it('test_credits_page_heading_out_of_labs', () => {
    // P3-64: Fact-check and UnEcho Chamber left Labs; the page names them (the placeholder keeps its code name).
    expect(template).toContain(`\n### ${FEATURE_NAMES.factcheck} and ${FEATURE_NAMES.perspectives}\n\n{{labsPrices}}\n`);
    expect(template).not.toMatch(/\bLabs\b/);
  });

  it('test_unknown_placeholder_fails', () => {
    expect(() => fillPlaceholders('Price: {{nope}}', { a: 'x' })).toThrow(/nope/);
    expect(() => creditsMarkdown(`${template}\n{{nope}}`, CREDIT_PRICE_SCHEDULE, OCT_14)).toThrow(/nope/);
    // A malformed placeholder is left over, never shown.
    expect(() => fillPlaceholders('Price: {{a}} {{a', { a: 'x' })).toThrow(/left over/);
    // A value is inserted as written, even with `$` in it.
    expect(fillPlaceholders('{{a}}', { a: "$1.00 $& $'" })).toBe("$1.00 $& $'");
  });

  it('test_credits_page_content', () => {
    const page = creditsMarkdown(template, CREDIT_PRICE_SCHEDULE, OCT_14);
    const facts = creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14);
    const text = flat(page);
    expect(page.split('\n')[0]).toBe(`# ${CREDITS_PAGE.title}`);
    expect(page).not.toMatch(/\{\{|\}\}/);
    expect(text).toContain('UnAlgorithm Cloud');
    expect(page).toContain('(https://cloud.unalgorithm.app)');
    expect(text).toContain('Add credit, or switch to on-device or your own key');
    for (const free of ['Rules', 'On-device AI', 'Your own key']) expect(text).toContain(free);
    // Running the server yourself is not promoted.
    expect(text).not.toMatch(/self-host/i);
    expect(text).toContain('Always free');
    expect(text).toContain(
      `charged at ${facts.classifyMultiplier} our AI cost, about ${facts.classifyPer1000} per thousand posts on ${facts.referenceModel}.`,
    );
    expect(text).toContain(`get ${facts.starterAmount} of starter credit`);
    expect(text).toContain(`${facts.starterDays} days`);
    for (const line of EXAMPLE_LINES) expect(page).toContain(line);
    expect(page).toContain(facts.labsPrices);
    // The scheduled change follows the price sentence.
    const changed = flat(creditsMarkdown(template, S, OCT_14));
    expect(changed).toContain(`per thousand posts on Claude Haiku 5.5. ${creditFacts(S, OCT_14).priceChange}`);
  });
});

/** CL5-09: a stub whose classify card doubles its multiplier 20 days after OCT_14. */
const NOV_3 = '2026-11-03T00:00:00Z';
const DOUBLED: CreditPriceSchedule = [
  LAUNCH,
  Object.freeze({
    effectiveFrom: NOV_3,
    cards: { classify: { ...LAUNCH_CLASSIFY, multiplier: LAUNCH_CLASSIFY.multiplier * 2 } },
  }),
];
const amountRows = (amounts: string): string[] => amounts.split('\n').filter((line) => /^\| \$/.test(line));

describe('pricing: buying credit, any amount (CL5-09)', () => {
  it('test_pricing_amounts_table_at_fixed_date', () => {
    const facts = creditFacts(CREDIT_PRICE_SCHEDULE, OCT_14);
    expect(facts.amountMin).toBe('$5');
    expect(facts.amountMax).toBe('$500');
    const { amounts } = facts;
    expect(
      amounts
        .split('\n')
        .filter((line) => line.startsWith('|'))
        .slice(0, 2),
    ).toEqual(['| You pay | Credit added | About |', '|---|---|---|']);
    expect(amountRows(amounts)).toEqual([
      '| $5.00 + tax where it applies | $5.00 | about 34,000 posts |',
      '| $10.00 + tax where it applies | $10.00 | about 68,000 posts |',
      '| $25.00 + tax where it applies | $25.00 | about 170,000 posts |',
    ]);
    expect(amountRows(amounts)).toHaveLength(CREDIT_AMOUNT_PRESETS.length);
    expect(amounts).not.toMatch(/pack|default/i);
    // In the page, the range and the examples follow the section's words.
    const page = creditsMarkdown(template, CREDIT_PRICE_SCHEDULE, OCT_14);
    const buying = page.slice(page.indexOf('## Buying credit'));
    expect(flat(buying)).toContain('Load any amount from $5 to $500, in whole dollars.');
    expect(flat(buying)).toContain('You pay exactly the amount you pick, plus tax where it applies');
    expect(buying).toContain(amounts);
    expect(flat(buying)).toContain('Purchased credit never expires.');
    expect(buying).toContain('(/refunds)');
    expect(page).not.toMatch(/\bpacks?\b/i);
  });

  it('test_pricing_amounts_table_dated_caption', () => {
    const dated = creditFacts(DOUBLED, OCT_14).amounts;
    expect(dated.split('\n')[0]).toBe('At the price until Nov 3, 2026 (UTC).');
    expect(amountRows(dated)).toHaveLength(CREDIT_AMOUNT_PRESETS.length); // one table, dated: no second column set
    expect(dated.split('\n')[2]).toBe('| You pay | Credit added | About |');
    const undated = creditFacts([LAUNCH], OCT_14).amounts;
    expect(undated.startsWith('|')).toBe(true);
    expect(undated).not.toContain('At the price until');
  });

  it('test_credits_markdown_still_figure_free', () => {
    expect(template).not.toMatch(/\$\d/);
    expect(template).not.toContain('×');
    expect(template).not.toMatch(/\d[\d,.]*\s+posts/);
    expect(template).not.toMatch(/^\|/m);
    for (const name of ['{{amountMin}}', '{{amountMax}}', '{{amounts}}']) expect(template).toContain(name);
    expect(() => creditsMarkdown(`${template}\n{{amountz}}`, CREDIT_PRICE_SCHEDULE, OCT_14)).toThrow(/amountz/);
    expect(() => creditsMarkdown(`${template}\n{{amounts`, CREDIT_PRICE_SCHEDULE, OCT_14)).toThrow(/left over/);
    expect(creditsMarkdown(template, CREDIT_PRICE_SCHEDULE, OCT_14)).not.toMatch(/\{\{|\}\}/);
  });
});

describe('pricing: credit calculator (CL5-09)', () => {
  it('test_calculator_data_covers_next_change', () => {
    const data = calculatorData(DOUBLED, OCT_14);
    expect(data.amount).toEqual({ minDollars: 5, maxDollars: 500, presetDollars: [5, 10, 25], defaultDollars: 10 });
    expect(data.amount.minDollars * 1_000_000).toBe(CREDIT_AMOUNT_MIN_MICROS);
    expect(data.amount.maxDollars * 1_000_000).toBe(CREDIT_AMOUNT_MAX_MICROS);
    expect(data.amount.presetDollars.map((d) => d * 1_000_000)).toEqual([...CREDIT_AMOUNT_PRESETS]);
    expect(data.amount.defaultDollars * 1_000_000).toBe(DEFAULT_CREDIT_AMOUNT);
    expect(data.prices).toEqual([
      { from: LAUNCH.effectiveFrom, microsPer1000Posts: retailMicrosPer1000Posts(OCT_14, 'classify', DOUBLED) },
      { from: NOV_3, microsPer1000Posts: retailMicrosPer1000Posts(new Date(NOV_3), 'classify', DOUBLED) },
    ]);
    const [now, next] = data.prices;
    expect(next!.microsPer1000Posts / now!.microsPer1000Posts).toBeGreaterThan(1.9);
    expect(next!.microsPer1000Posts / now!.microsPer1000Posts).toBeLessThan(2.1);
    // No later change: one price.
    expect(calculatorData([LAUNCH], OCT_14).prices).toHaveLength(1);
  });

  it('test_calculator_posts_match_estimate_for_every_amount', () => {
    const data = calculatorData(CREDIT_PRICE_SCHEDULE, OCT_14);
    for (let dollars = data.amount.minDollars; dollars <= data.amount.maxDollars; dollars++) {
      const result = calculatorResult(data, String(dollars), '1', OCT_14);
      const micros = creditAmount({ dollars })?.micros ?? 0;
      expect(result, String(dollars)).toMatchObject({ ok: true, posts: estimatePosts(micros, OCT_14) });
    }
  });

  it('test_calculator_days_and_input_errors', () => {
    const data = calculatorData([LAUNCH], OCT_14);
    const now = OCT_14;
    expect(calculatorResult(data, '10', '150', now)).toEqual({
      ok: true,
      days: 453,
      posts: 68_000,
      text: '$10 of credit lasts about 453 days at 150 posts a day.',
    });
    expect(calculatorResult(data, '25', '150', now)).toMatchObject({
      ok: true,
      text: '$25 of credit lasts about 1,133 days at 150 posts a day.',
    });
    expect(calculatorResult(data, '5', '5000', now)).toMatchObject({
      text: '$5 of credit lasts about 6 days at 5,000 posts a day.',
    });
    // Any whole-dollar amount, not only the quick picks; a leading "$" is fine.
    expect(calculatorResult(data, ' $40 ', '150', now)).toMatchObject({ ok: true, days: Math.floor(270_000 / 150) });
    expect(calculatorResult(data, '500', '150', now)).toMatchObject({
      ok: true,
      text: '$500 of credit lasts about 22,666 days at 150 posts a day.',
    });
    const amountError = calculatorAmountError(data);
    expect(amountError).toBe('Enter a whole-dollar amount from $5 to $500.');
    for (const amount of [
      '4',
      '501',
      '0',
      '010',
      '10000000',
      '',
      '  ',
      'abc',
      '10.5',
      '10.00',
      '-10',
      '1e1',
      '$$10',
      'Infinity',
    ]) {
      expect(calculatorResult(data, amount, '150', now), amount).toEqual({ ok: false, field: 'amount', error: amountError });
      // The calculator takes exactly what a purchase takes.
      expect(creditAmount({ dollars: amount.trim() }), amount).toBeNull();
    }
    for (const input of ['0', '5001', '', '  ', 'abc', '1.5', '-3', 'Infinity']) {
      expect(calculatorResult(data, '10', input, now), input).toEqual({
        ok: false,
        field: 'posts',
        error: CALCULATOR_INPUT_ERROR,
      });
    }
    // A wrong amount is reported first.
    expect(calculatorResult(data, '4', '0', now)).toMatchObject({ field: 'amount' });
    expect(CALCULATOR_INPUT_ERROR).toBe('Enter a number from 1 to 5,000.');
    expect(calculatorResult(data, '10', ' 1 ', now)).toMatchObject({ ok: true, days: 68_000 });
    // What runs in the browser imports nothing at run time (the protocol would bundle zod).
    const browser = readFileSync(new URL('packages/core/src/credit-calculator.ts', REPO_ROOT), 'utf8');
    expect(browser.match(/^import .*$/gm)).toBeNull();
  });

  it('test_calculator_switches_card_after_change_date', () => {
    const data = calculatorData(DOUBLED, OCT_14);
    const before = calculatorResult(data, '10', '150', new Date('2026-11-02T23:59:59Z'));
    const after = calculatorResult(data, '10', '150', new Date(NOV_3));
    const postsAt = (at: Date) => estimatePosts(10_000_000, at, 'classify', DOUBLED);
    expect(before).toMatchObject({ ok: true, days: Math.floor(postsAt(OCT_14) / 150) });
    expect(after).toMatchObject({ ok: true, days: Math.floor(postsAt(new Date(NOV_3)) / 150) });
    expect((before as { days: number }).days).toBeGreaterThan((after as { days: number }).days);
  });
});
