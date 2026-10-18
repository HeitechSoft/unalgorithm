# ADR 0008: Firefox and Edge, with unAlgorithm Cloud

- Status: Accepted
- Date: 2026-10-18

## Context

unAlgorithm Feed shipped for Chrome only. Firefox and Microsoft Edge builds must have everything Chrome has,
including every unAlgorithm Cloud feature: sign-in, settings sync, AI labels through the server, credits, server
fact-check and UnEcho Chamber, and the device list.

WXT already builds both targets. Edge is Chromium: same manifest, same APIs, a `chrome-extension://` origin and a
`https://<id>.chromiumapp.org/` sign-in redirect. Its store assigns its own extension id. Firefox differs in ways that
matter to Cloud:

- `runtime.id` is a gecko id (`name@domain` or `{uuid}`), not 32 letters a to p.
- `identity.getRedirectURL()` is `https://<sha1 hex of the add-on id>.extensions.allizom.org/` (40 lowercase hex
  characters, SHA-1 over the id's UTF-8 bytes; Firefox `toolkit/components/extensions/child/ext-identity.js`).
  `launchWebAuthFlow` accepts only a `redirect_uri` under that address or under Firefox's loopback form
  (`http://127.0.0.1/mozoauth2/<hash>`), first fetches the authorize URL in the background with the user's cookies,
  then opens a full browser window and resolves on the first request to the redirect address in that window's tab.
  The authorize page's `location.assign(redirect)` is caught there.
- Extension pages send `Origin: moz-extension://<uuid>`. The UUID is random per profile and install, so it cannot be
  tied to an add-on id.
- `identity`, `alarms` and `declarativeNetRequestWithHostAccess` cannot be optional permissions. None of them shows
  an install prompt when required.
- There is no `sidePanel` API. The sidebar (`sidebar_action`) is per window, and `sidebarAction.open()` only works
  inside a user-input handler: a click in an extension page (popup, sidebar, options), the toolbar button, an
  extension menu item or keyboard shortcut. A click in the page relayed from a content script does not count.
- The background is an event page, not a service worker. Firefox ends it 30 seconds after its last extension API
  call, even while it is still answering a message over a pending `fetch`. Alarms do not survive a browser restart.
- In content scripts, page objects such as `URL` come through Xray wrappers: the iterators of `URLSearchParams`
  can't be spread or looped over there (`[...params.keys()]` throws); `forEach` works.
- New add-ons must declare `data_collection_permissions` (AMO, since 2025-11-03; Firefox 140+).
- AMO needs the source code and build instructions for bundled code.

## Decision

### Extension ids

| Build | Chrome | Edge | Firefox |
|---|---|---|---|
| Store | Chrome Web Store id | Edge Add-ons id (assigned by Partner Center) | `feed@unalgorithmfeed.com` |
| Development, e2e, GitHub sideload | `aokmlebkpkeniofcnbeajmgabinicggm` (dev key) | same as Chrome | `feed-dev@unalgorithmfeed.com` |

The Firefox store id is permanent once the add-on is on AMO: the Cloud keys devices and the redirect address to it.
Store zips never carry a `key`. The GitHub release's sideload builds are the store builds with the development identity
(`UA_SIDELOAD=1`), so a sideloaded copy has an id that servers accept: one zip with the dev `key`, which Chrome and Edge
both load unpacked, and a Firefox build with `feed-dev@unalgorithmfeed.com`, which the release has AMO sign as an
unlisted add-on (release Firefox keeps only signed add-ons). The signed `.xpi` is on the release only when the AMO
credentials are set and AMO signed it during the release run; otherwise the release goes out without it, with a warning,
and the file can be attached by hand once AMO signs it.

### Wire contract (`packages/protocol`)

- `ClientIdSchema` accepts a Chromium id (`^[a-p]{32}$`) or a gecko id (`{uuid}` or `name@domain` in Firefox's own
  pattern, either case, at most 80 characters as AMO's linter allows; Firefox itself sets no length). `clientKind(id)`
  returns `'chromium'`, `'gecko'` or `null`. The old `ExtensionIdSchema` is removed so every caller is revisited. Ids
  are compared exactly: the redirect hashes the id as written.
- `redirectUriFor(id)` returns `chromiumRedirectUri(id)` or `geckoRedirectUri(id)` and never throws. The SHA-1 is a
  small synchronous pure-TypeScript `sha1Hex` in the package, checked against Firefox's own test vector, so the
  authorize request schema stays synchronous for the web page and the extension.
- `AuthorizeResponseSchema` accepts both redirect host families. The Firefox loopback redirect
  (`http://127.0.0.1/mozoauth2/…`) is not accepted.
- `/.well-known/unalgorithm.json` gains optional `auth.clients`: the client kinds the server accepts, from its
  configured ids. A missing field means `['chromium']`. Kinds a client doesn't know are dropped when it parses the
  document, and a list left with none reads as missing, so a stored document always parses again. The extension
  checks it when the person chooses the server, before the sign-in window, and explains that the server doesn't accept
  sign-ins from Firefox (or Chrome, or Edge) yet.

### Server

- `EXTENSION_IDS` takes both kinds. The default is every id this release knows: the Chromium dev id and both Firefox
  ids. Store ids for Chrome and Edge are added in the deployment's configuration once each store assigns them.
- CORS on `/v1/*` answers `chrome-extension://<id>` for listed Chromium ids and any `moz-extension://<uuid>` when at
  least one gecko id is listed. CORS is not the access control here: Hono's CORS never refuses a request, every
  `/v1` route needs a bearer token, a session or a secret (code and verifier, refresh token, Stripe signature),
  `Access-Control-Allow-Credentials` is never sent, and session writes stay behind the own-page Origin check. The
  sign-in is protected by the client id allowlist, the redirect bound to the id, and PKCE.
- Deploy order: a server must understand gecko ids before its configuration lists one. An older server refuses to
  start with one, so the gecko ids also come out of the configuration before a rollback to an older release.
- The authorize page follows a redirect only when it starts with the request's `redirect_uri`.

### Manifest per browser

| Key | Chrome and Edge | Firefox |
|---|---|---|
| `browser_specific_settings.gecko` | — | id per build (above), `strict_min_version` (the oldest version with every CSS and API feature we use: `147.0`, for CSS anchor positioning, which places the Why? popover and the coach mark; data-collection consent alone needs 140), `data_collection_permissions` |
| `minimum_chrome_version`, `key` | as before | left out |
| Side panel | `side_panel`, `sidePanel` permission | `sidebar_action` with `open_at_install: false`; `commands._execute_sidebar_action` shortcut (Alt+Shift+U, Control+Shift+U on a Mac) |
| `identity`, `alarms` (Cloud builds) | `alarms` required, `identity` optional (required in e2e builds) | both required |
| `declarativeNetRequestWithHostAccess` | optional | required |
| `scripting` | required (injects into open tabs at install) | left out: Firefox injects content scripts into open tabs itself |
| `action.default_area` | — | `navbar` |
| `content_security_policy.extension_pages` | default | `script-src 'self'`, so `http://` AI and self-hosted servers are not upgraded to https |

Data collection on Firefox: `required: ['none']` (rules-only mode sends nothing), and as optional only what the
build uses: `['websiteContent', 'personalCommunications']` in builds without the server card, and those two plus
`'personallyIdentifyingInfo'`, `'authenticationInfo'` and `'technicalAndInteraction'` in builds with it
(`cloudEnabled`). Feed posts are page content and also other people's social media posts, which Mozilla lists under
personal communications, so post text asks for both. The extension asks for those two in the click that turns on any AI
source but on-device AI (the person's own key, or any OpenAI-compatible server) or saves a web search key, in the same
prompt as the host permission, and for the server set (`CLOUD_DATA`: post text, `personallyIdentifyingInfo` and
`authenticationInfo`) in the click that signs in to an unAlgorithm server: post text; the people you chose to always
show or hide, by name, in synced settings; and the account the sign-in registers, with this device's sign-in to it. A
service on this computer (`localhost`, `127.0.0.1`, `[::1]`) is asked for like any other: Mozilla counts data handled
outside the browser, which a local server is, and an unAlgorithm server passes posts on to the AI its operator
configured. (The loopback addresses keep only the rule that tokens may go to them over `http`.) The server card asks
again from *Turn on*, sync from *Turn on sync*, and an *Allow* button appears on the card while the server is the AI
source, on the devices list and on sync's problem when consent is missing. Every send of post text, settings or account
details but a sign-out checks consent first, so revoked consent is treated like a revoked host permission: the source
stops and the UI offers to fix it, and consent given back resumes the feed. For a server, nothing about the person or
this device's sign-in goes to it without the whole server set but signing out, which ends the device there: no sign-in,
classify, balance, devices list or device revoke, sync or server job (`serverRequest` refuses before it reads the
token). Two anonymous reads (no cookie, token or user data) need no type and don't check consent: the server's discovery
document (`/.well-known/unalgorithm.json`), read whenever the extension checks what a server offers, choosing one
included, and the download of the Cloud's public source list at most once a day while UnEcho Chamber is on
(`background/official-list.ts`), a request to unAlgorithm Cloud whether or not the person signed in to it.

`technicalAndInteraction` is never requested and gates nothing (Mozilla's add-on policies: declining it must
not restrict the add-on). Firefox's install prompt offers it, on unless the person turns it off, and its add-ons page
changes it; it decides only whether a sign-in sends the device name. Declared only in builds with the server card, so
store builds without it offer no data choice at install. *Report a problem* declares no type: it opens a prefilled
GitHub issue form, and nothing reaches HeitechSoft unless the person submits the issue on GitHub themselves.

### Behaviour

- `src/lib/browser-kind.ts` is the one place that knows the browser: Firefox at build time
  (`import.meta.env.BROWSER === 'firefox'`; WXT's boolean `import.meta.env.FIREFOX` arrives in Vitest as the string
  `"false"`, which is truthy), Chrome or Edge at run time (`navigator.userAgentData` brands, since Edge users can
  install the Chrome Web Store build). Workspace packages stay browser-neutral and take labels as parameters.
- Sidebar: the popup's *Open Highlights* calls `sidebarAction.open()` on Firefox. A fact-check or UnEcho Chamber run
  started in the feed reports the panel as open only when the window's sidebar already is; otherwise the in-feed item
  says how to open it: the toolbar button, and the sidebar's shortcut as `commands.getAll()` reports it, since the
  person can change or remove it. The panel follows the active tab of its own window in every browser.
- Sign-in on Firefox skips the `identity` request (required there) and asks for data-collection consent in the same
  click. All browsers check `getRedirectURL() === redirectUriFor(runtime.id)` before opening the window. Firefox
  always signs in through the real `launchWebAuthFlow` window, e2e builds included.
- The background registers `runtime.onStartup`, so sync's alarm comes back after a restart in every browser.
- Firefox only: every background message handler calls a cheap extension API (`runtime.getPlatformInfo()`) every 20
  seconds until it answers, so the event page isn't ended in the middle of a slow AI or server answer.
- Device names use `runtime.getBrowserInfo()` on Firefox and the brand names elsewhere ("Edge", "Opera", "Chrome",
  "Chromium"), with "Browser" as the fallback, never "Chrome" by default. Firefox sends one only when
  `technicalAndInteraction` is granted at sign-in; a sign-in without it leaves the device unnamed, which the server and
  both devices lists already allow ("Unnamed device").
- On-device AI uses `LanguageModel` where it exists (Chrome; Edge previews). Firefox has no equivalent for
  extensions, so the card is hidden there. Copy names the right browser.
- Ollama's Origin rule uses the extension page host (`new URL(runtime.getURL('/')).hostname`) as the initiator: the
  extension id in Chrome and Edge, the per-install UUID in Firefox, which refuses an add-on id there. The documented
  fallback is `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*`.
- Content scripts on Firefox attach their styles with a `<style>` element, as WXT's own shadow-root UI does there,
  rather than an adopted constructed sheet, so no constructed sheet has to cross the content script's Xray wrappers.
  (An adopted sheet did apply in a Firefox 158 test; the `<style>` element is the conservative choice.)
- Facebook's extractor reads query parameter names with `forEach` (see Context).
- zod runs `jitless` in extension bundles (`src/lib/zod-jitless.ts`, imported first in every entrypoint), so nothing
  probes or compiles with `eval` under the extension CSP. The code is still in the bundle, so AMO's linter warns about
  it; `scripts/check-firefox-lint.mjs` accepts that warning and react-dom's `innerHTML` one, and nothing else.

### Store builds and Cloud

Every browser follows the same rule as Chrome: development and e2e builds always have Cloud; store builds have it when
`UA_CLOUD=1` is set and the [release checklist](../release.md#before-a-store-build-carries-the-cloud-card) is done,
which now covers each store's data answers and each store id in `EXTENSION_IDS`. The release workflow builds all
three browsers, and the sideload builds, in one `pnpm zip` step, and no package script sets the switch itself, so it
reaches every store's build or none (`apps/extension/tests/privacy-gate.test.ts`).

### Testing

- Edge runs the existing Playwright suite in branded Edge (`msedge` channel, extension loaded over CDP
  `Extensions.loadUnpacked`, which answers only on a browser-level session), on Linux and Windows CI.
- Firefox runs its own specs (`apps/extension/e2e/firefox/`): Playwright Test as the runner, Puppeteer over
  WebDriver BiDi as the driver (`installExtension` maps to `webExtension.install`), fixture pages by tab request
  interception, the background's HTTP traffic through a recording egress proxy set in profile prefs (HTTPS to a few
  named hosts decrypted with a run-local certificate), and the real `launchWebAuthFlow` window for Cloud sign-in. The
  moz-extension UUID stays random so the server's origin handling is tested as in production. BiDi opens
  `moz-extension://` pages only when Firefox starts with `--remote-allow-system-access`, and Firefox sends no
  navigation events for them, so the driver navigates with BiDi's own command instead of Puppeteer's `goto`.
  Puppeteer's `::-p-aria` queries work, inside open shadow roots too. Browser UI (permission and consent prompts, the
  sidebar document) is out of reach: the specs grant consent with Firefox's
  `extensions.webextOptionalPermissionPrompts` pref and open Highlights as a tab. A temporary add-on gets no install
  prompt, so `technicalAndInteraction` starts off there: specs sign in without a device name, and the one that checks
  the name turns the type on first from a button the test adds to an extension page, standing in for the person's
  install choice (the extension itself never asks for it).
- `web-ext lint` runs on the Firefox build (`scripts/check-firefox-lint.mjs`: no errors or notices, only reviewed
  warnings), and CI rebuilds the Firefox zip from its sources zip and compares (`scripts/check-firefox-sources.mjs`).

## Consequences

- One sign-in protocol and one `EXTENSION_IDS` list serve all three browsers; Edge needs only its store id listed.
- Self-hosted servers must upgrade before Firefox users can sign in; older servers say so through discovery.
- Firefox users open Highlights themselves after starting a fact-check from the feed.
- Release produces chrome, edge and firefox zips, a Firefox sources zip for AMO, a sideload zip for Chrome and Edge
  and, when the AMO credentials are set and AMO signs it during the run, an AMO-signed Firefox sideload `.xpi`. It submits to the Chrome Web Store
  (staged), AMO (listed: an approved version goes live) and Edge Add-ons (a draft a person submits), so the smoke test
  comes before the tag ([release.md](../release.md#steps)).
- ADR 0006 (Chromium for development and tests) still holds for the Chrome build; this ADR adds Edge and Firefox.
