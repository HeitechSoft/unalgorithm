import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.ts';
import {
  ACCOUNT_PAGE_PATH,
  CREDIT_ACCOUNT_PATH,
  CREDIT_AMOUNT_MAX_MICROS,
  CREDIT_AMOUNT_MIN_MICROS,
  CREDIT_AMOUNT_PRESETS,
  CREDIT_AMOUNT_STEP_MICROS,
  CREDIT_BALANCE_PATH,
  CREDIT_CURRENCY,
  CREDIT_ENTRY_KINDS,
  CREDIT_ENTRY_REASONS,
  CREDIT_PRICE_SCHEDULE,
  CREDIT_TASKS,
  CreditAccountSchema,
  CreditBalanceSchema,
  CreditHistoryItemSchema,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  checkPriceScheduleChange,
  creditAmount,
  DEFAULT_CREDIT_AMOUNT,
  estimatePosts,
  FACTCHECK_COST_CEILING_MICROS,
  FACTCHECK_TYPICAL_COST_MICROS,
  jobPriceAt,
  LOW_BALANCE_MICROS,
  MAX_CREDIT_HISTORY,
  nextPriceChange,
  PRICE_CARDS,
  PRICE_NOTICE_DAYS,
  priceCardsAt,
  priceRaisesWithinNotice,
  priceScheduleProblems,
  retailMicros,
  retailMicrosPer1000Posts,
  STARTER_CREDIT,
  taskPriceAt,
} from '../src/index.ts';

/** The undated cards CL2-26 removed, spelled in parts so that `git grep` finds the name in no tracked file. */
const REMOVED_CARDS = ['CREDIT', 'PRICE', 'CARDS'].join('_');

/** Fixed instants: no test here reads the clock (CL2-26 → Tests and the clock). */
const NOW = new Date('2026-10-14T12:00:00Z');
const at = (iso: string) => new Date(iso);
const MODEL = 'claude-haiku-5-5';

function entry(effectiveFrom: string, multiplier: number, cost = 73_000, model = MODEL): CreditPriceScheduleEntry {
  return { effectiveFrom, cards: { classify: { multiplier, referenceModel: model, referenceCostMicrosPer1000: cost } } };
}

/** The 2026-10-01 entry exactly as published: rule 1 keeps it deep-equal for good. */
const LAUNCH: CreditPriceScheduleEntry = {
  effectiveFrom: '2026-10-01T00:00:00Z',
  cards: { classify: { multiplier: 2, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73000 } },
};

/** The stub schedule S: the launch card A, then B (a raise to 2.5) from 15 November. */
const A = entry('2026-10-01T00:00:00Z', 2);
const B = entry('2026-11-15T00:00:00Z', 2.5);
const S: CreditPriceSchedule = [A, B];

const raiseText = (instant: string, from: [number, number], to: [number, number], earliest: string, days = 30) =>
  `${instant}: classify would go from multiplier ${from[0]} and ${from[1]} micro-dollars per 1,000 posts to multiplier ${to[0]} and ${to[1]}; a price raise needs ${days} days' notice: the earliest effectiveFrom allowed now for it is ${earliest}`;
const pastText = (e: string, earliest: string) =>
  `${e}: a new or changed price cannot start in the past; the earliest effectiveFrom allowed now is ${earliest}`;

