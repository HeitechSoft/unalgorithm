# Privacy model

This is the engineering view of [PRIVACY.md](../PRIVACY.md): what data exists, where it goes and what enforces it.

## Principles

1. **Rules only means no network.** The extension's required host permissions are only linkedin.com and
   facebook.com. With AI off, the service worker makes no requests.
2. **Only `PostForAI` leaves the device**, and only to the AI source the user chose.
3. **Nothing identifying is reported, and little is kept.** Caches, statistics, diagnostics and logs hold no post
   text and no names. Names are stored only where the user asked for them (always show/hide exceptions) and in the
   memory-only session state behind the current tab's Highlights (author, short snippet, link), which is dropped when
   the tab closes.
4. **Keys stay where pages can't reach them.**

## What leaves the device when AI is on

`PostForAISchema` in `packages/protocol/src/classify.ts` is the whole payload per post:

| Field | Notes |
|---|---|
| `ref` | A batch-local id (`p1`, `p2`…) for sources the browser calls directly; `pk_<sha256>` of the post id for a server. Never the post URL |
| `platform`, `lang` | |
| `text` | Normalized, NFKC, control/zero-width/bidi characters stripped, emails and phone numbers masked, @handles and tagged names (`PostData.mentions`, read from profile links inside the post text) masked unless the user turns that off (`core/classify/input.ts`), at most 2,000 characters (1,200 on-device, marked incomplete when cut) |
| `textComplete` | Whether the site cut the text off behind "See more" |
| `authorKind` | Person, page, group or unknown; never the name |
| `isReshare` | Whether the post shares another post |
| `media` | The kind of media only (image, video, document, link…) |
| `link` | Domain and title of a shared link, never the URL |

It never includes author names, profile links, group names, comments, images, the user's identity or browsing
history. Web addresses inside the text are reduced to `[link: site]`.

Each request also carries the user's `InterestProfile` (`core/classify/profile.ts`) so the model can judge relevance:
up to 20 topics wanted and 20 not wanted, the optional "About you" note (500 characters), and, when "Learn from More
like this and Not for me" is on, AI-written summaries (240 characters) of up to 4 rated posts with the rating. The
summaries come from earlier model output, so they are fenced like posts.

The content script builds `PostForAI` with `toPostForAI()`; the background parses it again with `PostForAISchema`,
which drops any field not listed above, and applies the per-source length cap.

A unit test in `apps/extension/tests` asserts that the AI request body built from a fixture contains no author names,
and the E2E AI test checks the body received by the mock server.

## Where post text goes

| Source | Destination | Who sees it |
|---|---|---|
| Rules only | — | — |
| On this device | Chrome's built-in model, in process | Nobody |
| Local / self-hosted | The URL the user entered (an optional host permission granted for that origin only) | The server's operator |
| Own key | The provider's API, directly from the browser | The provider, under their terms. OpenAI calls send `store: false` |
| UnAlgorithm Cloud (Phase 2) | HeitechSoft's gateway | HeitechSoft (zero retention, no request bodies logged); Facebook posts that are not public are excluded by default |

## Storage

See the storage table in [ARCHITECTURE.md](ARCHITECTURE.md#storage). API keys live in the extension origin's
IndexedDB (`secrets`). Content scripts run in the page's origin and cannot open it; they also never receive keys
through messages. Keys are never synced, exported or included in diagnostics. "Erase everything" in Privacy & Data
clears settings, statistics, votes, the classification cache and keys.

## Diagnostics

"Report a problem" builds a GitHub issue URL with at most 2 KB of JSON: versions, Chrome major version, page
language, health status, counts, detector hit counts and landmark counts. No text, names, ids or URLs. The user sees
the issue before submitting it. `content/report.ts` is the only place that builds it.

## Untrusted input

Post text is untrusted. Before it reaches a model it is fenced in `<post_NONCE …>` tags with a per-request random
nonce, attribute values are escaped, and the system prompt tells the model to treat post content as data. Model
output must match a strict schema; anything else is discarded.
