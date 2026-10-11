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
