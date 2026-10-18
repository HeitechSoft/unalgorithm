# UX specification

unAlgorithm follows Apple's Human Interface Guidelines in spirit: **deference** (the feed is the content, we stay
out of the way), **clarity** (one primary action per screen, plain words) and **depth** (detail is one step away,
never in the way).

## Principles in practice

| Principle | What it means here |
|---|---|
| Deference | Ordinary posts get no injected UI. Our brand never appears in the feed. In-feed text is one step smaller than the site's |
| Clarity | Reasons use the site's own words ("Promoted", "Sponsored"). "Why?" is plain language |
| Depth | Stub → Why? popover → Settings. Popup → side panel → Settings |
| User control | Everything hidden can be shown. Every rule change made in the feed has Undo. Pause per site |
| Progressive disclosure | Presets → switches → exceptions and keywords → advanced thresholds |
| Fail open | Unsure means shown. Errors show posts, never hide them |

## Surfaces

| Surface | Job |
|---|---|
| **Toolbar popup** (360 px) | Site on or paused (1 hour, until tomorrow, until I turn it back on); "6 posts hidden on this page"; reason chips that open the side panel; Strength segmented control (the feed updates live); "4 posts for you"; Peek; footer with AI status (credit balance in Phase 2), Report a problem and Help |
| **Side panel** "Highlights" | *For you* and *Hidden* tabs; hidden posts grouped by reason with Show; tap to scroll the feed to a post |
| **Settings** (full tab) | macOS System Settings layout: sidebar with colored icon tiles and search, inset grouped lists. Panes: LinkedIn, Facebook, Display, Interests, AI, Privacy & Data, About. Changes apply instantly; no Save button; destructive actions use alert dialogs |
| **Onboarding** (opens on install) | Welcome → Strength → Interests → AI (optional) → Done. Under a minute, every step skippable, saves as it goes, starts working in LinkedIn/Facebook tabs that are already open |
| **In the feed** | Collapsed stub, merged runs ("3 hidden · Show all"), Why? popover, revealed bar, "For you" ring and row with More like this / Not for me, one-time coach mark, toasts at the bottom left (chat windows dock at the bottom right) |
| **Toolbar icon** | Per-tab count badge in teal (never red); greyscale when paused |

## Presets

Balanced is the default.

| Hides | Light: "Just the clutter" | **Balanced: "What you didn't ask for"** | Calm: "Only what matters" |
|---|---|---|---|
| Ads, feed panels (People You May Know, jobs, games, Reels tray, suggested groups) | ✓ | ✓ | ✓ |
| Suggested posts, network activity ("Jane liked this"), groups you haven't joined | — | ✓ | ✓ |
| People and pages you don't follow | — | ✓ LinkedIn; Facebook after verification | ✓ |
| Reels in the feed, reshares | — | — | ✓ |
| With AI: engagement bait, rage bait, clickbait | — | ✓ | ✓ |
| With AI: off-topic, promotional, low-effort | — | — | ✓ |

## In-feed safety rules

1. AI never collapses a post that is on screen. Its verdict applies once the post scrolls away.
2. Any error shows posts.
3. If more than 50 / 80 / 95 % (Light / Balanced / Calm) of the first posts would be hidden, or no posts appear,
   unAlgorithm stops hiding on that page. The toolbar icon's tooltip says the layout looks different, and the popup
   shows "Filtering is paused on this page" with **Report a problem**.

## Onboarding copy anchors

| Step | Title | Notes |
|---|---|---|
| Welcome | "See the posts you came for." | Feed-cleaning illustration plays once; static with reduced motion |
| Strength | "How calm should your feed be?" | Three cards with mini feeds |
| Interests | "What do you want more of?" | 16 starter topics, each with English keywords so matching works without AI, plus "Anything you'd like less of?" |
| AI | "Want smarter filtering?" | On this device (live availability and download progress), Your own API key, Local or self-hosted, Set up later, and a disabled "unAlgorithm Cloud · Coming soon" card that becomes selectable in Phase 2 |
| Done | "You're all set." | Open LinkedIn / Facebook; pin-to-toolbar card that notices when it is pinned |

## Voice

Calm, short, honest. No exclamation marks. Never disparage LinkedIn or Facebook. AI decisions are marked with the
Iris accent and a sparkle and always say they can be wrong. Prefer "hidden" over "blocked", "Show" over "Unhide".
"by HeitechSoft" appears in onboarding, About and the store listing, never in the feed.

## Visual system (`packages/ui`)

- **Accent "Lagoon" teal** `#0B7A75` light / `#3CCFC0` dark; deliberately distinct from LinkedIn and Facebook blue.
  **Iris** `#6B4FD8` for AI.
- Every color is a token defined with `light-dark()`; the axe E2E check verifies WCAG AA contrast on every extension
  page in light and dark.
- Type ramp 34 / 26 / 20 / 17 / 14 / 13 / 12 / 11 with a compact variant for the popup, side panel and feed; system
  font stack.
- 4-point spacing; continuous corners with `corner-shape: squircle` where supported.
- Materials (`backdrop-filter`) only on floating layers, with a `prefers-reduced-transparency` fallback.
- Motion uses spring-like `linear()` easing and collapses to fades with `prefers-reduced-motion`.
- `forced-colors` supported; targets at least 24 px; focus never hidden.
- Plain CSS with cascade layers and a `ua-` class prefix. In the feed, one constructed stylesheet is adopted by every
  shadow root; overlays use native `popover` and CSS anchor positioning so the site's `overflow` and `z-index` can't
  clip them. Host-page DOM names use `unalgo-` (`<unalgo-post>`, `data-unalgo-*`).
- The site's card background, text color and font are sampled once into CSS variables so in-feed UI matches light
  and dark themes.
- Icons: a Lucide subset (ISC).

## Review

`pnpm e2e` builds the extension and, among the other end-to-end tests, renders every surface in light and dark
into `screens/`. Attach the relevant ones to UI pull requests. The axe E2E check must report no serious or
critical issues.