describe('price schedule', () => {
  it('test_price_schedule_launch_entry', () => {
    expect(CREDIT_PRICE_SCHEDULE[0]).toEqual(LAUNCH);
    expect(Object.isFrozen(CREDIT_PRICE_SCHEDULE)).toBe(true);
    for (const e of CREDIT_PRICE_SCHEDULE) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.cards)).toBe(true);
      for (const c of Object.values(e.cards)) expect(Object.isFrozen(c)).toBe(true);
    }
    // The entry in effect and every later one name a model with a price card (never checked for past entries).
    const current = CREDIT_PRICE_SCHEDULE.filter((e) => e === priceCardsAt(NOW) || Date.parse(e.effectiveFrom) > NOW.getTime());
    expect(current.length).toBeGreaterThan(0);
    for (const e of current) expect(e.cards.classify.referenceModel in PRICE_CARDS).toBe(true);
    expect(PRICE_NOTICE_DAYS).toBe(30);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    expect(REMOVED_CARDS in protocol).toBe(false);
  });

  it('test_price_cards_at_and_next_change', () => {
    expect(priceCardsAt(at('2026-11-14T23:59:59.999Z'), S)).toBe(A);
    expect(priceCardsAt(at('2026-11-15T00:00:00.000Z'), S)).toBe(B);
    expect(priceCardsAt(at('2026-09-01T00:00:00Z'), S)).toBe(A);
    expect(nextPriceChange(NOW, S)).toBe(B);
    expect(nextPriceChange(at('2026-11-15T00:00:00Z'), S)).toBeNull();
    expect(() => priceCardsAt(new Date(Number.NaN), S)).toThrow(RangeError);
    expect(() => priceCardsAt(NOW, [])).toThrow(RangeError);
    expect(priceCardsAt(NOW)).toBe(CREDIT_PRICE_SCHEDULE[0]);
    expect(nextPriceChange(NOW)).toBe(CREDIT_PRICE_SCHEDULE[1] ?? null);
  });

  it('test_retail_micros_rounds_up_and_rejects_bad_input', () => {
    expect(retailMicros(435, 2)).toBe(870);
    expect(retailMicros(1, 1.75)).toBe(2);
    expect(retailMicros(0, 2)).toBe(0);
    // 1.1 is not exact in binary floating point: Math.ceil(100 * 1.1) would be 111.
    expect(retailMicros(100, 1.1)).toBe(110);
    expect(retailMicros(1, 1.1)).toBe(2);
    for (const [cost, multiplier] of [
      [-1, 2],
      [1.5, 2],
      [10, 0],
      [10, Number.NaN],
      [10, 1.00001],
    ] as const) {
      expect(() => retailMicros(cost, multiplier)).toThrow(RangeError);
    }
  });

  it('test_retail_per_1000_posts', () => {
    expect(retailMicrosPer1000Posts(NOW)).toBe(146_000);
    expect(retailMicrosPer1000Posts(NOW, 'classify')).toBe(146_000);
    expect(retailMicrosPer1000Posts(at('2026-11-14T23:59:59.999Z'), 'classify', S)).toBe(146_000);
    expect(retailMicrosPer1000Posts(at('2026-11-15T00:00:00Z'), 'classify', S)).toBe(182_500);
  });

  it('test_estimate_posts_vectors', () => {
    const vectors: [balanceMicros: number, posts: number][] = [
      [1_000_000, 6_800],
      [970_000, 6_600],
      [4_820_000, 33_000],
      [200_000, 1_300],
      [25_000_000, 170_000],
      [10_000, 68],
      [146, 1],
      [145, 0],
      [0, 0],
      [-5, 0],
    ];
    for (const [balance, posts] of vectors) expect(estimatePosts(balance, NOW), `${balance}`).toBe(posts);
    expect(estimatePosts(1_000_000, at('2026-11-15T00:00:00Z'), 'classify', S)).toBe(5_400);
    expect(estimatePosts(1_000_000, at('2026-11-14T23:59:59.999Z'), 'classify', S)).toBe(6_800);
    // $0 reads neither the instant nor the schedule.
    expect(estimatePosts(0, new Date(Number.NaN))).toBe(0);
  });

  it('test_price_schedule_problems', () => {
    const bad = (problem: string, schedule: CreditPriceSchedule) => expect(priceScheduleProblems(schedule)).toEqual([problem]);
    const format = (e: string) => `entry 1 (${e}): effectiveFrom must be YYYY-MM-DDT00:00:00Z on a real calendar day`;
    const withCards = (cards: unknown) => [A, { ...B, cards: cards as CreditPriceScheduleEntry['cards'] }];
    bad('the schedule is empty', []);
    for (const e of ['2026-11-15T01:00:00Z', '2026-11-15', '2026-02-30T00:00:00Z'])
      bad(format(e), [A, { ...B, effectiveFrom: e }]);
    bad("entry 1 (2026-10-01T00:00:00Z): effectiveFrom must be later than entry 0's", [
      A,
      { ...B, effectiveFrom: A.effectiveFrom },
    ]);
    bad("entry 1 (2026-09-01T00:00:00Z): effectiveFrom must be later than entry 0's", [
      A,
      { ...B, effectiveFrom: '2026-09-01T00:00:00Z' },
    ]);
    const cards = 'entry 1 (2026-11-15T00:00:00Z): cards must price classify';
    bad(cards, withCards({}));
    expect(priceScheduleProblems(withCards({ ...B.cards, factcheck: B.cards.classify }))).toEqual([
      "entry 1 (2026-11-15T00:00:00Z): adds factcheck, so its other cards must equal entry 0's",
      'entry 1 (2026-11-15T00:00:00Z): factcheck unit must be check',
      'entry 1 (2026-11-15T00:00:00Z): factcheck maxChargeMicros must be a whole number of micro-dollars, at least its typical price of 183',
    ]);
    // A task key without a card prices nothing: every reader would crash on it, and the CI rule would compare nothing.
    bad(cards, withCards({ classify: null }));
    bad(cards, withCards({ classify: undefined }));
    const multiplier = 'entry 1 (2026-11-15T00:00:00Z): classify multiplier must be positive, in whole basis points';
    bad(multiplier, [A, entry(B.effectiveFrom, 1.00001)]);
    bad(multiplier, [A, entry(B.effectiveFrom, 0)]);
    const cost = 'entry 1 (2026-11-15T00:00:00Z): classify referenceCostMicrosPer1000 must be a whole number above 0';
    bad(cost, [A, entry(B.effectiveFrom, 2.5, 0)]);
    bad(cost, [A, entry(B.effectiveFrom, 2.5, 1.5)]);
    bad('entry 1 (2026-11-15T00:00:00Z): classify referenceModel must be a non-empty model id', [
      A,
      entry(B.effectiveFrom, 2.5, 73_000, ''),
    ]);
  });
});

