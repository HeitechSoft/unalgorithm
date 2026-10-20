# @unalgorithm/web

## 0.1.1

### Patch Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - The sign-in page takes Firefox's sign-in requests, and sends the browser back only to an address under the one the
  request named. The admin page no longer adds a note about store builds under the sentence to pass on: every store
  version of unAlgorithm Feed now signs in to servers.
- Updated dependencies [[`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096)]:
  - @unalgorithm/core@0.3.0
  - @unalgorithm/protocol@0.3.0
  - @unalgorithm/ui@0.1.0
  - @unalgorithm/outlets@0.0.3

## 0.1.0

### Minor Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The Pricing page at `/admin/prices`, linked from the admin page: an admin sees each task's price now and its scheduled
  changes, schedules a change of Classifying posts, Fact-check or UnEcho Chamber from a day, and cancels or moves a
  scheduled one. Before saving, the page says whether the change is a raise or a cut, the earliest day it can start, why
  the price rules refuse it, and exactly what people will be shown: the account page's, the website's and the extension's
  own lines (`taskPriceLines`). The server checks every rule again on save.

### Patch Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The balance's estimate follows your server's current price. The account page reads its price lines and the amounts
  one purchase may add from the server's `/prices.json`, and the extension's "about N posts" uses the price in the
  server's discovery document (`classifyPrice`), falling back to the bundled schedule for a server that sends none.
  The extension reads that document again at most every 5 minutes while the server classifies for it, not only when
  you sign in, so its price lines follow a price change too.
  `creditFacts`, `creditsMarkdown` and `calculatorData` take a price book (by default `DEFAULT_PRICE_BOOK`, today's
  prices) instead of a schedule, and `balanceLine` takes the server's price. No price changes.

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The Pricing page at `/admin/prices` now also sets the starter credit new accounts get, the amounts people can buy (the
  least, the most, the quick picks and the one preselected) and the auto-reload caps (the most a month and top-ups a
  day). Each section shows its figures now and says when a change applies; as the admin types, it checks the change with
  the price rules and says why they refuse it. Below them, the history lists every price change, newest first, with when
  and which admin made it. The history stays on the admin page and is never published.

- [#29](https://github.com/HeitechSoft/unalgorithm/pull/29) [`7c240dd`](https://github.com/HeitechSoft/unalgorithm/commit/7c240dd79dfbd2277194a5ceb3750b436a837a07) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The name is now written unAlgorithm, with a lowercase u: in Chrome ("unAlgorithm Feed"), the toolbar, onboarding,
  Settings, messages, the sign-in and account pages, and the wordmark.
- Updated dependencies [[`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8)]:
  - @unalgorithm/protocol@0.2.0
  - @unalgorithm/core@0.2.0
  - @unalgorithm/outlets@0.0.2
  - @unalgorithm/ui@0.0.3

## 0.0.2

### Patch Changes

- [#19](https://github.com/HeitechSoft/unalgorithm/pull/19) [`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The admin page uses the screen's width: up to 1120px, with accounts and invites in one column and usage in the other
  from 900px wide (one column below that), and the server's status (disk, backups, alerts) above the last 30 days. Sizes
  under 1 MB now read in KB, so a new server's backup shows "17 KB" rather than "0 MB".
- Updated dependencies [[`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237)]:
  - @unalgorithm/core@0.1.1
  - @unalgorithm/ui@0.0.2

## 0.0.1

### Patch Changes

- [#17](https://github.com/HeitechSoft/unalgorithm/pull/17) [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Auto-reload contract (additive): the ledger reason `auto-reload` (kind `purchase`, always adds credit) is appended to
  `CREDIT_ENTRY_REASONS`, and the account answer gains an optional `autoReload` summary (`AutoReloadSummarySchema`: the
  server's auto-reload page, and `off`, `on` with its amount, threshold and monthly limit, or `stopped` after a failed
  payment). The account page titles these history lines "Auto-reload" and, when the server sends the summary, says whether
  auto-reload is off, on or stopped, with a link to set it up or change it.

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
- Updated dependencies [[`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072), [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072)]:
  - @unalgorithm/protocol@0.1.0
  - @unalgorithm/core@0.1.0
  - @unalgorithm/ui@0.0.1
