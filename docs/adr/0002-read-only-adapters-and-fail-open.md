# ADR 0002: Read-only platform adapters, evidence strength and fail-open

- Status: Accepted
- Date: 2026-10-10

## Context

Feed markup changes often and Facebook obfuscates labels such as "Sponsored". Hiding a post someone wanted is worse
than letting an ad through: it silently breaks trust. Platforms also forbid automation, and some detect extensions.

## Decision

- Each platform implements `PlatformAdapter` and only **reads** the page. `checkAdapterContract()` fails a test if
  `inspect()` mutates the DOM, clicks or focuses. "See more" is never clicked.
- Every signal carries **evidence** (detector id + strong / medium / weak). Facebook hides as sponsored only on one
  strong, two medium, or one medium plus one weak; weak evidence never hides on its own.
- Relationship is `followed`, `not-followed` or `unknown`; **unknown never hides**.
- Unsupported UI languages switch text detectors off (`markersFor()` returns `null`).
- A **health monitor** over a rolling window stops all hiding on the page and shows a banner when detection looks
  wrong (too much hidden for the strength, authors unreadable, no feed found).
- No `web_accessible_resources`, CSS inlined into shadow roots, no remote code.

## Consequences

- Some noise gets through on new layouts until the adapter is fixed; users see a banner instead of a broken feed.
- "Why?" and the Report a problem diagnostics come for free from evidence ids.
- Facebook's not-followed rule stays off by default until verified on live captures (`FACEBOOK_NOT_FOLLOWED_VERIFIED`).

## Amendment (2026-10-18)

[ADR 0009](0009-problem-reports-and-resilient-detection.md) changes two consequences above and widens the health
monitor; the decision stands (adapters only read, evidence strength, unknown never hides, fail open).

- **Diagnostics go to unAlgorithm Cloud through the report page,** no longer to a prefilled GitHub issue. *Report a
  problem*, *Why? → Wrong call?* and the other entry points open the extension's report page, which shows every field
  and sends the report only on its **Send report** click. Evidence ids still make the report: the detectors that
  matched, and for *Wrong call?* the post's evidence with its strengths.
- **The health monitor also covers under-detection and page recognition,** not only over-detection: ad labels that
  almost match (`ad-label-near-miss`), a feed on an address the adapter doesn't recognise (`feed-not-started`, from a
  read-only watchdog, and `route-new`), adapter exceptions (`adapter-error`, counted by `safe()` in the controller, which
  fails open), and report-only checks such as `no-ads-seen`. Time limits count visible time only.
- **The banner is the in-feed notice card.** On positive evidence only, a card in our own shadow-root layer, never in
  the platform's feed list, says filtering is paused, isn't running, or that ads may be getting through, and offers
  *Let us know*. Absence-based issues (`no-feed`, `no-items`, `no-ads-seen`) never raise it; the popup, side panel and
  toolbar title still show them.
- A near-miss ad label is *medium* evidence: with the weak "no post age" or `no-timestamp` evidence it still hides as an
  ad, as the combination rule above allows, and the change is reported.