describe('schedule changes (the CI rule)', () => {
  const check = (base: CreditPriceSchedule, head: CreditPriceSchedule, now = NOW, days = 30) =>
    checkPriceScheduleChange(base, head, now, days);

  it('test_schedule_change_keeps_prices_in_effect', () => {
    expect(check(S, S)).toEqual([]);
    expect(check(S, [A])).toEqual([]);
    expect(check(S, [entry(A.effectiveFrom, 2.5), B])).toEqual([
      '2026-10-01T00:00:00Z: this price is in effect and cannot change; add a new dated entry instead',
    ]);
    expect(check(S, [B])).toEqual(['2026-10-01T00:00:00Z: this price is in effect and cannot be removed']);
    expect(check(S, [A], at('2026-11-15T00:00:00Z'))).toEqual([
      '2026-11-15T00:00:00Z: this price is in effect and cannot be removed',
    ]);
  });

  it('test_schedule_change_allows_cut_from_next_midnight', () => {
    expect(check(S, [A, entry('2026-10-15T00:00:00Z', 1.5), B])).toEqual([]);
  });

  it('test_schedule_change_raise_needs_notice', () => {
    const raise = (e: string) => [A, entry(e, 2.25), B];
    expect(check(S, raise('2026-11-13T00:00:00Z'))).toEqual([
      raiseText('2026-11-13T00:00:00Z', [2, 146000], [2.25, 164250], '2026-11-14T00:00:00Z'),
    ]);
    expect(check(S, raise('2026-11-14T00:00:00Z'))).toEqual([]);
    const longer = check(S, raise('2026-11-14T00:00:00Z'), NOW, 45);
    expect(longer).toHaveLength(1);
    expect(longer[0]).toMatch(
      /a price raise needs 45 days' notice: the earliest effectiveFrom allowed now for it is 2026-11-29T00:00:00Z$/,
    );

    // The window ends exactly at 19 November: an entry there is outside it.
    const later = at('2026-10-20T00:00:00Z');
    expect(check(S, [A, B, entry('2026-11-19T00:00:00Z', 3)], later)).toEqual([]);
    expect(check(S, [A, B, entry('2026-11-18T00:00:00Z', 3)], later)).toEqual([
      raiseText('2026-11-18T00:00:00Z', [2.5, 182500], [3, 219000], '2026-11-19T00:00:00Z'),
    ]);

    for (const n of [Number.NaN, -1, 1.5]) {
      expect(() => checkPriceScheduleChange(S, S, NOW, n), String(n)).toThrow(RangeError);
      expect(() => priceRaisesWithinNotice(S, S, NOW, n), String(n)).toThrow(RangeError);
    }
    expect(checkPriceScheduleChange(S, S, NOW, 0)).toEqual([]);
    expect(priceRaisesWithinNotice(S, S, NOW, 0)).toEqual([]);
  });

  it('test_schedule_change_cut_that_ends_needs_notice', () => {
    const C = entry('2026-10-15T00:00:00Z', 1.5);
    const R = entry('2026-10-20T00:00:00Z', 2);
    expect(check(S, [A, C, R, B])).toEqual([
      "2026-10-20T00:00:00Z: classify would rise from multiplier 1.5 and 109500 micro-dollars per 1,000 posts just before it to multiplier 2 and 146000, a rise the base does not have then; a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-11-14T00:00:00Z",
    ]);
    expect(check(S, [A, C, entry('2026-11-14T00:00:00Z', 2), B])).toEqual([]);
    // The same end in a second pull request.
    expect(check([A, C, B], [A, C, R, B])).toEqual([
      raiseText('2026-10-20T00:00:00Z', [1.5, 109500], [2, 146000], '2026-11-14T00:00:00Z'),
    ]);
    // A cut before a raise already announced: the base rises there too.
    const U = entry('2026-11-01T00:00:00Z', 2.5);
    expect(check([A, U], [A, C, U])).toEqual([]);
  });

  it('test_schedule_change_refuses_start_in_past', () => {
    for (const multiplier of [1.5, 2.5]) {
      expect(check(S, [A, entry('2026-10-10T00:00:00Z', multiplier), B])).toEqual([
        pastText('2026-10-10T00:00:00Z', '2026-10-15T00:00:00Z'),
      ]);
    }
    expect(check(S, [A, entry('2026-10-14T00:00:00Z', 1.5), B])).toEqual([
      pastText('2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z'),
    ]);
    const cut = [A, entry('2026-10-15T00:00:00Z', 1.5), B];
    expect(check(S, cut, at('2026-10-15T00:00:00Z'))).toEqual([pastText('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z')]);
    const justBefore = at('2026-10-14T23:59:59.999Z');
    expect(check(S, cut, justBefore)).toEqual([]);
    expect(check(S, [A, entry('2026-10-10T00:00:00Z', 1.5), B], justBefore)).toEqual([
      pastText('2026-10-10T00:00:00Z', '2026-10-15T00:00:00Z'),
    ]);
    // A copy of another entry's cards is still a new entry.
    const P = entry('2026-10-20T00:00:00Z', 2.5);
    expect(check([A, P], [A, { ...P, effectiveFrom: '2026-10-10T00:00:00Z' }, P], at('2026-10-25T00:00:00Z'))).toEqual([
      pastText('2026-10-10T00:00:00Z', '2026-10-26T00:00:00Z'),
    ]);
  });

  it('test_schedule_change_announced_raise', () => {
    const later = at('2026-10-20T00:00:00Z');
    expect(check(S, [A, entry(B.effectiveFrom, 3)])).toEqual([]);
    expect(check(S, [A, entry(B.effectiveFrom, 3)], later)).toEqual([
      raiseText('2026-11-15T00:00:00Z', [2.5, 182500], [3, 219000], '2026-11-19T00:00:00Z'),
    ]);
    expect(check(S, [A, entry(B.effectiveFrom, 2.25)], later)).toEqual([]);
  });

  it('test_schedule_change_checks_head_shape', () => {
    expect(check(S, [A, entry('2026-11-14T01:00:00Z', 2.5), B])).toEqual([
      'head: entry 1 (2026-11-14T01:00:00Z): effectiveFrom must be YYYY-MM-DDT00:00:00Z on a real calendar day',
    ]);
  });

  it('test_schedule_change_cancellations', () => {
    const K = entry('2026-10-20T00:00:00Z', 1.5);
    const U = entry('2026-11-01T00:00:00Z', 2.5);
    const Z = [A, K, U];
    expect(check(Z, [A, U])).toEqual([raiseText('2026-10-20T00:00:00Z', [1.5, 109500], [2, 146000], '2026-11-14T00:00:00Z')]);
    expect(check(Z, [A, K])).toEqual([]);
    expect(check([A, entry(B.effectiveFrom, 1.5)], [A])).toEqual([]);
  });

  it('test_schedule_change_compares_each_task', () => {
    // `priceRaisesWithinNotice` reads no shape: these factcheck cards lack the unit and cap a schedule needs.
    const two = (effectiveFrom: string, classify: number, factcheck: number) => ({
      effectiveFrom,
      cards: {
        classify: { multiplier: classify, referenceModel: MODEL, referenceCostMicrosPer1000: 73_000 },
        factcheck: { multiplier: factcheck, referenceModel: MODEL, referenceCostMicrosPer1000: 73_000 },
      },
    });
    const W = [two('2026-10-01T00:00:00Z', 2, 2)] as unknown as CreditPriceSchedule;
    const head = (factcheck: number) => [...W, two('2026-10-20T00:00:00Z', 1.5, factcheck)] as unknown as CreditPriceSchedule;
    expect(priceRaisesWithinNotice(W, head(2.5), NOW, 30)).toEqual([
      "2026-10-20T00:00:00Z: factcheck would go from multiplier 2 and 146000 micro-dollars per 1,000 posts to multiplier 2.5 and 182500; a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-11-14T00:00:00Z",
    ]);
    expect(priceRaisesWithinNotice(W, head(2), NOW, 30)).toEqual([]);
  });

  it('test_schedule_change_compares_published_price', () => {
    const on20th = (multiplier: number, cost: number, model = MODEL) => [
      A,
      entry('2026-10-20T00:00:00Z', multiplier, cost, model),
      B,
    ];
    expect(check(S, on20th(2, 80_000))).toEqual([
      raiseText('2026-10-20T00:00:00Z', [2, 146000], [2, 160000], '2026-11-14T00:00:00Z'),
    ]);
    const higherMultiplier = check(S, on20th(2.5, 50_000));
    expect(higherMultiplier).toHaveLength(1);
    expect(higherMultiplier[0]).toContain('to multiplier 2.5 and 125000;');
    expect(check(S, on20th(2, 70_000))).toEqual([]);
    expect(check(S, on20th(2, 73_000, 'other-model'))).toEqual([]);
  });

  it('test_schedule_change_in_effect_only', () => {
    const inEffect = (head: CreditPriceSchedule, now = NOW) => checkPriceScheduleChange(S, head, now, 30, 'in-effect');
    const backdated = [A, entry('2026-10-10T00:00:00Z', 1.5), B];
    expect(inEffect(backdated)).toEqual([]);
    expect(check(S, backdated)).toHaveLength(1);
    expect(inEffect([entry(A.effectiveFrom, 2.5), B])).toEqual([
      '2026-10-01T00:00:00Z: this price is in effect and cannot change; add a new dated entry instead',
    ]);
    expect(inEffect([A], at('2026-11-15T00:00:00Z'))).toEqual([
      '2026-11-15T00:00:00Z: this price is in effect and cannot be removed',
    ]);
  });
});

