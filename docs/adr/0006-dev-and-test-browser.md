# ADR 0006: Browser for development and end-to-end tests

- Status: Accepted for the Chrome build; Edge and Firefox in ADR 0008
- Date: 2026-10-10

## Context

Branded Google Chrome 137+ ignores `--load-extension`, which Playwright relies on to load an unpacked extension (and
which `web-ext` used then; `web-ext` 10.7 loads it over the DevTools pipe with `Extensions.loadUnpacked` first). E2E
tests must not touch live LinkedIn or Facebook.

## Decision

- **Development:** `wxt.config.ts` points `webExt.binaries.chrome` at Playwright's bundled Chromium (or `UA_CHROME`),
  with a persistent profile in `apps/extension/.wxt/chrome-data` so the developer signs in once. `web-ext` is a
  devDependency so the persistent profile options take effect.
- **E2E:** Playwright's bundled Chromium with `launchPersistentContext`, loading a `wxt build --mode e2e` output.
  Every request is aborted unless a test serves it; fixture pages are served at the real feed URLs so content
  scripts run on realistic markup. The e2e mode adds `http://127.0.0.1/*` for the mock AI server.

ADR 0008 adds the other two browsers on the same rules: `pnpm dev:edge` runs the installed Microsoft Edge (or
`UA_EDGE`) with its own profile in `.wxt/edge-data`, and the `edge` Playwright project runs the same specs in branded
Edge, with the build loaded over `Extensions.loadUnpacked`. `pnpm dev:firefox` runs Firefox with the build as a
temporary add-on and a profile in `.wxt/firefox-data`, and the `firefox` project runs its own specs through Puppeteer
over WebDriver BiDi.

## Consequences

- Contributors install Chromium once (`pnpm --filter @unalgorithm/extension exec playwright install chromium`).
  `UA_CHROMIUM` runs the e2e tests in another Chromium.
- E2E runs offline and deterministically on Ubuntu and Windows CI, in Chromium and Edge; Firefox's run on Ubuntu.
- Behaviour on live sites is verified manually with the dev profile.
