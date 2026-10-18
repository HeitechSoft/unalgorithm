# @unalgorithm/protocol

## 0.2.0

### Minor Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The price book: a server's task prices, starter credit, buying credit amounts and auto-reload caps in one shape, with
  today's prices as its default, the rules each change must pass (with typing-slip bounds), the shape `/prices.json`
  publishes and the admin contract of the Pricing page. Nothing reads it yet, and no price changes.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The price rules give each refusal a code and its facts (the task, the date and the earliest date allowed), in plain
  words for the Pricing page, without changing a line the price-schedule CI check prints. One task's price change is an
  edit of the dated schedule: price a task from a date, cancel a scheduled change, or move it.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Every price the server shows or charges now comes from its price book, so a change saved on the Pricing page applies
  at once, without a restart: discovery and the fact-check and UnEcho Chamber offers, and the billing module through
  the billing host's `prices` (which replaces `priceSchedule`). The book is published at `/prices.json`, public and
  cacheable with an ETag, on a server that charges. Discovery also gives a billing server's price of 1,000 classified
  posts (`classifyPrice`). No price changes.

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

- [#17](https://github.com/HeitechSoft/unalgorithm/pull/17) [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Auto-reload contract (additive): the ledger reason `auto-reload` (kind `purchase`, always adds credit) is appended to
  `CREDIT_ENTRY_REASONS`, and the account answer gains an optional `autoReload` summary (`AutoReloadSummarySchema`: the
  server's auto-reload page, and `off`, `on` with its amount, threshold and monthly limit, or `stopped` after a failed
  payment). The account page titles these history lines "Auto-reload" and, when the server sends the summary, says whether
  auto-reload is off, on or stopped, with a link to set it up or change it.