/** The 2026-11-01 fixture entry: the launch card copied, fact-check and perspectives added at 2× with their hold caps. */
const FACTCHECK = {
  multiplier: 2,
  referenceModel: 'claude-sonnet-5-5',
  referenceCostMicrosPer1000: 120_000_000,
  unit: 'check',
  maxChargeMicros: 400_000,
} as const;
const PERSPECTIVES = {
  multiplier: 2,
  referenceModel: 'claude-sonnet-5-5',
  referenceCostMicrosPer1000: 135_000_000,
  unit: 'comparison',
  maxChargeMicros: 500_000,
} as const;
const L = CREDIT_PRICE_SCHEDULE[0] as CreditPriceScheduleEntry;
const F: CreditPriceScheduleEntry = {
  effectiveFrom: '2026-11-01T00:00:00Z',
  cards: { classify: L.cards.classify, factcheck: FACTCHECK, perspectives: PERSPECTIVES },
};
const FIXTURE: CreditPriceSchedule = [L, F];
/** The schedule before P3-51 appended the 2026-12-01 fact-check entry, as published (not read back from the head). */
const TWO_ENTRIES: CreditPriceSchedule = [
  LAUNCH,
  { effectiveFrom: '2026-11-01T00:00:00Z', cards: { classify: LAUNCH.cards.classify, perspectives: PERSPECTIVES } },
];
/** The fixture, then an entry from `e` copying F's cards with `cards` replaced. */
const after = (e: string, cards: Partial<CreditPriceScheduleEntry['cards']>): CreditPriceSchedule => [
  ...FIXTURE,
  { effectiveFrom: e, cards: { ...F.cards, ...cards } },
];

