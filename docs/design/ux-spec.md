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
| **Toolbar popup** (360 px) | Site on or paused (1 hour, until tomorrow, until I turn it back on); "6 posts hidden on this page"; reason chips that open the side panel; Strength segmented control (the feed updates live); "4 posts for you"; Peek; footer with AI status (credit balance in Phase 2), Report a problem (on every page) and Help; the breakage banners ([below](#popup-side-panel-and-toolbar)) |
| **Side panel** "Highlights" | *For you* and *Hidden* tabs; hidden posts grouped by reason with Show; tap to scroll the feed to a post; a finished fact-check or UnEcho Chamber result ends with *How it works* and *Report a wrong verdict* / *Report a mistake* |
| **Report page** (a tab of its own) | Opened next to the feed by every *Report a problem*, *Let us know* and *Wrong call?*: the questions, *What we'll send*, the exact report, **Send report** ([below](#the-report-page)) |
| **Settings** (full tab) | macOS System Settings layout: sidebar with colored icon tiles and search, inset grouped lists. Panes: LinkedIn, Facebook, Display, Interests, AI, Privacy & Data, About. Changes apply instantly; no Save button; destructive actions use alert dialogs |
| **Onboarding** (opens on install) | Welcome → Strength → Interests → AI (optional) → Done. Under a minute, every step skippable, saves as it goes, starts working in LinkedIn/Facebook tabs that are already open |
| **In the feed** | Collapsed stub, merged runs ("3 hidden · Show all"), Why? popover, revealed bar, "For you" ring and row with More like this / Not for me, one-time coach mark, toasts at the bottom left (chat windows dock at the bottom right), and above them the breakage notice card ([below](#the-notice-card)) |
| **Toolbar icon** | Per-tab count badge in teal (never red); greyscale when paused; its title says what is happening on the tab ([below](#popup-side-panel-and-toolbar)) |

## Presets

Balanced is the default.

| Hides | Light: "Just the clutter" | **Balanced: "What you didn't ask for"** | Calm: "Only what matters" |
|---|---|---|---|
| Ads, feed panels (People You May Know, jobs, games, Reels tray, suggested groups) | ✓ | ✓ | ✓ |
| Suggested posts, network activity ("Jane liked this"), groups you haven't joined | — | ✓ | ✓ |
| People and pages you don't follow | — | ✓ | ✓ |
| Reels in the feed, reshares | — | — | ✓ |
| With AI: engagement bait, rage bait, clickbait | — | ✓ | ✓ |
| With AI: off-topic, promotional, low-effort | — | — | ✓ |

## In-feed safety rules

1. AI never collapses a post that is on screen. Its verdict applies once the post scrolls away.
2. Any error shows posts.
3. If more than 50 / 90 / 95 % (Light / Balanced / Calm) of the posts would be hidden, not counting ads, or no posts
   appear, unAlgorithm stops hiding on that page. The toolbar icon's tooltip says the layout looks different, and the
   popup shows "Filtering is paused on this page" with **Let us know**.
4. Noticing breakage never changes what is hidden, and nothing is sent until the person clicks **Send report**.

## Breakage notices and problem reports

When LinkedIn or Facebook change in a way that stops unAlgorithm, it says so, and the person can tell us from inside
the extension (ADR 0009). Every string is pinned by a test: `NOTICE_COPY` (`packages/ui/src/feed/Notice.tsx`),
`POPUP_COPY`, `NOTICES_COPY`, `ABOUT_REPORT_COPY` and `REPORT_COPY` (`entrypoints/report/copy.ts`).

### The notice card

The in-feed card shows only on positive evidence that detection stopped working. Missing things (no feed, no posts, no
ads seen) never raise it; the popup says those.

| Card | Raised by | Title | Body |
|---|---|---|---|
| `not-running` | A feed on an address unAlgorithm doesn't know, which the watchdog saw twice | unAlgorithm isn't running on this feed | {site} seems to have changed this page, so your feed shows as usual. |
| `paused` | Filtering paused on positive evidence: errors reading the page, too much hidden, too many items read as panels, or post text unreadable | Filtering is paused on this page | {site} looks different today, so we're showing every post rather than hide the wrong ones. |
| `ads-through` | Two or more ad labels that almost match | Some ads may be getting through | {site} may have changed how it labels ads. |

- **Actions:** **Let us know** (primary) opens the report page with the page as it is at that moment. **Not now**, ✕
  (labelled Dismiss) and Escape hide it. Footnote: "Nothing is sent unless you choose to." Actions run only on the
  person's own clicks and keys.
- **Placement:** bottom left, above the toasts, in our own shadow-root layer, at most 360 px wide; never inside the
  site's feed. One card at a time, in the order of the table. A page the controller doesn't run on gets a layer with
  the card only.
- **When:** the issue holds in two checks in a row, 10 seconds apart. Each card shows at most once per page load, never
  while the site is paused or off or the coach mark is up, and goes away quietly when the issue clears.
- **Snoozes:** *Not now* keeps that card away on that site for 24 hours; a report sent from anywhere, for 7 days. A new
  detection version ends a snooze. Snoozes are per device, shared by every tab, and never synced.
- **Settings → Display → Tell me when something breaks** (on by default), footer: "If LinkedIn or Facebook changes and
  unAlgorithm can't keep up, a short note appears in your feed. Nothing is sent unless you choose to."
- **Accessibility:** a region named "unAlgorithm" around a polite status that is always on the page; the card never
  takes focus; native buttons; light and dark tokens, forced colors, and the reduced-motion rule for its entrance.

### Popup, side panel and toolbar

They show the page's state whatever the card's snoozes.

| Where | State | What it shows |
|---|---|---|
| Popup | A card's issue on this page | A banner with the card's title and body (info tone for `ads-through`, warning for the others) and **Let us know** |
| Popup | Filtering paused without a card | The `paused` banner and **Let us know** |
| Popup | A LinkedIn or Facebook tab that finished loading but doesn't answer within 1.5 s | "unAlgorithm isn't running on this page" · "Reloading the page usually fixes this." · **Reload page** · *Still not working? Let us know* |
| Popup | A feed unAlgorithm doesn't run on | "unAlgorithm isn't running on this feed." in place of *Go to feed* (the banner says it when the card's issue is up) |
| Popup | 40 LinkedIn or 50 Facebook posts and no ad | "No ads found on this page yet." under the counts |
| Popup | Any page | *Report a problem* in the footer: about that page on LinkedIn and Facebook, and a general report elsewhere |
| Side panel | `not-running` or `paused` | The card's title and body in a banner, with **Let us know** |
| Toolbar title | A feed unAlgorithm doesn't run on | "unAlgorithm isn't running on this {site} page" |
| Toolbar title | Filtering paused by the health check | "unAlgorithm: {site}'s layout looks different, so nothing is hidden" |

The badge stays teal and is never alarming. Settings → About → **Report a problem** asks "What's it about?" first
(LinkedIn, Facebook, Something else); its banner, "Built in the open", says: "Found a post that was hidden by mistake?
Use Why? → Wrong call? on the post, or Report a problem in the toolbar menu."

### The report page

An extension page in a tab of its own, opened next to the feed tab: not the popup (it closes on blur and has no room
for the preview), not inside the site's page (its scripts could watch it), and not the side panel (Firefox can't open
its sidebar from a click in the page). One column, 640 px at most, light and dark, with the shared components. The
title takes focus when the page opens.

- **Title** "Report a problem". **Lead:** "This goes to HeitechSoft, who make unAlgorithm, so we can fix it in the
  next update." From a private window: "This is a private window, so the report includes nothing about the page."
- **Questions:** a problem on a page asks "What's wrong?" with checkboxes (Ads are still showing · Posts I didn't want
  are still showing · Posts I wanted are hidden · unAlgorithm isn't doing anything on this page · The page looks broken
  or slow · Something else); a card or an unanswered tab needs no answer, since the finding speaks for itself.
  *Wrong call?* asks one of: This post shouldn't have been hidden · It was hidden for the wrong reason. A general report
  asks "What's it about?" (Signing in or sync · AI labels, Fact-check or UnEcho Chamber · Credits · Something else);
  from Settings, after its own first question, "Which part of unAlgorithm?".
- **Corrections only** take words and an email: one answer (The verdict is wrong · A source is wrong or doesn't say
  that · Something else; for UnEcho Chamber: The comparison is wrong or unfair · An outlet or its lean is wrong ·
  Something else), then **In your own words** (required, with its hint and a count up to 1,000), then **Email for a
  reply (optional)**: "Only if you'd like a reply. We keep it until 30 days after we answer, and never more than 60
  days." Without an email: "Without an email we can't reply, but we review every correction and count it in our
  transparency report." The preview shows the words as they'll be sent, emails and phone numbers masked and links
  reduced to the site's name; the field keeps what the person typed.
- **What we'll send:** the report as plain lines, then **Show exactly what's sent**, the exact body in a focusable
  block. Then: "Not sent: what posts say, names, links, pictures or your account. Nothing in the report identifies you
  or this browser." (for a correction: "Not sent: the post, the result or your account. Your own words are sent as shown
  above, and your email only if you give it.") and "Sent to unAlgorithm Cloud (cloud.unalgorithm.app), HeitechSoft's
  server, whatever AI you use. HeitechSoft's team reads each report to fix unAlgorithm. Kept for 90 days." with a
  *Privacy policy* link. Links in a sentence are underlined.
- **Buttons:** **Send report** and **Cancel**. Send is never disabled: a missing answer shows "Choose at least one" (or
  "Choose one") by its group and moves focus there.

| After Send | Title | Then |
|---|---|---|
| Sent | Thanks, we got it. | "We read every report. When LinkedIn or Facebook change something, the fix comes in an update, usually within a few days." (a correction: "We review every correction. If you left an email, we reply within 5 business days."), the reference, and an email link to ask more · *Back to {site}* / *Close* |
| No connection or timeout | Couldn't send the report. | Check your internet connection, then try again. · *Try again* |
| Too many | You've sent several reports in a short time. | Please try again in about an hour. · *Try again* |
| Server busy | We can't take reports right now. | Please try again later. · *Try again* · *Email it instead* |
| Refused | This report couldn't be sent. | Update unAlgorithm and try again, or email it to us. · *Email it instead* |
| This browser's limit | You've sent several reports today. | Thank you, we have what we need. · *Close* |
| Firefox without technical data | Firefox is set not to share technical data from unAlgorithm. | Email this report instead, or allow Technical and interaction data in Firefox. · *Email this report* |
| Expired | This report has expired. | Go back to the page and choose Report a problem again. |

The result takes focus. *Try again* sends the same report again; *Email it instead* opens the person's own email
program with the same lines. In Firefox, while technical data isn't allowed, Send is **Email this report** from the
start; a correction whose words Firefox may not share says "Firefox is set not to share what you write from
unAlgorithm." with *Email it instead*.

## Onboarding copy anchors

| Step | Title | Notes |
|---|---|---|
| Welcome | "See the posts you came for." | Feed-cleaning illustration plays once; static with reduced motion |
| Strength | "How calm should your feed be?" | Three cards with mini feeds |
| Interests | "What do you want more or less of?" | One list of starter topics, each with English keywords so matching works without AI. Each topic is marked More, Less or neither; the first 10 show until "Show all topics". Settings → Interests has the same list |
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
