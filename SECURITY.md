# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Preferred: use GitHub's **Report a vulnerability** button on the Security tab of
  [HeitechSoft/unalgorithm](https://github.com/HeitechSoft/unalgorithm/security/advisories/new).
- Or email **security@heitechsoft.com**.

Include steps to reproduce, the affected version (Settings → About in the extension; `version` in
`/.well-known/unalgorithm.json` for a server), and the impact you see. We acknowledge reports within 3 business days,
keep you updated, and credit you in the release notes unless you prefer otherwise.

## Scope

- The UnAlgorithm Feed extension (`apps/extension` and the packages it is built from).
- The self-hostable UnAlgorithm server: `apps/server` and its sign-in page, `apps/web`, as released in the
  `ghcr.io/heitechsoft/unalgorithm-server` image.
- UnAlgorithm Cloud, HeitechSoft's hosted server at `cloud.unalgorithm.app`, once it is live.

A problem in someone else's running copy of the server is for its operator, unless it comes from our code.

## Supported versions

During the preview, security fixes go to the latest release of each of the two release trains
([release.md](docs/release.md#two-release-trains)):

- the extension, tagged `vX.Y.Z`;
- the server, tagged `server-vX.Y.Z`.

## Security fixes and UnAlgorithm Cloud

A security fix for the server may reach UnAlgorithm Cloud before the public server release, as in any coordinated
disclosure (ADR 0007). The public `server-v*` release with the fix follows within 30 days of the Cloud fix, or at
once if the issue is already public. The GitHub security advisory names the server release that fixes it.

## What we care about most

- Anything that sends post content, author names or API keys somewhere the user did not choose.
- Anything that lets a web page or a post's text control the extension (prompt injection that escapes the post
  fence, messages accepted from the wrong sender, script injection into extension pages).
- API keys readable outside the extension's own pages.
- Anything that makes the extension act on a platform (click, post, follow) on the user's behalf.
- Post text or interest profiles logged or stored by the server.
- Reading another account's data on a server.
- Reading or changing another account's sync space or devices.
- A revoked device that keeps access.
- Account deletion that leaves data behind (beyond the billing records the
  [privacy model](docs/privacy-model.md#what-a-server-stores) says are kept).
- A sync item that carries an API key or a token.
- Token theft, a refresh token that can be used again without revoking its device (beyond the one replay of a refresh
  whose answer was lost, within a minute and while its successor is unused), or a way past sign-in.
- Getting past the Facebook audience filter (a post that isn't public reaching a server's model) or the limit of 12
  posts per request.
- Using `/v1/classify` as a general model proxy.

## Design notes

- API keys and a server's refresh token live in the extension's own IndexedDB, which content scripts (running in the
  page's origin) cannot read. They are never synced, exported or included in diagnostics.
- Only UnAlgorithm's own content scripts (which run only on LinkedIn and Facebook) and its extension pages can
  message the background; there is no `externally_connectable`. Every handler also checks the sender: classification
  and tab state only from LinkedIn/Facebook tabs; keys, AI setup and data deletion only from extension pages.
- The background re-validates every post sent for classification against the `PostForAI` schema, dropping any extra
  field, so a faulty content script cannot add fields such as author names or profile links to an AI request.
- Post text is untrusted: it is normalized, stripped of control and bidi characters, escaped and fenced with a random
  nonce before it reaches a model, and model output must match a strict schema.
- No remote code. AI hosts are optional permissions requested one origin at a time; an UnAlgorithm server needs none,
  because it answers the extension through CORS.
- Emailed sign-in codes are limited per email address as well as per client address: 5 codes an address in 15
  minutes (past that the server answers as before and sends nothing) and 10 wrong codes an address an hour (then 429),
  so many IP addresses buy no more guesses.
- The server builds every prompt itself: `/v1/classify` takes posts and the interest profile, never a prompt, and logs
  no request body. The canary test (`apps/server/test/canary.test.ts`) checks that a marker sent in posts reaches no
  log line and no database row.
