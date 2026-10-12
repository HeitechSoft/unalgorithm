# Architecture

UnAlgorithm Feed (UnAlgorithm for short) is a Manifest V3 browser extension built with [WXT](https://wxt.dev) and
React, organized as a pnpm workspace. Everything platform-specific lives behind one adapter interface; everything that
does not need the browser is plain TypeScript, so the future UnAlgorithm server can reuse it.

```
apps/extension ──► packages/platforms ──► packages/core ──► packages/protocol
       │                                        ▲
       ├──────────► packages/ai ────────────────┘
       └──────────► packages/ui (React components, tokens, in-feed parts)
```

| Package | Responsibility | Rules |
|---|---|---|
| `protocol` | Wire contracts (zod): ids, `PostForAI`, classify request/response, AI error codes, usage + price cards, hybrid logical clock | zod only; additive changes only. The Phase 2 server imports the same files |
| `core` | Post model, rules and `decide()`, presets, settings schema/defaults/migration/clocks, the classification prompt and fence, cache policy, health evaluation | No `chrome.*`, no DOM |
| `platforms` | `PlatformAdapter` contract and the LinkedIn and Facebook adapters, per-locale markers, anonymized fixtures, `checkAdapterContract` | DOM reads only; never mutate, click, scroll or focus |
| `ai` | Vendor clients (Anthropic, OpenAI Responses, OpenAI-compatible, Chrome built-in), strict JSON schema helper, `classifyPosts` orchestrator, key detection, provider presets | No `chrome.*` except the `chrome-builtin` subpath |
| `ui` | Design tokens, accessible components, in-feed parts (stub, run, Why? popover, For you row, toasts) | No `chrome.*`; services come in as props |
| `apps/extension` | Entrypoints, the feed controller, background services, storage, messaging, E2E | The only place that talks to the browser |

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
| IndexedDB `secrets` | API keys | **Never**; not exported, not in diagnostics |
| IndexedDB `classifications` | Cached verdicts keyed by post + input hash + profile hash + source:model + prompt version; no text, no names | Never |

Settings use loose zod objects so fields written by a newer version survive an older one; migrations only fill
defaults and repair broken sections.

## Messaging

`lib/messages.ts` defines `BgRequest` and `BgResponses`. The background's handler map is typed so a missing handler is
a compile error. Every handler checks the sender: feed messages only from LinkedIn/Facebook tabs, in-feed actions
from those tabs or extension pages, privileged ones (keys, AI setup, model lists, data deletion) only from extension
pages. Content scripts never see API keys or build prompts; the background re-validates each post against
`PostForAISchema` before it is sent to a model.

## AI

See [ai-sources.md](ai-sources.md). In short: one strict JSON schema is sent through four transports (Anthropic
structured output, OpenAI Responses `json_schema`, OpenAI-compatible with a learned step-down ladder, Chrome's
`responseConstraint`). Posts are fenced with a per-request nonce after control/bidi characters are stripped and
entities escaped. Refusals bisect the batch so only the offending post fails; ids the model skipped are retried once;
usage is recorded even when a call fails.

## Testing

| Layer | Tool | What |
|---|---|---|
| Unit | Vitest projects (jsdom where needed) | Rules, decide, presets, migration, clocks, prompt/fence, adapters on fixtures, the contract check, AI clients against a fake fetch, the feed controller |
| End to end | Playwright + bundled Chromium, `wxt build --mode e2e` | The real extension on fixture pages served at `https://www.linkedin.com/feed/` with all network aborted; popup, settings, onboarding, Why? and undo, a mock OpenAI-compatible AI server, axe in light and dark |

## Decisions

Architecture decisions are recorded in [adr/](adr/).