describe('adding a task', () => {
  const OCT_15 = at('2026-10-15T12:00:00Z');

  it('test_credit_tasks_added_without_touching_entry_in_effect', () => {
    expect(CREDIT_TASKS).toEqual(['classify', 'factcheck', 'perspectives']);
    expect(CREDIT_PRICE_SCHEDULE[0]).toEqual(LAUNCH);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
  });

  it('test_perspectives_entry_passes_shape_and_change_rules', () => {
    expect(CREDIT_PRICE_SCHEDULE.slice(0, 2)).toEqual(TWO_ENTRIES);
    // The classify card is the launch card, the same object.
    expect(CREDIT_PRICE_SCHEDULE[1]?.cards.classify).toBe(CREDIT_PRICE_SCHEDULE[0]?.cards.classify);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    // A new task's first card is not a raise, and the entry in effect is unchanged.
    expect(checkPriceScheduleChange([LAUNCH], CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
    expect(taskPriceAt(OCT_15, 'perspectives')).toEqual({ offered: false });
  });

  it('test_job_price_at_perspectives_from_its_date', () => {
    expect(jobPriceAt(at('2026-11-02T00:00:00Z'), 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(jobPriceAt(at('2026-10-31T23:59:59Z'), 'perspectives')).toBeNull();
    // Fact-check is not priced until its own entry (P3-51).
    expect(jobPriceAt(at('2026-11-02T00:00:00Z'), 'factcheck')).toBeNull();
  });

  it('test_perspectives_cap_raise_needs_notice', () => {
    const real = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;
    const raised: CreditPriceSchedule = [
      ...TWO_ENTRIES,
      {
        effectiveFrom: '2026-11-11T00:00:00Z',
        cards: { ...real.cards, perspectives: { ...PERSPECTIVES, maxChargeMicros: 600_000 } },
      },
    ];
    const problems = checkPriceScheduleChange(TWO_ENTRIES, raised, at('2026-11-05T12:00:00Z'));
    expect(problems).toEqual([
      "2026-11-11T00:00:00Z: perspectives would raise its maximum charge from 500000 to 600000 micro-dollars; a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-12-06T00:00:00Z",
    ]);
  });

  it('test_new_task_first_entry_is_not_a_raise', () => {
    expect(priceScheduleProblems(FIXTURE)).toEqual([]);
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, FIXTURE, OCT_15)).toEqual([]);
  });

  it('test_schedule_never_drops_a_task', () => {
    const { factcheck: _dropped, ...rest } = F.cards;
    expect(priceScheduleProblems([...FIXTURE, { effectiveFrom: '2026-12-01T00:00:00Z', cards: rest }])).toEqual([
      'entry 2 (2026-12-01T00:00:00Z): drops factcheck, which entry 1 priced',
    ]);
  });

  it('test_new_task_entry_copies_other_cards', () => {
    const classify = { ...L.cards.classify, multiplier: 1.5 };
    expect(priceScheduleProblems([L, { ...F, cards: { ...F.cards, classify } }])).toEqual([
      "entry 1 (2026-11-01T00:00:00Z): adds factcheck, perspectives, so its other cards must equal entry 0's",
    ]);
    // Once the tasks are priced, a later entry may change any card (the no-raise rule still applies).
    expect(priceScheduleProblems(after('2026-12-01T00:00:00Z', { classify }))).toEqual([]);
  });

  it('test_schedule_rejects_unknown_task_and_missing_classify', () => {
    const summarize = { ...F, cards: { ...F.cards, summarize: L.cards.classify } } as unknown as CreditPriceScheduleEntry;
    expect(priceScheduleProblems([L, summarize])).toEqual(['entry 1 (2026-11-01T00:00:00Z): summarize is not a credit task']);
    const noClassify = { effectiveFrom: L.effectiveFrom, cards: { factcheck: FACTCHECK } } as unknown as CreditPriceScheduleEntry;
    expect(priceScheduleProblems([noClassify])).toEqual(['entry 0 (2026-10-01T00:00:00Z): cards must price classify']);
  });

  it('test_job_card_needs_unit_and_max_charge', () => {
    const e = '2026-12-01T00:00:00Z';
    const cap = `entry 2 (${e}): factcheck maxChargeMicros must be a whole number of micro-dollars, at least its typical price of 240000`;
    const unit = `entry 2 (${e}): factcheck unit must be check`;
    const { maxChargeMicros: _cap, ...noCap } = FACTCHECK;
    const { unit: _unit, ...noUnit } = FACTCHECK;
    expect(priceScheduleProblems(after(e, { factcheck: noCap }))).toEqual([cap]);
    expect(priceScheduleProblems(after(e, { factcheck: noUnit }))).toEqual([unit]);
    expect(priceScheduleProblems(after(e, { factcheck: { ...FACTCHECK, unit: 'post' } }))).toEqual([unit]);
    expect(priceScheduleProblems(after(e, { factcheck: { ...FACTCHECK, maxChargeMicros: 100_000 } }))).toEqual([cap]);
    // Classify may name its unit, and has no hold cap.
    expect(priceScheduleProblems(after(e, { classify: { ...L.cards.classify, unit: 'post' } }))).toEqual([]);
    expect(priceScheduleProblems(after(e, { classify: { ...L.cards.classify, maxChargeMicros: 1_000 } }))).toEqual([
      `entry 2 (${e}): classify has no maxChargeMicros`,
    ]);
  });

  it('test_higher_max_charge_is_a_raise', () => {
    const nov5 = at('2026-11-05T12:00:00Z');
    const notice = "a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-12-06T00:00:00Z";
    const raised = after('2026-11-15T00:00:00Z', { factcheck: { ...FACTCHECK, maxChargeMicros: 450_000 } });
    expect(checkPriceScheduleChange(FIXTURE, raised, nov5)).toEqual([
      `2026-11-15T00:00:00Z: factcheck would raise its maximum charge from 400000 to 450000 micro-dollars; ${notice}`,
    ]);
    const cut = after('2026-11-06T00:00:00Z', { factcheck: { ...FACTCHECK, maxChargeMicros: 350_000 } });
    expect(checkPriceScheduleChange(FIXTURE, cut, nov5)).toEqual([]);
    // Ending that cut within the notice is a rise the base does not have.
    const ended = [...cut, { effectiveFrom: '2026-11-10T00:00:00Z', cards: F.cards }];
    expect(checkPriceScheduleChange(cut, ended, nov5)).toEqual([
      `2026-11-10T00:00:00Z: factcheck would raise its maximum charge from 350000 to 400000 micro-dollars; ${notice}`,
    ]);
  });

  it('test_scheduled_first_card_raise_needs_notice', () => {
    // Once on main, a task's first card is a published price: raising it before its date is a raise like any other.
    const notice = "a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-11-15T00:00:00Z";
    const dearer = { ...FACTCHECK, multiplier: 3, maxChargeMicros: 600_000 };
    const raise = (e: string) => [
      `${e}: factcheck would raise its maximum charge from 400000 to 600000 micro-dollars; ${notice}`,
      `${e}: factcheck would go from multiplier 2 and 240000000 micro-dollars per 1,000 posts to multiplier 3 and 360000000; ${notice}`,
    ];
    const raisedInPlace = [L, { ...F, cards: { ...F.cards, factcheck: dearer } }];
    expect(checkPriceScheduleChange(FIXTURE, raisedInPlace, OCT_15)).toEqual(raise(F.effectiveFrom));
    const postponedAndRaised = [L, { effectiveFrom: '2026-11-10T00:00:00Z', cards: { ...F.cards, factcheck: dearer } }];
    expect(checkPriceScheduleChange(FIXTURE, postponedAndRaised, OCT_15)).toEqual(raise('2026-11-10T00:00:00Z'));
    // Lowering it, postponing it or cancelling it is not a raise.
    const lowered = [L, { ...F, cards: { ...F.cards, factcheck: { ...FACTCHECK, maxChargeMicros: 350_000 } } }];
    expect(checkPriceScheduleChange(FIXTURE, lowered, OCT_15)).toEqual([]);
    expect(checkPriceScheduleChange(FIXTURE, [L, { ...F, effectiveFrom: '2026-11-10T00:00:00Z' }], OCT_15)).toEqual([]);
    expect(checkPriceScheduleChange(FIXTURE, [L], OCT_15)).toEqual([]);
    // After its first card, a task's rise needs notice even where the base does not offer it yet.
    const addedThenRaised = (e: string) => [...FIXTURE, { effectiveFrom: e, cards: { ...F.cards, factcheck: dearer } }];
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, addedThenRaised('2026-11-05T00:00:00Z'), OCT_15)).toEqual([
      `2026-11-05T00:00:00Z: factcheck would raise its maximum charge from 400000 to 600000 micro-dollars; ${notice}`,
      `2026-11-05T00:00:00Z: factcheck would rise from multiplier 2 and 240000000 micro-dollars per 1,000 posts just before it to multiplier 3 and 360000000, a rise the base does not have then; ${notice}`,
    ]);
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, addedThenRaised('2026-11-15T00:00:00Z'), OCT_15)).toEqual([]);
  });

  it('test_task_price_at_not_offered_then_offered', () => {
    expect(taskPriceAt(OCT_15, 'factcheck')).toEqual({ offered: false });
    expect(taskPriceAt(OCT_15, 'classify')).toEqual({ offered: true, card: L.cards.classify, effectiveFrom: L.effectiveFrom });
    expect(taskPriceAt(at('2026-10-31T23:59:59Z'), 'factcheck', FIXTURE)).toEqual({ offered: false });
    expect(taskPriceAt(at('2026-11-01T00:00:00Z'), 'factcheck', FIXTURE)).toEqual({
      offered: true,
      card: FACTCHECK,
      effectiveFrom: '2026-11-01T00:00:00Z',
    });
    expect(() => taskPriceAt(new Date(Number.NaN), 'factcheck')).toThrow(RangeError);
  });

  it('test_job_price_at_typical_and_max', () => {
    const nov2 = at('2026-11-02T00:00:00Z');
    expect(jobPriceAt(nov2, 'factcheck', FIXTURE)).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(jobPriceAt(nov2, 'perspectives', FIXTURE)).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(jobPriceAt(nov2, 'factcheck')).toBeNull();
  });
});

