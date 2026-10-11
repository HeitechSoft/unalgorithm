# Adding or fixing a platform

Everything UnAlgorithm knows about a site's layout lives in `packages/platforms/src/<platform>/`. The feed
controller, rules, UI and AI are shared.

## When a site changes its layout

1. Reproduce it in the dev profile (`pnpm dev` or `pnpm dev:fb`).
2. Capture the broken items with the capture script ([fixtures.md](fixtures.md)) and save them under
   `packages/platforms/fixtures/<platform>/<yyyy-mm>-<what>.html`.
3. Write a failing test that loads the fixture and asserts what `inspect()` should return.
4. Fix the selectors (`selectors.ts`), markers (`markers/en.ts`) or extraction (`extract.ts`).
5. Bump the adapter `version` (for example `linkedin@2026.11.0`) so diagnostics show which detection a report used.
6. Add a changeset: `pnpm changeset` → patch.

## Adding a new platform

1. Add the id to `PLATFORMS` and `PLATFORM_PREFIX` in `packages/protocol/src/platform.ts` (additive change).
2. Create `packages/platforms/src/<platform>/` with:
   - `markers/en.ts`: text and aria-label patterns for the English UI. Anchor patterns (`^…$`) so names cannot match.
   - `extract.ts`: reads one feed item into `PostData`. Every signal records `evidence` with a strength:
     **strong** (an explicit label or link the platform uses for that thing), **medium**, or **weak** (a hint).
     Decide hiding thresholds so weak evidence never hides on its own.
   - `adapter.ts`: implements `PlatformAdapter` (`packages/platforms/src/types.ts`).
3. Register it in `adapterFor()` (`packages/platforms/src/index.ts`).
4. Add a content script entrypoint in `apps/extension/src/entrypoints/<platform>.content/index.ts` that calls
   `bootContentScript(adapter, ctx)`, and add the host to `host_permissions` in `apps/extension/wxt.config.ts`.
5. In `apps/extension/src/entrypoints/background.ts`, add the host to `FEED_HOSTS` (otherwise the background refuses
   that site's classification and tab-state messages) and to the host → script map and URL list in
   `injectIntoOpenTabs()`. Add the feed URL to `FEED_URLS` and the site to `platformOfUrl()` in
   `apps/extension/src/lib/hooks.ts`.
6. Add the platform to settings defaults (`packages/core/src/settings/defaults.ts`) and presets. New platforms start
   with the not-followed rule **off** until verified on live feeds, like Facebook
   (`FACEBOOK_NOT_FOLLOWED_VERIFIED`).
7. Add a Settings pane entry in `apps/extension/src/entrypoints/options/nav.ts`.
8. Run `pnpm typecheck`: records keyed by `PlatformId` will point at anything else that needs the new platform.

## Rules every adapter follows

- **Read-only.** `inspect()` must not mutate the DOM, click, focus, scroll or fetch. `checkAdapterContract()` from
  `@unalgorithm/platforms/testing` fails if it does (it also checks id prefixes, id stability and outermost items);
  call it from your adapter's tests.
- **Stable ids**, prefixed with the platform (`li:`, `fb:`). Prefer the platform's own id; otherwise hash content
  that does not change as the post ages (no timestamps, no counts).
- **Outermost items only** from `findItems()`, in page order. Nested posts (a reshared post inside a post) belong to
  their outer item, and buttons inside them (a nested Follow) must not affect the outer post.
- **Fail open.** If the UI language is unsupported, `markersFor()` returns `null` and text detectors stay off.
  If you cannot tell whether the user follows the author, the relationship is `unknown`, which never hides.
- **No content in diagnostics.** `probe()` returns landmark counts only.
- **Never click "See more".** Mark `textComplete: false` instead; the controller re-reads the item if the user
  expands it.

## Performance budget

Median `inspect()` at most 4 ms on fixtures, no content-script task over 50 ms. The controller does the scheduling;
keep adapter queries scoped to the item (`el.querySelector`, not `document.querySelector`).
