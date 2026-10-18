# @unalgorithm/core

## 0.2.0

### Minor Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The price book: a server's task prices, starter credit, buying credit amounts and auto-reload caps in one shape, with
  today's prices as its default, the rules each change must pass (with typing-slip bounds), the shape `/prices.json`
  publishes and the admin contract of the Pricing page. Nothing reads it yet, and no price changes.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The price rules give each refusal a code and its facts (the task, the date and the earliest date allowed), in plain
  words for the Pricing page, without changing a line the price-schedule CI check prints. One task's price change is an
  edit of the dated schedule: price a task from a date, cancel a scheduled change, or move it.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The balance's estimate follows your server's current price. The account page reads its price lines and the amounts
  one purchase may add from the server's `/prices.json`, and the extension's "about N posts" uses the price in the
  server's discovery document (`classifyPrice`), falling back to the bundled schedule for a server that sends none.
  The extension reads that document again at most every 5 minutes while the server classifies for it, not only when
  you sign in, so its price lines follow a price change too.
  `creditFacts`, `creditsMarkdown` and `calculatorData` take a price book (by default `DEFAULT_PRICE_BOOK`, today's
  prices) instead of a schedule, and `balanceLine` takes the server's price. No price changes.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The Pricing page at `/admin/prices`, linked from the admin page: an admin sees each task's price now and its scheduled
  changes, schedules a change of Classifying posts, Fact-check or UnEcho Chamber from a day, and cancels or moves a
  scheduled one. Before saving, the page says whether the change is a raise or a cut, the earliest day it can start, why
  the price rules refuse it, and exactly what people will be shown: the account page's, the website's and the extension's
  own lines (`taskPriceLines`). The server checks every rule again on save.

### Patch Changes

- Updated dependencies [[`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8)]:
  - @unalgorithm/protocol@0.2.0

## 0.1.1

### Patch Changes

- [#19](https://github.com/HeitechSoft/unalgorithm/pull/19) [`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The admin page uses the screen's width: up to 1120px, with accounts and invites in one column and usage in the other
  from 900px wide (one column below that), and the server's status (disk, backups, alerts) above the last 30 days. Sizes
  under 1 MB now read in KB, so a new server's backup shows "17 KB" rather than "0 MB".

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