describe('terms and paths', () => {
  it('test_starter_terms_and_paths', () => {
    expect(STARTER_CREDIT).toEqual({ amountMicros: 1_000_000, expiresAfterDays: 90 });
    expect(Object.isFrozen(STARTER_CREDIT)).toBe(true);
    expect(LOW_BALANCE_MICROS).toBe(200_000);
    expect(CREDIT_BALANCE_PATH).toBe('/v1/billing/balance');
    expect(CREDIT_ACCOUNT_PATH).toBe('/v1/billing/account');
    expect(ACCOUNT_PAGE_PATH).toBe('/account');
  });
});

const balance = {
  v: 1,
  balanceMicros: 1_250_000,
  promoMicros: 250_000,
  purchasedMicros: 1_000_000,
  promoExpiresAt: '2027-01-11T00:00:00.000Z',
  starter: 'active',
};

const usageLine = { kind: 'usage', reason: 'classify', amountMicros: -60_000, at: '2026-10-12T00:00:00Z', posts: 412 };
const starterGrant = { kind: 'grant', reason: 'starter-credit', amountMicros: 1_000_000, at: '2026-10-13T09:30:00Z' };

describe('schemas', () => {
  it('test_credit_balance_parts_add_up', () => {
    expect(CreditBalanceSchema.parse(balance)).toEqual(balance);
    expect(CreditBalanceSchema.safeParse({ ...balance, promoExpiresAt: null, starter: 'unavailable' }).success).toBe(true);
    expect(CreditBalanceSchema.safeParse({ ...balance, balanceMicros: 1_250_001 }).success).toBe(false);
    expect(CreditBalanceSchema.safeParse({ ...balance, balanceMicros: -1, promoMicros: -1, purchasedMicros: 0 }).success).toBe(
      false,
    );
    expect(CreditBalanceSchema.safeParse({ ...balance, balanceMicros: 1_250_000.5, purchasedMicros: 1_000_000.5 }).success).toBe(
      false,
    );
    expect(CreditBalanceSchema.safeParse({ ...balance, promoExpiresAt: '2027-01-11T01:00:00+01:00' }).success).toBe(false);
  });

  it('test_history_item_reason_fits_kind', () => {
    expect(CreditHistoryItemSchema.parse(usageLine)).toEqual(usageLine);
    expect(CreditHistoryItemSchema.safeParse(starterGrant).success).toBe(true);
    const { posts: _posts, ...withoutPosts } = usageLine;
    expect(CreditHistoryItemSchema.safeParse(withoutPosts).success).toBe(false);
    expect(CreditHistoryItemSchema.safeParse({ ...starterGrant, reason: 'classify' }).success).toBe(false);
    expect(
      CreditHistoryItemSchema.safeParse({ kind: 'adjustment', reason: 'starter-credit', amountMicros: -5, at: starterGrant.at })
        .success,
    ).toBe(false);
  });

  it('test_history_usage_line_for_factcheck', () => {
    const line = { kind: 'usage', reason: 'factcheck', amountMicros: -480_000, at: '2026-11-02T00:00:00Z', posts: 2 };
    expect(CreditHistoryItemSchema.parse(line)).toEqual(line);
    expect(CreditHistoryItemSchema.safeParse({ ...starterGrant, reason: 'factcheck' }).success).toBe(false);
    expect(CreditHistoryItemSchema.safeParse({ ...line, reason: 'perspectives' }).success).toBe(true);
  });

  it('test_credit_account_limits', () => {
    const minimal = { v: 1, balance, history: [usageLine, starterGrant] };
    expect(CreditAccountSchema.parse(minimal)).toEqual(minimal);
    const full = { ...minimal, pricingUrl: 'https://unalgorithmfeed.com/credits', addCreditPath: '/account/credit' };
    expect(CreditAccountSchema.parse(full)).toEqual(full);
    const history = Array.from({ length: MAX_CREDIT_HISTORY + 1 }, () => usageLine);
    expect(MAX_CREDIT_HISTORY).toBe(200);
    expect(CreditAccountSchema.safeParse({ ...minimal, history: history.slice(1) }).success).toBe(true);
    expect(CreditAccountSchema.safeParse({ ...minimal, history }).success).toBe(false);
    expect(CreditAccountSchema.safeParse({ ...minimal, pricingUrl: 'http://unalgorithmfeed.com/credits' }).success).toBe(false);
    expect(CreditAccountSchema.safeParse({ ...minimal, addCreditPath: '//evil.example' }).success).toBe(false);
  });
});

