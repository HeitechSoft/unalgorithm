# Name and brand

## Names

| Name | Use it for | Where |
|---|---|---|
| **unAlgorithm Feed** | The product's full name | The store title on the Chrome Web Store, Firefox Add-ons and Microsoft Edge Add-ons and the extension's name in the browser, the website's title, release titles, legal documents and press. The first mention in any document |
| **unAlgorithm** | Shorthand | Everywhere inside the extension (popup, toolbar tooltip, onboarding, settings, in-feed labels) and in docs after the first mention |
| **unAlgo** | Informal short form | Social posts, hashtags, tight headlines, conversation |
| **by HeitechSoft** | Byline | Store listing, website header and footer, README, onboarding footer, About in Settings |
| **unAlgorithm Cloud** | HeitechSoft's hosted service at `cloud.unalgorithm.app` only. Never for anyone else's copy of the server; the extension shows other servers by their address | Hosted AI (later accounts, sync and credits) and the website; in the extension, only for that address |
| **unAlgorithm server** | The open-source server (`apps/server`), which runs unAlgorithm Cloud. It has no releases of its own. Someone else's running copy is "their server", never "unAlgorithm Cloud" | Docs, the extension's server card |

## Writing the name

- One word with a lowercase u and a capital A: **unAlgorithm**, **unAlgo**. Never "UnAlgorithm", "Unalgorithm" or
  "Un-Algorithm". The u stays lowercase at the start of a sentence, a heading or a title too.
- Lowercase `unalgorithm` only where the medium requires it: domains, URLs, package names, file names and code
  identifiers. These stay `unalgorithm` (`@unalgorithm/*`, `github.com/HeitechSoft/unalgorithm`,
  `unalgorithm-<version>-chrome.zip` and the release's other files).
- In store and website copy, open with the full name: "unAlgorithm Feed by HeitechSoft". After that, "unAlgorithm"
  is fine.
- Plain "unAlgorithm" is never the store title or a page title on its own, and "unAlgo" never stands in for the
  product name. Neither is a separate product, and we don't own an "unalgo" domain.
- No platform names in the product name: never "unAlgorithm for LinkedIn". Descriptions may say "works with LinkedIn
  and Facebook", always with the non-affiliation line: *unAlgorithm Feed is not affiliated with, endorsed by, or
  sponsored by LinkedIn or Meta.*

## Feature names

| Name | What it does | Code |
|---|---|---|
| **UnEcho Chamber** | Shows how outlets across the spectrum covered the story behind a shared news link | `perspectives` |
| **Fact-check** | Checks the claims in a public post against sources on the web. Its button says "Check facts" | `factcheck` |

Writing them:

- Exactly **UnEcho Chamber**: capital U, E and C, with "UnEcho" one word. Never "Unecho", "Un-Echo", "UnEcho chamber",
  "Unecho Chamber", "UEC" or "UnEcho" on its own.
- UnEcho Chamber is a feature of unAlgorithm Feed, never a separate product: it has no logo, icon, store listing,
  domain, social account or byline of its own. Store and website copy introduce it as part of unAlgorithm Feed.
- The name is never shortened. The in-feed button says the full name; its accessible name adds what it does
  ("UnEcho Chamber: see how outlets across the spectrum covered this story").
- Code stays `perspectives`, as code stays `unalgorithm`: the credit task (`CREDIT_TASKS`) and the price schedule's
  entries, the server's `PERSPECTIVES=on`, the `labs.perspectives` setting, routes, message types, storage keys, and file
  and test names.
- Each name has one source in the code, `FEATURE_NAMES` in `@unalgorithm/protocol`; every string people read takes it
  from there.

## Domains

| Domain | Role |
|---|---|
| `unalgorithmfeed.com` | The website: what unAlgorithm Feed does, how to install it, the privacy policy, help and release notes. `www.` redirects to it. Also the domain of the Firefox add-on ids, `feed@unalgorithmfeed.com` (Firefox Add-ons) and `feed-dev@unalgorithmfeed.com` (development, test and GitHub sideload builds), which are ids only, never email addresses |
| `unalgorithm.app` | The app's domain (unAlgorithm Cloud). The website doesn't serve or redirect it |
| `cloud.unalgorithm.app` | unAlgorithm Cloud (invite-only beta until the public launch) |

## Mark and colors

The mark is a Lagoon tile with a "U" holding a single dot: the post that is for you. The wordmark sets "un" in Lagoon
and "Algorithm" in ink. Both live in `packages/ui/src/components/brand.tsx`; icons are rendered from the same drawing by
`scripts/make-icons.mjs`. The brand color is Lagoon (`--ua-lagoon-700`, `#0B7A75`, the light-mode accent); the full
ramp and every other color live in the design tokens, `packages/ui/src/styles/tokens.css`.

Screenshots and store or website artwork are made from fixtures, never from real feeds.

See [TRADEMARKS.md](../TRADEMARKS.md) for what forks may and may not do with the names and the mark.
