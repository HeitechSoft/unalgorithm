# Contributing to UnAlgorithm Feed

Thanks for helping. UnAlgorithm Feed is maintained by HeitechSoft and built in the open. Bug reports, layout fixes,
translations, accessibility improvements and ideas are all welcome.

## Before you start

- **Layout broke?** Use *Why? → Wrong call* on a hidden post, or **Report a problem** in the popup. It opens an issue
  with anonymized diagnostics (versions, counts, detector names; never post text).
- **Bigger change?** Open an issue or a Discussion first so we can agree on the approach.
- **Security issue?** Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

```bash
npm i -g pnpm@10       # or `corepack enable` from an elevated shell
pnpm install
pnpm --filter @unalgorithm/extension exec playwright install chromium   # once: the browser for dev and E2E
pnpm dev               # launches Chromium with the extension and a persistent profile in apps/extension/.wxt/chrome-data
```

Node 22.12 or newer. Branded Google Chrome 137+ no longer loads unpacked extensions from the command line, so dev
uses Playwright's Chromium (set `UA_CHROME` to use another Chromium or Chrome for Testing). Sign in to LinkedIn or
Facebook in that dev profile once; it stays on your machine.

Useful commands:

| Command | What it does |
|---|---|
| `pnpm check` | Biome lint + format check, typecheck every package, unit tests |
| `pnpm format` | Format and apply safe fixes |
| `pnpm e2e` | Build in `e2e` mode and run Playwright: the real extension in Chromium against fixture pages |
| `UA_SERVER_E2E=1 pnpm e2e` | Also sign in to a real local server with an emailed code and label the feed through it (`e2e/cloud.spec.ts`), and show, lower and run out of a balance with the test billing module (`e2e/credits.spec.ts`). Needs Postgres and Mailpit (`docker compose -f apps/server/compose.dev.yaml up -d`) and `pnpm --filter @unalgorithm/web build` first |
| `pnpm fixtures:check` | Make sure captured fixtures contain no real names or post text |
| `pnpm scan:public` | Make sure no tracked file or commit holds a public IP address, server details or a key file |
| `pnpm licenses:server` | Make sure no server dependency is GPL, AGPL or LGPL, and none is MPL or unknown without a review |
| `pnpm changeset` | Describe a user-facing change for the changelog |

## Ground rules

1. **Read-only on the platforms.** Adapters only read what is on the page. Never click, scroll, focus, type, follow,
   like or fetch anything on someone's behalf. The adapter contract test enforces this.
2. **Fail open.** When detection is unsure, show the post. Weak signals never hide a post on their own.
3. **Privacy by construction.** Nothing that identifies an author (names, profile URLs, group names) may reach an
   AI request, a cache, a log or a diagnostic report. If you add a field to `PostForAI`, explain why in the PR.
4. **Rules work without AI.** AI is optional; every core feature must work with it off.
5. **Accessible and calm.** Follow the design system in `packages/ui` (tokens, components, copy voice). Run the
   axe E2E check. Ordinary posts get no injected UI.
6. **Anonymized fixtures only.** Use the capture scripts in `scripts/capture/`. Never commit a real person's name,
   photo, post or profile link.

## Pull requests

- Small, focused PRs with tests. Detection changes need a fixture that reproduces the case.
- Add a changeset for anything users will notice (`pnpm changeset`).
- CI must pass: lint, typecheck, unit tests, fixture check, build, E2E.
- Screenshots for UI changes, light and dark: `pnpm e2e` builds the extension and writes them to `screens/`.
- Contributions are accepted under a [Contributor License Agreement](CLA.md). HeitechSoft needs it to keep offering
  the project under AGPL-3.0, to run the server in UnAlgorithm Cloud together with its private billing module, and to
  license it commercially, for example to organizations running private deployments. **The CLA is still being
  finalized:** pull requests from outside contributors are welcome and will be reviewed, and they will be merged once
  the final CLA is published and signed. CI enforces this for code that ships in the server image (`apps/server`,
  `apps/web`, and `packages/sync`, `protocol`, `core`, `ai` and `ui`). A bot will then ask you to sign it with a
  comment.

## Style

TypeScript strict, Biome for formatting and lint (`pnpm format`). Prefer small pure functions in `packages/core`,
explicit types at package boundaries, and comments that explain *why*. UI copy: short, calm, honest; no exclamation
marks; AI decisions always labelled "can be wrong".

## Maintainers

See [MAINTAINERS.md](MAINTAINERS.md).

## Code of conduct

Everyone participating agrees to the [Code of Conduct](CODE_OF_CONDUCT.md).
