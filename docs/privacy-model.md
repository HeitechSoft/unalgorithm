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
| `audience` | Facebook only: who can see the post; servers never receive non-public posts, and refuse them if sent |

It never includes author names, profile links, group names, comments, images, the user's identity or browsing
history. Web addresses inside the text are reduced to `[link: site]`.

Each request also carries the user's `InterestProfile` (`core/classify/profile.ts`) so the model can judge relevance:
up to 20 topics wanted and 20 not wanted, the optional "About you" note (500 characters), and, when "Learn from More
like this and Not for me" is on, AI-written summaries (240 characters) of up to 4 rated posts with the rating. The
summaries come from earlier model output, so they are fenced like posts. Each rating records whether a server may
receive its post (`serverMayReceive`); a server's profile leaves out summaries of Facebook posts that aren't public,
and of ratings recorded before that mark existed (R23).

The content script builds `PostForAI` with `toPostForAI()`; the background parses it again with `PostForAISchema`,
which drops any field not listed above, and applies the per-source length cap.

A unit test in `apps/extension/tests` asserts that the AI request body built from a fixture contains no author names,
and the E2E AI test checks the body received by the mock server.

## Where post text goes

| Source | Destination | Who sees it |
|---|---|---|
| Rules only | — | — |
| On this device | Chrome's built-in model, in process | Nobody |
| Local or self-hosted model (OpenAI-compatible) | The URL the user entered (an optional host permission granted for that origin only) | The server's operator |
| Own key | The provider's API, directly from the browser | The provider, under their terms. OpenAI calls send `store: false` |
| An UnAlgorithm server you or your organization run | That server, then the AI provider its operator configured | The server's operator and the AI provider they configure |
| UnAlgorithm Cloud | HeitechSoft's gateway in Canada, then Anthropic | HeitechSoft (nothing logged or stored; the canary test) and Anthropic, under its commercial API terms (zero retention only once that agreement is signed) |

For both kinds of UnAlgorithm server, Facebook posts that aren't public are never sent: the background leaves them out
(`serverMayReceive`), and a server declines any that reach it without calling a model. The extension names each server
by its address; only `https://cloud.unalgorithm.app` is called UnAlgorithm Cloud
(`apps/extension/src/lib/server-label.ts`).

## What a server stores

