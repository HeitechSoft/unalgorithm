# Architecture

UnAlgorithm Feed (UnAlgorithm for short) is a Manifest V3 browser extension built with [WXT](https://wxt.dev) and
React, organized as a pnpm workspace. Everything platform-specific lives behind one adapter interface; everything that
does not need the browser is plain TypeScript, so the UnAlgorithm server (`apps/server`) reuses it.

```
apps/extension ──► packages/platforms ──► packages/core ──► packages/protocol
       │                                        ▲
       ├──────────► packages/ai ────────────────┤
       ├──────────► packages/sync ──────────────┘   (and packages/ai/presets)
       └──────────► packages/ui (React components, tokens, in-feed parts)

apps/server ─────► packages/ai, packages/core, packages/protocol, packages/sync   (never ui, platforms or wxt)
apps/web ────────► packages/ui, packages/core, packages/protocol   (the server's sign-in and account pages)
```

| Package | Responsibility | Rules |
|---|---|---|
| `protocol` | Wire contracts (zod): ids, `PostForAI`, classify request/response, AI error codes, usage and model price cards, the dated credit price schedule, hybrid logical clock, server discovery and sign-in | zod only; additive changes only. The server imports the same files |
| `core` | Post model, rules and `decide()`, presets, settings schema/defaults/migration/clocks, the classification prompt and fence, cache policy, health evaluation | No `chrome.*`, no DOM |
| `platforms` | `PlatformAdapter` contract and the LinkedIn and Facebook adapters, per-locale markers, anonymized fixtures, `checkAdapterContract` | DOM reads only; never mutate, click, scroll or focus |
| `ai` | Vendor clients (Anthropic, OpenAI Responses, OpenAI-compatible, Chrome built-in), strict JSON schema helper, `classifyPosts` orchestrator, key detection, provider presets | No `chrome.*` except the `chrome-builtin` subpath |
| `sync` | Collection registry, merge strategies, settings items and merge; imported by the server and the extension | Only `protocol`, `core`, zod and the SDK-free `@unalgorithm/ai/presets`; no `chrome.*`, DOM or Node |
| `ui` | Design tokens, accessible components, in-feed parts (stub, run, Why? popover, For you row, toasts) | No `chrome.*`; services come in as props |
| `apps/extension` | Entrypoints, the feed controller, background services, storage, messaging, E2E | The only place that talks to the browser |
| `apps/server` | The self-hostable UnAlgorithm server: email-code sign-in, PKCE sign-in for the extension, the `/v1/classify` gateway, usage records, limits and the billing seam ([Server](#server)) | Imports `protocol`, `core`, `ai` and `sync`; never `ui`, `platforms` or `wxt`. Logs no request body |
| `apps/web` | The sign-in and account pages the server serves on its own origin (`/`, `/authorize` and `/account`), built by Vite into `apps/web/dist` | Imports `protocol`, `ui` and `core`'s wording helpers; never `platforms` or `wxt` |

Boundaries are enforced with Biome `noRestrictedImports` per folder and per-package `tsconfig` settings. Packages
are consumed as TypeScript source (`exports` points at `src/index.ts`); there is no separate build step for them.

## Extension entrypoints

| Entrypoint | Job |
|---|---|
| `background.ts` | Typed message router (exhaustive handler map, sender validation), AI classification, IndexedDB (secrets, cache), per-tab state and badge, settings actions with undo, install flow (opens onboarding, injects into already-open feed tabs) |
| `linkedin.content`, `facebook.content` | Boot the feed controller with that platform's adapter (`content/bootstrap.ts`) |
| `popup` | The toolbar "Control Center": on/pause, hidden count, reason chips, Strength, For you, Peek, Report a problem |
| `sidepanel` | Highlights: For you and Hidden lists, with scroll-to and Show |
| `options` | Settings, macOS System Settings style: LinkedIn, Facebook, Display, Interests, AI, Privacy & Data, About |
| `onboarding` | Welcome → Strength → Interests → AI (optional) → Done |

## How a feed item flows

1. **Find.** The controller observes only the adapter's `feedScope`. New items are read as they appear, in page
   order; items that change before they settle are re-read in debounced passes capped at 8 ms.
2. **Read.** `adapter.inspect(el)` returns a normalized `PostData` (or a module, `pending` for skeleton cards, or
   `ignore`). It never changes the page. Each signal (sponsored, suggested, network activity, reshare, unjoined
   group, reel) comes with `evidence`: detector ids and a strength, used by "Why?" and diagnostics.
3. **Settle.** An item is re-read while LinkedIn/Facebook are still filling it in, then settles and is not read again
   unless the user expands it ("See more").
4. **Decide.** `decide()` in `core` combines, in order: the user's own vote on that post, rules (`ruleFilter`:
   always-hide → sponsored → always-show → suggested → network activity → reshare → unjoined group → reel →
   not-followed, which only fires on an explicit `not-followed`), muted words and "less of" topics, then AI verdicts
   when available. Unknown or weak evidence never hides a post.
5. **Show.** Only items that need UI get it: hidden items become a one-line stub (or a merged run: "3 hidden · Show
   all"), dimmed and revealed items get a bar, highlighted items get a "For you" row. One React root renders every
   item through portals into small shadow roots that adopt one constructed stylesheet. Ordinary posts are untouched.
6. **Classify (optional).** Rule-passing posts near the viewport are batched (2–6 per request, by source) and sent to the
   background, which checks the IndexedDB cache, then calls the chosen AI source. A verdict for a post that is on
   screen waits until it scrolls away, so posts never vanish while you read them.

The controller also re-arms infinite scroll when collapsed posts stall loading, and runs the **health monitor**: if
too much would be hidden for the chosen strength, authors cannot be read, or no feed appears, it stops hiding on
that page (fail open). The toolbar icon says so, and the popup shows a banner with **Report a problem**.

## Storage

| Where | What | Synced in Phase 2 |
|---|---|---|
| `storage.local` `settings` | Preset, display, per-platform filters and exceptions, interests, AI behaviour | Yes, per field |
| `storage.local` `settingsClocks` | A hybrid logical clock per changed settings path, stamped by `updateSettings()` | Used for merging |
| `storage.local` `device` | AI source config (no keys), onboarding state, dev flags | Never |
| `storage.local` `learned`, `votes`, `usage`, `stats` | Topic weights, recent votes, AI usage (30 days), daily counts | Learned/votes later; usage never |
| `storage.session` `tab:<id>` | Live per-tab state for the popup and side panel: counts, health, and for each hidden or highlighted post its author, a short snippet and its link. Memory only; cleared when the tab closes or on Erase everything | Never |
| `storage.local` `serverAccount` | The UnAlgorithm server the user signed in to: its origin and discovery answer, the email address, the device id, when it signed in, and whether it needs a new sign-in. No tokens. Removed on sign-out and on Erase everything | Never |
| `storage.session` `serverAccess` | That server's 15-minute access token. Memory only, closed to content scripts | Never |
| `storage.session` `serverBalance` | The signed-in account's latest credit balance, from a classify answer, a 402 or the balance endpoint, with the server's origin and the device id it belongs to. Only for a server that advertises billing. Memory only, closed to content scripts, cleared on Erase everything | Never |
| IndexedDB `secrets` | API keys, and the server's refresh token under `server-refresh:<origin>` | **Never**; not exported, not in diagnostics |
| IndexedDB `classifications` | Cached verdicts keyed by post + input hash + profile hash + source:model + prompt version; no text, no names | Never |

Settings use loose zod objects so fields written by a newer version survive an older one; migrations only fill
defaults and repair broken sections.

## Messaging

`lib/messages.ts` defines `BgRequest` and `BgResponses`. The background's handler map is typed so a missing handler is
a compile error. Every handler checks the sender: feed messages only from LinkedIn/Facebook tabs, in-feed actions
from those tabs or extension pages, privileged ones (keys, AI setup and status, model lists, data deletion) only from
extension pages. Content scripts never see API keys or build prompts; the background re-validates each post against
`PostForAISchema` before it is sent to a model.

## AI

See [ai-sources.md](ai-sources.md). In short: one strict JSON schema is sent through four transports (Anthropic
structured output, OpenAI Responses `json_schema`, OpenAI-compatible with a learned step-down ladder, Chrome's
`responseConstraint`). Posts are fenced with a per-request nonce after control/bidi characters are stripped and
entities escaped. Refusals bisect the batch so only the offending post fails; ids the model skipped are retried once;
usage is recorded even when a call fails.

## Server

`apps/server` is the self-hostable UnAlgorithm server: Hono with zod-openapi, Postgres 17 through Drizzle, and Better
Auth for email codes. `apps/web` holds the sign-in and account pages it serves on its own origin. UnAlgorithm Cloud
runs this same server; HeitechSoft's private repository adds only a billing module and its own operations
configuration (ADR 0007).
One image holds both apps (`apps/server/Dockerfile`), released on the server train
([release.md](release.md#server-releases)). What a server keeps is in
[privacy-model.md](privacy-model.md#what-a-server-stores).

### Sign-in

1. The extension reads `/.well-known/unalgorithm.json`: the server's name, version, source link and capabilities.
2. The background opens `/authorize` in `chrome.identity.launchWebAuthFlow` with a PKCE challenge. On that page the
   person enters their email address and the six-digit code the server emails, or, where the discovery document lists
   them, uses a passkey they added on the account page or continues with Google, which sends the browser back to the
   page signed in (it then waits for "Continue as"). Accounts are created only for addresses in `SIGNUP_ALLOWLIST`,
   and signing in starts a one-day session for the page.
3. The page asks `POST /v1/auth/authorize` for a single-use code, valid for a minute and bound to the extension id
   (one of `EXTENSION_IDS`), its redirect address and the challenge, and sends the browser back to the extension with
   it.
4. The background trades the code and its verifier at `POST /v1/auth/token` for a 15-minute EdDSA access token and a
   refresh token, and the server records a device. Each refresh token is traded once at the same route for the next;
   one used twice revokes its device. The one exception is a refresh whose answer was lost: a token spent less than a
   minute ago may be traded once more while the token it issued is unused, the device is signed in and the extension id
   matches; that successor is then spent, new tokens answer, and the server logs `auth.refresh_replayed`. Sign-out ends
   the device with `POST /v1/auth/revoke`.

Emailed codes are limited per email address as well as per client address (Better Auth's own limits): 5 codes an
address in 15 minutes (past that the server answers as before but makes and mails no code) and 10 wrong codes an
address an hour (then 429 with `Retry-After`; a sign-in that works is not counted). The counters live in memory, keyed
by a SHA-256 hash of the lowercased address, and a send Better Auth refuses is given back
(`apps/server/src/auth/better-auth.ts`).

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

### Database

Postgres 17 (PGlite in tests), migrated at startup under an advisory lock from `apps/server/drizzle`. No table holds
post text or prompts. The only names are in each person's synced settings: the labels of people that person chose to
always show or hide (`sync_items`).

| Table | What it holds |
|---|---|
| `user` | Accounts (Better Auth): the email address only |
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
| `sync_spaces` | One personal sync space per account: its epoch, the last seq handed out, item and byte counts, and the tombstone cleanup floor |
| `sync_items` | Each person's synced settings, one row per collection and key, with the seq, clock and device of its last write; a deleted key stays as a tombstone without a value |
| `sync_pushes` | One record per sync push, by push id, with the statuses, seqs and reasons the server answered and the keys it did not refuse; never a value or a refused key |

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
pages' session); the job registry; the logger; the server's origin, name and version; and the running release's
`packages/protocol` with its dated price schedule (`CREDIT_PRICE_SCHEDULE`, `priceCardsAt`). It offers no API to the server's schema, the AI clients, post text or prompts. The seam is a
reviewed contract, not an isolation boundary: the module runs in the server process with the server's database access
(its SQL runs on the server's pool and database role, so it could read any server table), and its routes see requests
as any server route does. Adding to `BillingHost` is a reviewed public change. UnAlgorithm Cloud's billing module lives
in HeitechSoft's private repository and reaches the server only through this seam. Where discovery advertises billing,
the account page (`apps/web`) shows the balance and history the module answers at `GET /v1/billing/account`.

### Jobs

Background jobs run on graphile-worker inside the server process, on the server's own pool, one at a time
(`apps/server/src/jobs/worker.ts`). The server and a billing module register named tasks and UTC cron schedules on
the job registry while the server starts. The server's own: `auth.purge-expired`, hourly, deletes expired refresh
tokens, extension codes and `verification` rows (`apps/server/src/auth/purge.ts`); `sync.gc`, every 6 hours,
deletes sync tombstones after 90 days (raising the space's floor, so older cursors get `410 resync-required`), lapsed
`ttl-cache` items and push records after 24 hours (`apps/server/src/sync/gc.ts`). The server registers both on every
server backed by Postgres, so graphile-worker runs on each of them. After a database restore, `pnpm sync:new-epoch`
gives every space a new epoch, so every device resyncs. graphile-worker creates the
`graphile_worker` schema when it first starts and keeps its queue there: each job's task name, payload, run
time and attempts, and after a failure the error's name and code, never its message. Payloads hold ids and numbers
only. A job's row is deleted once it succeeds; one that fails every attempt stays. PGlite, in tests, runs no worker.

## Testing

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest projects (jsdom where needed) | Rules, decide, presets, migration, clocks, prompt/fence, adapters on fixtures, the contract check, AI clients against a fake fetch, the feed controller |
| End to end | Playwright + bundled Chromium, `wxt build --mode e2e` | The real extension on fixture pages served at `https://www.linkedin.com/feed/` with all network aborted; popup, settings, onboarding, Why? and undo, a mock OpenAI-compatible AI server, axe in light and dark; with `UA_SERVER_E2E=1` (CI `server` job), sign-in to a real server process on Postgres and Mailpit and the feed labelled through it, and with the test billing module the balance pill, its drop after classifying and the pause at $0 |
| Server | The Vitest `server` project on PGlite, and on Postgres 17 and Mailpit in the CI `server` job; `compose-smoke.sh` and `backup-smoke.sh` | Routes, sign-in and tokens, classify, limits, migrations, the canary test; the image and compose file as self-hosters run them, and their encrypted backups |

## Decisions

Architecture decisions are recorded in [adr/](adr/).
