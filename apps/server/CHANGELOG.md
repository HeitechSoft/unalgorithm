# @unalgorithm/server

## 0.3.0

### Minor Changes

- Fact-check (Labs): a verdict kept from an earlier check of the same claim now shows its short explanation too, not only
  when it was checked. The explanation is left out when it repeats six or more words in a row of the post or of a claim the
  check found, and so is a source's title or quote that repeats a claim. Servers keep it in their claim cache (migration
  0014). The privacy policy says exactly what a kept result holds.

- [#11](https://github.com/HeitechSoft/unalgorithm/pull/11) [`63066b3`](https://github.com/HeitechSoft/unalgorithm/commit/63066b3f0b2687181aea3642ddbbe7fd171964fa) Thanks [@TomHeiber](https://github.com/TomHeiber)! - `SIGNUP=open` lets every address its provider verified create an account, with no allowlist or invite (the default,
  `SIGNUP=allowlist`, is unchanged). Emailed sign-in codes are now limited to 5 an address at once, then one every 12
  minutes (was one every 3 minutes), so an open server cannot be used to flood someone's mailbox; a refused request never reaches Better Auth and logs
  `auth.code_limited` without the address.

## 0.2.0

### Minor Changes

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`a5dfa77`](https://github.com/HeitechSoft/unalgorithm/commit/a5dfa77c3866c1b9faab399889b4621650599c39) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Credit prices are dated: each price applies from 00:00 UTC of its effective date. On a server that bills, the account
  page shows what AI costs per 1,000 posts and the next scheduled price change, with its date. A billing module now
  receives `checkedAt`, the instant the server checked a request, in `check` and `settle`, and prices the request at it.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`58fc51c`](https://github.com/HeitechSoft/unalgorithm/commit/58fc51cb934b351f40d149c416181a3c77b978b1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check (Labs) can run on a billing server such as UnAlgorithm Cloud from 2026-12-01, at the same 2× our AI cost
  as everything else: typically about $0.24 a check, never more than $0.40. Before that date a billing server doesn't
  offer it.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`11e2b77`](https://github.com/HeitechSoft/unalgorithm/commit/11e2b77047cfa52c279f5d9a00b612b954d1e7fb) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check researches more cheaply: one search per claim plus one (at most 5), at low research effort, and the verdict
  step sees only sources it can quote. The fact-check prompt version is now 2. Upgrade note for servers: fact-check and
  Other perspectives stay off until the admin runs `route-eval factcheck` again, about $3 with Anthropic.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`17a8385`](https://github.com/HeitechSoft/unalgorithm/commit/17a8385ded5f776693a6cdf5a6b41d9062d4a924) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives (Labs) can run on a billing server such as UnAlgorithm Cloud from 2026-11-01, at the same 2× our AI
  cost as everything else: typically about $0.27 a comparison, never more than $0.50. Classifying is unchanged, so the
  account page shows no new price line for it. The discovery document can
  advertise `capabilities.perspectives` and `jobPrices.perspectives`; older documents still parse.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`7cf39e0`](https://github.com/HeitechSoft/unalgorithm/commit/7cf39e0d456b383e4e09988acc886617cab13073) Thanks [@TomHeiber](https://github.com/TomHeiber)! - `PUBLIC_URL` must be written without a trailing slash: `https://host`, not `https://host/`. Before upgrading, remove
  the slash from an existing `.env`, or `check-config` and the server stop with a `PUBLIC_URL` error ("must be written
  without a trailing slash"). Self-hosters can now turn on HTTPS with Compose: `COMPOSE_PROFILES=caddy` in `.env` starts
  Caddy on ports 80 and 443 with a Let's Encrypt certificate for the `PUBLIC_URL` host (set `TRUST_PROXY=one-hop` with
  it).

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`6718c5c`](https://github.com/HeitechSoft/unalgorithm/commit/6718c5cb0e52918e0a529b948ad54d672bb41a08) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The server syncs settings between a person's signed-in devices: `GET /v1/sync/spaces`, `GET /v1/sync/changes` and
  `POST /v1/sync/push`, with 120 sync requests a minute per account. A changes request with nothing new waits up to 20
  seconds for a push from another device. The discovery document now says `sync: true`. A stopping server answers
  waiting changes requests at once and closes each connection after its answer, so a stop is not held open by them.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`afdf1ef`](https://github.com/HeitechSoft/unalgorithm/commit/afdf1ef1c4435b3a67d1a1c1888a3afff3f7eb34) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The sign-in and account pages offer "Continue with Google" on servers with a Google client, and "Sign in with a
  passkey" in browsers that support passkeys, next to the emailed code.

### Patch Changes

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`ce2cd84`](https://github.com/HeitechSoft/unalgorithm/commit/ce2cd84d94617a455d4f60ed6175a26e6497ffc3) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Emailed sign-in codes are limited per email address as well as per client address: 5 codes an address in 15 minutes
  (past that the answer is unchanged and no code is sent) and 10 wrong codes an address an hour (then 429). A refresh
  whose answer was lost may be replayed within a minute while the token it issued is unused, instead of signing the
  device out as a stolen token. An hourly job deletes expired refresh tokens, extension codes and verification rows, so
  every server on Postgres now runs graphile-worker.
