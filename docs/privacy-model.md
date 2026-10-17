# Privacy model

This is the engineering view of [PRIVACY.md](../PRIVACY.md): what data exists, where it goes and what enforces it.

## Principles

1. **Rules only means no network.** The extension's required host permissions are only linkedin.com and
   facebook.com. With AI off, the service worker makes no requests. The one request that doesn't depend on the AI
   source is unAlgorithm Cloud's source list, and only while UnEcho Chamber is on
   ([UnEcho Chamber's source lists](#unecho-chambers-source-lists)).
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
| `ref` | A batch-local id (`p1`, `p2`…) for every source, a server too, mapped back to the post on the device. Never the post URL, and never anything derived from the post's id: where a page shows no id, the id is a hash of the author's name and the text, so a hash of it would let a server test names |
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
| An unAlgorithm server you or your organization run | That server, then the AI provider its operator configured | The server's operator and the AI provider they configure |
| unAlgorithm Cloud | HeitechSoft's gateway in Canada, then Anthropic | HeitechSoft (nothing logged or stored; the canary test) and Anthropic, under its commercial API terms (zero retention only once that agreement is signed) |

For both kinds of unAlgorithm server, Facebook posts that aren't public are never sent: the background leaves them out
(`serverMayReceive`), and a server declines any that reach it without calling a model. The extension names each server
by its address; only `https://cloud.unalgorithm.app` is called unAlgorithm Cloud
(`apps/extension/src/lib/server-label.ts`).

### Fact-check

Fact-check (RM1) runs on the user's own Anthropic key (or on their unAlgorithm server, below), only when Settings → AI → Fact-check is on, and only
after the user confirms a check of one post. The background (`apps/extension/src/background/factcheck.ts`) checks
every gate again: Fact-check on, an `anthropic` source, the post parses with `PostForAISchema` (extra fields such as an
author name are dropped, the text is capped at 2,000 characters with the same masking as above), and
`serverMayReceive` passes, so a Facebook post that isn't public is never checked, on an own key too. Three calls go
directly from the browser to Anthropic:

1. Claims (Haiku): the post's text, platform, language and shared link's domain and title. No interests, no ref
   derived from the post.
2. Research (Sonnet with Anthropic's web search tool): only the claims picked in step 1. Anthropic runs the searches.
3. Verdicts (Sonnet, no tools): the claims, the retrieved snippets and the research notes.

The result is kept in session storage under `session:factcheck:<tabId>` (the 5 newest checks per tab), removed when
the tab closes, when the browser restarts and by "Erase everything". Usage goes to the local usage ledger with no post
counted. Nothing goes to HeitechSoft.

Own-key checks (Anthropic, OpenAI, OpenAI-compatible) use a per-device claim cache (P3-60,
`apps/extension/src/background/claim-cache.ts`) under P3-57's rules, for public posts only. It lives in the
`claimChecks` store of the extension's IndexedDB, which content scripts cannot open (ADR 0005). A row is `{ key, entry,
expiresAt }`: `key` is HMAC-SHA-256 of the normalized claim under `claim-cache-key`, 32 random bytes kept in `secrets`
(never synced or exported); `entry` is the verdict, the model's explanation (at most 280 characters, left out when it
echoes the post or any claim of the check), at least two public sources on independent domains (URL, host, title, a
short quote; none on Facebook or LinkedIn, none echoing the post; a title or quote echoing a claim is stored as '') and
the hour checked; `expiresAt` is that hour plus 24 hours. No claim text, post
text, post id, author or account id. "Echoing" is P3-57's rule: six consecutive words shared with the post text or its
link title, or with any claim the claims step produced (all of them when it has fewer), with Chinese, Japanese and Thai
text split into words. A later check whose
claims all hit sends only the claims call (step 1) and replays the kept verdicts and explanations, marked `cachedAt`; it
costs that call. Expired rows are deleted on the next write. "Clear cache" empties the store; "Erase everything" also
deletes the key. A `server` source never reads or writes it.

With a `server` source (P3-21), the check runs on the person's unAlgorithm server instead, and only when that server's
discovery document offers fact-check (`serverOfferFrom`, `sourceCapabilities(cfg, offer)`) on the source's own origin.
The same gates apply first (Fact-check on, the post parses with `PostForAISchema` at the server source's 2,000-character cap,
`serverMayReceive`), then `apps/extension/src/background/factcheck-server.ts` sends one `POST /v1/jobs/factcheck` with
`{ v: 1, post }` (the same fields classification sends, ref `p1`, no interests) and the device's bearer token, no
cookies, and long-polls the job. The server keeps the job in memory only (at most 10 minutes after it ends; a restart
loses it), never in Postgres or the job queue, and its usage row holds no post content. It may search the claims (not the
post) through its configured search provider. On a billing server the check holds at most the advertised maximum and
settles at most that; an early stop (`truncated`) is not charged. Closing the tab aborts the run and sends a
best-effort `POST …/cancel`, which ends the job and releases its hold. The server's error text is never shown: the
extension maps its codes to its own words. `local:serverOffer`, which content scripts may read, holds only the origin,
whether it bills, whether it offers fact-check and its price: no email, device id or token.

Sync carries settings only. Post text never enters a sync request, and the server refuses sync items that look like API
keys. Settings include the person's own UnEcho Chamber source list (`perspectives.outlets`, one sync item per outlet: its
name, web addresses and the lean the person gave it) and which list UnEcho Chamber uses (`perspectives.list`). These
leans are the person's own opinions: stored and synced like their interests and exceptions, never shared or published.

## UnEcho Chamber's source lists

UnEcho Chamber sorts coverage by the outlets on a source list, and a lean comes only from a list people set, never from
a model. Every extension reads unAlgorithm Cloud's published list, whatever its AI source:
`apps/extension/src/background/official-list.ts` makes the one request, and nothing else fetches a list.

- **When.** Only while Settings → AI → UnEcho Chamber is on as the switch shows it (`perspectivesSwitchOn`: the
  device-local `device.labs.perspectives` and an AI source that can compare). The flag stays stored when the source
  changes, but with AI off, on-device AI, an OpenAI-compatible source with no web search key, or a server that doesn't
  offer UnEcho Chamber, the switch shows off and nothing is asked. Checked at each service-worker start and whenever it
  comes on: the switch turned on, or, with the switch left on, a source that can compare chosen, a web search key added
  or the server's offer arriving. At most one request per 24 hours, counted from the last request whether it was
  answered or not: `checkedAt` is written before the request, so a crash, a failure or a second wake within the day
  never asks again, and requests are serialised (`createLock`), so two wakes at once make one. No retry sooner after a
  failure. E2E builds never make it: they use the fictional fixture.
- **The request.** `GET https://cloud.unalgorithm.app/outlets.json` (`CLOUD_ORIGIN` + `OUTLETS_JSON_PATH`), a fixed
  address with no query; never another server's list. Its options, and why:
  - `credentials: 'omit'`: no cookie. The Cloud's account page keeps a session cookie on the same host, and it stays
    off this request.
  - `referrerPolicy: 'no-referrer'`: no `Referer`.
  - `headers: { Accept: 'application/json' }` and no other header: never the device id, a token, the server account
    or anything from settings or the feeds.
  - `redirect: 'error'`: a redirect fails the request instead of taking it to another address.
  - `cache: 'no-cache'`: the browser revalidates its copy with the ETag the Cloud sent, so an unchanged list costs a
    304 and no body.
  - `signal: AbortSignal.timeout(15_000)`: 15 seconds at most.

  No host permission is needed: the endpoint answers `Access-Control-Allow-Origin: *`. Like any web request it comes
  from the person's IP address; the Cloud logs it as its standard request line, without the IP address, and a failed
  request can reach the web server's error log, kept 14 days ([CLOUD-BETA-NOTICE.md](../CLOUD-BETA-NOTICE.md) §3).
- **What is kept.** Only a 200 whose body, read up to 1 MB (`readBoundedText` stops reading past the cap), is JSON,
  passes `OfficialListSchema` (fields it doesn't know are dropped) and has no `listProblems`. Anything else (a network error,
  the timeout, any other status, a larger body, bad JSON, a schema or list-rule failure) keeps the last good copy. A
  valid list with no lean is a good copy and replaces the old one: it is what the Cloud publishes now. Nothing about the
  list or the answer is logged.
- **Where it lives.** `storage.local` `officialList` (`{ list, checkedAt }`), on this device only: never synced,
  exported or sent anywhere. It is public data, with nothing about the person but when UnEcho Chamber last asked.
  Content scripts can write `storage.local` (ADR 0005), so every reader takes the list through `storedOfficialList()`
  (`apps/extension/src/lib/outlets.ts`), which checks it against the schema and the list rules again (and answers the
  fixture in e2e builds).

### A comparison carries its list

A comparison runs on the list the person chose (`chosenList`: the Cloud's stored copy or their own), and only when that
list is ready (`listReady`: an outlet with a lean, no list problem; decision D103). Before anything is sent, the
background (`runPerspectivesForTab` in `apps/extension/src/background/factcheck.ts`) refuses a list that isn't, and
keeps the list's balance warnings (fixed words from code) on the tab's entry for the side panel.

- **Own key.** The pipeline runs in the browser on that list: each bucket's search sends the web addresses of that
  bucket's outlets with a lean to the provider (or to Brave or Tavily), never a lean, a name or the post.
- **Server.** `POST /v1/jobs/perspectives` carries `{ v: 1, link, platform, audience?, list }`, where `list` is
  `wireList(chosen)` (`PerspectivesListSchema`): `kind`, `version` and the outlets with a lean as `{ bucket, domains }`,
  sorted by id. No outlet name, id or evidence, and no outlet without a lean; at most 300 outlets and 400 web addresses,
  so the largest request stays under the server's 128 KB `/v1` body limit. The server
  (`apps/server/src/routes/perspectives.ts`) rebuilds a list from it (`sourceListFromWire`: outlets `o1`…`oN`, named by
  their first web address), refuses one with a list problem (a web address in two outlets, or inside another's) with a
  400 before anything is metered, and holds it only in the request handler and the in-memory job: no log line (the
  `perspectives.done` line is counts), no table, no usage row. No server needs a list of its own.
- **The answer.** The extension keeps a result only when every lean in it is the sent list's (`matchLeans`: each
  source's web address and page address map to one outlet of the list with that bucket, each coverage row holds only its
  own bucket's sources, and the result names the same list and version); it then shows the list's own outlet names and
  ids, never the server's.

The canary covers the field: every comparison in `apps/server/test/canary.test.ts` carries a list with one more outlet,
on a marked web address, and one more comparison sends that address in two outlets. The address may reach the search
provider and the done comparison's own answer; it must be in no log line, nothing written to standard output or standard
error, no error answer and no table, after the done, failed and refused comparisons.

## What a server stores

An unAlgorithm server, self-hosted or unAlgorithm Cloud, keeps what sign-in, limits and usage records need, and
nothing from the posts it classifies. Every table is listed in [ARCHITECTURE.md](ARCHITECTURE.md#database), except
those a billing module adds of its own ([What a billing module sees](#what-a-billing-module-sees)).

- **Accounts:** the email address, and no name or picture (`user`).
- **Admin role and removed access:** whether an account is an admin (`user.role`), and whether an admin removed its
  access (`user.banned`, with the reason `removed-by-admin`).
- **Invites:** the addresses an admin invited, and which admin (none for a setup link's invite), until the account is
  created, the invite removed, or the account with that address deleted (`signup_invites`). This is the address of
  someone who may never sign in; it is not used for anything else and no email is sent to it.
- **Setup links:** the hash of each one-time setup link and the address it was made for, when it was made, when it
  expires and when it was used (`setup_tokens`). A used link's row is kept until the account with that address is
  deleted; an unused one until a new link replaces it. The link itself travels in the URL fragment, which browsers never
  send to a server.
- **Devices:** one row per signed-in copy of the extension: its extension id, the short name the extension gave itself
  at sign-in (such as "Chrome on Windows", never read from request headers), when it signed in and was last used, and
  when and why it was signed out or revoked: signed out from the extension, a refresh token used twice, or revoked
  from the account page (`devices`).
- **Passkeys:** for each passkey the person added on the account page, its public key, its credential id, the
  authenticator model's id (AAGUID), its sign count, a label and when it was added (`passkey`). Never a private key or
  biometric data: they never leave the person's device.
- **Google sign-in** (only when the server's operator set it up): Google's id for the person's Google account and the
  verified address Google gave (`account`, `user`). No Google access, refresh or ID token is kept. A Google sign-in
  under way keeps its state (its PKCE verifier and the pages to return to) for ten minutes (`verification`).
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
- **Sign-in limits:** the server counts the codes sent to each email address and the wrong codes tried for it (at most
  5 codes an address an hour and 10 wrong codes an hour), with a SHA-256 hash of the lowercased address as the
  counter's key. The counts live in the server's memory only, never in the database or a log line, and go after an hour
  without a request for that address (or when the server restarts).
- **Sign-in page sessions:** signing in on the server's own page starts a session that records the browser's IP
  address and user agent (`session`). The session expires after one day, but expired rows are not purged
  automatically yet, so a row can stay until the account is deleted.
- **AI routes:** which provider and model serve classification, and their eval results (`ai_routes`). No user data.
- **Usage counts and costs:** one row per AI request with the account, the device, the time and the request id, and the
  number of posts, token counts, the model, the outcome and the cost (`usage_events`). Together the rows show when each
  device used AI; they stay until the account is deleted.
- **Per-user limits:** a daily post cap the server's admin set for an account with `user-cap` (`user_limits`).
- **Synced settings** (only when the person turns sync on in the extension; sync is off by default): the extension's
  settings, interests and exceptions, one item per field, each with its edit time (a hybrid logical clock), the seq the
  server gave it and the device that wrote it (`sync_items`, in the account's one space, `sync_spaces`, which holds the
  space's epoch, counts and cleanup floor). Exceptions hold the name and profile identifier the person chose to always
  show or hide. The person's own UnEcho Chamber source list is one item per outlet: its name, web addresses and the lean
  the person gave it, their own opinion, never shared or published. A deleted entry is kept as a marker without a value
  for 90 days, then removed. A record of each push (its keys and the server's answers, no values, never a refused key)
  is kept for 24 hours (`sync_pushes`). Never synced: API keys, endpoint tokens, refresh tokens, AI source settings,
  learned topics, votes, statistics or cached results ([Sync](ARCHITECTURE.md#sync)).
- **Shared claim cache:** for each claim checked in a public post on this server, one row: a keyed hash of the
  normalized claim (HMAC-SHA-256 under a key derived from the server's `BETTER_AUTH_SECRET`, never stored), the verdict,
  the model's explanation of it (at most 280 characters; left out when it repeats six or more consecutive words of the
  post text or its link title, the rule quotes and titles follow, or of any claim of the check, or all of a shorter
  claim; a quote or title repeating a claim is stored empty), up to 4 public source URLs with each one's title and a
  quote of 25 words at most, and when it was checked and when it expires, both to the hour (`claim_cache`). Never the
  claim, the post text, who checked it (no account, device or post id, and no exact time that would match a usage row),
  or a source on Facebook or LinkedIn. A row is served for 24 hours from its check and deleted by an hourly job after
  that. The cache is this server's own: it is filled only from checks of public posts made here, is never sent to
  another server, and a different server's key finds nothing in it; a new `BETTER_AUTH_SECRET` makes every row
  unreachable. A hit tells the next person on this server who checks the same claim that someone here checked that same
  public claim that day, never who.
- **Source list for UnEcho Chamber:** the server's published list of news outlets: each outlet's name, web addresses,
  country, lean bucket and the evidence for its lean (`outlets`), and every change to it, kept as long as the server
  runs: what changed, when, and which admin made the change (`outlet_changes`). Only the server's admins change the
  list. The history keeps the admin's account id for audits and appeals: the server's admins see that admin's address
  beside each change, it is never published, and it is cleared when that account is deleted, while the change itself
  stays. An account's export does not list its admin's changes: they are edits to a public list. No other user data.
- **Background jobs:** the hourly purge of expired sign-in rows above, the hourly purge of expired claim cache rows
  (`factcheck.purge-claim-cache`), the sync cleanup every 6 hours (`sync.gc`, which
  removes deletion markers after 90 days and push records after 24 hours), and any job a billing module registers
  ([ARCHITECTURE.md → Jobs](ARCHITECTURE.md#jobs)). graphile-worker's queue (schema `graphile_worker`) holds each job's
  task name, a payload of ids and numbers (a scheduled run adds the time it was due), when it runs and its attempts,
  and after a failure the error's name and code, never its message. A job's row is deleted once it succeeds; one that
  fails every attempt stays.
- **Open alerts:** for each alert open now, a fixed key, a level, when it opened, when it was last seen and last
  notified, and one measured number (`ops_alerts`); the row goes when the alert closes. No user data. The check runs
  every five minutes (`ops.check-alerts`).
- **The signing key** for access tokens, its private half encrypted with the server's secret (`jwks`).
- **Backups:** every night a copy of the whole database, encrypted to the operator's key (the server cannot read it),
  kept for `BACKUP_KEEP` nights (14 by default) in the backups folder, plus any copies the operator makes. A deleted
  account stays in backups until they age out. Status files beside them hold only the backup kind, whether it worked,
  times, the backup's file name and size, and an error code.
- **Export and deletion:** the account page downloads everything above about the account as JSON: the address, its
  devices, passkeys (label, kind and when added; never the public key or credential id), linked sign-in methods, page
  sessions, daily usage counts and synced settings, with no token, hash or code. Deleting the account removes all of it
  at once, in one transaction, and signs out every device. A billing module's own records (on unAlgorithm Cloud, the
  credit ledger and the keyed starter-credit hash) follow that module's deletion policy, not this cascade
  ([What a billing module sees](#what-a-billing-module-sees)). On unAlgorithm Cloud, the module puts the account's
  credit ledger in the download and erases the account's promotional credit records with the account, keeping only the
  keyed starter-credit hash, which no longer names the account.

Never stored or logged: post text, link titles, interest profiles, classification results, prompts or model answers.
A classify request is handled in memory and answered with `Cache-Control: no-store`.

The server logs one JSON line per event (`apps/server/src/log.ts`). Each request's `http` line carries its request id,
method, path, status and timing (`requestLog`). Other lines name an event and a few facts about it, among them:

- `auth.*`: the request id and the device id when a device signs in, refreshes its token (as often as every 15 minutes
  while it is in use), replays a refresh whose answer was lost, is signed out, or reuses a refresh token. These lines
  show roughly when each device was in use. `auth.purged` holds only how many expired rows the hourly purge deleted.
- `classify.done`: the request id, the number of posts asked for, answered and declined (Facebook posts that aren't
  public), the model, the outcome and the time taken.
- `sync.*`: the request id and how many items a push applied, found stale, refused or replayed (`sync.push`), why a
  device must resync (`sync.resync`) and a space over its quota (`sync.quota`); `sync.gc` holds only counts. Never a
  key or a value.
- `account.*`: the request id when an account is exported or deleted, and the device id when a device is revoked from
  the account page.
- `limits.spend_breaker`: the day's AI spend and the limit, once per UTC day, when the daily spend limit
  (`DAILY_SPEND_LIMIT_USD`) stops classification for everyone.
- `admin.*`: the request id, the admin's and the account's ids, and a cap or a role, when an admin sets a cap, removes
  or restores access, sets a role, or adds or removes an invite, and when a setup link is claimed. Never an address.
- `setup.*`: fixed reason codes, when a setup link is refused (`setup.refused`) and, at start, that the server has no
  admin yet (`setup.needed`).
- `alert.*`: an alert's key, level and measured number when it opens, how long it was open when it closes, and a
  delivery that failed (the webhook's status code, or an error's name and code).
- `backup.*` and `restore.*`, from the backup service's scripts: file names, sizes, times and, after a restore, the row
  count of each table.
- `ops.database_size_failed`: an error's name and code when the database's size cannot be read.
- Failures: an error's name, code and top stack frames, with the request id when there is one, never its message.

No line carries a request body, a query string, an IP address or an email address. A web server or proxy in front of a
server keeps logs of its own, under its operator's settings. On unAlgorithm Cloud its access log holds no IP addresses
or query strings, and its error log can record the IP address and requested address of a request that fails.

**Alerts and metrics** carry server-wide numbers, fixed alert keys and levels, and the server's name and address, never
an account, an address or a post. Alert emails go to the server's admins, or to the addresses in `ALERT_EMAIL`, and to
`ALERT_WEBHOOK_URL` when it is set; `/metrics` answers only with `METRICS_TOKEN`, and does not exist without it.
**Optional profiles:** the Caddy profile keeps no access log, and its own lines carry no client address, request
address or header; with the Ollama profile, posts are classified on the same machine and go nowhere else.

The canary test (`apps/server/test/canary.test.ts`) proves the rule for the server's own code. It puts a marker in
post text, link titles and the interest profile (and a marked web address in the source list each comparison carries,
[above](#a-comparison-carries-its-list)), and sends it down every classify path: a success, provider errors
that echo it back, invalid and unauthenticated requests, and a Facebook post that isn't public. The marker must then be
in no log line, nothing the process wrote to standard output or standard error, no error answer and no row of any
table. The test also checks that the marker did reach the mock model, and never from the non-public post. It runs on
PGlite in every `pnpm test` and on Postgres 17 in the CI `server` job.

## What a billing module sees

A server started with `BILLING=module` loads a billing module into its own process
([ARCHITECTURE.md → Billing seam](ARCHITECTURE.md#billing-seam)). unAlgorithm Cloud runs HeitechSoft's module. A
self-hosted server with `BILLING=off`, the default, loads none and keeps no ledger.

What the seam passes to a module:

- **The account:** its id, its email address, whether that address is verified, and when the account was created.
- **Each AI request:** the account, device and request ids and the time the server checked it; after the call, the
  model, the token usage, the cost and the number of posts counted. The module keeps its own ledger of amounts from
  these, in tables of its own.
- **Export and deletion:** the account's id when the person downloads their data, for the module's own records in the
  download, and before the account is deleted, so the module applies its deletion policy (`exportAccount`,
  `deleteAccount`). A module that implements neither keeps its records after the account is deleted.
- **The server's AI cost per day:** for each UTC day and model, the summed cost and the number of requests, with no
  account or request id, so the module can compare it with the AI vendor's bill.

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
the issue before submitting it.

A finished fact-check or UnEcho Chamber result in the side panel links the correction form (P3-69, decisions D88,
D107): `correctionUrl` sets `template=correction.yml` and four fields only, `feature` (the feature's name), `version`
(the extension's), `prompt` (the result's prompt version) and, for UnEcho Chamber, `list` ("unAlgorithm Cloud's list"
or "My own list"). No date, verdict, claim, source, link, list content or anything from the post or about the person.
The other links under a result are fixed: the methodology page on the website and unAlgorithm Cloud's public source
list (a Cloud result only).

`content/report.ts` and `lib/report-links.ts` are the only places that build a GitHub issue URL.

## Untrusted input

Post text is untrusted. Before it reaches a model it is fenced in `<post_NONCE …>` tags with a per-request random
nonce, attribute values are escaped, and the system prompt tells the model to treat post content as data. Model
output must match a strict schema; anything else is discarded.
