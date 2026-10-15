# Name and brand

## Names

| Name | Use it for | Where |
|---|---|---|
| **UnAlgorithm Feed** | The product's full name | Chrome Web Store title and the extension's name in Chrome, the website's title, release titles, legal documents and press. The first mention in any document |
| **UnAlgorithm** | Shorthand | Everywhere inside the extension (popup, toolbar tooltip, onboarding, settings, in-feed labels) and in docs after the first mention |
| **UnAlgo** | Informal short form | Social posts, hashtags, tight headlines, conversation |
| **by HeitechSoft** | Byline | Store listing, website header and footer, README, onboarding footer, About in Settings |
| **UnAlgorithm Cloud** | The Phase 2 service | Accounts, sync and hosted AI |

## Writing the name

- One word with a capital U and A: **UnAlgorithm**, **UnAlgo**. Never "Unalgorithm", "Un-Algorithm" or "unAlgorithm".
- Lowercase `unalgorithm` only where the medium requires it: domains, URLs, package names, file names and code
  identifiers. These stay `unalgorithm` (`@unalgorithm/*`, `github.com/HeitechSoft/unalgorithm`,
  `unalgorithm-<version>-chrome.zip`).
- In store and website copy, open with the full name: "UnAlgorithm Feed by HeitechSoft". After that, "UnAlgorithm"
  is fine.
- Plain "UnAlgorithm" is never the store title or a page title on its own, and "UnAlgo" never stands in for the
  product name. Neither is a separate product, and we don't own an "unalgo" domain.
- No platform names in the product name: never "UnAlgorithm for LinkedIn". Descriptions may say "works with LinkedIn
  and Facebook", always with the non-affiliation line: *UnAlgorithm Feed is not affiliated with, endorsed by, or
  sponsored by LinkedIn or Meta.*

## Domains

| Domain | Role |
|---|---|
| `unalgorithmfeed.com` | The website: what UnAlgorithm Feed does, how to install it, the privacy policy, help and release notes. `www.` redirects to it |
| `unalgorithm.app` | The app's domain (UnAlgorithm Cloud). The website doesn't serve or redirect it |

## Mark and colors

The mark is a Lagoon tile with a "U" holding a single dot: the post that is for you. The wordmark sets "Un" in Lagoon
and "Algorithm" in ink. Both live in `packages/ui/src/components/brand.tsx`; icons are rendered from the same drawing by
`scripts/make-icons.mjs`. The brand color is Lagoon (`--ua-lagoon-700`, `#0B7A75`, the light-mode accent); the full
ramp and every other color live in the design tokens, `packages/ui/src/styles/tokens.css`.

Screenshots and store or website artwork are made from fixtures, never from real feeds.

See [TRADEMARKS.md](../TRADEMARKS.md) for what forks may and may not do with the names and the mark.