An UnAlgorithm server, self-hosted or UnAlgorithm Cloud, keeps what sign-in, limits and usage records need, and
nothing from the posts it classifies. Every table is listed in [ARCHITECTURE.md](ARCHITECTURE.md#database), except
those a billing module adds of its own ([What a billing module sees](#what-a-billing-module-sees)).

- **Accounts:** the email address, and no name or picture (`user`).
- **Devices:** one row per signed-in copy of the extension: its extension id, the short name the extension gave itself
  at sign-in (such as "Chrome on Windows", never read from request headers), when it signed in and was last used, and
  whether it was signed out or revoked (`devices`).
- **Hashed refresh tokens and codes:** refresh tokens and the single-use codes the extension trades for them are kept
  by hash only (`refresh_tokens`, `auth_codes`). Each refresh adds a row with its time, so the rows show when each
  device refreshed, as often as every 15 minutes while it is in use. A spent token is kept until its own 60-day expiry,
  so that a copy coming back is still caught: there is always a rolling 60-day record of each device's refreshes. An
  hourly job deletes refresh tokens once they expire and the extension's codes once past their minute. An emailed
  sign-in code is kept by hash under the address it was asked for (`verification`), whether or not that address may
  sign in. A code works for five minutes, and each new code adds a row. Trying a code deletes every row for that
  address; a wrong code puts the newest one back to count the attempt. The same hourly job deletes the rows of codes
  past their five minutes (and of Google sign-ins and passkey challenges past theirs), so none stays more than about an
  hour after it expires.
- **Sign-in limits:** the server counts the codes sent to each email address and the wrong codes tried for it, with
  a hash of the address as the counter's key. The counts live in the server's memory only, never in the database or a log line,
  and go after an hour without a request for that address (or when the server restarts).
- **Sign-in page sessions:** signing in on the server's own page starts a session that records the browser's IP
  address and user agent (`session`). The session expires after one day, but expired rows are not purged
  automatically yet, so a row can stay until the account is deleted.
- **AI routes:** which provider and model serve classification, and their eval results (`ai_routes`). No user data.
- **Usage counts and costs:** one row per AI request with the account, the device, the time and the request id, and the
  number of posts, token counts, the model, the outcome and the cost (`usage_events`). Together the rows show when each
  device used AI; they stay until the account is deleted.
- **Per-user limits:** a daily post cap the server's admin set for an account with `user-cap` (`user_limits`).
- **Background jobs:** the hourly purge of expired sign-in rows above, and any job a billing module registers
  ([ARCHITECTURE.md → Jobs](ARCHITECTURE.md#jobs)). graphile-worker's queue (schema `graphile_worker`) holds each job's
  task name, a payload of ids and numbers (a scheduled run adds the time it was due), when it runs and its attempts,
  and after a failure the error's name and code, never its message. A job's row is deleted once it succeeds; one that
  fails every attempt stays.
- **The signing key** for access tokens, its private half encrypted with the server's secret (`jwks`).

Never stored or logged: post text, link titles, interest profiles, classification results, prompts or model answers.
A classify request is handled in memory and answered with `Cache-Control: no-store`.

The server logs one JSON line per event (`apps/server/src/log.ts`). Each request's `http` line carries its request id,
method, path, status and timing (`requestLog`). Other lines name an event and a few facts about it, among them:

- `auth.*`: the request id and the device id when a device signs in, refreshes its token (as often as every 15 minutes
  while it is in use), replays a refresh whose answer was lost, is signed out, or reuses a refresh token. These lines
  show roughly when each device was in use. `auth.purged` holds only how many expired rows the hourly purge deleted.
- `classify.done`: the request id, the number of posts asked for, answered and declined (Facebook posts that aren't
  public), the model, the outcome and the time taken.
- `limits.spend_breaker`: the day's AI spend and the limit, once per UTC day, when the daily spend limit
  (`DAILY_SPEND_LIMIT_USD`) stops classification for everyone.
- Failures: an error's name, code and top stack frames, with the request id when there is one, never its message.

No line carries a request body, a query string, an IP address or an email address. A web server or proxy in front of a
server keeps logs of its own, under its operator's settings. On UnAlgorithm Cloud its access log holds no IP addresses
or query strings, and its error log can record the IP address and requested address of a request that fails.

The canary test (`apps/server/test/canary.test.ts`) proves the rule for the server's own code. It puts a marker in
post text, link titles and the interest profile, and sends it down every classify path: a success, provider errors
that echo it back, invalid and unauthenticated requests, and a Facebook post that isn't public. The marker must then be
in no log line, nothing the process wrote to standard output or standard error, no error answer and no row of any
table. The test also checks that the marker did reach the mock model, and never from the non-public post. It runs on
PGlite in every `pnpm test` and on Postgres 17 in the CI `server` job.

## What a billing module sees

A server started with `BILLING=module` loads a billing module into its own process
([ARCHITECTURE.md → Billing seam](ARCHITECTURE.md#billing-seam)). UnAlgorithm Cloud runs HeitechSoft's module. A
self-hosted server with `BILLING=off`, the default, loads none and keeps no ledger.

What the seam passes to a module:

- **The account:** its id, its email address, whether that address is verified, and when the account was created.
- **Each AI request:** the account, device and request ids; after the call, the model, the token usage, the cost and
  the number of posts counted. The module keeps its own ledger of amounts from these, in tables of its own.

A module's own routes (`mount`), such as the balance route the extension reads, receive each request like any route of
the server, the client's IP address and headers included. The module also runs inside the server process with the
server's database access, so what it reads beyond the seam is limited by review of the module, not by the seam.

Never post text, prompts, interests or author data: the server neither stores nor passes them, so they are neither in
what the seam passes nor in any server table a module could read.

The extension reads the balance from `GET /v1/billing/balance` with the access token it already sends to that server,
and sends nothing else. That is why PRIVACY.md does not change with credits: the balance request carries no data from
the browser beyond the token the extension already sends. The answer is kept in session memory only
([Storage](#storage)).

## Storage

See the storage table in [ARCHITECTURE.md](ARCHITECTURE.md#storage). API keys, and the refresh token of the server
the user signed in to, live in the extension origin's IndexedDB (`secrets`); the server's 15-minute access token lives
only in session memory. Content scripts run in the page's origin and cannot open either; they also never receive keys
or tokens through messages. Keys and tokens are never synced, exported or included in diagnostics. "Erase everything"
in Privacy & Data clears settings, statistics, votes, the classification cache and keys. When the user is signed in to
a server, it first signs this browser out of that server, which ends its device and refresh token there, and then
removes the account from the extension.

## Diagnostics

"Report a problem" builds a GitHub issue URL with at most 2 KB of JSON: versions, Chrome major version, page
language, health status, counts, detector hit counts and landmark counts. No text, names, ids or URLs. The user sees
the issue before submitting it. `content/report.ts` is the only place that builds it.

## Untrusted input

Post text is untrusted. Before it reaches a model it is fenced in `<post_NONCE …>` tags with a per-request random
nonce, attribute values are escaped, and the system prompt tells the model to treat post content as data. Model
output must match a strict schema; anything else is discarded.
