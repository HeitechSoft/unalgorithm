# @unalgorithm/core

## 0.1.0

### Minor Changes

- [#17](https://github.com/HeitechSoft/unalgorithm/pull/17) [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Credit purchases: any amount from $5 to $500, no packs. The fixed packs (`CREDIT_PACKS`, `CREDIT_PACK_IDS`,
  `CreditPackIdSchema`, `creditPack`, `DEFAULT_CREDIT_PACK`) are removed; the amount rules replace them:
  `CREDIT_AMOUNT_MIN_MICROS` ($5), `CREDIT_AMOUNT_MAX_MICROS` ($500), whole dollars only (`CREDIT_AMOUNT_STEP_MICROS`),
  the quick picks `CREDIT_AMOUNT_PRESETS` ($5, $10, $25) and `DEFAULT_CREDIT_AMOUNT` ($10), with `creditAmount({ dollars })`
  or `creditAmount({ micros })`, which returns the amount in dollars, cents and micro-dollars, or null for anything outside
  the rules (never throws). Credit added equals the amount paid, and purchased credit never expires; auto-reload amounts
  follow the same rules. `CREDIT_PACK_CURRENCY` is now `CREDIT_CURRENCY`. The ledger reason `credit-pack` keeps its name
  for existing entries; the account page titles it "Credit purchase" and says "Any amount from $5 to $500." under
  "Add credit". The website's "How credits work" says credit loads in any amount from $5 to $500, with the quick picks as
  examples, and its calculator (`calculatorData`, `calculatorResult(data, amount, postsPerDay, now)`) takes any
  whole-dollar amount within the rules.

### Patch Changes

- Updated dependencies [[`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072), [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072)]:
  - @unalgorithm/protocol@0.1.0
