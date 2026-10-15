/**
 * A price schedule for tests, never shipped: the launch entry, then one from 2026-10-02 that adds the job tasks at Tom's
 * 2x multiplier and the hold caps ($0.40 a fact-check, $0.50 a comparison). Pass it as `priceSchedule` to
 * `createTestHost` or `createTestApp` to bill checks before production offers them.
 */
import { CREDIT_PRICE_SCHEDULE, type CreditPriceSchedule } from '@unalgorithm/protocol';

const launch = CREDIT_PRICE_SCHEDULE[0];
if (!launch) throw new Error('CREDIT_PRICE_SCHEDULE is empty');

export const TEST_PRICE_SCHEDULE: CreditPriceSchedule = Object.freeze([
  launch,
  Object.freeze({
    effectiveFrom: '2026-10-02T00:00:00Z',
    cards: Object.freeze({
      classify: launch.cards.classify,
      factcheck: Object.freeze({
        multiplier: 2,
        referenceModel: 'claude-sonnet-5-5',
        referenceCostMicrosPer1000: 120_000_000,
        unit: 'check',
        maxChargeMicros: 400_000,
      }),
      perspectives: Object.freeze({
        multiplier: 2,
        referenceModel: 'claude-sonnet-5-5',
        referenceCostMicrosPer1000: 135_000_000,
        unit: 'comparison',
        maxChargeMicros: 500_000,
      }),
    }),
  }),
]);
