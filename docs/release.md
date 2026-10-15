# Releasing

## Two release trains

UnAlgorithm Feed ships from this repository on two trains, versioned independently. Neither train's tags trigger the
other's workflow.

| Train | Tag | Workflow | What it publishes |
|---|---|---|---|
| Extension | `vX.Y.Z` | `.github/workflows/release.yml` | The Chrome zip on a GitHub Release, then the Chrome Web Store (the steps below) |
| Server | `server-vX.Y.Z` | `.github/workflows/server-release.yml` | The image `ghcr.io/heitechsoft/unalgorithm-server` and a GitHub Release ([Server releases](#server-releases)) |

UnAlgorithm Cloud, HeitechSoft's hosted server, is not released from here: its private repository pins a server
release and builds the Cloud image from that tag (ADR 0007, [Pinning a release](#pinning-a-release)). Security fixes
follow their own rule: see [Security fixes](#security-fixes). Credit prices are dated: a raise is scheduled at least
30 days ahead, a cut can start at the next 00:00 UTC, and every part switches on its date: see
[Changing a price card](#changing-a-price-card).

## Versioning

The extension version lives in `apps/extension/package.json` and follows semver. Changes are described with
[Changesets](https://github.com/changesets/changesets): every user-visible PR adds one with `pnpm changeset`.

## Steps

1. Merging to `main` keeps a **Version packages** PR open (`.github/workflows/changesets.yml`). It bumps versions and
   writes `apps/extension/CHANGELOG.md`.
2. Review the changelog wording (it becomes the release notes), then merge the PR.
3. Tag the merge commit and push the tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
4. `release.yml` verifies (lint, typecheck, tests, fixtures, notices), checks the tag matches the version, builds
   `unalgorithm-<version>-chrome.zip`, writes `SHA256SUMS.txt`, attests build provenance and creates the GitHub
   Release. It runs in the protected `release` environment.
5. **Smoke test** the zip unpacked in a clean Chrome profile: onboarding opens, LinkedIn feed hides ads and suggested
   posts, popup counts match, Settings opens, no errors in the service worker console.
6. **Chrome Web Store** (manual during the preview): upload the same zip in the developer dashboard, update the
   listing and privacy disclosures if permissions or data use changed, submit for review.

## Chrome Web Store listing

- **Name:** UnAlgorithm Feed. It comes from `extName` in `apps/extension/public/_locales/en/messages.json`; never
  plain "UnAlgorithm" (see [brand.md](brand.md)). Publish from the HeitechSoft developer account, so the listing shows
  HeitechSoft as the developer, and open the long description with "UnAlgorithm Feed by HeitechSoft".
- 128 px icon, 1280×800 screenshots made from fixtures (never real feeds), promo tile, short and long descriptions
  with the non-affiliation line.
- **Website, support and privacy policy URLs:** `https://unalgorithm.app`, its help page and its privacy page once the
  website is live; until then the GitHub repo, SUPPORT.md and PRIVACY.md on GitHub. Update the store's data-use
  disclosures whenever PRIVACY.md changes.

## Before a store build carries the Cloud card

Store builds show the UnAlgorithm Cloud card only as "Coming soon". The working card, which signs in to UnAlgorithm
Cloud or another UnAlgorithm server (Settings → AI and onboarding), the `identity` permission it signs in with and the
`alarms` permission settings sync runs on are added only when `UA_CLOUD=1` is set (`cloudEnabled()` in
`apps/extension/wxt.config.ts`; development and e2e builds always have them). A store build may carry them only when
all nine of these are done:

1. The UnAlgorithm Cloud beta privacy notice and beta terms are live on unalgorithm.app.
2. The Chrome Web Store data-use answers and the justification for the `identity` permission are updated, ready to
   submit with this release.
3. PRIVACY.md describes the server source (what is sent, to whom, what UnAlgorithm Cloud keeps), in the same release.
4. The store extension's id is in `EXTENSION_IDS` on UnAlgorithm Cloud, so the Cloud accepts its sign-in.
5. Invitees are still limited to the sign-up allowlist (`SIGNUP_ALLOWLIST`) until the public launch.
6. The privacy impact assessment for UnAlgorithm Cloud (Quebec Law 25) is started, in HeitechSoft's private
   repository.
7. PRIVACY.md has the sections *When you sign in to an UnAlgorithm server* and *Sync between your computers*, and an
   *Alarms* row in its permissions table (the text is drafted in HeitechSoft's private repository with the store
   answers). CI's privacy-gate test (`apps/extension/tests/privacy-gate.test.ts`) refuses the release workflow
   otherwise.
8. The Chrome Web Store data-use answers cover sync.
9. Remove the store-build line under the admin page's pass-on sentence (`apps/web/src/AdminInvites.tsx`, CL4-09) in the
   same release.

Then, in the same release PR that updates PRIVACY.md, set `UA_CLOUD: "1"` in the `env` of the "Build zip" step of
`release.yml`. Until that PR, `release.yml` never sets it.

```yaml
      - name: Build zip
        run: pnpm zip
        env:
          UA_CLOUD: "1"
```

## Server releases

The self-hostable server (`apps/server`) has a release train of its own: tags `server-vX.Y.Z`, built by
`.github/workflows/server-release.yml` into the public image `ghcr.io/heitechsoft/unalgorithm-server`. The extension's
`v*.*.*` tags and the server's `server-v*.*.*` tags never trigger each other's workflow. The steps above are for the
extension.

### Versioning

The server version lives in `apps/server/package.json` and follows semver, independently of the extension. A PR that
changes the server adds a changeset for `@unalgorithm/server` (`pnpm changeset`); the **Version packages** PR bumps the
version and writes `apps/server/CHANGELOG.md`, whose section for the version becomes the release notes. A release with
no changelog section gets the heading "UnAlgorithm Feed server X.Y.Z".

### Steps

1. Review the `apps/server/CHANGELOG.md` wording in the **Version packages** PR, then merge it.
2. Tag the merge commit and push the tag:
   ```bash
   git tag server-v0.1.0 && git push origin server-v0.1.0
   ```
3. `server-release.yml`'s `verify` job installs the dependencies and runs lint, typecheck, tests and the server
   licence check with a read-only token.
4. Approve the deployment: the `publish` job runs in the protected `release` environment and waits for a reviewer. It
   holds the write, OIDC and attestation rights and runs no pnpm or project dependency on the runner. It checks the tag
   matches the version in `apps/server/package.json` (a mismatch fails the job before anything is pushed), builds and
   pushes the image, attests its build provenance and creates the GitHub Release.
5. First server release only: make the image public before announcing it (see *What is published*).

### The `release` environment

Both trains deploy through the same protected `release` environment. Its deployment tag rules (Settings → Environments
→ release → Deployment branches and tags) must list both patterns, each of type tag:

- `v*.*.*` for the extension;
- `server-v*.*.*` for the server. Without it, the server job is rejected before any step runs instead of waiting for
  approval.

Add the server rule before pushing the first server tag, then check that this call lists both patterns, each with
`"type": "tag"`:

```bash
gh api repos/HeitechSoft/unalgorithm/environments/release/deployment-branch-policies
```

### What is published

- The image `ghcr.io/heitechsoft/unalgorithm-server:X.Y.Z`, and `:latest` moved to it. The image carries an SBOM and
  BuildKit provenance, and its OCI labels name the source repository, the licence (AGPL-3.0-only) and the version.
- A build provenance attestation for the image digest, stored in the registry and on GitHub. Anyone can check it:
  ```bash
  gh attestation verify oci://ghcr.io/heitechsoft/unalgorithm-server:X.Y.Z --repo HeitechSoft/unalgorithm
  ```
- A GitHub Release titled "UnAlgorithm Feed server X.Y.Z" with the changelog section and install notes. It is never
  marked Latest, so the repository's Latest release stays the extension, which is what store users look for.

**After the first release, once:** GHCR creates `ghcr.io/heitechsoft/unalgorithm-server` as a private package on the
first push, because a package takes its repository's access permissions but not its visibility. The GitHub Release
from the same run already tells self-hosters to pull the image, so right after the first `server-v0.1.0` run a
HeitechSoft organization owner makes it public: the organization's Packages tab → `unalgorithm-server` → Package
settings → Danger Zone → Change visibility (the organization's package creation settings must allow public packages).
Before announcing the release, check that it pulls without signing in:

```bash
docker logout ghcr.io && docker pull ghcr.io/heitechsoft/unalgorithm-server:0.1.0
```

A public package cannot be made private again, and later releases push to the same package, so this is needed once.

### Pinning a release

Self-hosters pin a release with `UNALGORITHM_VERSION=X.Y.Z` in the `.env` next to `apps/server/compose.yaml`
(unset, compose runs `latest`), and upgrade by changing it and running `docker compose pull && docker compose up -d`.
A running server reports its release as `version` in `/.well-known/unalgorithm.json`, and `source` links to the
`server-vX.Y.Z` tree unless `SOURCE_URL` names the source of a modified build.

UnAlgorithm Cloud, HeitechSoft's hosted server, pins a server release in its private repository and builds its image
from that tag (ADR 0007), so its `/.well-known/unalgorithm.json` reports the public release it runs.

### After restoring a database

Restoring a database, and starting a new sync epoch after it, follows [Restore after losing the server](self-hosting.md#11-restore-after-losing-the-server) in the self-hosting guide.

## Changing a price card

Credit prices are a dated schedule, `CREDIT_PRICE_SCHEDULE` in `packages/protocol/src/price-schedule.ts`. An entry's
price cards apply from its `effectiveFrom` (00:00 UTC of that day) until the next entry's. Each part finds the price in
effect by itself:

- UnAlgorithm Cloud's billing module prices each request at the instant the server checks it (`checkedAt`).
- The account page and the extension's "about N posts" use the time they show it.
- The website is built from `main`.

### The rules

The `price-schedule` CI job enforces them on pull requests and pushes to `main`:

- A price in effect is never changed or removed.
- A new or changed entry starts at a 00:00 UTC after its merge, never in the past.
- Within `PRICE_NOTICE_DAYS` (30) days of the merge, no task may charge (its multiplier) or publish (its price per 1,000
  posts) more than before, and no price may rise on a date where it did not already rise. So a raise, the end of a cut
  included, is dated at least 30 days ahead, and a scheduled cut that falls within those 30 days cannot be cancelled.
- A cut may take effect from the next 00:00 UTC, and a scheduled raise may be lowered or cancelled before its date.
- An entry not yet in effect may be removed, unless that raises a price within the 30 days.

`server-release.yml` checks the first rule again before it builds an image, against the previous `server-v*` release.

### Adding a task

`CREDIT_TASKS` (`packages/protocol/src/billing.ts`) lists the tasks a server may charge for. Tasks are only ever added,
and adding one never edits an entry in effect. The shape check enforces:

- Every card key is a `CREDIT_TASKS` member, and every entry prices `classify`.
- An entry prices every task the entry before it priced: a task is never dropped.
- A task first appears in a new dated entry, from the next 00:00 UTC or later, that copies every card of the entry
  before it unchanged.
- A card's `unit`, when set, is the task's unit (`TASK_UNITS`: post, check, comparison); its reference cost is per
  1,000 of those. A `factcheck` or `perspectives` card has its `unit` and a `maxChargeMicros`, the most one job is
  charged (the hold cap), at least its typical price per unit. A `classify` card has no `maxChargeMicros`.

There is deliberately no rule that the last entry prices every task: a task can be in `CREDIT_TASKS` before the entry
that first prices it. Until that entry is in effect the task is not offered (`taskPriceAt`), and a billing server
refuses its jobs. A task's first card is not a raise; after it, the notice rule applies to it like any other card, and
a higher `maxChargeMicros` is a raise. Adding a task follows [The procedure](#the-procedure) like any other entry.

`perspectives` was added this way: its first card is the 2026-11-01 entry (2×, hold cap $0.50), which copies the
2026-10-01 classify card unchanged.

### Merging a schedule change

The check uses its run's clock, and GitHub does not run it again at merge. On the day you merge a pull request that
touches the schedule, re-run its `price-schedule` check first and merge only on green. Merge a cut early enough that
its push-to-`main` run and steps 2 to 4 below finish before 00:00 UTC of its date.

A red `price-schedule` run on `main` is fixed before any server release, with two exceptions that need no fix:

- A cut merged after its date, or whose push run started after its date, stays as merged. Rule 1 still holds at release
  (the previous release lacks the entry), no release charges a date already past, and the Cloud charges the previous
  card until it runs the cut.
- The restoration below, whose own push run is red as expected.

When the red run is a price in effect that was removed, the fix restores the entry exactly. The check refuses that
restoration as a backdated entry, so it is merged with a code-owner (@TomHeiber) override of that one check. The
override is used for nothing else.

### The procedure

All of it is done before the effective date:

1. Add the entry, with the code owner's sign-off (@TomHeiber) and changesets for the server and the extension, and
   merge it.
2. Cut a `server-vX.Y.Z` release ([Server releases](#server-releases)).
3. HeitechSoft adds the same entry to the Cloud module's multiplier schedule, pins that release, and deploys the Cloud.
   The module's CI and its start-up check refuse a schedule that differs from the release's, future entries included.
4. Release the extension (`vX.Y.Z`, [Steps](#steps)) built from a commit with the entry.
5. Deploy the website.

**Price cuts.** A cut may take effect from the next 00:00 UTC; raises keep the 30-day notice. Date a cut at the first
00:00 UTC by which the server release and the Cloud deploy (steps 2 and 3) can be done, and release the server, deploy
the Cloud and release the extension (steps 1 to 4) before that date. The Cloud keeps charging the previous card until
it runs a release with the cut, and the ledger records which card priced each request (`price_from`). A cut is never
cancelled because a step is late (within 30 days of its date the check refuses that): finish the late steps as soon as
possible. An extension release that trails the cut is harmless: older extensions estimate fewer posts than the balance
buys. The website is redeployed on or after the date, and only once the Cloud runs the cut (step 5 is not needed
before it): until then it shows the earlier, higher price, never a lower one than the Cloud charges.

On the date, at 00:00 UTC, each part switches by itself:

- the Cloud charges requests checked from then on at the new card;
- the account page shows the new price;
- extensions with step 4's release estimate at it.

The website is the exception. It is static, so it cannot switch by itself. Every line on it about a scheduled price is
dated, so a scheduled change stays true on it. Deploy it again on or after the date so its first line and its examples
move to the new card (after a cut, once the Cloud runs it); until that deploy it shows the earlier, higher price.

Older installed extensions estimate at the old price until Chrome updates them; the balance itself always comes from
the server. A raise's notice period leaves time for those updates; after a cut they estimate fewer posts than the
balance buys, never more.

### Cancelling

Before the date, a change is cancelled by removing its entry, except a cut within 30 days of its date: removing it
would raise a price people were told, and the check refuses it. Steps 2 to 5 are repeated before the date, the
extension release included, or installed extensions estimate at the cancelled price from that date. If any step of a
raise, or of a cut more than 30 days from its date, cannot be finished before the date, cancel the change, also before
the date; a cut within 30 days of its date is never cancelled because a step is late (Price cuts, above).

A cancellation that has not reached the Cloud by the date leaves that price in effect: the Cloud charges it from 00:00
UTC and then refuses to start on a release without it. So the entry is restored on `main` (the override above) and is
changed from then on only by a new dated entry (a cut back to the earlier price can start at the next 00:00 UTC).

### Once in effect, no rollback

There is no rollback of a price in effect. A wrong price is corrected by a new dated entry: a lower price from the next
00:00 UTC, a higher one with 30 days' notice.

### The starter credit

`STARTER_CREDIT` (`packages/protocol/src/billing.ts`) is not a price and is not dated. A change to it is merged,
released in a `server-vX.Y.Z`, pinned and deployed on the Cloud, released in the extension, and only then shown by a
website deploy. The website is not deployed between the merge and the Cloud deploy unless from a commit whose
`STARTER_CREDIT` equals the running Cloud release's. It is reverted the same way.

## Security fixes

Vulnerabilities are reported privately ([SECURITY.md](../SECURITY.md)), and their fixes stay private until they are
released.

- **Extension:** the fix ships in the next `vX.Y.Z` release.
- **Server:** the fix may reach UnAlgorithm Cloud before the public server release, as in any coordinated disclosure
  (ADR 0007). The public `server-vX.Y.Z` release with the fix follows within 30 days of the Cloud fix, or at once if
  the issue is already public.
- The GitHub security advisory is published with the public release and names the server release that fixes the issue
  (and the extension release, when the extension changed too), so self-hosters know which `UNALGORITHM_VERSION` to
  pin.
