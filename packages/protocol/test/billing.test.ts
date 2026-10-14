import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_PAGE_PATH,
  CREDIT_ACCOUNT_PATH,
  CREDIT_BALANCE_PATH,
  CREDIT_PRICE_CARDS,
  CreditAccountSchema,
  CreditBalanceSchema,
  CreditHistoryItemSchema,
  estimatePosts,
  LOW_BALANCE_MICROS,
  MAX_CREDIT_HISTORY,
  PRICE_CARDS,
  retailMicros,
  retailMicrosPer1000Posts,
  STARTER_CREDIT,
} from '../src/index.ts';

describe('price cards', () => {
  it('test_price_cards_exact_values', () => {
    expect(CREDIT_PRICE_CARDS).toEqual({
      classify: { multiplier: 2, referenceModel: 'claude-haiku-5-5', referenceCostMicrosPer1000: 73000 },
    });
    expect(Object.isFrozen(CREDIT_PRICE_CARDS)).toBe(true);
    expect(Object.isFrozen(CREDIT_PRICE_CARDS.classify)).toBe(true);
    expect(CREDIT_PRICE_CARDS.classify.referenceModel in PRICE_CARDS).toBe(true);
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
    expect(retailMicrosPer1000Posts()).toBe(146_000);
    expect(retailMicrosPer1000Posts('classify')).toBe(146_000);
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
    for (const [balance, posts] of vectors) expect(estimatePosts(balance), `${balance}`).toBe(posts);
  });

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
