import { readFileSync } from 'node:fs';
import {
  CREDIT_PRICE_SCHEDULE,
  CREDITS_PAGE,
  type CreditPriceSchedule,
  priceCardsAt,
  STARTER_CREDIT,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  CREDITS_PLACEHOLDERS,
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
      '- **Other perspectives**: from Nov 1, 2026 (UTC), 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison.',
    ]);
    // Once in effect, the same line without its date.
    expect(creditFacts(CREDIT_PRICE_SCHEDULE, new Date('2026-11-01T00:00:00Z')).labsPrices.split('\n')[1]).toBe(
      '- **Other perspectives**: 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison.',
    );
    // A change to a card in effect is dated like classify's.
    const pv = priceCardsAt(new Date('2026-11-01T00:00:00Z'));
    const cut = { ...(pv.cards.perspectives ?? LAUNCH_CLASSIFY), multiplier: 1.5 };
    const changed: CreditPriceSchedule = [
      pv,
      { effectiveFrom: '2027-01-01T00:00:00Z', cards: { ...pv.cards, perspectives: cut } },
    ];
    expect(creditFacts(changed, NOV_15).labsPrices).toBe(
      '- **Other perspectives**: 2× our AI cost, typically about $0.27 per comparison on Claude Sonnet 5.5, and never more than $0.50 for one comparison. That price applies until Jan 1, 2027 (UTC). From Jan 1, 2027 (UTC): 1.5× our AI cost, typically about $0.20 per comparison, and never more than $0.50 for one comparison.',
    );
    // Only classify priced, now and later.
    expect(creditFacts([LAUNCH], OCT_14).labsPrices).toBe('Labs features are not offered on UnAlgorithm Cloud yet.');
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
    for (const free of ['Rules', 'On-device AI', 'Your own key', 'Self-hosted servers']) expect(text).toContain(free);
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
