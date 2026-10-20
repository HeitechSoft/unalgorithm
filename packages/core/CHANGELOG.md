# @unalgorithm/core

## 0.3.0

### Minor Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook's Balanced now hides posts from people and pages you don't follow, as LinkedIn's does. Until now it was only
  in Calm while it was checked on live feeds. If your Facebook strength is Balanced, it gets the new rule when you
  update. If you chose Custom, or changed a filter, your filters stay as they are, and Settings → Facebook → People and
  pages you don't follow turns it off. It goes by the Follow button Facebook shows next to an author you don't follow,
  so your friends' posts, the pages and people you follow and groups you're in stay. A friend sharing a page's post or
  reel should stay too: a Follow button inside what they shared doesn't count, nor, in a group you're in, one after the
  member's name. If a post you wanted is folded, Why? on it shows what was detected, with a one-click fix. With sync on,
  each computer sends the setting once when it updates, so computers that update or start syncing later show the same,
  and Balanced picked on a computer that hasn't updated yet still means the new Balanced on one that has.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Each hidden post now has its own thin line, with Why? and Show, even when several are hidden one after another, so
  you can see what was hidden without an extra click. To show them as one line with Show all, as before, turn on
  Settings → Display → Group hidden posts in a row. It's off for everyone when you update, unless you had changed that
  switch yourself, and then your choice stays. With sync on, turning it on or off carries to your other computers like
  the rest of Display.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Report a problem from inside unAlgorithm, without GitHub or an account. Report a problem in the popup, Let us know on a
  note that something stopped working, Why? → Wrong call? and Settings → About open a page that asks what's wrong, shows
  what will be sent in plain words and exactly, and sends it to HeitechSoft through unAlgorithm Cloud only when you click
  Send report. A report holds versions, counts and your answers, never what posts say, names, links or anything that
  identifies you, and it is deleted after 90 days. To ask us to correct a Fact-check or UnEcho Chamber result, choose
  Report a wrong verdict or Report a mistake under it and say what's wrong in your own words, with your email if you'd
  like a reply. In Firefox, reports are sent while its technical and interaction data choice, offered at install, is on;
  otherwise the page offers to email the report from your own email program. PRIVACY.md describes what a report holds,
  who reads it and how long it is kept.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - unAlgorithm notices when LinkedIn or Facebook change in a way that stops it working, and says so. When it isn't
  running on a page that looks like your feed, when it paused filtering, or when ads may be getting through, a short note
  appears at the bottom left of your feed (once per page; Not now keeps it away for a day), and the popup, the side panel
  and the toolbar button say the same. Settings → Display → Tell me when something breaks turns the note off. Detection
  also survives more of the sites' changes: a feed moved to a new address keeps working when the page is clearly your
  home feed; an ad label with a new word, such as "Promoted • Brand content" or "Ad · Paid", is still folded when the post
  shows other signs of an ad, and the note says some ads may be getting through; a line in a post's own text that reads
  like an ad label no longer hides it; and an error reading the page shows your posts instead of stopping silently. On
  Facebook, posts the site empties while you scroll no longer raise a false warning. These checks run on your computer,
  and nothing is sent unless you choose to.

### Patch Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - On Facebook, the feed no longer keeps folding and opening every few seconds as you scroll. When unAlgorithm would hide
  too many posts, it now shows every post until you reload the page, and a card in the feed says so right away. Posts
  and panels that Facebook clears far from the screen still count as what they were, so scrolling no longer turns
  filtering off and on.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - A feed that is mostly noise keeps its noise hidden. The safety check that stops hiding when detection looks wrong now
  allows up to 90% of a page's items at Balanced (was 80%), and hidden ads no longer count toward it, since they have a
  check of their own. LinkedIn feeds of mostly suggested, promoted and unfollowed posts no longer trip it.
- Updated dependencies [[`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096)]:
  - @unalgorithm/protocol@0.3.0

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
