# Releasing

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
