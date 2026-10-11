## What and why

<!-- What does this change, and why? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Unit tests, fixtures, E2E, manual check on a live feed (which site, which language)? -->

## Checklist

- [ ] Tests cover the change; detection changes include a fixture that reproduces the case
- [ ] Fixtures are anonymized (`pnpm fixtures:check` passes) and contain no real names, photos or post text
- [ ] Adapters stay read-only (no clicks, scrolling, focus or fetching on the platform)
- [ ] **Privacy impact:** no new data leaves the device, or the PR explains what and why (`PostForAI`, diagnostics, storage)
- [ ] Changeset added for user-visible changes (`pnpm changeset`)
- [ ] UI changes: screenshots in light and dark, keyboard-only check, copy follows the voice guide