describe('the fact-check price card (P3-51)', () => {
  const OCT_15 = at('2026-10-15T12:00:00Z');
  const DEC_1 = '2026-12-01T00:00:00Z';
  const D = CREDIT_PRICE_SCHEDULE[2] as CreditPriceScheduleEntry;

  it('test_factcheck_entry_passes_shape_and_change_rules', () => {
    expect(CREDIT_PRICE_SCHEDULE).toHaveLength(3);
    expect(D.effectiveFrom).toBe(DEC_1);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    // The 2026-10-01 and 2026-11-01 entries are unchanged, and a task's first card is not a raise.
    expect(checkPriceScheduleChange(TWO_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
  });

  it('test_factcheck_entry_copies_earlier_cards', () => {
    const before = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;
    expect(D.cards.classify).toEqual(before.cards.classify);
    expect(D.cards.perspectives).toEqual(before.cards.perspectives);
    // Copied by identity, so the 2026-11-01 entry is the same data it was.
    expect(D.cards.classify).toBe(before.cards.classify);
    expect(D.cards.perspectives).toBe(before.cards.perspectives);
    expect(Object.isFrozen(D.cards.factcheck)).toBe(true);
  });

  it('test_job_price_at_factcheck_from_its_date', () => {
    expect(jobPriceAt(at('2026-12-02T00:00:00Z'), 'factcheck')).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(jobPriceAt(at('2026-11-30T23:59:59Z'), 'factcheck')).toBeNull();
    expect(taskPriceAt(at('2026-11-15T00:00:00Z'), 'factcheck')).toEqual({ offered: false });
    expect(taskPriceAt(at(DEC_1), 'factcheck')).toEqual({ offered: true, card: D.cards.factcheck, effectiveFrom: DEC_1 });
    expect(jobPriceAt(at('2026-12-02T00:00:00Z'), 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
  });

  it('test_factcheck_card_matches_constants', () => {
    expect(D.cards.factcheck).toEqual(FACTCHECK);
    expect(D.cards.factcheck?.referenceCostMicrosPer1000).toBe(FACTCHECK_TYPICAL_COST_MICROS * 1_000);
    expect(D.cards.factcheck?.maxChargeMicros).toBe(FACTCHECK_COST_CEILING_MICROS * 2);
    expect(D.cards.factcheck?.multiplier).toBe(2);
  });

  it('test_factcheck_entry_date_and_raise_rules', () => {
    // Merged on the entry's own date: rule 2a refuses a start in the past.
    expect(checkPriceScheduleChange(TWO_ENTRIES, CREDIT_PRICE_SCHEDULE, at('2026-12-01T12:00:00Z'))).toEqual([
      pastText(DEC_1, '2026-12-02T00:00:00Z'),
    ]);
    // Once priced, a higher hold cap is a raise and needs notice.
    const raised: CreditPriceSchedule = [
      ...CREDIT_PRICE_SCHEDULE,
      { effectiveFrom: '2026-12-11T00:00:00Z', cards: { ...D.cards, factcheck: { ...FACTCHECK, maxChargeMicros: 450_000 } } },
    ];
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, raised, at('2026-12-05T12:00:00Z'))).toEqual([
      "2026-12-11T00:00:00Z: factcheck would raise its maximum charge from 400000 to 450000 micro-dollars; a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2027-01-05T00:00:00Z",
    ]);
  });

  it('test_factcheck_entry_cancellable_before_date', () => {
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, TWO_ENTRIES, at('2026-11-20T00:00:00Z'))).toEqual([]);
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, TWO_ENTRIES, at('2026-12-02T00:00:00Z'))).toEqual([
      `${DEC_1}: this price is in effect and cannot be removed`,
    ]);
    // Moving it later before its date also passes.
    const moved = [...TWO_ENTRIES, { ...D, effectiveFrom: '2026-12-15T00:00:00Z' }];
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, moved, at('2026-11-20T00:00:00Z'))).toEqual([]);
  });
});

describe('credit amounts (any amount from $5 to $500)', () => {
  it('test_amount_rules_constants', () => {
    expect(CREDIT_AMOUNT_MIN_MICROS).toBe(5_000_000);
    expect(CREDIT_AMOUNT_MAX_MICROS).toBe(500_000_000);
    expect(CREDIT_AMOUNT_STEP_MICROS).toBe(1_000_000);
    expect(CREDIT_AMOUNT_PRESETS).toEqual([5_000_000, 10_000_000, 25_000_000]);
    expect(Object.isFrozen(CREDIT_AMOUNT_PRESETS)).toBe(true);
    expect(DEFAULT_CREDIT_AMOUNT).toBe(10_000_000);
    expect(CREDIT_AMOUNT_PRESETS).toContain(DEFAULT_CREDIT_AMOUNT);
    expect(CREDIT_CURRENCY).toBe('usd');
    // Every quick pick is itself a valid amount, smallest first.
    for (const micros of CREDIT_AMOUNT_PRESETS) expect(creditAmount({ micros })).not.toBeNull();
    expect([...CREDIT_AMOUNT_PRESETS].sort((a, b) => a - b)).toEqual([...CREDIT_AMOUNT_PRESETS]);
    // The packs are gone: no pack list, id or lookup is exported.
    for (const name of ['CREDIT_PACKS', 'CREDIT_PACK_IDS', 'CreditPackIdSchema', 'creditPack', 'DEFAULT_CREDIT_PACK']) {
      expect(Object.hasOwn(protocol, name), name).toBe(false);
    }
  });

  it('test_credit_amount_buys_exactly_its_price', () => {
    expect(creditAmount({ dollars: 10 })).toEqual({ dollars: 10, cents: 1_000, micros: 10_000_000 });
    expect(Object.isFrozen(creditAmount({ dollars: 10 }))).toBe(true);
    expect(creditAmount({ dollars: '25' })).toEqual({ dollars: 25, cents: 2_500, micros: 25_000_000 });
    expect(creditAmount({ micros: 5_000_000 })).toEqual({ dollars: 5, cents: 500, micros: 5_000_000 });
    expect(creditAmount({ micros: 500_000_000 })).toEqual({ dollars: 500, cents: 50_000, micros: 500_000_000 });
    for (let dollars = 5; dollars <= 500; dollars++) {
      const amount = creditAmount({ dollars });
      expect(amount?.micros).toBe(dollars * 1_000_000);
      expect(amount?.cents).toBe(dollars * 100);
      expect(creditAmount({ micros: dollars * 1_000_000 })).toEqual(amount);
      expect(creditAmount({ dollars: String(dollars) })).toEqual(amount);
    }
  });

  it('test_credit_amount_refuses_outside_the_rules', () => {
    const dollars = [4, 501, 0, -10, 10.5, 12.25, Number.NaN, Infinity, -Infinity, 1e21, Number.MAX_SAFE_INTEGER + 2, -0];
    const strings = ['', ' 10', '10 ', '4', '501', '010', '10.00', '10.5', '1e1', '+10', '-10', '$10', '0x10', '１０', '10e0'];
    const micros = [4_999_999, 5_000_001, 10_500_000, 500_000_001, 501_000_000, 0, -5_000_000, 5e6 + 0.5, Number.NaN];
    for (const value of [...dollars, ...strings, null, undefined, true, [], {}, 10n]) {
      expect(creditAmount({ dollars: value }), String(value)).toBeNull();
    }
    for (const value of [...micros, '10000000', null, undefined, 10_000_000n]) {
      expect(creditAmount({ micros: value }), String(value)).toBeNull();
    }
  });

  it('test_credit_amount_never_throws_on_hostile_input', () => {
    const throwing = Object.defineProperty({}, 'dollars', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('boom');
        },
      },
    );
    const revoked = Proxy.revocable({ dollars: 10 }, {});
    revoked.revoke();
    const inherited = Object.create({ dollars: 10 });
    const hostile = [
      10,
      '10',
      10_000_000,
      null,
      undefined,
      [10],
      () => 10,
      Symbol('10'),
      { dollars: 10, micros: 10_000_000 }, // both: which one was meant?
      { amount: 10 },
      JSON.parse('{"__proto__": {"dollars": 10}}'),
      inherited,
      throwing,
      proxy,
      revoked.proxy,
      { dollars: { valueOf: () => 10 } },
      { dollars: ['10'] },
    ];
    for (const value of hostile) expect(() => creditAmount(value)).not.toThrow();
    for (const value of hostile) expect(creditAmount(value)).toBeNull();
  });
});

