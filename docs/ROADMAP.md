# Roadmap

unAlgorithm Feed is built in phases. Dates are not promised; each phase ships when it is solid.

## Phase 1: the extension (now)

- **v0.1, first preview.** LinkedIn and Facebook (preview), three strengths, Why? with one-click fixes and undo,
  For you highlights, toolbar popup, side panel, settings, onboarding, health monitor and Report a problem. Optional
  AI: Chrome's on-device AI, your own key (Anthropic, OpenAI, Gemini, OpenRouter, Groq), local and self-hosted
  models; noise labels, relevance, More/Less like this.
- **Facebook checked on live feeds (done).** Detection checked against anonymized captures of the live feed, and
  Balanced hides people and pages you don't follow on Facebook too, as on LinkedIn.
- **Next.** A right-click menu on posts, and French for Canada.
- **Website and stores.** The product website at unalgorithmfeed.com: what unAlgorithm Feed does, how to install it,
  the privacy policy, help and release notes. Then the store releases as unAlgorithm Feed by HeitechSoft, on the
  Chrome Web Store, Firefox Add-ons and Microsoft Edge Add-ons, with the listings and the extension's links pointing
  to the website.
- **Edge and Firefox (done).** Builds for Microsoft Edge and Firefox (desktop) with everything the Chrome build has,
  unAlgorithm Cloud included: sign-in, sync, AI labels and credits, fact-check and UnEcho Chamber on a server, and the
  devices list. In Firefox, Highlights is in the sidebar and there is no on-device AI; Edge's on-device AI is a preview
  ([ADR 0008](adr/0008-firefox-and-edge.md)).

## Phase 2: unAlgorithm Cloud

- Free accounts and **sync across devices** (settings, interests, exceptions; never API keys).
- **Hosted AI** with **pay-as-you-go credits**: no subscription, priced at the AI cost plus a published margin, a
  starter credit, purchased credit never expires. Rules, on-device, own key and self-hosted stay free.
- An **open-source server** (AGPL): unAlgorithm Cloud runs it, and its source is public; only its billing and
  HeitechSoft's operations are private.
- **Organizations**: shared policies, private AI endpoints, invoicing (HeitechSoft Private AI).
- **On the website**: how credits work, with live prices and the published margin; terms of service.

## Phase 3: Fact-check and UnEcho Chamber

- **Fact-check** on posts with checkable claims: claims, verdicts and sources, with "AI can be wrong, open the
  sources". Price shown before running.
- **UnEcho Chamber** for shared news links: how outlets across the spectrum covered the same
  story, what they agree on, what differs, with links to every source. Outlet leanings come from unAlgorithm Cloud's
  public source list, set by people with evidence, or from your own list, never from the model.
- The **methodology**, the source list, corrections and regular **transparency reports** are published on the website.

## Phase 4: more places

- A Safari build; mobile through Safari on iOS and Firefox on Android.
- More sites (X, Threads, Reddit, Instagram, YouTube), more languages (French for Canada first).
- Signed, data-only detection updates so layout fixes don't wait for store review.
- The website in French, with an install page for each browser.

Ideas and votes: [GitHub Discussions](https://github.com/HeitechSoft/unalgorithm/discussions).
