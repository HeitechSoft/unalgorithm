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
3. Approve the deployment: the job runs in the protected `release` environment and waits for a reviewer.
4. `server-release.yml` verifies (lint, typecheck, tests, the server licence check), checks the tag matches the version
   in `apps/server/package.json` (a mismatch fails the job before anything is pushed), builds and pushes the image,
   attests its build provenance and creates the GitHub Release.
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
