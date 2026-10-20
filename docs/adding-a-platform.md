# Adding or fixing a platform

Everything unAlgorithm knows about a site's layout lives in `packages/platforms/src/<platform>/`. The feed
controller, rules, UI and AI are shared.

## When a site changes its layout

1. Reproduce it in the dev profile (`pnpm dev` or `pnpm dev:fb`). A problem report names the address class, the
   detection version and the issues, never the page itself: capture the page yourself.
2. Capture the broken items with the capture script ([fixtures.md](fixtures.md)) and save them under
   `packages/platforms/fixtures/<platform>/<yyyy-mm>-<what>.html`. If the console lists a label with scrambled words,
   add them to the script's `KEEP` list and capture again.
3. Write a failing test that loads the fixture and asserts what `inspect()` should return. For a whole page, add it as
   a golden page with its expect file ([fixtures.md](fixtures.md#golden-pages)).
4. Fix the selectors (`selectors.ts`), markers (`markers/en.ts`), slots (`slots.ts`), discovery (`discover.ts`) or
   extraction (`extract.ts`).
5. Run the goldens and the mutation suite. A changed golden is reviewed like code; a new `silent` or `over-hide`
   verdict is a bug.
6. A new detector, observation or strategy id goes into the protocol registry (`packages/protocol/src/report-codes.ts`)
   and the adapter's `ids`, and the Cloud is deployed with it, before an extension that sends it ships.
7. Bump the adapter `version` (for example `linkedin@2026.10.2`) so reports show which detection a report used. Date
   it in the month you build it, never ahead: the Cloud's report alerts ignore a version dated in a future month
   (`latestAdapterOrder`), and `contract.test.ts` fails on one.
8. Add a changeset: `pnpm changeset` → patch.

## Adding a new platform

1. Add the id to `PLATFORMS` and `PLATFORM_PREFIX` in `packages/protocol/src/platform.ts` (additive change), and its
   detector, observation and strategy ids and landmark keys to `packages/protocol/src/report-codes.ts`.
2. Create `packages/platforms/src/<platform>/` with:
   - `markers/en.ts`: text and aria-label markers for the English UI. Labels are `LabelPattern`s
     (`shared/labels.ts`: heads, known tails, the words that make it something else), so a reworded label still counts,
     as weaker evidence, and is reported. Sentence markers stay regexes, read on header lines only and anchored so
     names cannot match.
   - `extract.ts`: reads one feed item into `PostData`. Every signal records `evidence` with a strength:
     **strong** (an explicit label or link the platform uses for that thing), **medium**, or **weak** (a hint), and
     core's `signalStrength` decides (one strong; two medium; or medium plus weak). Labels are read only in label
     positions (the age slot, header lines, header buttons), never in post text, comments or shared posts.
   - `slots.ts`: layered locators for each part of a post (class, then test id, then accessible name, then structure);
     the locator that won is recorded as an observation (`<prefix>.slot.<part>.<locator>`).
   - `discover.ts`: item discovery strategies, cheapest first (today's selector first). Each is scored on a sample of
     items (author, action bar, age slot, menu, text, `shared/structure.ts`), and another takes over only after
     beating the current one by 0.15 on 2 health ticks in a row. A fallback winning puts the page in cautious mode.
   - `routes.ts`: `classifyRoute` (`feed`, `feed-candidate` or `not-feed`), `homeSignature` (`strong` when the page's
     structure says it is the home feed) and `signedIn` (a signed-in shell, found by where its links go, so a login
     page or a consent wall never counts as breakage).
   - `ids.ts`: every detector, observation, strategy and landmark id the adapter can emit.
   - `adapter.ts`: implements `PlatformAdapter` (`packages/platforms/src/types.ts`), with the hooks above, `ids`,
     `discovery()` and `rediscover()`. An item holding several posts inspects as `ignore` with
     `<prefix>.item.multi-post`, and never hides.
3. Register it in `adapterFor()` (`packages/platforms/src/index.ts`).
4. Add golden pages for it to `packages/platforms/test/golden/goldens.ts` (anonymized captures and pages from its
   builders), add its capture script under `scripts/capture/` with a `KEEP` list the capture-vocab test checks, and
   make the mutation suite pass: no `silent`, no `over-hide`, and the false-positive probes change nothing.
5. Add a content script entrypoint in `apps/extension/src/entrypoints/<platform>.content/index.ts` that calls
   `bootContentScript(adapter, ctx)`, and add the host to `host_permissions` in `apps/extension/wxt.config.ts`.
6. In `apps/extension/src/entrypoints/background.ts`, add the host to `FEED_HOSTS` (otherwise the background refuses
   that site's classification and tab-state messages) and to the host → script map and URL list in
   `injectIntoOpenTabs()`. Add the feed URL to `FEED_URLS` and the site to `platformOfUrl()` in
   `apps/extension/src/lib/hooks.ts`.
7. Add the platform to settings defaults (`packages/core/src/settings/defaults.ts`) and presets. A new platform's
   Balanced leaves the not-followed rule **off** (a condition in `presetValues`) until it passes the live accuracy
   gate in [fixtures.md](fixtures.md), as Facebook's did until settings version 2; turning it on then needs a
   settings migration like version 2's, so people on the old Balanced move to the new one.
8. Add a Settings pane entry in `apps/extension/src/entrypoints/options/nav.ts`.
9. Run `pnpm typecheck`: records keyed by `PlatformId` will point at anything else that needs the new platform.

## Calibrating the health thresholds

The breakage checks (`packages/core/src/health.ts`) compare a page with what a healthy feed looks like, so their
thresholds come from live numbers, not guesses. Before relying on them for a new platform (or after a big redesign):

1. Capture several pages across a few sessions and add them as golden pages.
2. Read the rates off the expect files: ads per post (`emitted` ad detectors over the posts), hidden per preset
   (`decisions`), header lines recognised and not (`li.header.unknown`-style observations), unlabelled ad cues.
3. Set each threshold so a healthy page trips it about once in 100,000 page loads at those rates (LinkedIn showed 25 %
   ads and Facebook about 18 %, so "no ads over 40 or 50 posts" and "more than half ads over 20 posts" are safe), and
   keep the report-only checks report-only until the rates are known.
4. The goldens pin the result: a healthy capture must stay `ok` on every preset.

## Rules every adapter follows

- **Read-only.** No adapter call (`inspect()`, discovery, the route hooks) mutates the DOM, clicks, focuses, scrolls
  or fetches. `checkAdapterContract()` from `@unalgorithm/platforms/testing` fails if one does. It also checks id
  prefixes, id stability, outermost items, the route hooks against the home feed and addresses that are never it, and
  that every id the adapter emits is in its `ids` and every one of its `ids` in the protocol registry. Call it from
  your adapter's tests; the golden check runs it on every golden page.
- **Stable ids**, prefixed with the platform (`li:`, `fb:`). Prefer the platform's own id; otherwise hash content
  that does not change as the post ages (no timestamps, no counts).
- **Outermost items only** from `findItems()`, in page order. Nested posts (a reshared post inside a post) belong to
  their outer item, and buttons inside them (a nested Follow) must not affect the outer post.
- **Fail open.** If the UI language is unsupported, `markersFor()` returns `null` and text detectors stay off.
  If you cannot tell whether the user follows the author, the relationship is `unknown`, which never hides. A fallback
  discovery strategy means cautious mode: only strong signals hide.
- **No content in diagnostics.** `probe()` returns landmark counts only, and observations are registry ids, never text.
- **Never click "See more".** Mark `textComplete: false` instead; the controller re-reads the item if the user
  expands it.

## Performance budget

Median `inspect()` at most 4 ms on fixtures, no content-script task over 50 ms, full discovery about 5 ms. The
controller does the scheduling; keep adapter queries scoped to the item (`el.querySelector`, not
`document.querySelector`).
