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
  type CreditPriceCard,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  checkPriceScheduleChange,
  creditAmount,
  DEFAULT_CREDIT_AMOUNT,
  earliestRaise,
  estimatePosts,
  FACTCHECK_COST_CEILING_MICROS,
  FACTCHECK_TYPICAL_COST_MICROS,
  isPriceDate,
  jobPriceAt,
  LOW_BALANCE_MICROS,
  MAX_CREDIT_HISTORY,
  nextMidnight,
  nextPriceChange,
  PRICE_CARDS,
  PRICE_ISSUE_CODES,
  PRICE_NOTICE_DAYS,
  type PriceIssueCode,
  priceCardsAt,
  priceRaiseIssues,
  priceRaisesWithinNotice,
  priceScheduleChangeIssues,
  priceScheduleIssues,
  priceScheduleProblems,
  retailMicros,
  retailMicrosPer1000Posts,
  STARTER_CREDIT,
  taskPriceAt,
  withTaskCard,
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
/**
 * The schedule on main until 2026-10-17, as published: perspectives (UnEcho Chamber) from 2026-11-01 and factcheck from
 * 2026-12-01. Neither had taken effect when one 2026-10-18 entry replaced both.
 */
const THREE_ENTRIES: CreditPriceSchedule = [
  ...TWO_ENTRIES,
  {
    effectiveFrom: '2026-12-01T00:00:00Z',
    cards: { classify: LAUNCH.cards.classify, perspectives: PERSPECTIVES, factcheck: FACTCHECK },
  },
];
const OCT_18 = '2026-10-18T00:00:00Z';
/** The schedule as published from 2026-10-17: the launch entry, then perspectives and factcheck together from 2026-10-18. */
const PUBLISHED: CreditPriceSchedule = [
  LAUNCH,
  { effectiveFrom: OCT_18, cards: { classify: LAUNCH.cards.classify, perspectives: PERSPECTIVES, factcheck: FACTCHECK } },
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
    expect(CREDIT_PRICE_SCHEDULE).toEqual(PUBLISHED);
    // The classify card is the launch card, the same object.
    expect(CREDIT_PRICE_SCHEDULE[1]?.cards.classify).toBe(CREDIT_PRICE_SCHEDULE[0]?.cards.classify);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    // A new task's first card is not a raise (two at once here), and the entry in effect is unchanged.
    expect(checkPriceScheduleChange([LAUNCH], CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
    expect(taskPriceAt(OCT_15, 'perspectives')).toEqual({ offered: false });
  });

  it('test_job_price_at_perspectives_from_its_date', () => {
    expect(jobPriceAt(at(OCT_18), 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(jobPriceAt(at('2026-11-02T00:00:00Z'), 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(jobPriceAt(at('2026-10-17T23:59:59.999Z'), 'perspectives')).toBeNull();
    // Fact-check is priced from the same entry, not before it.
    expect(jobPriceAt(at(OCT_18), 'factcheck')).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(jobPriceAt(at('2026-10-17T23:59:59.999Z'), 'factcheck')).toBeNull();
  });

  it('test_perspectives_cap_raise_needs_notice', () => {
    const real = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;
    const raised: CreditPriceSchedule = [
      ...CREDIT_PRICE_SCHEDULE,
      {
        effectiveFrom: '2026-11-11T00:00:00Z',
        cards: { ...real.cards, perspectives: { ...PERSPECTIVES, maxChargeMicros: 600_000 } },
      },
    ];
    const problems = checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, raised, at('2026-11-05T12:00:00Z'));
    expect(problems).toEqual([
      "2026-11-11T00:00:00Z: perspectives would raise its maximum charge from 500000 to 600000 micro-dollars; a price raise needs 30 days' notice: the earliest effectiveFrom allowed now for it is 2026-12-06T00:00:00Z",
    ]);
  });

  it('test_new_task_first_entry_is_not_a_raise', () => {
    expect(priceScheduleProblems(FIXTURE)).toEqual([]);
    // Against a base that prices factcheck only later (main until 2026-10-17), and one that prices neither task.
    expect(checkPriceScheduleChange(THREE_ENTRIES, FIXTURE, OCT_15)).toEqual([]);
    expect(checkPriceScheduleChange([LAUNCH], FIXTURE, OCT_15)).toEqual([]);
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
    // After its first card, a task's rise needs notice even where the base does not offer it yet (main until
    // 2026-10-17 priced factcheck from 2026-12-01 only).
    const addedThenRaised = (e: string) => [...FIXTURE, { effectiveFrom: e, cards: { ...F.cards, factcheck: dearer } }];
    expect(checkPriceScheduleChange(THREE_ENTRIES, addedThenRaised('2026-11-05T00:00:00Z'), OCT_15)).toEqual([
      `2026-11-05T00:00:00Z: factcheck would raise its maximum charge from 400000 to 600000 micro-dollars; ${notice}`,
      `2026-11-05T00:00:00Z: factcheck would rise from multiplier 2 and 240000000 micro-dollars per 1,000 posts just before it to multiplier 3 and 360000000, a rise the base does not have then; ${notice}`,
    ]);
    expect(checkPriceScheduleChange(THREE_ENTRIES, addedThenRaised('2026-11-15T00:00:00Z'), OCT_15)).toEqual([]);
    // Where the base offers it already (the real schedule, from 2026-10-18), the same rise is measured against its card.
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, addedThenRaised('2026-11-05T00:00:00Z'), OCT_15)).toEqual(
      raise('2026-11-05T00:00:00Z'),
    );
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
    // The real schedule prices both from 2026-10-18 at the same cards, and neither before it.
    expect(jobPriceAt(nov2, 'factcheck')).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(jobPriceAt(nov2, 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(jobPriceAt(OCT_15, 'factcheck')).toBeNull();
    expect(jobPriceAt(OCT_15, 'perspectives')).toBeNull();
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

describe('the fact-check price card (P3-51), from 2026-10-18 with UnEcho Chamber', () => {
  const OCT_15 = at('2026-10-15T12:00:00Z');
  const OCT_17 = at('2026-10-17T12:00:00Z');
  const D = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;

  it('test_factcheck_entry_passes_shape_and_change_rules', () => {
    expect(CREDIT_PRICE_SCHEDULE).toHaveLength(2);
    expect(D.effectiveFrom).toBe(OCT_18);
    expect(priceScheduleProblems(CREDIT_PRICE_SCHEDULE)).toEqual([]);
    // The 2026-10-01 entry is unchanged, and a task's first card is not a raise, against every earlier published base.
    expect(checkPriceScheduleChange([LAUNCH], CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
    expect(checkPriceScheduleChange(TWO_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
    expect(checkPriceScheduleChange(THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_15)).toEqual([]);
  });

  it('test_merged_entry_replaces_entries_not_in_effect', () => {
    // Main until 2026-10-17 priced perspectives from 2026-11-01 and factcheck from 2026-12-01. Neither was in effect, so
    // one entry from 2026-10-18 at the same cards may replace both before its date.
    expect(checkPriceScheduleChange(THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_17)).toEqual([]);
    expect(checkPriceScheduleChange(THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_17, PRICE_NOTICE_DAYS, 'in-effect')).toEqual([]);
    expect(checkPriceScheduleChange(THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, at('2026-10-17T23:59:59.999Z'))).toEqual([]);
    // The cards are the ones main published, field for field: only the date moved.
    const was = THREE_ENTRIES[2] as CreditPriceScheduleEntry;
    expect(D.cards).toEqual(was.cards);
  });

  it('test_factcheck_entry_copies_earlier_cards', () => {
    const before = CREDIT_PRICE_SCHEDULE[0] as CreditPriceScheduleEntry;
    expect(D.cards.classify).toEqual(before.cards.classify);
    // Copied by identity, so the 2026-10-01 entry is the same data it was.
    expect(D.cards.classify).toBe(before.cards.classify);
    expect(D.cards.perspectives).toEqual(PERSPECTIVES);
    expect(Object.isFrozen(D.cards.perspectives)).toBe(true);
    expect(Object.isFrozen(D.cards.factcheck)).toBe(true);
  });

  it('test_job_price_at_factcheck_from_its_date', () => {
    expect(jobPriceAt(at('2026-10-19T00:00:00Z'), 'factcheck')).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });
    expect(jobPriceAt(at('2026-10-17T23:59:59Z'), 'factcheck')).toBeNull();
    expect(taskPriceAt(OCT_17, 'factcheck')).toEqual({ offered: false });
    expect(taskPriceAt(at(OCT_18), 'factcheck')).toEqual({ offered: true, card: D.cards.factcheck, effectiveFrom: OCT_18 });
    expect(taskPriceAt(OCT_17, 'perspectives')).toEqual({ offered: false });
    expect(taskPriceAt(at(OCT_18), 'perspectives')).toEqual({ offered: true, card: D.cards.perspectives, effectiveFrom: OCT_18 });
    expect(jobPriceAt(at('2026-10-19T00:00:00Z'), 'perspectives')).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
  });

  it('test_factcheck_card_matches_constants', () => {
    expect(D.cards.factcheck).toEqual(FACTCHECK);
    expect(D.cards.factcheck?.referenceCostMicrosPer1000).toBe(FACTCHECK_TYPICAL_COST_MICROS * 1_000);
    expect(D.cards.factcheck?.maxChargeMicros).toBe(FACTCHECK_COST_CEILING_MICROS * 2);
    expect(D.cards.factcheck?.multiplier).toBe(2);
  });

  it('test_factcheck_entry_date_and_raise_rules', () => {
    // Merged on the entry's own date: rule 2a refuses a start in the past.
    for (const base of [[LAUNCH], THREE_ENTRIES]) {
      expect(checkPriceScheduleChange(base, CREDIT_PRICE_SCHEDULE, at('2026-10-18T12:00:00Z'))).toEqual([
        pastText(OCT_18, '2026-10-19T00:00:00Z'),
      ]);
    }
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
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, [LAUNCH], OCT_17)).toEqual([]);
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, [LAUNCH], at('2026-10-19T00:00:00Z'))).toEqual([
      `${OCT_18}: this price is in effect and cannot be removed`,
    ]);
    // Moving it later before its date also passes.
    const moved = [LAUNCH, { ...D, effectiveFrom: '2026-10-25T00:00:00Z' }];
    expect(checkPriceScheduleChange(CREDIT_PRICE_SCHEDULE, moved, OCT_17)).toEqual([]);
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

  it('test_credit_amount_takes_rules', () => {
    // The price book's purchase rules are the limits; the amounts stay whole dollars.
    const wide = { minMicros: 1_000_000, maxMicros: 1_000_000_000 };
    expect(creditAmount({ dollars: 600 }, wide)).toEqual({ dollars: 600, cents: 60_000, micros: 600_000_000 });
    expect(creditAmount({ dollars: 600 })).toBeNull();
    expect(creditAmount({ dollars: 1 }, wide)).toEqual({ dollars: 1, cents: 100, micros: 1_000_000 });
    expect(creditAmount({ dollars: '1000' }, wide)).toEqual({ dollars: 1000, cents: 100_000, micros: 1_000_000_000 });
    for (const value of [0, 1001]) expect(creditAmount({ dollars: value }, wide), String(value)).toBeNull();
    expect(creditAmount({ micros: 600_500_000 }, wide)).toBeNull();
    const narrow = { minMicros: 20_000_000, maxMicros: 50_000_000 };
    for (const dollars of [5, 10, 19, 51, 500]) expect(creditAmount({ dollars }, narrow), String(dollars)).toBeNull();
    expect(creditAmount({ micros: 20_000_000 }, narrow)?.dollars).toBe(20);
    // The default rules are the constants.
    const constants = { minMicros: CREDIT_AMOUNT_MIN_MICROS, maxMicros: CREDIT_AMOUNT_MAX_MICROS };
    for (const dollars of [4, 5, 10, 500, 501]) {
      expect(creditAmount({ dollars }, constants), String(dollars)).toEqual(creditAmount({ dollars }));
    }
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

describe('price issues', () => {
  /** What a call returns, or the error it throws: the string rules and the issue rules must agree on both. */
  const outcome = <T>(call: () => T): T | string => {
    try {
      return call();
    } catch (err) {
      return `throws ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
    }
  };
  const texts = (issues: readonly { text: string }[]) => issues.map((issue) => issue.text);

  it('test_issue_texts_equal_ci_lines', () => {
    // Every schedule the shape tests above pass to priceScheduleProblems, with the codes its issues carry.
    const withCards = (cards: unknown) => [A, { ...B, cards: cards as CreditPriceScheduleEntry['cards'] }];
    const e = '2026-12-01T00:00:00Z';
    const { factcheck: _dropped, ...rest } = F.cards;
    const { maxChargeMicros: _cap, ...noCap } = FACTCHECK;
    const { unit: _unit, ...noUnit } = FACTCHECK;
    const classify15 = { ...L.cards.classify, multiplier: 1.5 };
    const summarize = [L, { ...F, cards: { ...F.cards, summarize: L.cards.classify } } as unknown as CreditPriceScheduleEntry];
    const shapes: [CreditPriceSchedule, PriceIssueCode[]][] = [
      [CREDIT_PRICE_SCHEDULE, []],
      [[], ['empty']],
      [[A, { ...B, effectiveFrom: '2026-11-15T01:00:00Z' }], ['date-format']],
      [[A, { ...B, effectiveFrom: '2026-11-15' }], ['date-format']],
      [[A, { ...B, effectiveFrom: '2026-02-30T00:00:00Z' }], ['date-format']],
      [[A, { ...B, effectiveFrom: A.effectiveFrom }], ['date-order']],
      [[A, { ...B, effectiveFrom: '2026-09-01T00:00:00Z' }], ['date-order']],
      [withCards({}), ['no-classify']],
      [withCards({ ...B.cards, factcheck: B.cards.classify }), ['add-copies', 'unit', 'cap-below-typical']],
      [withCards({ classify: null }), ['no-classify']],
      [withCards({ classify: undefined }), ['no-classify']],
      [[A, entry(B.effectiveFrom, 1.00001)], ['multiplier']],
      [[A, entry(B.effectiveFrom, 0)], ['multiplier']],
      [[A, entry(B.effectiveFrom, 2.5, 0)], ['reference-cost']],
      [[A, entry(B.effectiveFrom, 2.5, 1.5)], ['reference-cost']],
      [[A, entry(B.effectiveFrom, 2.5, 73_000, '')], ['reference-model']],
      [FIXTURE, []],
      [[...FIXTURE, { effectiveFrom: e, cards: rest }], ['drops-task']],
      [[L, { ...F, cards: { ...F.cards, classify: classify15 } }], ['add-copies']],
      [after(e, { classify: classify15 }), []],
      [summarize, ['not-a-task']],
      [
        [{ effectiveFrom: L.effectiveFrom, cards: { factcheck: FACTCHECK } } as unknown as CreditPriceScheduleEntry],
        ['no-classify'],
      ],
      [after(e, { factcheck: noCap }), ['cap-below-typical']],
      [after(e, { factcheck: noUnit }), ['unit']],
      [after(e, { factcheck: { ...FACTCHECK, unit: 'post' } }), ['unit']],
      [after(e, { factcheck: { ...FACTCHECK, maxChargeMicros: 100_000 } }), ['cap-below-typical']],
      [after(e, { classify: { ...L.cards.classify, unit: 'post' } }), []],
      [after(e, { classify: { ...L.cards.classify, maxChargeMicros: 1_000 } }), ['classify-cap']],
    ];
    for (const [schedule, codes] of shapes) {
      const issues = priceScheduleIssues(schedule);
      expect(texts(issues)).toEqual(priceScheduleProblems(schedule));
      expect(issues.map((issue) => issue.code)).toEqual(codes);
    }
    expect(priceScheduleIssues(summarize)[0]).toMatchObject({ task: 'summarize', effectiveFrom: F.effectiveFrom });
    expect(priceScheduleIssues(after(e, { factcheck: noCap }))[0]).toMatchObject({
      effectiveFrom: e,
      task: 'factcheck',
      typicalMicros: 240_000,
    });

    // Every base and head the change tests above compare, at their instant and notice.
    const OCT_15 = at('2026-10-15T12:00:00Z');
    const OCT_17 = at('2026-10-17T12:00:00Z');
    const nov5 = at('2026-11-05T12:00:00Z');
    const later = at('2026-10-20T00:00:00Z');
    const D = CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry;
    const C = entry('2026-10-15T00:00:00Z', 1.5);
    const R = entry('2026-10-20T00:00:00Z', 2);
    const U = entry('2026-11-01T00:00:00Z', 2.5);
    const K = entry('2026-10-20T00:00:00Z', 1.5);
    const P = entry('2026-10-20T00:00:00Z', 2.5);
    const raise = (d: string) => [A, entry(d, 2.25), B];
    const on20th = (multiplier: number, cost: number, model = MODEL) => [
      A,
      entry('2026-10-20T00:00:00Z', multiplier, cost, model),
      B,
    ];
    const cut = after('2026-11-06T00:00:00Z', { factcheck: { ...FACTCHECK, maxChargeMicros: 350_000 } });
    const dearer = { ...FACTCHECK, multiplier: 3, maxChargeMicros: 600_000 };
    const addedThenRaised = (d: string) => [...FIXTURE, { effectiveFrom: d, cards: { ...F.cards, factcheck: dearer } }];
    const capFrom = (d: string, task: 'factcheck' | 'perspectives', card: CreditPriceCard): CreditPriceSchedule => [
      ...CREDIT_PRICE_SCHEDULE,
      { effectiveFrom: d, cards: { ...D.cards, [task]: card } },
    ];
    const pairs: [CreditPriceSchedule, CreditPriceSchedule, Date, number?][] = [
      [S, S, NOW],
      [S, [A], NOW],
      [S, [entry(A.effectiveFrom, 2.5), B], NOW],
      [S, [B], NOW],
      [S, [A], at('2026-11-15T00:00:00Z')],
      [S, [A, C, B], NOW],
      [S, raise('2026-11-13T00:00:00Z'), NOW],
      [S, raise('2026-11-14T00:00:00Z'), NOW],
      [S, raise('2026-11-14T00:00:00Z'), NOW, 45],
      [S, [A, B, entry('2026-11-19T00:00:00Z', 3)], later],
      [S, [A, B, entry('2026-11-18T00:00:00Z', 3)], later],
      [S, S, NOW, 0],
      [S, S, NOW, Number.NaN],
      [S, S, NOW, -1],
      [S, S, NOW, 1.5],
      [S, S, new Date(Number.NaN)],
      [S, [A, C, R, B], NOW],
      [S, [A, C, entry('2026-11-14T00:00:00Z', 2), B], NOW],
      [[A, C, B], [A, C, R, B], NOW],
      [[A, U], [A, C, U], NOW],
      [S, [A, entry('2026-10-10T00:00:00Z', 1.5), B], NOW],
      [S, [A, entry('2026-10-10T00:00:00Z', 2.5), B], NOW],
      [S, [A, entry('2026-10-14T00:00:00Z', 1.5), B], NOW],
      [S, [A, C, B], at('2026-10-15T00:00:00Z')],
      [S, [A, C, B], at('2026-10-14T23:59:59.999Z')],
      [S, [A, entry('2026-10-10T00:00:00Z', 1.5), B], at('2026-10-14T23:59:59.999Z')],
      [[A, P], [A, { ...P, effectiveFrom: '2026-10-10T00:00:00Z' }, P], at('2026-10-25T00:00:00Z')],
      [S, [A, entry(B.effectiveFrom, 3)], NOW],
      [S, [A, entry(B.effectiveFrom, 3)], later],
      [S, [A, entry(B.effectiveFrom, 2.25)], later],
      [S, [A, entry('2026-11-14T01:00:00Z', 2.5), B], NOW],
      [S, [], NOW],
      [[A, K, U], [A, U], NOW],
      [[A, K, U], [A, K], NOW],
      [[A, entry(B.effectiveFrom, 1.5)], [A], NOW],
      [S, on20th(2, 80_000), NOW],
      [S, on20th(2.5, 50_000), NOW],
      [S, on20th(2, 70_000), NOW],
      [S, on20th(2, 73_000, 'other-model'), NOW],
      [CREDIT_PRICE_SCHEDULE, CREDIT_PRICE_SCHEDULE, OCT_15],
      [[LAUNCH], CREDIT_PRICE_SCHEDULE, OCT_15],
      [
        CREDIT_PRICE_SCHEDULE,
        capFrom('2026-11-11T00:00:00Z', 'perspectives', { ...PERSPECTIVES, maxChargeMicros: 600_000 }),
        nov5,
      ],
      [THREE_ENTRIES, FIXTURE, OCT_15],
      [[LAUNCH], FIXTURE, OCT_15],
      [FIXTURE, after('2026-11-15T00:00:00Z', { factcheck: { ...FACTCHECK, maxChargeMicros: 450_000 } }), nov5],
      [FIXTURE, cut, nov5],
      [cut, [...cut, { effectiveFrom: '2026-11-10T00:00:00Z', cards: F.cards }], nov5],
      [FIXTURE, [L, { ...F, cards: { ...F.cards, factcheck: dearer } }], OCT_15],
      [FIXTURE, [L, { effectiveFrom: '2026-11-10T00:00:00Z', cards: { ...F.cards, factcheck: dearer } }], OCT_15],
      [FIXTURE, [L, { ...F, cards: { ...F.cards, factcheck: { ...FACTCHECK, maxChargeMicros: 350_000 } } }], OCT_15],
      [FIXTURE, [L, { ...F, effectiveFrom: '2026-11-10T00:00:00Z' }], OCT_15],
      [FIXTURE, [L], OCT_15],
      [THREE_ENTRIES, addedThenRaised('2026-11-05T00:00:00Z'), OCT_15],
      [THREE_ENTRIES, addedThenRaised('2026-11-15T00:00:00Z'), OCT_15],
      [CREDIT_PRICE_SCHEDULE, addedThenRaised('2026-11-05T00:00:00Z'), OCT_15],
      [CREDIT_PRICE_SCHEDULE, addedThenRaised('2026-11-15T00:00:00Z'), OCT_15],
      [TWO_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_15],
      [THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_15],
      [THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, OCT_17],
      [THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, at('2026-10-17T23:59:59.999Z')],
      [[LAUNCH], CREDIT_PRICE_SCHEDULE, at('2026-10-18T12:00:00Z')],
      [THREE_ENTRIES, CREDIT_PRICE_SCHEDULE, at('2026-10-18T12:00:00Z')],
      [
        CREDIT_PRICE_SCHEDULE,
        capFrom('2026-12-11T00:00:00Z', 'factcheck', { ...FACTCHECK, maxChargeMicros: 450_000 }),
        at('2026-12-05T12:00:00Z'),
      ],
      [CREDIT_PRICE_SCHEDULE, [LAUNCH], OCT_17],
      [CREDIT_PRICE_SCHEDULE, [LAUNCH], at('2026-10-19T00:00:00Z')],
      [CREDIT_PRICE_SCHEDULE, [LAUNCH, { ...D, effectiveFrom: '2026-10-25T00:00:00Z' }], OCT_17],
      [PUBLISHED, CREDIT_PRICE_SCHEDULE, OCT_17],
    ];
    let refused = 0;
    for (const [base, head, now, days = 30] of pairs) {
      for (const rules of ['all', 'in-effect'] as const) {
        const lines = outcome(() => checkPriceScheduleChange(base, head, now, days, rules));
        if (typeof lines === 'string' || lines.length > 0) refused += 1;
        expect(outcome(() => texts(priceScheduleChangeIssues(base, head, now, days, rules)))).toEqual(lines);
      }
      expect(outcome(() => texts(priceRaiseIssues(base, head, now, days)))).toEqual(
        outcome(() => priceRaisesWithinNotice(base, head, now, days)),
      );
    }
    // The vectors reach the rules, not only the empty answer.
    expect(refused).toBeGreaterThan(30);

    // `priceRaisesWithinNotice` reads no shape: the per-task vectors of test_schedule_change_compares_each_task.
    const two = (effectiveFrom: string, classify: number, factcheck: number) => ({
      effectiveFrom,
      cards: {
        classify: { multiplier: classify, referenceModel: MODEL, referenceCostMicrosPer1000: 73_000 },
        factcheck: { multiplier: factcheck, referenceModel: MODEL, referenceCostMicrosPer1000: 73_000 },
      },
    });
    const W = [two('2026-10-01T00:00:00Z', 2, 2)] as unknown as CreditPriceSchedule;
    for (const factcheck of [2.5, 2]) {
      const head = [...W, two('2026-10-20T00:00:00Z', 1.5, factcheck)] as unknown as CreditPriceSchedule;
      expect(texts(priceRaiseIssues(W, head, NOW, 30))).toEqual(priceRaisesWithinNotice(W, head, NOW, 30));
    }

    // A head's shape issue keeps its code and facts; only its text gains the `head: ` prefix.
    expect(priceScheduleChangeIssues(S, [A, entry('2026-11-14T01:00:00Z', 2.5), B], NOW)).toEqual([
      {
        code: 'date-format',
        effectiveFrom: '2026-11-14T01:00:00Z',
        text: 'head: entry 1 (2026-11-14T01:00:00Z): effectiveFrom must be YYYY-MM-DDT00:00:00Z on a real calendar day',
      },
    ]);
  });

  it('test_change_issue_codes_and_dates', () => {
    // Only ever appended to.
    expect(PRICE_ISSUE_CODES).toEqual([
      'empty',
      'date-format',
      'date-order',
      'not-a-task',
      'no-classify',
      'drops-task',
      'add-copies',
      'multiplier',
      'reference-cost',
      'reference-model',
      'unit',
      'classify-cap',
      'cap-below-typical',
      'in-effect-removed',
      'in-effect-changed',
      'starts-in-past',
      'cap-raise',
      'raise',
      'rise',
      // the price book (priceBookIssues, priceBookChangeIssues)
      'reference-model-unknown',
      'multiplier-range',
      'cap-too-high',
      'starter-order',
      'starter-history',
      'starter-range',
      'purchase-order',
      'purchase-default',
      'purchase-presets',
      'purchase-range',
      'auto-reload-per-day',
      'auto-reload-monthly',
    ]);
    const NOV_2 = at('2026-11-02T12:00:00Z');
    const NOV_3 = '2026-11-03T00:00:00Z';
    const DEC_3 = '2026-12-03T00:00:00Z';
    const FC = (CREDIT_PRICE_SCHEDULE[1] as CreditPriceScheduleEntry).cards.factcheck as CreditPriceCard;
    const edit = (from: string, card: CreditPriceCard) => withTaskCard(CREDIT_PRICE_SCHEDULE, 'factcheck', from, card);
    const facts = (head: CreditPriceSchedule) =>
      priceScheduleChangeIssues(CREDIT_PRICE_SCHEDULE, head, NOV_2).map(({ text: _text, ...rest }) => rest);

    // AC 3: a cut from the next 00:00 UTC passes; a higher multiplier or hold cap needs 30 days' notice.
    expect(facts(edit(NOV_3, { ...FC, maxChargeMicros: 300_000 }))).toEqual([]);
    const raise = { ...FC, multiplier: 2.5 };
    const capRaise = { ...FC, maxChargeMicros: 500_000 };
    expect(facts(edit(NOV_3, raise))).toEqual([{ code: 'raise', task: 'factcheck', effectiveFrom: NOV_3, earliest: DEC_3 }]);
    expect(facts(edit(NOV_3, capRaise))).toEqual([
      { code: 'cap-raise', task: 'factcheck', effectiveFrom: NOV_3, earliest: DEC_3 },
    ]);
    expect(facts(edit(DEC_3, raise))).toEqual([]);
    expect(facts(edit(DEC_3, capRaise))).toEqual([]);

    // AC 4: an entry in effect cannot change; a new price cannot start before the next 00:00 UTC.
    const cutCard = { ...FC, maxChargeMicros: 300_000 };
    expect(facts(edit(OCT_18, cutCard))).toEqual([{ code: 'in-effect-changed', effectiveFrom: OCT_18 }]);
    expect(facts(edit('2026-11-02T00:00:00Z', cutCard))).toEqual([
      { code: 'starts-in-past', effectiveFrom: '2026-11-02T00:00:00Z', earliest: NOV_3 },
    ]);
    expect(facts([LAUNCH])).toEqual([{ code: 'in-effect-removed', effectiveFrom: OCT_18 }]);

    // Ending a cut within the notice is a rise the base does not have: the issue names the instant of the rise.
    const cut = edit(NOV_3, { ...FC, multiplier: 1.5 });
    const ended = withTaskCard(cut, 'factcheck', '2026-11-10T00:00:00Z', FC);
    expect(facts(ended)).toEqual([{ code: 'rise', task: 'factcheck', effectiveFrom: '2026-11-10T00:00:00Z', earliest: DEC_3 }]);

    // The two dates the rules compute, and the dates they accept.
    expect(nextMidnight(NOV_2)).toBe(NOV_3);
    expect(nextMidnight(at('2026-11-02T00:00:00Z'))).toBe(NOV_3);
    expect(earliestRaise(NOV_2)).toBe(DEC_3);
    expect(earliestRaise(at('2026-11-02T00:00:00Z'))).toBe('2026-12-02T00:00:00Z');
    expect(earliestRaise(NOV_2, 45)).toBe('2026-12-18T00:00:00Z');
    expect(() => nextMidnight(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => earliestRaise(NOV_2, 1.5)).toThrow(RangeError);
    for (const value of [NOV_3, '2028-02-29T00:00:00Z']) expect(isPriceDate(value), value).toBe(true);
    for (const value of [
      '2026-11-03',
      '2026-11-03T00:00:00.000Z',
      '2026-02-30T00:00:00Z',
      '2026-11-03T01:00:00Z',
      20261103,
      null,
    ]) {
      expect(isPriceDate(value), String(value)).toBe(false);
    }
  });
});
