# Releasing

## What is released here

The extension is released from this repository: `vX.Y.Z` tags, built by `.github/workflows/release.yml` for Chrome,
Microsoft Edge and Firefox in one step, attached to a GitHub Release and sent to the three stores: the Chrome Web
Store, Firefox Add-ons (addons.mozilla.org, AMO) and Microsoft Edge Add-ons. A person publishes each version after the
smoke test (the steps below).

The server (`apps/server`) is not released from here: no tags, no GitHub Releases and no public images (Tom,
2026-10-16). It runs unAlgorithm Cloud, whose private repository builds the Cloud image from a pinned commit of this
repository (ADR 0007, amended; [The server](#the-server)). Its source stays public here. Security fixes follow their
own rule: see [Security fixes](#security-fixes). Credit prices are set on a server's Pricing page and dated: a raise
is scheduled at least 30 days ahead, a cut can start at the next 00:00 UTC, and every part switches on its date: see
[Prices](#prices).

## Versioning

The extension version lives in `apps/extension/package.json` and follows semver; one version covers every browser.
Changes are described with [Changesets](https://github.com/changesets/changesets): every user-visible PR adds one with
`pnpm changeset`.

## What a release carries

`pnpm zip` builds every file into `apps/extension/.output`, from one build of each browser ([ADR
0008](adr/0008-firefox-and-edge.md)):

| File | What it is |
|---|---|
| `unalgorithm-<version>-chrome.zip` | The Chrome Web Store upload |
| `unalgorithm-<version>-edge.zip` | The Microsoft Edge Add-ons upload: Chrome's manifest, built for Edge |
| `unalgorithm-<version>-firefox.zip` | The Firefox Add-ons upload, with the add-on id `feed@unalgorithmfeed.com` |
| `unalgorithm-<version>-sources.zip` | The source AMO builds the Firefox zip from: the extension, the workspace packages, the lockfile and [amo-build.md](amo-build.md) |
| `unalgorithm-<version>-sideload.zip` | Chrome's store build with the development key, for Load unpacked in Chrome and Edge: its id (`aokmlebkpkeniofcnbeajmgabinicggm`) is one unAlgorithm servers accept |
| `unalgorithm-<version>-firefox-sideload.xpi` | Only when the Firefox Add-ons credentials are set and AMO signed it during the run: Firefox's store build with the development id (`feed-dev@unalgorithmfeed.com`), signed by AMO as an unlisted add-on, since release Firefox installs only signed add-ons |
| `SHA256SUMS.txt` | Checksums of every file above, with a build provenance attestation |

The store zips never carry a key: each store gives its own id (the Firefox one is fixed in the manifest).

## Steps

1. Merging to `main` keeps a **Version packages** PR open (`.github/workflows/changesets.yml`). It bumps versions and
   writes `apps/extension/CHANGELOG.md`.
2. Review the changelog wording (it becomes the release notes), then merge the PR.
3. **Smoke test** the merge commit, before the tag: Firefox Add-ons publishes a version once it is signed, with no
   staged step. Use the `unalgorithm-zips` artifact of the commit's CI run, which `pnpm zip` built from the same
   commit, or run `pnpm zip` on it yourself (with `UA_CLOUD=1` once `release.yml` sets it: CI builds without it). In a
   clean profile of each browser:
   - **Chrome:** unzip the chrome zip, then `chrome://extensions`, Developer mode, **Load unpacked**.
   - **Edge:** the edge zip, the same way in `edge://extensions`.
   - **Firefox:** unzip the firefox zip, then `about:debugging`, **This Firefox**, **Load Temporary Add-on…**, and pick
     its `manifest.json`. A temporary add-on needs no signature.

   Each time: onboarding opens, the LinkedIn feed hides ads and suggested posts, popup counts match, **Open
   Highlights** opens the side panel (the sidebar in Firefox), Settings opens, and the background console (**Inspect**
   on the extension's card; in Firefox on `about:debugging`) shows no errors. With the Cloud card, also sign in to
   unAlgorithm Cloud (Firefox asks for its data-collection consent first), see the feed labelled through it, turn on
   sync between two of the browsers, and check the devices list names each one. A temporary add-on gets no install
   prompt, so Firefox's technical and interaction data starts off there and its device is unnamed: turn it on in
   `about:addons` (unAlgorithm Feed → Permissions and data) before signing in. An unpacked store zip gets an id of
   its own in Chrome and Edge, which the Cloud doesn't accept: test sign-in there with the sideload zip, the same
   build with the development id. The firefox zip keeps its store id.
4. If the release changes the permissions, the data use or the listing, save those changes in each store before the
   tag: the Chrome Web Store developer dashboard, without submitting (the tag submits the zip with whatever the
   dashboard holds, [what the API leaves to the dashboard](#chrome-web-store-credentials)); the listing pages of the
   add-on in the Firefox Add-ons Developer Hub; and, for Edge, the draft a person submits in step 8. Then tag the merge
   commit and push the tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
5. `release.yml` verifies (lint, typecheck, tests, fixtures, notices), checks the tag matches the version, builds every
   file with `pnpm zip`, runs Mozilla's add-on linter on the Firefox build (`scripts/check-firefox-lint.mjs`: no errors
   or notices, only the reviewed warnings) and rebuilds the Firefox zip from the sources zip to compare
   (`scripts/check-firefox-sources.mjs`). It has AMO sign the Firefox sideload build, writes `SHA256SUMS.txt`, attests
   build provenance, creates the GitHub Release, and then sends the store zips: to the Chrome Web Store for review with
   staged publishing, to Firefox Add-ons on the listed channel with the sources zip, and to Microsoft Edge Add-ons as a
   draft. It runs in the protected `release` environment. Until a store's credentials are set, its step only leaves a
   notice. The signed sideload is optional: if AMO doesn't sign it (an error, or no approval within web-ext's 15
   minutes), its step only leaves a warning, and the release and the store submissions go out without the `.xpi`
   ([The signed sideload](#the-signed-sideload)).
6. **Chrome Web Store:** once the review passes, the version waits in the developer dashboard instead of going live.
   Publish it from the item's page when the smoke test has passed, within 30 days of approval (after that it goes back
   to draft and needs a new review). If the smoke test fails, don't publish it: cancel the submission if it is still in
   review, and release a fixed version. If the submission step was skipped or failed, the GitHub Release is already
   made: upload its zip in the dashboard and submit it for review by hand, with publishing deferred.
7. **Firefox Add-ons:** AMO checks and signs the version, usually within a day, and it goes live at once; a reviewer
   may still look at it later and ask questions by email. If the step was skipped or failed, upload the firefox zip
   by hand on the add-on's Developer Hub page (**Upload New Version**), answer yes to the source code question and
   upload the sources zip, and paste the Notes for Reviewers from [store-listing-firefox.md](store-listing-firefox.md).
   If a live version turns out broken, release a fixed one; disabling a version in the Developer Hub takes it down for
   new installs.
8. **Microsoft Edge Add-ons:** the new package waits as a draft in Partner Center. Check the listing, paste the Notes
   for certification from [store-listing-edge.md](store-listing-edge.md) and **Publish**. Certification can take up to
   seven business days, and the version goes live as soon as it passes. If the step was skipped or failed, upload the
   edge zip on the extension's **Packages** page first.

A failed run can't simply run again for the same version once a store has it: AMO refuses a version number it has
already received, signed sideload included. Fix what failed by hand as above, or release the next patch version.

### The signed sideload

A release without `unalgorithm-X.Y.Z-firefox-sideload.xpi` tells Firefox users, in its notes, to try the firefox zip
as a temporary add-on until Firefox Add-ons has the version. When that happened although the Firefox Add-ons
credentials are set, the "Signed Firefox sideload" step's warning says why. If AMO received the version and signs it
later, download the signed file from the `feed-dev@unalgorithmfeed.com` add-on's versions page in the Developer Hub,
name it `unalgorithm-X.Y.Z-firefox-sideload.xpi`, and attach it:

```bash
gh release upload vX.Y.Z unalgorithm-X.Y.Z-firefox-sideload.xpi
```

Then edit the release notes' Firefox line to what `scripts/release-notes.mjs` writes when the file is there ("open
`unalgorithm-X.Y.Z-firefox-sideload.xpi` in Firefox and add it…"). A file attached this way is not in `SHA256SUMS.txt`
or the build provenance attestation; Mozilla's signature, which Firefox checks when it installs the file, vouches for
it. If AMO never received the version, this release stays without the file, and the next one carries it.

## Store listings

The paste-ready text for each store, with its permission notes, data answers and reviewer notes:

- Chrome Web Store: [store-listing.md](store-listing.md), the reference the others follow.
- Firefox Add-ons: [store-listing-firefox.md](store-listing-firefox.md).
- Microsoft Edge Add-ons: [store-listing-edge.md](store-listing-edge.md).

The screenshots and promo tiles in [store/](store/) serve all three stores.

- **Name:** unAlgorithm Feed. It comes from `extName` in `apps/extension/public/_locales/en/messages.json`; never
  plain "unAlgorithm" (see [brand.md](brand.md)). Publish from HeitechSoft's account in each store, so the listing
  shows HeitechSoft as the developer, and open the long description with "unAlgorithm Feed by HeitechSoft".
- 128 px icon, 1280×800 screenshots made from fixtures (never real feeds), promo tiles, short and long descriptions
  with the non-affiliation line. `pnpm --filter @unalgorithm/extension store:screens` remakes the screenshots and
  `node scripts/make-icons.mjs --store` the promo tiles.
- **Website, support and privacy policy URLs:** `https://unalgorithmfeed.com/`, `https://unalgorithmfeed.com/help/`
  and `https://unalgorithmfeed.com/privacy/` once the website is live; until then the GitHub repo, SUPPORT.md and
  PRIVACY.md on GitHub. The website's privacy page is built from PRIVACY.md, so a merged change reaches it with the
  website's next deploy. Firefox Add-ons keeps its own copy of the policy's text: paste it again when PRIVACY.md
  changes. Update every store's data disclosures whenever PRIVACY.md changes.

## Chrome Web Store credentials

`release.yml` submits through the Chrome Web Store API v2 (`wxt submit`, which runs `publish-browser-extension`), as a
Google Cloud service account added to the HeitechSoft publisher. To set it up once:

1. In the Google Cloud console, create a project for it (or pick HeitechSoft's) and enable the **Chrome Web Store
   API**.
2. Create a service account in that project. It needs no IAM roles. Add a JSON key to it (**Keys → Add key**).
3. In the [developer dashboard](https://chrome.google.com/webstore/devconsole/), on the HeitechSoft publisher, add the
   service account's email under **Account**. A publisher has one service account.
4. In the repository's **Settings → Environments → release**, add four environment secrets:
   - `CHROME_EXTENSION_ID`: the item's ID in the dashboard.
   - `CHROME_PUBLISHER_ID`: the publisher ID under **Publisher → Settings** in the dashboard.
   - `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`: `client_email` from the key.
   - `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`: `private_key` from the key, the whole PEM block (the step accepts it with
     line breaks or with the `\n` escapes of the JSON file), for example
     `jq -r .private_key key.json | gh secret set CHROME_SERVICE_ACCOUNT_PRIVATE_KEY --env release`.

   Then delete the key file. With none of the four set, the step skips with a notice; with only some, it fails. To
   change the key, add a new one, replace the secret and delete the old key in the console.

The API uploads the zip and submits it, nothing else. The store listing, screenshots, permission justifications and
data-use answers are changed by hand in the dashboard and saved before the tag (step 4), and the submission carries
them. That matters most for the `UA_CLOUD` release, which adds the `identity` and `alarms` permissions: both
justifications and the data-use answers for sign-in and sync are saved before it is tagged. The store takes one
submission at a time, so cancel a version still in review before tagging the next.

**Without a stored key (not set up):** GitHub's OIDC token can stand in for the JSON key through Google's Workload
Identity Federation. The job already has `id-token: write`. A workload identity pool trusting this repository's
`release` environment lets `google-github-actions/auth` (pinned by SHA, `token_format: access_token`,
`access_token_scopes: https://www.googleapis.com/auth/chromewebstore`) mint a short-lived token as the same service
account, passed to the step as `CHROME_SERVICE_ACCOUNT_ACCESS_TOKEN` in place of the email and key (the step's secret
check changes with it).

## Firefox Add-ons credentials

`release.yml` uses AMO's API twice, with one API key of HeitechSoft's AMO developer account: `wxt submit` sends the
firefox zip and its sources to the listed add-on `feed@unalgorithmfeed.com`, and `web-ext sign --channel unlisted`
has AMO sign the sideload build, `feed-dev@unalgorithmfeed.com`, for the GitHub Release.

1. **The first listed version is uploaded by hand**, because AMO needs the listing before its API takes versions: in
   the [Developer Hub](https://addons.mozilla.org/developers/), **Submit a New Add-on**, **On this site**, upload the
   firefox zip, answer yes to the source code question and upload the sources zip, then fill in the listing from
   [store-listing-firefox.md](store-listing-firefox.md). AMO ties the listing to `feed@unalgorithmfeed.com` for good:
   unAlgorithm servers key devices and the sign-in address to that id, so it never changes.
2. Under **Tools → Manage API Keys**, generate credentials. In the repository's **Settings → Environments →
   release**, add `FIREFOX_JWT_ISSUER` (the JWT issuer) and `FIREFOX_JWT_SECRET` (the JWT secret).

The first signed sideload creates the unlisted add-on `feed-dev@unalgorithmfeed.com` on the same account; nothing about
it is public. With neither secret set, both steps skip with a notice and the release has no signed Firefox file; with
only one, they fail. With both, a signing AMO doesn't complete only warns ([The signed sideload](#the-signed-sideload)).
To change the key, generate a new one in the Developer Hub (which revokes the old) and replace both secrets. AMO keeps
the listing text, the privacy policy and the reviewer notes; the API sends only the files.

## Microsoft Edge Add-ons credentials

`release.yml` uploads the edge zip through the Microsoft Edge Add-ons API (v1.1, `wxt submit`) and doesn't submit it
(`EDGE_SKIP_SUBMIT_REVIEW`): a certified version goes live at once, so a person submits it after the smoke test
([Steps](#steps), step 8).

1. **The first version is published by hand**, because the API only updates an extension that exists: in
   [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview), **Create new extension**, upload
   the edge zip, and fill in Availability, Properties, Store listings and the Notes for certification from
   [store-listing-edge.md](store-listing-edge.md).
2. Partner Center assigns the Edge store's own extension id, different from the Chrome Web Store's. unAlgorithm Cloud
   must list it in `EXTENSION_IDS` before a Cloud build is published there. If the id only shows once the extension is
   published, publish the first version with **Visibility: Hidden** (reachable only by its link), read the id, list it,
   then make it public.
3. On Partner Center's **Publish API** page, create API credentials. In the repository's **Settings → Environments →
   release**, add `EDGE_PRODUCT_ID` (the extension's product id on its overview page), `EDGE_CLIENT_ID` and
   `EDGE_API_KEY`.

With none of the three set, the step skips with a notice; with only some, it fails. API keys expire: Partner Center
shows when, and a new one replaces the secret.

## Before a store build carries the Cloud card

From 0.4.0, store builds carry the working unAlgorithm Cloud card; before that they showed it only as "Coming soon".
The working card, which signs in to unAlgorithm Cloud or another unAlgorithm server (Settings → AI and onboarding), the
`identity` permission it signs in with and the
`alarms` permission settings sync runs on are added only when `UA_CLOUD=1` is set (`cloudEnabled()` in
`apps/extension/wxt.config.ts`; development and e2e builds always have them). The switch reaches every browser at once:
`release.yml` builds all of them in its one `pnpm zip` step, and CI refuses a second build step or a package script
that sets it (`apps/extension/tests/privacy-gate.test.ts`). In Chrome and Edge, `identity` is asked for in the click
that signs in; Firefox grants `identity` and `alarms` with the extension, without a prompt, and asks for its
data-collection consent in that click instead (ADR 0008). A store build may carry them only when all ten of these are
done, for all three stores:

1. The unAlgorithm Cloud beta privacy notice and beta terms (`CLOUD-BETA-NOTICE.md`, `CLOUD-BETA-TERMS.md`) are live on
   unalgorithmfeed.com at `/cloud/beta-privacy` and `/cloud/beta-terms`.
2. Each store's answers for sign-in are saved before the release is tagged, since the tag submits the zips
   ([Steps](#steps), step 4):
   - Chrome Web Store: the data-use answers and the justifications for the `identity` and `alarms` permissions, in the
     dashboard.
   - Microsoft Edge Add-ons: the same answers wherever Partner Center asks for them, before the draft is submitted.
   - Firefox Add-ons: the listing's privacy policy text. AMO has no permission justifications; it reads the
     data-collection types from the manifest, and the Notes for Reviewers explain `identity` and `alarms`.
3. PRIVACY.md describes the server source (what is sent, to whom, what unAlgorithm Cloud keeps), in the same release.
4. Each store's id is in `EXTENSION_IDS` on unAlgorithm Cloud, so the Cloud accepts its sign-in: the Chrome Web Store
   id, the Microsoft Edge Add-ons id ([its credentials](#microsoft-edge-add-ons-credentials), step 2) and
   `feed@unalgorithmfeed.com`. A server must understand Firefox ids before it lists one (an older one refuses to start
   with one), so the Cloud runs such a server first, and its `/.well-known/unalgorithm.json` lists `chromium` and
   `gecko` in `auth.clients`.
5. Invitees are still limited to the sign-up allowlist (`SIGNUP_ALLOWLIST`) until the public launch.
6. The privacy impact assessment for unAlgorithm Cloud (Quebec Law 25) is started, in HeitechSoft's private
   repository.
7. PRIVACY.md has the sections *When you sign in to an unAlgorithm server* and *Sync between your computers*, and an
   *Alarms* row in its permissions table (the text is drafted in HeitechSoft's private repository with the store
   answers). They say how each browser grants `identity` and `alarms`, as above. CI's privacy-gate test
   (`apps/extension/tests/privacy-gate.test.ts`) refuses the release workflow otherwise.
8. Every store's data answers cover sync. For Firefox, the manifest's `data_collection_permissions`
   (`browser_specific_settings.gecko` in `apps/extension/wxt.config.ts`) are checked against Mozilla's data categories
   for everything sign-in and sync send, such as the device name and the synced settings, and changed in the same
   release if a type is missing. `technicalAndInteraction` may only decide whether the device name is sent: nothing
   may depend on it (Mozilla's add-on policies).
9. Remove the store-build line under the admin page's pass-on sentence (`apps/web/src/AdminInvites.tsx`, CL4-09) in the
   same release.
10. Each store that tests by hand has a reviewer account on unAlgorithm Cloud: Firefox Add-ons and Microsoft Edge
    Add-ons ask for test credentials when a feature needs an account. Use a mailbox made only for store reviews,
    invite it on the Cloud's admin page (an invite admits one address without opening sign-ups), sign in with it once
    and add review credit. Its address and password go only into the store's reviewer notes at submission, never into
    a repository. The Firefox reviewer builds from the sources with `UA_CLOUD=1` ([amo-build.md](amo-build.md)).

The 0.4.0 release PR, which added those PRIVACY.md sections, set `UA_CLOUD: "1"` in the `env` of the "Build zips" step
of `release.yml`, for all three browsers at once. Taking it out takes the card out of every store build again.

```yaml
      - name: Build zips
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

## Prices

What a server charges is its price book: the task prices (a dated schedule), the starter credit, the amounts one
purchase may add and the caps on automatic purchases. Its admins set it on the server's Pricing page (`/admin/prices`),
and the server keeps every change in `price_changes`, with when and which admin (the admin is never published). Until
an admin first saves, the server uses the code defaults, `DEFAULT_PRICE_BOOK` (`packages/protocol/src/prices.ts`):
`CREDIT_PRICE_SCHEDULE` (`packages/protocol/src/price-schedule.ts`), `STARTER_CREDIT`, the amount rules
(`CREDIT_AMOUNT_MIN_MICROS`, `CREDIT_AMOUNT_MAX_MICROS`, `CREDIT_AMOUNT_PRESETS`, `DEFAULT_CREDIT_AMOUNT` in
`packages/protocol/src/billing.ts`) and the auto-reload caps ($1,000 a month, two top-ups a day). The first save stores
those defaults as its first row, then the change. From then on, a release's code schedule no longer changes that
server's prices: only its Pricing page does.

Every save is checked by the server with [the rules](#the-rules) below and refused in plain words. The server runs the
same functions as the `price-schedule` CI job, which still guards the code schedule for servers that never saved.

An entry's price cards apply from its `effectiveFrom` (00:00 UTC of that day) until the next entry's. Each reader finds
the price in effect by itself, in the server's book, and reads the book at each use, so a save applies without a
restart:

- The server's offers and discovery (`jobPrices` and `classifyPrice` in `/.well-known/unalgorithm.json`), at the time
  they answer. The extension keeps the discovery document it last read and reads it again at most every 5 minutes
  while the server classifies for it, so its price lines and its "about N posts" follow a change within about 5
  minutes of the extension's next use of the server, not at the instant it takes effect.
- The account page, from the server's `/prices.json`, read with the account, at the time it shows it.
- The billing module, through the billing host (`host.prices`): it prices each request at the instant the server
  checks it (`checkedAt`), grants the starter credit, and checks purchases and automatic purchases from the same book.
  It keeps no copy.
- `/prices.json`, the book as published: public, cached for 5 minutes, with an ETag, and with no history and no admin.
  A server with `BILLING=off` charges nothing and publishes none.
- The website, at its build: its "How credits work" page (`docs/site/credits.md`, filled by `creditsMarkdown` in
  `packages/core`) and the calculator's data (`calculatorData`) come from unAlgorithm Cloud's `/prices.json`: the
  entry in effect then, every later change, each dated (a change dated before one already scheduled never hides it),
  and the amount rules.

### unAlgorithm Cloud's procedure

A price change on unAlgorithm Cloud is a save on its Pricing page. It needs no Cloud deploy and no extension release.

1. Save the change on `https://cloud.unalgorithm.app/admin/prices`. The Cloud charges from the book at once: a dated
   task price from its date, by itself, and the other parts as [When a change applies](#when-a-change-applies) says.
2. Deploy the website right after saving. Every line on it about a scheduled price is dated, so it stays true until
   the date.
3. Deploy the website again on or after a task price's date, so its first line and its examples move to the new card.
   It is static and cannot switch by itself: until that deploy it shows the earlier price.

**Price cuts.** A cut may take effect from the next 00:00 UTC; raises keep the 30-day notice. Within 30 days of its
date a cut is never cancelled (the rules refuse it), so check the date before saving one. Until the website's deploy on
or after the date, it shows the earlier, higher price, never a lower one than the Cloud charges.

Older installed extensions that don't read `classifyPrice` estimate "about N posts" at their bundled schedule until
their browser updates them; the balance itself and the job price lines always come from the server. A raise's notice
period leaves time for those updates; after a cut they estimate fewer posts than the balance buys, never more.

### When a change applies

- **Task prices:** from the entry's date, as [the rules](#the-rules) allow.
- **The starter credit:** to accounts created after the change is saved. An account gets the amount in effect when it
  was created, whenever its first check grants it, and credit already granted never changes. It is a gift, so a
  change needs no notice.
- **Buying credit:** at once, for new purchases. A Checkout already started still adds exactly what was paid, and an
  auto-reload agreement keeps the amount the person agreed to.
- **Auto-reload caps:** lowering a cap applies at once, to every agreement; raising one applies only to agreements
  made after it.

### The rules

The server enforces them on every save on the Pricing page, and the `price-schedule` CI job on the code schedule, on
pull requests and pushes to `main`:

- A price in effect is never changed or removed.
- A new or changed entry starts at a 00:00 UTC after its save or merge, never in the past.
- Within `PRICE_NOTICE_DAYS` (30) days of the save or merge, no task may charge (its multiplier) or publish (its price
  per 1,000 posts) more than before, and no price may rise on a date where it did not already rise. So a raise, the
  end of a cut included, is dated at least 30 days ahead, and a scheduled cut that falls within those 30 days cannot be
  cancelled.
- A cut may take effect from the next 00:00 UTC, and a scheduled raise may be lowered or cancelled before its date.
- An entry not yet in effect may be removed, unless that raises a price within the 30 days.

unAlgorithm Cloud's private build checks the first rule again on the code schedule (`--in-effect-only`) before it
builds an image, against the commit it last deployed ([The server](#the-server)).

### Adding a task

`CREDIT_TASKS` (`packages/protocol/src/billing.ts`) lists the tasks a server may charge for. Tasks are only ever added,
and adding one never edits an entry in effect. The shape check enforces, on the code schedule or the Pricing page:

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
a higher `maxChargeMicros` is a raise. A task's first card is added like any other entry, on the Pricing page or in the
code schedule.

`perspectives` (UnEcho Chamber) and `factcheck` were added this way, together: both are first priced in the 2026-10-18
entry (`perspectives` 2×, hold cap $0.50; `factcheck` 2×, hold cap $0.40), which copies the 2026-10-01 classify card
unchanged. That entry replaced the 2026-11-01 entry (`perspectives`) and the 2026-12-01 entry (`factcheck`), scheduled
earlier at the same cards, before either took effect.

### Changing the code schedule

The code defaults are the prices of every server whose admins never saved, unAlgorithm Cloud's included until its
first save. After that save, a change here no longer changes the Cloud's prices: use its Pricing page.

**Merging.** The check uses its run's clock, and GitHub does not run it again at merge. On the day you merge a pull
request that touches the schedule, re-run its `price-schedule` check first and merge only on green. Merge a cut early
enough that its push-to-`main` run and the steps below finish before 00:00 UTC of its date.

A red `price-schedule` run on `main` is fixed before the Cloud deploys a commit after it, with two exceptions that
need no fix:

- A cut merged after its date, or whose push run started after its date, stays as merged. Rule 1 still holds at the
  Cloud build (the previously deployed commit lacks the entry), no build charges a date already past, and a server
  charges the previous card until it runs the cut.
- The restoration below, whose own push run is red as expected.

When the red run is a price in effect that was removed, the fix restores the entry exactly. The check refuses that
restoration as a backdated entry, so it is merged with a code-owner (@TomHeiber) override of that one check. The
override is used for nothing else.

**The procedure.** All of it is done before the effective date:

1. Add the entry, with the code owner's sign-off (@TomHeiber) and changesets for the server and the extension, and
   merge it. A server that never saved charges it once it runs a release with it: unAlgorithm Cloud, until its first
   save, once HeitechSoft pins a commit with the entry and deploys it ([The server](#the-server)).
2. Release the extension (`vX.Y.Z`, [Steps](#steps)) built from a commit with the entry: its bundled schedule is what
   it estimates with for a server that sends no `classifyPrice`.
3. Deploy the website, and again on or after the date, as in the Cloud's procedure.

A cut is dated at the first 00:00 UTC by which steps 1 and 2 can be done. A server charges the previous card until it
runs a release with the cut, and the Cloud's ledger records which card priced each request (`price_from`). A cut is
never cancelled because a step is late (within 30 days of its date the check refuses that): finish the late steps as
soon as possible.

**Cancelling.** Before the date, a change is cancelled by removing its entry, except a cut within 30 days of its date:
removing it would raise a price people were told, and the check refuses it. The steps are repeated before the date,
the extension release included, or installed extensions estimate at the cancelled price from that date. If any step of
a raise, or of a cut more than 30 days from its date, cannot be finished before the date, cancel the change, also
before the date. A cancellation that has not reached a server by the date leaves that price in effect there, so the
entry is restored on `main` (the override above) and is changed from then on only by a new dated entry.

### Once in effect, no rollback

There is no rollback of a price in effect. A wrong price is corrected by a new dated entry, in the code schedule or on
the Pricing page: a lower price from the next 00:00 UTC, a higher one with 30 days' notice.

## Security fixes

Vulnerabilities are reported privately ([SECURITY.md](../SECURITY.md)), and their fixes stay private until they are
released.

- **Extension:** the fix ships in the next `vX.Y.Z` release.
- **Server:** the fix may reach unAlgorithm Cloud before it is merged here, as in any coordinated disclosure (ADR
  0007). It is merged to `main` within 30 days of the Cloud fix, or at once if the issue is already public.
- The GitHub security advisory is published when the fix is public and names the commit that fixes the server (and
  the extension release, when the extension changed too).
