# Architecture

unAlgorithm Feed (unAlgorithm for short) is a Manifest V3 browser extension built with [WXT](https://wxt.dev) and
React, organized as a pnpm workspace. Everything platform-specific lives behind one adapter interface; everything that
does not need the browser is plain TypeScript, so the unAlgorithm server (`apps/server`) reuses it.

```
apps/extension ──► packages/platforms ──► packages/core ──► packages/protocol
       │                                        ▲
       ├──────────► packages/ai ────────────────┤
       ├──────────► packages/sync ──────────────┘   (and packages/ai/presets)
       └──────────► packages/ui (React components, tokens, in-feed parts)

apps/server ─────► packages/ai, packages/core, packages/protocol, packages/sync   (never ui, platforms or wxt)
apps/web ────────► packages/ui, packages/core, packages/protocol, packages/outlets   (the server's own pages)
```

| Package | Responsibility | Rules |
|---|---|---|
| `protocol` | Wire contracts (zod): ids, `PostForAI`, classify request/response, AI error codes, usage and model price cards, the dated credit price schedule, hybrid logical clock, server discovery and sign-in, the problem report and its code registry (`report.ts`, `report-codes.ts`) | zod only; additive changes only. The server imports the same files |
| `core` | Post model, rules and `decide()`, presets, settings schema/defaults/migration/clocks, the classification prompt and fence, cache policy, health evaluation and notices, the problem report helpers (`describeReport`, `cleanReportMessage`, `summarizePostForReport`, `routeWord`) | No `chrome.*`, no DOM |
| `platforms` | `PlatformAdapter` contract and the LinkedIn and Facebook adapters, per-locale markers, anonymized fixtures, `checkAdapterContract` | DOM reads only; never mutate, click, scroll or focus |
| `ai` | Vendor clients (Anthropic, OpenAI Responses, OpenAI-compatible, the built-in AI of Chrome and Edge), strict JSON schema helper, `classifyPosts` orchestrator, key detection, provider presets | No `chrome.*` except the `chrome-builtin` subpath |
| `sync` | Collection registry, merge strategies, settings items and merge; imported by the server and the extension | Only `protocol`, `core`, zod and the SDK-free `@unalgorithm/ai/presets`; no `chrome.*`, DOM or Node |
| `ui` | Design tokens, accessible components, in-feed parts (stub, run, Why? popover, For you row, toasts) | No `chrome.*`; services come in as props |
| `apps/extension` | Entrypoints, the feed controller, background services, storage, messaging, E2E | The only place that talks to the browser |
| `apps/server` | The open-source unAlgorithm server: email-code sign-in, PKCE sign-in for the extension, the `/v1/classify` gateway, usage records, limits, the billing seam and, where it is on, problem reports ([Server](#server)) | Imports `protocol`, `core`, `ai` and `sync`; never `ui`, `platforms` or `wxt`. Logs no request body |
| `apps/web` | The sign-in and account pages the server serves on its own origin (`/`, `/authorize` and `/account`), its admin pages (`/admin`, `/admin/sources`, `/admin/prices`, `/admin/reports`), and its public source list (`/outlets`, read from `/outlets.json`), built by Vite into `apps/web/dist` | Imports `protocol`, `ui`, `core`'s wording helpers and `outlets`' balance rule; never `platforms` or `wxt` |

Boundaries are enforced with Biome `noRestrictedImports` per folder and per-package `tsconfig` settings. Packages
are consumed as TypeScript source (`exports` points at `src/index.ts`); there is no separate build step for them.

## Extension entrypoints

| Entrypoint | Job |
|---|---|
| `background.ts` | Typed message router (exhaustive handler map, sender validation), AI classification, IndexedDB (secrets, cache), per-tab state and badge, settings actions with undo, install flow (opens onboarding; in Chrome and Edge injects into already-open feed tabs, which Firefox does itself) |
| `linkedin.content`, `facebook.content` | Class the page's address and boot the feed controller with that platform's adapter, or the read-only watchdog on a page that may be a moved feed (`content/bootstrap.ts`, [How a feed item flows](#how-a-feed-item-flows)) |
| `popup` | The toolbar "Control Center": on/pause, hidden count, reason chips, Strength, For you, Peek, banners when filtering is paused or isn't running, Report a problem |
| `report` | The report page (`report.html`, ADR 0009): opened in a tab next to the feed from the popup, the in-feed notice card, *Why? → Wrong call?*, Settings or the side panel's *Report a wrong verdict* / *Report a mistake*. It shows the person's choices, what will be sent in plain lines and the exact JSON, and only its **Send report** click sends anything ([Problem reports](#problem-reports)) |
| `sidepanel` | Highlights: For you and Hidden lists, with scroll-to and Show. Chrome's and Edge's side panel; Firefox's sidebar (`sidebar_action`, opened from the popup or Alt+Shift+U) |
| `options` | Settings, macOS System Settings style: LinkedIn, Facebook, Display, Interests, AI, Privacy & Data, About |
| `onboarding` | Welcome → Strength → Interests → AI (optional) → Done |

## How a feed item flows

0. **Recognise the page.** The adapter classes the address (`classifyRoute`): `feed`, `feed-candidate` (an address
   the feed may have moved to, such as LinkedIn's `/feed/<word>/` or Facebook's `/home`) or `not-feed`. On `feed` the
   controller starts. On a candidate it starts only when the page carries a strong home signature (`homeSignature`),
   and notes the report-only issue `route-new`, so a moved feed keeps working until a release learns the address.
   Otherwise a read-only watchdog (`content/watchdog.ts`) probes at 5 and 12 seconds of visible time; when the page
   looks like a feed, it raises `feed-not-started` and shows the notice card, and nothing is hidden or sent to AI.
1. **Find.** The controller observes only the adapter's `feedScope`. New items are read as they appear, in page
   order; items that change before they settle are re-read in debounced passes capped at 8 ms.
2. **Read.** `adapter.inspect(el)` returns a normalized `PostData` (or a module, `pending` for skeleton cards and
   emptied virtualised slots, or `ignore`). It never changes the page. Each signal (sponsored, suggested, network
   activity, reshare, unjoined group, reel) comes with `evidence`: detector ids and a strength, used by "Why?" and
   diagnostics. Ad labels are read only in label positions (an age slot, a header line, the actor, a header button), and
   a near miss ("Promoted • Brand content") is medium evidence that also tells the health monitor. Every adapter call
   (`feedScope`, `findItems`, `itemRootOf`, `inspect`, `probe`) runs inside `safe()`, which counts a throw per operation
   (never its message) and fails open: a failed `inspect` is `ignore`, a failed `findItems` keeps the last items.
3. **Settle.** An item is re-read while LinkedIn/Facebook are still filling it in, then settles and is not read again
   unless the user expands it ("See more").
4. **Decide.** `decide()` in `core` combines, in order: the user's own vote on that post, rules (`ruleFilter`:
   always-hide → sponsored → always-show → suggested → network activity → reshare → unjoined group → reel →
   not-followed, which only fires on an explicit `not-followed`), muted words and "less of" topics, then AI verdicts
   when available. Unknown or weak evidence never hides a post.
5. **Show.** Only items that need UI get it: hidden items become a one-line stub (or a merged run: "3 hidden · Show
   all"), dimmed and revealed items get a bar, highlighted items get a "For you" row. One React root renders every
   item through portals into small shadow roots that adopt one constructed stylesheet (in Firefox each gets a
   `<style>` element instead, ADR 0008). Ordinary posts are untouched.
6. **Classify (optional).** Rule-passing posts near the viewport are batched (2–6 per request, by source) and sent to the
   background, which checks the IndexedDB cache, then calls the chosen AI source. A verdict for a post that is on
   screen waits until it scrolls away, so posts never vanish while you read them.

The controller also re-arms infinite scroll when collapsed posts stall loading, and runs the **health monitor** every 10
seconds of visible time (`evaluateHealth` in `core`, ADR 0002 and 0009): if too much would be hidden for the chosen
strength, authors cannot be read, adapter calls keep failing, or no feed appears on a signed-in page, it stops hiding on
that page (fail open). It also watches for detection that has quietly stopped working: ad labels that nearly match,
no ads over many posts, header lines it doesn't recognise. The toolbar icon and the popup always say what it found.
When the finding is positive evidence (`feed-not-started`, `adapter-error`, `over-filtering`, `module-overmatch`,
`text-detection`, `ad-label-near-miss`) held over two checks, an **in-feed notice card** in our own shadow-root layer
says so in plain words, with **Let us know**, which opens the report page, and **Not now**, which snoozes it (a day;
a week after a report; `device.notices`). Absence alone (no feed, no items, no ads seen) never raises the card.

## Storage

| Where | What | Synced in Phase 2 |
|---|---|---|
| `storage.local` `settings` | Preset, display, per-platform filters and exceptions, interests, AI behaviour | Yes, per field |
| `storage.local` `settingsClocks` | A hybrid logical clock per changed settings path, stamped by `updateSettings()` | Used for merging |
| `storage.local` `device` | AI source config (no keys), onboarding state, dev flags, the notice card's switch and snoozes (`notices`) | Never |
| `storage.local` `learned`, `votes`, `usage`, `stats` | Topic weights, recent votes, AI usage (30 days), daily counts | Learned/votes later; usage never |
| `storage.session` `tab:<id>` | Live per-tab state for the popup and side panel: counts, health, and for each hidden or highlighted post its author, a short snippet and its link. Memory only; cleared when the tab closes or on Erase everything | Never |
| `storage.local` `serverAccount` | The unAlgorithm server the user signed in to: its origin and discovery answer, the email address, the device id, when it signed in, and whether it needs a new sign-in. No tokens. Removed on sign-out and on Erase everything | Never |
| `storage.session` `serverAccess` | That server's 15-minute access token. Memory only, closed to content scripts | Never |
| `storage.session` `serverBalance` | The signed-in account's latest credit balance, from a classify answer, a 402 or the balance endpoint, with the server's origin and the device id it belongs to. Only for a server that advertises billing. Memory only, closed to content scripts, cleared on Erase everything | Never |
| `storage.session` `report:<id>` | A problem report's draft while its report page is open: codes, counts and versions, and the person's choices and words once they send. An hour at most, 5 at most; cleared when the page closes and on Erase everything | Never |
| `storage.local` `reportLog` | When reports were sent from this browser, as timestamps only, for the local limit (3 an hour, 10 a day); never sent, cleared on Erase everything | Never |
| `storage.local` `officialList` | unAlgorithm Cloud's published source list (outlets, web addresses, leans, evidence) and when it was last asked for | Never |
| IndexedDB `secrets` | API keys, and the server's refresh token under `server-refresh:<origin>` | **Never**; not exported, not in diagnostics |
| IndexedDB `classifications` | Cached verdicts keyed by post + input hash + profile hash + source:model + prompt version; no text, no names | Never |

Settings use loose zod objects so fields written by a newer version survive an older one. Migrations fill defaults,
repair broken sections and upgrade values from older versions: version 2 gives Facebook's Balanced the not-followed rule
(Custom and changed filters stay as they were). Synced items carry no version, and a device still on version 1 reads
Balanced its own way, so sync keeps that filter explicit (`packages/core/src/settings/migrate.ts`): the first write
after the upgrade stamps it, with a clock right after the choice it belongs to, so it is sent once and any later edit
wins (`upgradeClocks`, stored by the background when it starts); an edit that changes Facebook's strength sends it too
(`editPaths`); and a merge of items from other devices reads a strength set no earlier than the filter as this version
does (`upgradeMerged`, in `applyRemoteItems`), without a clock, so nothing echoes and devices never trade the value.

## Messaging

`lib/messages.ts` defines `BgRequest` and `BgResponses`. The background's handler map is typed so a missing handler is
a compile error. Every handler checks the sender: feed messages only from LinkedIn/Facebook tabs, in-feed actions
from those tabs or extension pages, privileged ones (keys, AI setup and status, model lists, data deletion) only from
extension pages. Content scripts never see API keys or build prompts; the background re-validates each post against
`PostForAISchema` before it is sent to a model.

## AI

See [ai-sources.md](ai-sources.md). In short: one strict JSON schema is sent through four transports (Anthropic
structured output, OpenAI Responses `json_schema`, OpenAI-compatible with a learned step-down ladder, the built-in
AI's `responseConstraint` in Chrome and Edge). Posts are fenced with a per-request nonce after control/bidi characters
are stripped and entities escaped. Refusals bisect the batch so only the offending post fails; ids the model skipped
are retried once; usage is recorded even when a call fails.

## Server

`apps/server` is the open-source unAlgorithm server: Hono with zod-openapi, Postgres 17 through Drizzle, and Better
Auth for email codes. `apps/web` holds the sign-in and account pages it serves on its own origin. unAlgorithm Cloud
runs this same server; HeitechSoft's private repository adds only a billing module and its own operations
configuration (ADR 0007).
One image holds both apps (`apps/server/Dockerfile`). It is not released from here: unAlgorithm Cloud's private
repository builds it from a pinned commit ([release.md](release.md#the-server)). What a server keeps is in
[privacy-model.md](privacy-model.md#what-a-server-stores).

### Sign-in

1. The extension reads `/.well-known/unalgorithm.json`: the server's name, version, source link and capabilities,
   and `auth.clients`, the kinds of extension it takes sign-ins from (`chromium`, `gecko`; missing means Chrome and
   Edge only). If its own kind isn't there, it says the server doesn't accept sign-ins from this browser yet and stops.
2. The background opens `/authorize` in `identity.launchWebAuthFlow` with a PKCE challenge and the redirect address of
   its own id (`redirectUriFor` in `packages/protocol`): `https://<id>.chromiumapp.org/` in Chrome and Edge,
   `https://<SHA-1 of the add-on id>.extensions.allizom.org/` in Firefox. It opens the window only when the browser's
   `identity.getRedirectURL()` is that same address; the browser catches the redirect itself, so nothing is ever sent
   to that host. In Firefox the click that starts the sign-in also asks for consent to share website content, personal
   communications, personally identifying information and authentication information, for a server on this computer
   too, and the background refuses the sign-in without it (ADR 0008). On that page the person
   enters their email address and the six-digit code the server emails, or, where the discovery document lists
   them, uses a passkey they added on the account page or continues with Google, which sends the browser back to the
   page signed in (it then waits for "Continue as"). Accounts are created only for verified addresses in
   `SIGNUP_ALLOWLIST` or that an admin invited, and signing in starts a one-day session for the page.
3. The page asks `POST /v1/auth/authorize` for a single-use code, valid for a minute and bound to the extension id
   (one of `EXTENSION_IDS`: each store's Chrome and Edge id, the Firefox add-on ids and the development ids), the
   redirect address that id must use and the challenge, and sends the browser back to the extension with it, only to
   an address under the request's own redirect address.
4. The background trades the code and its verifier at `POST /v1/auth/token` for a 15-minute EdDSA access token and a
   refresh token, and the server records a device. Each refresh token is traded once at the same route for the next;
   one used twice revokes its device. The one exception is a refresh whose answer was lost: a token spent less than a
   minute ago may be traded once more while the token it issued is unused, the device is signed in and the extension id
   matches; that successor is then spent, new tokens answer, and the server logs `auth.refresh_replayed`. Sign-out ends
   the device with `POST /v1/auth/revoke`.

Emailed codes are limited per email address as well as per client address (Better Auth's own limits): 5 codes an
address an hour, refilled over the hour (past that the server answers as before without calling Better Auth, so it
makes and mails no code and the last one emailed still works) and 10 wrong codes an address an hour (then 429 with
`Retry-After`; a sign-in that works is not counted). The counters live in memory, keyed
by a SHA-256 hash of the lowercased address, and a send Better Auth refuses is given back
(`apps/server/src/auth/better-auth.ts`).

**Extension origins.** `/v1/*` answers CORS for `chrome-extension://<id>` of each Chrome and Edge id in
`EXTENSION_IDS`, and for any `moz-extension://<uuid>` once a Firefox id is listed: Firefox picks that UUID at random
for each install, so it can't be tied to an add-on id (`extensionCors` in `apps/server/src/http/middleware.ts`). CORS
is not the access control: every `/v1` route needs a bearer token, a session or a secret (code and verifier, refresh
token, the payment provider's signature), no answer allows credentials, and session writes from the server's own
pages check that the request came from them. The one exception is `POST /v1/reports`, the server's only anonymous
write route, mounted only with `REPORTS=on` and answering CORS of its own ([Problem reports](#problem-reports)). A
server older than Firefox support refuses to start with a Firefox id in `EXTENSION_IDS`, so it is upgraded first.

### Classify

1. The background sends up to 12 `PostForAI` items and the interest profile to `POST /v1/classify` with the access
   token. There is no prompt field.
2. `requireDevice` checks the token and that its device exists and isn't revoked.
3. Facebook posts that aren't public are declined without a call. The rest pass the limits (`ai/limits.ts`): the
   per-user rate limit, the server's daily spend breaker (`DAILY_SPEND_LIMIT_USD`, logged as `limits.spend_breaker`
   once per UTC day when it trips) and the per-user daily post cap.
4. The enabled `classify` route that passed its eval for the current prompt version names the provider and model.
5. Inside the billing seam, `classifyPosts` from `packages/ai` builds the prompts with the same `packages/core`
   builders the extension uses, and calls the model under a 25-second deadline.
6. Results go back under the client's refs, and one `usage_events` row is written in `finally`, whatever happened.
   The refs are batch-local (`p1`, `p2`…), as for every AI source, and mapped back to the posts on the device; a
   server never sees a post's URL or anything derived from its id
   ([privacy-model.md](privacy-model.md#what-leaves-the-device-when-ai-is-on)).

### Sync

Settings sync between a person's browsers through the server they signed in to. It is off until the person turns it
on in the extension. `packages/sync` holds what both ends share; the server's side is `apps/server/src/routes/sync.ts`
and `apps/server/src/sync`, the extension's `background/sync-client.ts` and `background/sync-scheduler.ts`. Discovery
advertises it as `capabilities.sync`.

- **Spaces.** Each account has one personal space (`sync_spaces`), created on first use. Who may read or write a space
  is decided by one access check, where read-only organization spaces will plug in.
- **What syncs.** `SYNC_COLLECTIONS` lists the collections: only `settings` (settings, interests and exceptions), an
  `lww-map` with one item per field, where the edit with the later hybrid logical clock (HLC) wins. Learned topics,
  votes, usage, caches, device state, keys and tokens are not collections. Both ends refuse an item that looks like an
  API key (`packages/sync/src/credential.ts`).
- **Push, seq, changes.** A device pushes its changed items to `POST /v1/sync/push` under a push id; the server gives
  each item it applies the space's next seq. A push sent again with the same id gets the same answer, from a record
  kept for 24 hours (`sync_pushes`). `GET /v1/sync/changes` answers the items after a cursor (the space's epoch and a
  seq), 500 at a time, and long-polls up to 20 seconds when nothing is new. The extension pulls, applies, then pushes:
  after a local edit, as soon as another device pushes while a feed tab or extension page is open, and on a 30-second
  alarm otherwise.
- **Quotas.** 200 items a push within the 128 KiB body limit, 8 KiB an item, 5,000 live items and 2 MiB a space (413
  `quota-exceeded`); a clock more than 10 minutes ahead of the server's is refused.
- **Tombstones and resync.** A deleted key stays as a tombstone for 90 days; `sync.gc` ([Jobs](#jobs)) then removes it
  and raises the space's floor. A cursor older than the floor, from another epoch, or ahead of the server gets `410
  resync-required`: the device reads the whole space again and pushes its newer local edits.
- **Epochs.** After a database restore, `sync:new-epoch` gives every space a new epoch, so no device trusts a cursor
  from after the backup ([release.md → After restoring a database](release.md#after-restoring-a-database)).

### Problem reports

People report problems from inside the extension, in every browser, with or without an account (ADR 0009). The
extension sends every report to unAlgorithm Cloud only (`REPORTS_URL` in `packages/protocol`), whatever AI it uses, and
only when the person clicks **Send report** on the report page; nothing is queued, retried or sent on its own.

- **Off by default.** `POST /v1/reports` is mounted only with `REPORTS=on` (unAlgorithm Cloud sets it), so a
  self-hosted server has no anonymous write route. It is the exception to "every `/v1` route needs a token, a session
  or a secret": no account, cookie or token, and nothing that identifies the person, browser or install.
- **The route** (`routes/reports.ts`, `reports/intake.ts`). Its own CORS answers any `chrome-extension://` or
  `moz-extension://` page, independent of `EXTENSION_IDS`, so a report from Edge works before the Edge store id is
  listed; never with credentials. A request without an extension's Origin gets 403 before its body is read; a body over
  16 KiB gets 413; one that isn't JSON or a `ProblemReportSchema` report gets 400 with fixed words. Then: a correction
  from an extension the server doesn't list gets 403 `unlisted` (the page offers email instead); an id stored before
  answers 200 with its reference and takes no limit; the limits; only codes listed in `report-codes.ts` are kept, the
  rest counted in `unknown_codes`; a correction's words are cleaned again (`cleanReportMessage`) and a reply address
  lowercased; the row is stored with the time rounded down to the hour and a reference the server picks (40 random
  bits, `7KQ3-M2PA`), and the answer is 201 `{ ok, ref }` with `Cache-Control: no-store`. A report from below the
  platform's "Fixed in" floor is stored already handled (`older-version`).
- **No addresses or headers.** The Origin becomes one boolean, `listed`: a Chrome or Edge id in `EXTENSION_IDS`, or the
  Firefox add-on id the report names (`env.client`, never stored). Unlisted detection, wrong-call and other reports
  are kept but never alert; the admin page counts them, which shows a missing Edge id. The IP address, User-Agent,
  Accept-Language and client hints are never stored, logged or used as they are. The one log line is
  `report.received` with the kind, platform, detection version, topic and `listed`.
- **Limits** (`reports/limits.ts`), in memory and keyed by an HMAC-SHA-256 under a salt replaced at each UTC midnight
  and never written down: `REPORTS_PER_HOUR` (6) an hour and 20 a day per address (IPv6 by /64), 60 a day per /24 or
  /48, 120 a minute from everyone (429 with `Retry-After`), and `REPORTS_DAILY_MAX` (1000) a UTC day, read back from
  the database after a restart (503 until 00:00 UTC). The stored bit `first_from_network` says whether a report was the
  first of its kind that day, about that platform, from its /24 or /48 (never per detection version, which a sender can
  vary), so alerts can tell many people from one; it can't be turned back into an address.
- **Admin page** (`/admin/reports`, `routes/reports-admin.ts`, `reports/admin.ts`), behind the admin role like
  `/admin`: groups by platform, detection version, kind and topic, with networks and 14 daily counts; one report in full
  with `describeReport`'s lines; mark handled or reopen (one report or a whole group), "Fixed in" per platform, forget a
  reply address, delete, and lookup by reference for privacy requests. Its log lines name the admin by id and carry
  counts only.
- **Retention** (`reports.purge`, [Jobs](#jobs)): a reply address goes 30 days after the report is handled and never
  stays more than 60 days; rows go after 90 days, a correction first becoming one more in `correction_counts` for the
  transparency report (`transparency` counts those plus the rows still kept). Deleting an account clears its address
  from any report that gave it. Deleted rows stay in the encrypted nightly backups for up to 14 more nights.

### Database

Postgres 17 (PGlite in tests), migrated at startup under an advisory lock from `apps/server/drizzle`. No table holds
post text or prompts. The only names are in each person's synced settings: the labels of people that person chose to
always show or hide (`sync_items`).

| Table | What it holds |
|---|---|
| `user` | Accounts (Better Auth): the email address, whether the account is an admin (`role`), and whether an admin removed its access (`banned`, `ban_reason`) |
| `session` | One-day sessions of the sign-in page, with the browser's IP address and user agent |
| `account` | Better Auth's linked sign-in methods: for Google, Google's account id and never a Google token; empty while sign-in is by email code only |
| `verification` | Emailed sign-in codes, by hash, under the address they were asked for; each Google sign-in's state (its PKCE verifier and return pages), valid for ten minutes; each passkey ceremony's challenge, with the account's id and address when adding one, valid for five minutes |
| `passkey` | Passkeys a signed-in person added: the public key, the credential id, the authenticator model's id (AAGUID), the sign count, a label and when it was added; never a private key or biometric data |
| `jwks` | The key pair that signs access tokens, its private half encrypted with the server's secret |
| `devices` | One row per signed-in extension: account, extension id, the name it gave itself at sign-in, last use, revocation |
| `auth_codes` | Single-use codes for the PKCE exchange, by hash, with the extension, redirect address and challenge they are bound to |
| `refresh_tokens` | Device refresh tokens, by hash, each usable once (bar the one replay of a refresh whose answer was lost), with the token each refresh issued; deleted once expired |
| `ai_routes` | Which provider and model serve each task, and their eval results; never an API key |
| `usage_events` | One row per AI request: account, device, time, post and token counts, model, outcome and cost |
| `user_limits` | Per-user daily post caps, set with the `user-cap` command |
| `signup_invites` | Addresses an admin invited, until the account is created or the invite removed |
| `setup_tokens` | One-time setup links by hash, with the address each was made for |
| `sync_spaces` | One personal sync space per account: its epoch, the last seq handed out, item and byte counts, and the tombstone cleanup floor |
| `sync_items` | Each person's synced settings, one row per collection and key, with the seq, clock and device of its last write; a deleted key stays as a tombstone without a value |
| `sync_pushes` | One record per sync push, by push id, with the statuses, seqs and reasons the server answered and the keys it did not refuse; never a value or a refused key |
| `ops_alerts` | Alerts open now: key, level, times, one number |
| `claim_cache` | The shared claim cache: per checked public claim, a keyed hash of the normalized claim, the verdict, its explanation (≤ 280 characters, null when it repeats 6 consecutive words of the post), 2–4 validated public sources (URL, domain, title, a quote of 25 words at most) and when it was checked and expires, both to the hour; never a claim, post text or any user, device or post id; deleted hourly once past its 24 hours |
| `outlets` | The server's published source list for UnEcho Chamber: each outlet's name, web addresses, country, lean bucket and evidence |
| `outlet_changes` | Every change to it: what changed, when, and which admin; the admin is never published and is cleared when that account is deleted |
| `price_changes` | The server's prices (task prices, starter credit, buying credit, auto-reload caps) as admins set them: every change, when, and which admin; the newest row's book is in use; the admin is never published and is cleared when that account is deleted |
| `problem_reports` | Problem reports people sent ([Problem reports](#problem-reports)): the extension's random id, the reference, the hour it arrived, the kind, where it started, the extension's version, channel and browser and whether its id is listed, the platform and detection version, the topic, the person's choices, the `first_from_network` bit, the page's codes and counts (registry codes only) and how many codes were dropped; for a correction, the person's own words and, if they gave one, a reply address; who handled it, when and how. Never an IP address, Origin, extension id or request header; deleted after 90 days |
| `report_floors` | "Fixed in" per platform: the detection version from which reports count, when an admin set it and which admin |
| `correction_counts` | Corrections per quarter, feature and how they ended, counted as their reports are deleted, for the transparency report; numbers only |

A billing module keeps tables of its own in its `billing` schema ([Billing seam](#billing-seam)), and graphile-worker
keeps its queue in the `graphile_worker` schema ([Jobs](#jobs)).

### Billing seam

Billing sits behind one interface, `BillingProvider` (`apps/server/src/billing/provider.ts`); why the server is open
and billing may be private is in [ADR 0007](adr/0007-open-server-private-billing.md). A provider has four calls and
three optional ones:

- `check`, in each classify request once the limits pass and a route is chosen (step 5 above), with the account,
  device and request ids and `checkedAt`, the instant of the check, which prices the request (the card in effect then,
  also for its settlement): allow the call, hold an amount, or refuse with `insufficient-credits` (402, no model
  called).
- `settle` after the model call, with the model, token usage, cost and post count of the calls that succeeded, and the
  same `checkedAt`; or
  `release` when none succeeded or the call failed, so a failed request is never charged.
- `balance`: an account's balance, or none. Classify does not call it; a classify answer carries the balance `settle`
  returned.
- `mount`, once at start: adds the provider's own routes and pages, behind the server's middleware and after its API
  routes.
- `exportAccount?(userId)`: the module's records for the account export's `billing` field (`null` there when the module
  does not implement it).
- `deleteAccount?(userId)`: called before the account is deleted; a rejection stops the deletion. It may be called
  again for the same account, so it is idempotent per userId.
- `alerts?(now)`: asked at each alert check (`ops.check-alerts`), the module's alerts open now, each a `billing-<code>`
  key, a level and one number, which open, close and notify as the server's own do. Invalid ones are dropped and at
  most 20 kept; a rejection, or no answer within 5 s, keeps the module's open alerts as they are and opens
  `billing-alerts-failed`.

A module's rows are keyed by user id with no foreign key, so a module that implements neither keeps them after the
account is deleted.

`BILLING=off`, the default, is the no-op provider: usage is recorded and admins set caps, but nobody is charged, no
ledger is kept and discovery advertises no billing. `BILLING=module` with `BILLING_MODULE=<absolute path>` imports that
file at start, hands its `createBillingProvider` the host and checks the provider it returns; the module reads its own
settings from the other `BILLING_*` variables, and the `billing` command runs its admin commands. A module that fails
to load, throws or returns no valid provider stops the start, so a server meant to charge never serves AI for free.

The host (`BillingHost`, `apps/server/src/billing/host.ts`) is all a module is offered: SQL on the server's database,
for the module's own `billing` schema; its own migrations, under a lock of their own; an account's id, email address,
verified flag and creation time; the two auth checks for its routes (the extension's bearer token and the server
pages' session); the job registry; the logger; the server's origin, name and version; the running release's
`packages/protocol` with its price rules (`taskPriceAt`, `starterCreditAt`, `creditAmount`); the server's prices
(`prices.current()`: the price book its admins set on the Pricing page, or the code defaults, read at each use, so the
module charges from the book discovery and `/prices.json` publish); and the server's metered
AI cost per UTC day and model (`usage.costByDay`: summed cost and request counts, no user or request id). It offers no API to the server's schema, the AI clients, post text or prompts. The seam is a
reviewed contract, not an isolation boundary: the module runs in the server process with the server's database access
(its SQL runs on the server's pool and database role, so it could read any server table), and its routes see requests
as any server route does. Adding to `BillingHost` is a reviewed public change. unAlgorithm Cloud's billing module lives
in HeitechSoft's private repository and reaches the server only through this seam. Where discovery advertises billing,
the account page (`apps/web`) shows the balance and history the module answers at `GET /v1/billing/account`.

### Jobs

Background jobs run on graphile-worker inside the server process, on the server's own pool, one at a time
(`apps/server/src/jobs/worker.ts`). The server and a billing module register named tasks and UTC cron schedules on
the job registry while the server starts. The server's own: `auth.purge-expired`, hourly, deletes expired refresh
tokens, extension codes and `verification` rows (`apps/server/src/auth/purge.ts`); `sync.gc`, every 6 hours,
deletes sync tombstones after 90 days (raising the space's floor, so older cursors get `410 resync-required`), lapsed
`ttl-cache` items and push records after 24 hours (`apps/server/src/sync/gc.ts`); `ops.check-alerts`, every five
minutes, checks the server's status and opens or closes alerts ([Operations](#operations));
`factcheck.purge-claim-cache`, hourly, deletes `claim_cache` rows past their expiry (`apps/server/src/ai/claim-cache.ts`);
`reports.purge`, hourly, clears problem reports' reply addresses and deletes reports after 90 days, counting corrections
first ([Problem reports](#problem-reports), `apps/server/src/reports/purge.ts`).
The server registers all five on every server backed by Postgres, whatever `REPORTS` is, so graphile-worker runs on
each of them. After a database restore, `pnpm sync:new-epoch`
gives every space a new epoch, so every device resyncs. graphile-worker creates the
`graphile_worker` schema when it first starts and keeps its queue there: each job's task name, payload, run
time and attempts, and after a failure the error's name and code, never its message. Payloads hold ids and numbers
only. A job's row is deleted once it succeeds; one that fails every attempt stays. PGlite, in tests, runs no worker.

### Operations

How the server's running parts fit. `apps/server/compose.yaml` starts three services, `server`, `postgres` and
`backup`, and has three profiles: `caddy` (HTTPS in front of the server, no access log), `ollama` (a local model on the
same machine) and `tools` (the one-off `keygen`).

- **Backups.** The `backup` service runs on the `postgres` image, so its `pg_dump` matches the database. Each night it
  encrypts a dump to the operator's public key (made by `keygen`; the private key belongs off the server) and keeps the
  newest `BACKUP_KEEP`. It writes a status file per backup kind, which the server reads through a read-only mount;
  `restore.sh` restores a backup with the private key piped in.
- **Status.** `readOpsStatus` (`apps/server/src/ops/status.ts`) measures free disk, the database's size, the error lines
  of the last 15 minutes and the backups' last runs: numbers, times and fixed codes only. The admin page shows them as
  the `ops` block of `GET /v1/admin/overview`.
- **Alerts.** The `ops.check-alerts` job ([Jobs](#jobs)) reads that status every five minutes, keeps the alerts open now
  in `ops_alerts`, and notifies the admins (or `ALERT_EMAIL`) by email, and `ALERT_WEBHOOK_URL`, when an alert opens, is
  still open a day later, and closes. With `REPORTS=on` it also reads the problem reports (`ops/report-alerts.ts`),
  counting only listed reports from builds other than development ones, at or above the "Fixed in" floor and not dated
  in a future month (`latestAdapterOrder`; an adapter version is dated in the month it is built):
  `reports-linkedin-broken` and `reports-facebook-broken` open when unhandled detection reports of the last 24 hours
  come from `REPORTS_ALERT_NETWORKS` (2) networks with a sign of breakage, or twice that many whatever they say
  (critical from 5), counting the UTC day with more networks, so one network either side of midnight is one;
  `reports-waiting` when a report has waited more than 24 hours; `reports-cap` when today's reports reach
  `REPORTS_DAILY_MAX`. Their messages carry a count and link to `/admin/reports`; `REPORTS_ALERT_NETWORKS=0` turns them
  off, and `alerts test --key reports-…` sends a test of each.
- **Metrics.** `GET /metrics` answers the same server-wide numbers in the Prometheus text format, only with the bearer
  token `METRICS_TOKEN`; without one set, the path does not exist.
- **Admins.** The `setup-link` command prints a one-time link to `/setup`, its secret in the URL fragment and only its
  hash stored (`setup_tokens`); signing in there with the address it was made for makes that account an admin (Better
  Auth's admin plugin's `role` column; none of the plugin's own routes is mounted). Admins use `/admin` and the
  `/v1/admin/*` routes to invite people (`signup_invites`), set caps and roles, and remove access, and `/admin/sources`
  to keep the server's source list (`outlets`): add, edit and remove outlets, each lean with evidence, or import the
  candidate list into an empty list, and `/admin/reports` to read and handle problem reports. `--recover` makes a link
  that works although the server already has an admin.

## Testing

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest projects (jsdom where needed) | Rules, decide, presets, migration, clocks, prompt/fence, adapters on fixtures, the contract check, AI clients against a fake fetch, the feed controller |
| End to end | Playwright Test with each browser's `wxt build --mode e2e`: the `chromium` and `edge` projects drive Playwright's Chromium and Microsoft Edge (the same specs), the `firefox` project drives Firefox through Puppeteer over WebDriver BiDi (`e2e/firefox/`, ADR 0008) | The real extension on fixture pages served at `https://www.linkedin.com/feed/` with all network aborted; popup, settings, onboarding, Why? and undo, a mock OpenAI-compatible AI server, axe in light and dark; with `UA_SERVER_E2E=1` (CI `server` job), sign-in to a real server process on Postgres and Mailpit and the feed labelled through it, and with the test billing module the balance pill, its drop after classifying and the pause at $0. In Firefox, the background's requests go through a recording proxy, and sign-in uses Firefox's own sign-in window |
| Firefox package | `scripts/check-firefox-lint.mjs` (Mozilla's add-on linter), `scripts/check-firefox-sources.mjs` | The Firefox build has no linter errors or notices and only the reviewed warnings; the sources zip holds nothing private and rebuilds the Firefox zip byte for byte, with and without the Cloud card |
| Server | The Vitest `server` project on PGlite, and on Postgres 17 and Mailpit in the CI `server` job; `compose-smoke.sh`, `backup-smoke.sh` and `restore-smoke.sh` | Routes, sign-in and tokens, classify, limits, problem reports (the route, its limits, retention, admin routes and alerts, and that no address or header is kept), migrations, the canary test; the image and compose file as an operator runs them, their encrypted backups, and a wiped stack restored from one |

## Decisions

Architecture decisions are recorded in [adr/](adr/).