describe('money entries (CL5-01)', () => {
  const AT = '2026-11-02T10:00:00Z';
  const line = (kind: string, reason: string, amountMicros: number) => ({ kind, reason, amountMicros, at: AT });

  it('test_money_entries_fit_their_kind', () => {
    const accepted = [
      line('purchase', 'credit-pack', 10_000_000),
      line('refund', 'refund', -4_200_000),
      line('refund', 'refund', 0),
      line('chargeback', 'chargeback', -5_000_000),
      line('chargeback', 'chargeback-reversed', 5_000_000),
      line('refund', 'test-mode-void', -5_000_000),
    ];
    for (const item of accepted) expect(CreditHistoryItemSchema.parse(item)).toEqual(item);
  });

  it('test_money_entries_refuse_wrong_kind_or_sign', () => {
    const refused = [
      line('purchase', 'refund', -1_000_000),
      line('refund', 'credit-pack', 1_000_000),
      line('purchase', 'credit-pack', 0),
      line('purchase', 'credit-pack', -10_000_000),
      line('refund', 'refund', 1),
      line('chargeback', 'chargeback-reversed', 0),
      line('chargeback', 'chargeback-reversed', -5_000_000),
      line('purchase', 'test-mode-void', -5_000_000),
      line('refund', 'test-mode-void', 1),
    ];
    for (const item of refused) expect(CreditHistoryItemSchema.safeParse(item).success, JSON.stringify(item)).toBe(false);
    expect(CreditHistoryItemSchema.safeParse(line('adjustment', 'correction', -500)).success).toBe(true);
  });

  it('test_existing_kinds_and_reasons_keep_their_order', () => {
    expect(CREDIT_ENTRY_KINDS.slice(0, 3)).toEqual(['grant', 'usage', 'adjustment']);
    // CL2-01's five reasons with P3-51's factcheck and perspectives in the place they were added.
    expect(CREDIT_ENTRY_REASONS.slice(0, 7)).toEqual([
      'starter-credit',
      'classify',
      'factcheck',
      'perspectives',
      'promo-expired',
      'correction',
      'goodwill',
    ]);
    expect(CREDIT_ENTRY_KINDS.slice(3)).toEqual(['purchase', 'refund', 'chargeback']);
    expect(CREDIT_ENTRY_REASONS.slice(7, 12)).toEqual([
      'credit-pack',
      'refund',
      'chargeback',
      'chargeback-reversed',
      'test-mode-void',
    ]);
  });

  it('test_credit_account_refund_policy_url', () => {
    const minimal = { v: 1, balance, history: [] };
    expect(CreditAccountSchema.safeParse(minimal).success).toBe(true);
    const withPolicy = { ...minimal, refundPolicyUrl: 'https://unalgorithm.app/refunds' };
    expect(CreditAccountSchema.parse(withPolicy)).toEqual(withPolicy);
    expect(CreditAccountSchema.safeParse({ ...minimal, refundPolicyUrl: 'http://unalgorithm.app/refunds' }).success).toBe(false);
  });
});

describe('auto-reload (CL6-01)', () => {
  const AT = '2026-11-02T10:00:00Z';
  it('test_auto_reload_reason_appended', () => {
    expect(CREDIT_ENTRY_REASONS).toHaveLength(13);
    expect(CREDIT_ENTRY_REASONS.slice(0, 12)).toEqual([
      'starter-credit',
      'classify',
      'factcheck',
      'perspectives',
      'promo-expired',
      'correction',
      'goodwill',
      'credit-pack',
      'refund',
      'chargeback',
      'chargeback-reversed',
      'test-mode-void',
    ]);
    expect(CREDIT_ENTRY_REASONS[12]).toBe('auto-reload');
  });

  it('test_auto_reload_history_item_sign_and_kind', () => {
    const item = { kind: 'purchase', reason: 'auto-reload', amountMicros: 10_000_000, at: AT };
    expect(CreditHistoryItemSchema.parse(item)).toEqual(item);
    for (const amountMicros of [0, -1]) {
      const result = CreditHistoryItemSchema.safeParse({ ...item, amountMicros });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([['amountMicros']]);
    }
    const refund = CreditHistoryItemSchema.safeParse({ ...item, kind: 'refund' });
    expect(refund.success).toBe(false);
    expect(refund.error?.issues.map((issue) => issue.path)).toEqual([['reason']]);
  });

  it('test_account_auto_reload_summary_shapes', () => {
    const minimal = { v: 1, balance, history: [] };
    const path = '/billing/auto-reload';
    const amounts = { amountMicros: 10_000_000, thresholdMicros: 1_000_000, monthlyLimitMicros: 25_000_000 };
    const accepted = [
      minimal,
      { ...minimal, autoReload: { path, state: 'off' } },
      { ...minimal, autoReload: { path, state: 'on', ...amounts } },
      { ...minimal, autoReload: { path, state: 'stopped', ...amounts } },
    ];
    for (const account of accepted) expect(CreditAccountSchema.parse(account)).toEqual(account);

    const { thresholdMicros: _threshold, ...withoutThreshold } = amounts;
    const missing = CreditAccountSchema.safeParse({ ...minimal, autoReload: { path, state: 'on', ...withoutThreshold } });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([['autoReload', 'state']]);

    const refused = [
      { path: 'https://evil.example/x', state: 'off' },
      { path: '//evil.example', state: 'off' },
      { path, state: 'on', ...amounts, amountMicros: -1 },
    ];
    for (const autoReload of refused) {
      expect(CreditAccountSchema.safeParse({ ...minimal, autoReload }).success, JSON.stringify(autoReload)).toBe(false);
    }
  });
});
