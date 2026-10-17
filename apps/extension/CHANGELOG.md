# @unalgorithm/extension

## 0.3.0

### Minor Changes

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check is out of Labs. Turn it on in Settings → AI. It still runs only when you click, on public posts, and shows the price first.

- [#27](https://github.com/HeitechSoft/unalgorithm/pull/27) [`553babb`](https://github.com/HeitechSoft/unalgorithm/commit/553babbde368378fcfc4871cf93d12bf4946b623) Thanks [@TomHeiber](https://github.com/TomHeiber)! - UnEcho Chamber and fact-check on unAlgorithm Cloud are priced from 18 October 2026 (00:00 UTC), at the same prices as
  announced: a comparison costs about $0.27 at 2× and at most $0.50, a check about $0.24 at 2× and at most $0.40. The price
  schedule prices both in one entry from 2026-10-18, which replaces the 2026-11-01 and 2026-12-01 entries before either
  took effect. The classify price is unchanged.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - While UnEcho Chamber is on, unAlgorithm downloads unAlgorithm Cloud's source list once a day, with nothing about you.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Keep your own source list for UnEcho Chamber in Settings → AI: start from unAlgorithm Cloud's list or the candidates, and set leans yourself.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - UnEcho Chamber runs on unAlgorithm Cloud's source list or your own, with warnings when a list isn't balanced. The comparison request carries the list.

### Patch Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The balance's estimate follows your server's current price. The account page reads its price lines and the amounts
  one purchase may add from the server's `/prices.json`, and the extension's "about N posts" uses the price in the
  server's discovery document (`classifyPrice`), falling back to the bundled schedule for a server that sends none.
  The extension reads that document again at most every 5 minutes while the server classifies for it, not only when
  you sign in, so its price lines follow a price change too.
  `creditFacts`, `creditsMarkdown` and `calculatorData` take a price book (by default `DEFAULT_PRICE_BOOK`, today's
  prices) instead of a schedule, and `balanceLine` takes the server's price. No price changes.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - A finished fact-check or UnEcho Chamber result links to how it works and to a form for reporting a mistake. The form is filled in with versions only, never anything from the post.

- [#29](https://github.com/HeitechSoft/unalgorithm/pull/29) [`7c240dd`](https://github.com/HeitechSoft/unalgorithm/commit/7c240dd79dfbd2277194a5ceb3750b436a837a07) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The name is now written unAlgorithm, with a lowercase u: in Chrome ("unAlgorithm Feed"), the toolbar, onboarding,
  Settings, messages, the sign-in and account pages, and the wordmark.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives is now called UnEcho Chamber. Only its name changed.
- Updated dependencies [[`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8)]:
  - @unalgorithm/protocol@0.2.0
  - @unalgorithm/core@0.2.0
  - @unalgorithm/ai@0.0.3
  - @unalgorithm/outlets@0.0.2
  - @unalgorithm/platforms@0.0.4
  - @unalgorithm/research@0.0.3
  - @unalgorithm/sync@0.0.3
  - @unalgorithm/ui@0.0.3

## 0.2.3

### Patch Changes

- [#22](https://github.com/HeitechSoft/unalgorithm/pull/22) [`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook filtering works again. Facebook's home feed no longer marks its post list with `role="feed"`, so unAlgorithm
  found no feed, paused itself on every page and showed "Facebook's layout looks different". It now also finds the list
  the 2026 layout uses (the block after the screen-reader "Feed posts" heading, without reading that English text), hides
  ads labelled "Ad" as well as "Sponsored", and reads "Shared with …'s friends" as a friends-only post.
- Updated dependencies [[`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c)]:
  - @unalgorithm/platforms@0.0.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237)]:
  - @unalgorithm/core@0.1.1
  - @unalgorithm/ai@0.0.2
  - @unalgorithm/platforms@0.0.2
  - @unalgorithm/research@0.0.2
  - @unalgorithm/sync@0.0.2
  - @unalgorithm/ui@0.0.2

## 0.2.1

### Patch Changes

- [#17](https://github.com/HeitechSoft/unalgorithm/pull/17) [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072) Thanks [@TomHeiber](https://github.com/TomHeiber)! - See what each batch of posts cost on a server that bills, in Why? and Settings → AI. The Why? popover of a post the AI
  hid says what its batch cost ("This batch of 12 posts cost $0.0018 of your credit."), and Settings → AI shows today's
  charged total and the day's batches from this browser, newest first. The figures are the server's own charges.

- When AI on unAlgorithm Cloud (or another unAlgorithm server) pauses because the balance ran out, it resumes by itself
  once credit is added: paused LinkedIn and Facebook tabs pick up again without a reload.

- Fact-check (Labs): a verdict kept from an earlier check of the same claim now shows its short explanation too, not only
  when it was checked. The explanation is left out when it repeats six or more words in a row of the post or of a claim the
  check found, and so is a source's title or quote that repeats a claim. Servers keep it in their claim cache (migration
  0014). The privacy policy says exactly what a kept result holds.

## 0.2.0

### Minor Changes

- **Labs** (Settings → Labs, off by default): **Fact-check** checks the claims in a public post against independent
  sources, and **Other perspectives** compares how other outlets covered a post's shared link, with lean labels only
  from unAlgorithm's reviewed outlet list. Both run on your own Anthropic or OpenAI key, or on your own AI server with a
  Brave or Tavily search key. Results stay in the tab, and nothing goes to HeitechSoft. The privacy policy describes
  exactly what each sends.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`58fc51c`](https://github.com/HeitechSoft/unalgorithm/commit/58fc51cb934b351f40d149c416181a3c77b978b1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check (Labs) can run on a billing server such as unAlgorithm Cloud from 2026-12-01, at the same 2× our AI cost
  as everything else: typically about $0.24 a check, never more than $0.40. Before that date a billing server doesn't
  offer it.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`11e2b77`](https://github.com/HeitechSoft/unalgorithm/commit/11e2b77047cfa52c279f5d9a00b612b954d1e7fb) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check researches more cheaply: one search per claim plus one (at most 5), at low research effort, and the verdict
  step sees only sources it can quote. The fact-check prompt version is now 2. Upgrade note for servers: fact-check and
  Other perspectives stay off until the admin runs `route-eval factcheck` again, about $3 with Anthropic.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`17a8385`](https://github.com/HeitechSoft/unalgorithm/commit/17a8385ded5f776693a6cdf5a6b41d9062d4a924) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives (Labs) can run on a billing server such as unAlgorithm Cloud from 2026-11-01, at the same 2× our AI
  cost as everything else: typically about $0.27 a comparison, never more than $0.50. Classifying is unchanged, so the
  account page shows no new price line for it. The discovery document can
  advertise `capabilities.perspectives` and `jobPrices.perspectives`; older documents still parse.

### Patch Changes

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`7ab0b59`](https://github.com/HeitechSoft/unalgorithm/commit/7ab0b59a1bad17882a68dca1292d63dd9ab13d33) Thanks [@TomHeiber](https://github.com/TomHeiber)! - When AI pauses (today's limit reached, a key out of credit, sign-in needed), posts it already sorted stay sorted, and
  posts it sorted before are still sorted from the saved results. Only new AI requests stop until it resumes.

- [#13](https://github.com/HeitechSoft/unalgorithm/pull/13) [`17dae73`](https://github.com/HeitechSoft/unalgorithm/commit/17dae73078927bbf96c67660a8edd47a58e233f1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Settings → AI: the API key and server address fields inside the selected option can be clicked and typed into again.

- [#1](https://github.com/HeitechSoft/unalgorithm/pull/1) [`8af8f3a`](https://github.com/HeitechSoft/unalgorithm/commit/8af8f3a06ddb79e0fa2f67b52547619eb66871fc) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The extension is now named unAlgorithm Feed in Chrome and on the Chrome Web Store. Inside the extension it is still
  unAlgorithm for short.

- [#5](https://github.com/HeitechSoft/unalgorithm/pull/5) [`81b3978`](https://github.com/HeitechSoft/unalgorithm/commit/81b39785b1e210646ced139e24988c4b47d8005e) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Help, the privacy policy and What's new now open on the unAlgorithm Feed website, unalgorithmfeed.com, which is also
  the extension's homepage in Chrome. Settings → About adds Website and Help links. Source code, licenses and Report a
  problem still go to GitHub.

## 0.1.0

First public preview.

- Hides ads, suggested posts, network activity ("Jane liked this") and feed panels such as People You May Know on
  LinkedIn, plus posts from people and pages you don't follow (on by default in Balanced). Facebook support is in
  preview, with "people you don't follow" limited to Calm until it is verified on live feeds.
- Three strengths: Light, Balanced and Calm.
- Why? on every hidden post, with one-click fixes and Undo.
- For you highlights based on your interests, using keywords or AI.
- A toolbar popup, a Highlights side panel, Settings and a one-minute setup.
- Optional AI: Chrome's on-device model, your own key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq), or a local
  or self-hosted model. Only the post text and a few facts about it are sent; never author names.
- A health monitor that stops hiding when a layout looks different, and Report a problem with content-free
  diagnostics.
