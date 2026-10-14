import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.ts';
import {
  ACCOUNT_PAGE_PATH,
  CREDIT_ACCOUNT_PATH,
  CREDIT_BALANCE_PATH,
  CREDIT_PRICE_SCHEDULE,
  CreditAccountSchema,
  CreditBalanceSchema,
  CreditHistoryItemSchema,
  type CreditPriceSchedule,
  type CreditPriceScheduleEntry,
  checkPriceScheduleChange,
  estimatePosts,
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
    expect(CREDIT_PRICE_SCHEDULE).toEqual([
      {
        effectiveFrom: '2026-10-01T00:00:00Z',
        cards: { classify: { multiplier: 2, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73000 } },
      },
    ]);
    const [launch] = CREDIT_PRICE_SCHEDULE;
    expect(Object.isFrozen(CREDIT_PRICE_SCHEDULE)).toBe(true);
    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch?.cards)).toBe(true);
    expect(Object.isFrozen(launch?.cards.classify)).toBe(true);
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
    const cards = 'entry 1 (2026-11-15T00:00:00Z): cards must price exactly classify';
    bad(cards, withCards({}));
    bad(cards, withCards({ ...B.cards, factcheck: B.cards.classify }));
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
    // CREDIT_TASKS holds only classify until Phase 3, so a two-task schedule is a stub cast past the type.
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

  it('test_credit_account_limits', () => {
    const minimal = { v: 1, balance, history: [usageLine, starterGrant] };
    expect(CreditAccountSchema.parse(minimal)).toEqual(minimal);
    const full = { ...minimal, pricingUrl: 'https://unalgorithm.app/credits', addCreditPath: '/account/credit' };
    expect(CreditAccountSchema.parse(full)).toEqual(full);
    const history = Array.from({ length: MAX_CREDIT_HISTORY + 1 }, () => usageLine);
    expect(MAX_CREDIT_HISTORY).toBe(200);
    expect(CreditAccountSchema.safeParse({ ...minimal, history: history.slice(1) }).success).toBe(true);
    expect(CreditAccountSchema.safeParse({ ...minimal, history }).success).toBe(false);
    expect(CreditAccountSchema.safeParse({ ...minimal, pricingUrl: 'http://unalgorithm.app/credits' }).success).toBe(false);
    expect(CreditAccountSchema.safeParse({ ...minimal, addCreditPath: '//evil.example' }).success).toBe(false);
  });
});
