<p align="center">
  <img src="apps/extension/public/icon/128.png" width="96" height="96" alt="" />
</p>

<h1 align="center">unAlgorithm Feed</h1>

<p align="center"><strong>See the posts you came for.</strong><br />
An open-source browser extension by HeitechSoft that quietly folds away ads, suggested posts and other noise on LinkedIn
and Facebook.</p>

<p align="center"><a href="https://unalgorithmfeed.com/">unalgorithmfeed.com</a> ·
<a href="https://unalgorithmfeed.com/help/">Help</a> ·
<a href="https://unalgorithmfeed.com/privacy/">Privacy</a></p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0-only" src="https://img.shields.io/badge/license-AGPL--3.0--only-0B7A75" /></a>
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-0B7A75" />
  <img alt="Edge MV3" src="https://img.shields.io/badge/Edge-MV3-0B7A75" />
  <img alt="Firefox MV3" src="https://img.shields.io/badge/Firefox-MV3-0B7A75" />
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-a15c00" />
</p>

---

Social feeds are ranked to keep you scrolling. They mix in ads, posts "suggested for you", "Jane liked this"
activity, and content from people you never chose to follow. **unAlgorithm Feed (unAlgorithm for short) hides that
noise and leaves a thin line in its place**, so you can still peek, and it never touches the posts from people you
actually follow.

<p align="center"><img src="docs/images/feed-linkedin-light.png" width="520" alt="A LinkedIn feed where an ad and other noise posts are folded into thin lines, and one post is highlighted For you" /></p>

## What it does

| | |
|---|---|
| **Hides the noise, no setup** | Ads (Promoted/Sponsored), suggested posts, network activity, feed panels like People You May Know, groups you haven't joined, and people and pages you don't follow. Works with zero configuration and **makes no network requests at all**. |
| **Three strengths** | *Light* (just the clutter), *Balanced* (what you didn't ask for), *Calm* (only what matters). Change it from the toolbar; the feed updates live. |
| **Always explains itself** | Every hidden post has **Why?**: what was detected, and one-click fixes like "Always show this person" or "Stop hiding suggested posts", with Undo. |
| **For you** | Pick a few interests and matching posts get a quiet highlight. Works with simple keyword matching, or with AI if you turn it on. |
| **Optional AI, your choice** | Spot off-topic posts, engagement bait and rage bait with **your browser's built-in on-device AI** (free, private; Chrome, and Edge's preview builds), **your own API key** (Anthropic, OpenAI, Gemini, OpenRouter, Groq), or **a local or self-hosted model** (Ollama, LM Studio, any OpenAI-compatible server). |
| **Private by design** | Rules run in your browser. When AI is on, only what's needed to classify a post goes to the AI you chose: its text (with emails, phone numbers, @mentions and tagged names masked), the kind of media, a shared link's site and title, and your interests. Never author names, profile links, comments or images. Your API keys stay in this browser. No analytics, no tracking, no account. |
| **Fails open** | If a site changes its layout and detection looks wrong, unAlgorithm stops hiding and tells you, rather than hiding posts by mistake. **Report a problem**, in unAlgorithm itself, tells us: it shows you exactly what it sends, and sends it only when you click Send report. |

<p align="center">
  <img src="docs/images/popup-light.png" width="300" alt="The unAlgorithm toolbar popup showing 6 posts hidden and the Strength control" />
  &nbsp;
  <img src="docs/images/onboarding-1-welcome-light.png" width="460" alt="The welcome screen: See the posts you came for" />
</p>

## Install

