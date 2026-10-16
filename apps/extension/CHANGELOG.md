# @unalgorithm/extension

## 0.2.0

### Minor Changes

- **Labs** (Settings → Labs, off by default): **Fact-check** checks the claims in a public post against independent
  sources, and **Other perspectives** compares how other outlets covered a post's shared link, with lean labels only
  from UnAlgorithm's reviewed outlet list. Both run on your own Anthropic or OpenAI key, or on your own AI server with a
  Brave or Tavily search key. Results stay in the tab, and nothing goes to HeitechSoft. The privacy policy describes
  exactly what each sends.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`58fc51c`](https://github.com/HeitechSoft/unalgorithm/commit/58fc51cb934b351f40d149c416181a3c77b978b1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check (Labs) can run on a billing server such as UnAlgorithm Cloud from 2026-12-01, at the same 2× our AI cost
  as everything else: typically about $0.24 a check, never more than $0.40. Before that date a billing server doesn't
  offer it.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`11e2b77`](https://github.com/HeitechSoft/unalgorithm/commit/11e2b77047cfa52c279f5d9a00b612b954d1e7fb) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check researches more cheaply: one search per claim plus one (at most 5), at low research effort, and the verdict
  step sees only sources it can quote. The fact-check prompt version is now 2. Upgrade note for servers: fact-check and
  Other perspectives stay off until the admin runs `route-eval factcheck` again, about $3 with Anthropic.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`17a8385`](https://github.com/HeitechSoft/unalgorithm/commit/17a8385ded5f776693a6cdf5a6b41d9062d4a924) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives (Labs) can run on a billing server such as UnAlgorithm Cloud from 2026-11-01, at the same 2× our AI
  cost as everything else: typically about $0.27 a comparison, never more than $0.50. Classifying is unchanged, so the
  account page shows no new price line for it. The discovery document can
  advertise `capabilities.perspectives` and `jobPrices.perspectives`; older documents still parse.

### Patch Changes

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`7ab0b59`](https://github.com/HeitechSoft/unalgorithm/commit/7ab0b59a1bad17882a68dca1292d63dd9ab13d33) Thanks [@TomHeiber](https://github.com/TomHeiber)! - When AI pauses (today's limit reached, a key out of credit, sign-in needed), posts it already sorted stay sorted, and
  posts it sorted before are still sorted from the saved results. Only new AI requests stop until it resumes.

- [#13](https://github.com/HeitechSoft/unalgorithm/pull/13) [`17dae73`](https://github.com/HeitechSoft/unalgorithm/commit/17dae73078927bbf96c67660a8edd47a58e233f1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Settings → AI: the API key and server address fields inside the selected option can be clicked and typed into again.

- [#1](https://github.com/HeitechSoft/unalgorithm/pull/1) [`8af8f3a`](https://github.com/HeitechSoft/unalgorithm/commit/8af8f3a06ddb79e0fa2f67b52547619eb66871fc) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The extension is now named UnAlgorithm Feed in Chrome and on the Chrome Web Store. Inside the extension it is still
  UnAlgorithm for short.

- [#5](https://github.com/HeitechSoft/unalgorithm/pull/5) [`81b3978`](https://github.com/HeitechSoft/unalgorithm/commit/81b39785b1e210646ced139e24988c4b47d8005e) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Help, the privacy policy and What's new now open on the UnAlgorithm Feed website, unalgorithmfeed.com, which is also
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
