# Releasing

## What is released here

The extension is released from this repository: `vX.Y.Z` tags, built by `.github/workflows/release.yml` into the Chrome
zip on a GitHub Release, then the Chrome Web Store (the steps below).

The server (`apps/server`) is not released from here: no tags, no GitHub Releases and no public images (Tom,
2026-10-16). It runs unAlgorithm Cloud, whose private repository builds the Cloud image from a pinned commit of this
repository (ADR 0007, amended; [The server](#the-server)). Its source stays public here. Security fixes follow their
own rule: see [Security fixes](#security-fixes). Credit prices are dated: a raise is scheduled at least 30 days ahead,
a cut can start at the next 00:00 UTC, and every part switches on its date: see
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

The paste-ready listing, permission justifications and data-use answers are in [store-listing.md](store-listing.md),
and the screenshots and promo tiles in [store/](store/).

- **Name:** unAlgorithm Feed. It comes from `extName` in `apps/extension/public/_locales/en/messages.json`; never
  plain "unAlgorithm" (see [brand.md](brand.md)). Publish from the HeitechSoft developer account, so the listing shows
  HeitechSoft as the developer, and open the long description with "unAlgorithm Feed by HeitechSoft".
- 128 px icon, 1280×800 screenshots made from fixtures (never real feeds), promo tile, short and long descriptions
  with the non-affiliation line. `pnpm --filter @unalgorithm/extension store:screens` remakes the screenshots and
  `node scripts/make-icons.mjs --store` the promo tiles.
- **Website, support and privacy policy URLs:** `https://unalgorithmfeed.com/`, `https://unalgorithmfeed.com/help/`
  and `https://unalgorithmfeed.com/privacy/` once the website is live; until then the GitHub repo, SUPPORT.md and
  PRIVACY.md on GitHub. The website's privacy page is built from PRIVACY.md, so a merged change reaches it with the
  website's next deploy. Update the store's data-use disclosures whenever PRIVACY.md changes.

## Before a store build carries the Cloud card

Store builds show the unAlgorithm Cloud card only as "Coming soon". The working card, which signs in to unAlgorithm
Cloud or another unAlgorithm server (Settings → AI and onboarding), the `identity` permission it signs in with and the
`alarms` permission settings sync runs on are added only when `UA_CLOUD=1` is set (`cloudEnabled()` in
`apps/extension/wxt.config.ts`; development and e2e builds always have them). A store build may carry them only when
all nine of these are done:

1. The unAlgorithm Cloud beta privacy notice and beta terms (`CLOUD-BETA-NOTICE.md`, `CLOUD-BETA-TERMS.md`) are live on
   unalgorithmfeed.com at `/cloud/beta-privacy` and `/cloud/beta-terms`.
2. The Chrome Web Store data-use answers and the justification for the `identity` permission are updated, ready to
   submit with this release.
3. PRIVACY.md describes the server source (what is sent, to whom, what unAlgorithm Cloud keeps), in the same release.
4. The store extension's id is in `EXTENSION_IDS` on unAlgorithm Cloud, so the Cloud accepts its sign-in.
5. Invitees are still limited to the sign-up allowlist (`SIGNUP_ALLOWLIST`) until the public launch.
6. The privacy impact assessment for unAlgorithm Cloud (Quebec Law 25) is started, in HeitechSoft's private
   repository.
7. PRIVACY.md has the sections *When you sign in to an unAlgorithm server* and *Sync between your computers*, and an
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

## The server

The server version lives in `apps/server/package.json` and follows semver, independently of the extension. A PR that
changes the server adds a changeset for `@unalgorithm/server` (`pnpm changeset`); the **Version packages** PR bumps the
version and writes `apps/server/CHANGELOG.md`, the server's history. The server is not tagged or released here.

unAlgorithm Cloud's private repository pins a commit of this repository's `main`, builds the Cloud image from it
(`apps/server/Dockerfile`, with the repository root as the build context) together with its billing module, and deploys
it. Before it builds, it checks that no price in effect changed since the commit it last deployed
(`scripts/check-price-schedule.mjs --base <that commit> --in-effect-only`). A running server reports its `version`
from `apps/server/package.json` in `/.well-known/unalgorithm.json`, and the Cloud sets `SOURCE_URL` to the pinned
commit's tree, so `source` there links to the exact code it runs (AGPL section 13).

The image `ghcr.io/heitechsoft/unalgorithm-server:0.2.0`, pushed on 2026-10-16 before this change, stays private and is
not updated.

### After restoring a database

A database is restored with the backup's private key through `apps/server/backup/restore.sh` (`--check`, then `--yes`
with the server stopped), into the same server release or a newer one, never an older one. Then
`apps/server/src/cli/sync-new-epoch.ts` starts a new sync epoch, so every browser syncs again from the restored copy.

## Changing a price card

Credit prices are a dated schedule, `CREDIT_PRICE_SCHEDULE` in `packages/protocol/src/price-schedule.ts`. An entry's
price cards apply from its `effectiveFrom` (00:00 UTC of that day) until the next entry's. Each part finds the price in
effect by itself:

- unAlgorithm Cloud's billing module prices each request at the instant the server checks it (`checkedAt`).
- The account page and the extension's "about N posts" use the time they show it.
- The website is built from `main`: its "How credits work" page (`docs/site/credits.md`) is filled at build time by
  `creditsMarkdown` (`packages/core`), from the entry in effect then and the next dated change. Its examples of buying
  credit and the calculator's data (`calculatorData`) come from the same entries and the amount rules
  (`CREDIT_AMOUNT_MIN_MICROS`, `CREDIT_AMOUNT_MAX_MICROS`, `CREDIT_AMOUNT_PRESETS`, `DEFAULT_CREDIT_AMOUNT` in
  `packages/protocol/src/billing.ts`, the only place they are stated).

### The rules

The `price-schedule` CI job enforces them on pull requests and pushes to `main`:

- A price in effect is never changed or removed.
- A new or changed entry starts at a 00:00 UTC after its merge, never in the past.
- Within `PRICE_NOTICE_DAYS` (30) days of the merge, no task may charge (its multiplier) or publish (its price per 1,000
  posts) more than before, and no price may rise on a date where it did not already rise. So a raise, the end of a cut
  included, is dated at least 30 days ahead, and a scheduled cut that falls within those 30 days cannot be cancelled.
- A cut may take effect from the next 00:00 UTC, and a scheduled raise may be lowered or cancelled before its date.
- An entry not yet in effect may be removed, unless that raises a price within the 30 days.

unAlgorithm Cloud's private build checks the first rule again (`--in-effect-only`) before it builds an image, against
the commit it last deployed ([The server](#the-server)).

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

`perspectives` (UnEcho Chamber) and `factcheck` were added this way, together: both are first priced in the 2026-10-18
entry (`perspectives` 2×, hold cap $0.50; `factcheck` 2×, hold cap $0.40), which copies the 2026-10-01 classify card
unchanged. That entry replaced the 2026-11-01 entry (`perspectives`) and the 2026-12-01 entry (`factcheck`), scheduled
earlier at the same cards, before either took effect.

### Merging a schedule change

The check uses its run's clock, and GitHub does not run it again at merge. On the day you merge a pull request that
touches the schedule, re-run its `price-schedule` check first and merge only on green. Merge a cut early enough that
its push-to-`main` run and steps 2 and 3 below finish before 00:00 UTC of its date.

A red `price-schedule` run on `main` is fixed before the Cloud deploys a commit after it, with two exceptions that
need no fix:

- A cut merged after its date, or whose push run started after its date, stays as merged. Rule 1 still holds at the
  Cloud build (the previously deployed commit lacks the entry), no build charges a date already past, and the Cloud
  charges the previous card until it runs the cut.
- The restoration below, whose own push run is red as expected.

When the red run is a price in effect that was removed, the fix restores the entry exactly. The check refuses that
restoration as a backdated entry, so it is merged with a code-owner (@TomHeiber) override of that one check. The
override is used for nothing else.

### The procedure

All of it is done before the effective date:

1. Add the entry, with the code owner's sign-off (@TomHeiber) and changesets for the server and the extension, and
   merge it.
2. HeitechSoft adds the same entry to the Cloud module's multiplier schedule, pins a commit with the entry, and deploys
   the Cloud ([The server](#the-server)). The module's CI and its start-up check refuse a schedule that differs from the
   pinned commit's, future entries included.
3. Release the extension (`vX.Y.Z`, [Steps](#steps)) built from a commit with the entry.
4. Deploy the website.

**Price cuts.** A cut may take effect from the next 00:00 UTC; raises keep the 30-day notice. Date a cut at the first
00:00 UTC by which the Cloud deploy (step 2) can be done, and deploy the Cloud and release the extension (steps 1 to 3)
before that date. The Cloud keeps charging the previous card until it runs a build with the cut, and the ledger records which card priced each request (`price_from`). A cut is never
cancelled because a step is late (within 30 days of its date the check refuses that): finish the late steps as soon as
possible. An extension release that trails the cut is harmless: older extensions estimate fewer posts than the balance
buys. The website is redeployed on or after the date, and only once the Cloud runs the cut (step 4 is not needed
before it): until then it shows the earlier, higher price, never a lower one than the Cloud charges.

On the date, at 00:00 UTC, each part switches by itself:

- the Cloud charges requests checked from then on at the new card;
- the account page shows the new price;
- extensions with step 3's release estimate at it.

The website is the exception. It is static, so it cannot switch by itself. Every line on it about a scheduled price is
dated, so a scheduled change stays true on it. Deploy it again on or after the date so its first line and its examples
move to the new card (after a cut, once the Cloud runs it); until that deploy it shows the earlier, higher price.

Older installed extensions estimate at the old price until Chrome updates them; the balance itself always comes from
the server. A raise's notice period leaves time for those updates; after a cut they estimate fewer posts than the
balance buys, never more.

### Cancelling

Before the date, a change is cancelled by removing its entry, except a cut within 30 days of its date: removing it
would raise a price people were told, and the check refuses it. Steps 2 to 4 are repeated before the date, the
extension release included, or installed extensions estimate at the cancelled price from that date. If any step of a
raise, or of a cut more than 30 days from its date, cannot be finished before the date, cancel the change, also before
the date; a cut within 30 days of its date is never cancelled because a step is late (Price cuts, above).

A cancellation that has not reached the Cloud by the date leaves that price in effect: the Cloud charges it from 00:00
UTC and then refuses to start on a build without it. So the entry is restored on `main` (the override above) and is
changed from then on only by a new dated entry (a cut back to the earlier price can start at the next 00:00 UTC).

### Once in effect, no rollback

There is no rollback of a price in effect. A wrong price is corrected by a new dated entry: a lower price from the next
00:00 UTC, a higher one with 30 days' notice.

### The starter credit

`STARTER_CREDIT` (`packages/protocol/src/billing.ts`) is not a price and is not dated. A change to it is merged,
pinned and deployed on the Cloud, released in the extension, and only then shown by a website deploy. The website is
not deployed between the merge and the Cloud deploy unless from a commit whose `STARTER_CREDIT` equals the running
Cloud build's. It is reverted the same way.

## Security fixes

Vulnerabilities are reported privately ([SECURITY.md](../SECURITY.md)), and their fixes stay private until they are
released.

- **Extension:** the fix ships in the next `vX.Y.Z` release.
- **Server:** the fix may reach unAlgorithm Cloud before it is merged here, as in any coordinated disclosure (ADR
  0007). It is merged to `main` within 30 days of the Cloud fix, or at once if the issue is already public.
- The GitHub security advisory is published when the fix is public and names the commit that fixes the server (and
  the extension release, when the extension changed too).