unAlgorithm is in **public preview** for Chrome, Microsoft Edge and Firefox. Until it is on the Chrome Web Store,
Microsoft Edge Add-ons and Firefox Add-ons, install it from a
[GitHub release](https://github.com/HeitechSoft/unalgorithm/releases) (each release says how) or build it from source
with Node.js 22.12 or newer:

```bash
git clone https://github.com/HeitechSoft/unalgorithm.git
cd unalgorithm
npm i -g pnpm@10      # or: corepack enable
pnpm install
pnpm build            # Chrome
pnpm build:edge       # Microsoft Edge
pnpm build:firefox    # Firefox
```

Then load the build. A short setup opens in a new tab.

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
  `apps/extension/.output/chrome-mv3`.
- **Microsoft Edge:** open `edge://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select
  `apps/extension/.output/edge-mv3`.
- **Firefox:** open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on…**, and select
  `apps/extension/.output/firefox-mv3/manifest.json`. Firefox keeps a temporary add-on until it restarts; it keeps for
  good only add-ons Mozilla signed, such as the signed file a GitHub release carries when it has one.

Requires Chrome or Edge 130 or newer, or Firefox 147 or newer, on a computer. Other Chromium browsers may work with the
Chrome build but aren't tested. LinkedIn and Facebook must be in English for now.

## Status

| Platform | Status |
|---|---|
| LinkedIn | Ported from a tool used daily; tested against fixtures in LinkedIn's October 2026 feed structure. |
| Facebook | **Preview.** Tested against anonymized captures of the live feed (October 2026) and synthetic fixtures. "People and pages you don't follow" was checked on live feeds ([what was checked](docs/fixtures.md)) and is part of Balanced, as on LinkedIn. |
| AI | Anthropic, OpenAI and OpenAI-compatible servers work end to end. Chrome's on-device AI depends on your hardware and Chrome version; Edge's is a preview in Edge Canary and Dev; Firefox has none. |
| Browsers | Chrome and Edge builds share one manifest; Firefox has its own, with Highlights in the sidebar (Alt+Shift+U) instead of the side panel. All three run the end-to-end tests in CI ([ADR 0008](docs/adr/0008-firefox-and-edge.md)). |

See [docs/ROADMAP.md](docs/ROADMAP.md) for what is next: unAlgorithm Cloud (sync, hosted AI with pay-as-you-go
credits), fact-checking and UnEcho Chamber, Safari, mobile and more platforms.

## Develop

```bash
pnpm --filter @unalgorithm/extension exec playwright install chromium   # once
pnpm dev          # Chromium with the extension and hot reload, persistent profile (sign in to LinkedIn once)
pnpm dev:fb       # same, opening Facebook
pnpm dev:edge     # the same in your installed Microsoft Edge, with its own profile
pnpm dev:firefox  # the same in Firefox, as a temporary add-on, with its own profile
pnpm test         # unit tests (Vitest)
pnpm e2e          # end-to-end tests: the built extension in Chromium against fixture pages, no live sites
pnpm e2e:edge     # the same tests in Microsoft Edge
pnpm e2e:firefox  # Firefox's own end-to-end tests, through WebDriver BiDi
pnpm check        # lint + typecheck + tests
pnpm zip          # every release file: the Chrome, Edge and Firefox zips, the Firefox sources and the sideload builds
```

[CONTRIBUTING.md](CONTRIBUTING.md) says which browser each command needs and how to point it at another one.

The repo is a pnpm workspace:

| Path | What lives there |
|---|---|
| `apps/extension` | The WXT (Manifest V3) extension for Chrome, Edge and Firefox: background, content scripts, popup, side panel (Firefox's sidebar), settings, onboarding |
| `packages/platforms` | LinkedIn and Facebook adapters: how to find and read posts on each site, with fixtures |
| `packages/core` | Rules, presets, settings, the classification prompt and everything else that is pure TypeScript |
| `packages/ai` | AI clients (Anthropic, OpenAI, OpenAI-compatible, the built-in AI of Chrome and Edge) and the classify orchestrator |
| `packages/ui` | The design system: tokens, components, in-feed UI |
| `packages/protocol` | Wire contracts shared with the unAlgorithm server |
| `apps/server` | The unAlgorithm server that runs unAlgorithm Cloud (Node, Hono, Postgres, Docker Compose): sign-in, AI labels, invites, caps, backups |

The server's source is public under AGPL-3.0 ([LICENSE](LICENSE)); its billing module and HeitechSoft's operations
are private ([ADR 0007](docs/adr/0007-open-server-private-billing.md)).

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first, then [CONTRIBUTING.md](CONTRIBUTING.md).
When a site changes its layout, [docs/adding-a-platform.md](docs/adding-a-platform.md) and
[docs/fixtures.md](docs/fixtures.md) explain how to capture fixtures and fix detection.

## Privacy

The short version: nothing leaves your browser unless you turn on AI, and then only what's needed to classify each
post goes to the AI you picked, never who wrote it, or unless you send us a problem report, which you see in full
first and which holds no post text or names. Read [PRIVACY.md](PRIVACY.md).

## License and trademarks

Copyright (C) 2026 HeitechSoft. unAlgorithm is free software under the
[GNU Affero General Public License, version 3 only](LICENSE) (SPDX: `AGPL-3.0-only`). Contributions will be accepted
under the [Contributor License Agreement](CLA.md) once it is final. "unAlgorithm Feed", "unAlgorithm", "unAlgo" and
the logo are trademarks of HeitechSoft; see [TRADEMARKS.md](TRADEMARKS.md) if you fork, and [docs/brand.md](docs/brand.md)
for how to write the name. Maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md).

unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta. LinkedIn and Facebook are
trademarks of their respective owners.

Made by [HeitechSoft](https://heitechsoft.com) in Ontario, Canada.
