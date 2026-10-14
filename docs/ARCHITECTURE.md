# Architecture

UnAlgorithm Feed (UnAlgorithm for short) is a Manifest V3 browser extension built with [WXT](https://wxt.dev) and
React, organized as a pnpm workspace. Everything platform-specific lives behind one adapter interface; everything that
does not need the browser is plain TypeScript, so the UnAlgorithm server (`apps/server`) reuses it.

```
apps/extension ──► packages/platforms ──► packages/core ──► packages/protocol
       │                                        ▲
       ├──────────► packages/ai ────────────────┘
       └──────────► packages/ui (React components, tokens, in-feed parts)

apps/server ─────► packages/ai, packages/core, packages/protocol   (never ui, platforms or wxt)
apps/web ────────► packages/ui, packages/core, packages/protocol   (the server's sign-in and account pages)
```

| Package | Responsibility | Rules |
|---|---|---|
| `protocol` | Wire contracts (zod): ids, `PostForAI`, classify request/response, AI error codes, usage + price cards, hybrid logical clock, server discovery and sign-in | zod only; additive changes only. The server imports the same files |
| `core` | Post model, rules and `decide()`, presets, settings schema/defaults/migration/clocks, the classification prompt and fence, cache policy, health evaluation | No `chrome.*`, no DOM |
| `platforms` | `PlatformAdapter` contract and the LinkedIn and Facebook adapters, per-locale markers, anonymized fixtures, `checkAdapterContract` | DOM reads only; never mutate, click, scroll or focus |
| `ai` | Vendor clients (Anthropic, OpenAI Responses, OpenAI-compatible, Chrome built-in), strict JSON schema helper, `classifyPosts` orchestrator, key detection, provider presets | No `chrome.*` except the `chrome-builtin` subpath |
| `ui` | Design tokens, accessible components, in-feed parts (stub, run, Why? popover, For you row, toasts) | No `chrome.*`; services come in as props |
| `apps/extension` | Entrypoints, the feed controller, background services, storage, messaging, E2E | The only place that talks to the browser |
| `apps/server` | The self-hostable UnAlgorithm server: email-code sign-in, PKCE sign-in for the extension, the `/v1/classify` gateway, usage records, limits and the billing seam ([Server](#server)) | Imports `protocol`, `core` and `ai`; never `ui`, `platforms` or `wxt`. Logs no request body |
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
   person enters their email address and the six-digit code the server emails. Accounts are created only for
   addresses in `SIGNUP_ALLOWLIST`, and signing in starts a one-day session for the page.
3. The page asks `POST /v1/auth/authorize` for a single-use code, valid for a minute and bound to the extension id
   (one of `EXTENSION_IDS`), its redirect address and the challenge, and sends the browser back to the extension with
   it.
4. The background trades the code and its verifier at `POST /v1/auth/token` for a 15-minute EdDSA access token and a
   refresh token, and the server records a device. Each refresh token is traded once at the same route for the next;
   one used twice revokes its device. Sign-out ends the device with `POST /v1/auth/revoke`.

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

### Database

Postgres 17 (PGlite in tests), migrated at startup under an advisory lock from `apps/server/drizzle`. No table holds
post text, names or prompts.

| Table | What it holds |
|---|---|
| `user` | Accounts (Better Auth): the email address only |
| `session` | One-day sessions of the sign-in page, with the browser's IP address and user agent |
| `account` | Better Auth's linked sign-in methods; empty while sign-in is by email code only |
| `verification` | Emailed sign-in codes, by hash, under the address they were asked for |
| `jwks` | The key pair that signs access tokens, its private half encrypted with the server's secret |
| `devices` | One row per signed-in extension: account, extension id, last use, revocation |
| `auth_codes` | Single-use codes for the PKCE exchange, by hash, with the extension, redirect address and challenge they are bound to |
| `refresh_tokens` | Device refresh tokens, by hash, each usable once |
| `ai_routes` | Which provider and model serve each task, and their eval results; never an API key |
| `usage_events` | One row per AI request: account, device, time, post and token counts, model, outcome and cost |
| `user_limits` | Per-user daily post caps, set with the `user-cap` command |

### Billing seam

Billing sits behind one interface, `BillingProvider` (`apps/server/src/billing/provider.ts`, ADR 0007). Before an AI
call it allows the call, holds an amount, or refuses with `insufficient-credits`; after it, it settles what succeeded
or releases the hold. It also reports a balance and may mount its own routes and pages. The open server ships the
no-op provider (`BILLING=off`): usage is recorded and admins set caps, but nobody is charged. A provider sees account
ids, amounts and usage counts, never posts. UnAlgorithm Cloud's billing module lives in HeitechSoft's private
repository and reaches the server only through this interface. Where the discovery document advertises billing, the
account page (`apps/web`, public) shows the balance and credit history the module answers at `GET /v1/billing/account`,
in the extension's wording.

## Testing

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest projects (jsdom where needed) | Rules, decide, presets, migration, clocks, prompt/fence, adapters on fixtures, the contract check, AI clients against a fake fetch, the feed controller |
| End to end | Playwright + bundled Chromium, `wxt build --mode e2e` | The real extension on fixture pages served at `https://www.linkedin.com/feed/` with all network aborted; popup, settings, onboarding, Why? and undo, a mock OpenAI-compatible AI server, axe in light and dark; with `UA_SERVER_E2E=1` (CI `server` job), sign-in to a real server process on Postgres and Mailpit and the feed labelled through it, and with the test billing module the balance pill, its drop after classifying and the pause at $0 |
| Server | The Vitest `server` project on PGlite, and on Postgres 17 and Mailpit in the CI `server` job; `compose-smoke.sh` | Routes, sign-in and tokens, classify, limits, migrations, the canary test; the image and compose file as self-hosters run them |

## Decisions

Architecture decisions are recorded in [adr/](adr/).
