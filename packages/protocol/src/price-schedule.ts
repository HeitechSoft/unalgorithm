/**
 * Data only: no runtime import, only `import type`. scripts/check-price-schedule.mjs reads this file from the base
 * commit with `git show` and imports it with Node's type stripping from a temporary directory. Never edit an entry
 * that is in effect: add a new dated entry (docs/release.md → Changing a price card).
 */
import type { CreditPriceSchedule } from './billing.ts';

/**
 * The least notice a raise gives: within this many days of a change's merge, no task may charge or publish more than
 * before. A cut may take effect from the next 00:00 UTC. Confirmed by Tom 2026-10-14.
 */
export const PRICE_NOTICE_DAYS = 30;

/** Spec → Monetization: classify 1,000 posts on Haiku 5.5 ≈ $0.073, multiplier 2.0×, retail ≈ $0.15. */
const CREDIT_PRICE_SCHEDULE_LAUNCH_CLASSIFY = Object.freeze({
  multiplier: 2,
  referenceModel: 'claude-haiku-5-5',
  referenceCostMicrosPer1000: 73_000,
});

/**
 * 2026-10-01: the launch classify card. 2026-11-01: perspectives added (docs/release.md → Adding a task), the classify
 * card copied as the same object; a comparison ≈ $0.135 on Sonnet 5.5 at 2×, hold cap $0.50 (Tom, decision 1).
 */
export const CREDIT_PRICE_SCHEDULE: CreditPriceSchedule = Object.freeze([
  Object.freeze({
    effectiveFrom: '2026-10-01T00:00:00Z',
    cards: Object.freeze({ classify: CREDIT_PRICE_SCHEDULE_LAUNCH_CLASSIFY }),
  }),
  Object.freeze({
    effectiveFrom: '2026-11-01T00:00:00Z',
    cards: Object.freeze({
      classify: CREDIT_PRICE_SCHEDULE_LAUNCH_CLASSIFY,
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
