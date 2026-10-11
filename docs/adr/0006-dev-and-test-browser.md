# ADR 0006: Browser for development and end-to-end tests

- Status: Accepted
- Date: 2026-10-10

## Context

Branded Google Chrome 137+ ignores `--load-extension`, which both `web-ext` (used by `wxt dev`) and Playwright rely
on to load an unpacked extension. E2E tests must not touch live LinkedIn or Facebook.

## Decision

- **Development:** `wxt.config.ts` points `webExt.binaries.chrome` at Playwright's bundled Chromium (or `UA_CHROME`),
  with a persistent profile in `apps/extension/.wxt/chrome-data` so the developer signs in once. `web-ext` is a
  devDependency so the persistent profile options take effect.
- **E2E:** Playwright's bundled Chromium with `launchPersistentContext`, loading a `wxt build --mode e2e` output.
  Every request is aborted unless a test serves it; fixture pages are served at the real feed URLs so content
  scripts run on realistic markup. The e2e mode adds `http://127.0.0.1/*` for the mock AI server.

## Consequences

- Contributors install Chromium once (`pnpm --filter @unalgorithm/extension exec playwright install chromium`).
- E2E runs offline and deterministically on Ubuntu and Windows CI.
- Behaviour on live sites is verified manually with the dev profile.
