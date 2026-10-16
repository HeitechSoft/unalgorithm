# @unalgorithm/outlets

The open outlet registry that UnEcho Chamber sorts coverage with: which news outlets exist, their domains and
country, and, only where the review panel approved one, a lean label.

- **Code** (`src/`, `test/`): AGPL-3.0-only, as the rest of the repository.
- **Data** (`data/registry.json`): Creative Commons Attribution 4.0 International (CC BY 4.0), legal code in
  [`data/LICENSE`](data/LICENSE).

## Where lean labels come from

A lean label comes only from the human review panel. Never from a model, never from an agent, never inferred from
anything else. The schema makes that mechanical: every label needs at least one piece of evidence (an HTTPS link and a
note), at least two distinct reviewers who are on the registry's panel, and a review date that is not in the future.

An outlet whose details nobody checked is listed with name, domains and country only, `verified: false` and no facts.
A fact (owner, parent company, founding, headquarters) needs a source link and the day it was checked.

## Registry status

| `meta.status` | Labels                     | Ships?                                   | Perspectives                    |
| ------------- | -------------------------- | ---------------------------------------- | ------------------------------- |
| `draft`       | none (every `lean: null`)  | yes                                      | hidden                          |
| `reviewed`    | panel-approved, signed     | only with a signature that verifies      | shown once every bucket is set  |
| `fixture`     | fictional, `.example` only | never                                    | tests and e2e builds only       |

The bundled registry is a draft until the panel reviews v0. `usableRegistry()` is the runtime rule: perspectives
uses a registry only when it is reviewed, sound and has at least one labelled outlet in every lean bucket.

## Draft seed

`data/registry.json` ships a **candidate list for the review panel**: about 115 US and 55 Canadian general-news outlets
that publish online daily or weekly (national newspapers and broadcasters, wire services, national digital-native news
sites, the largest regional dailies, and a few major Spanish- and French-language outlets). Satire, opinion-only blogs
and aggregators were left out, and so were outlets based outside the US and Canada (the schema only has `US` and
`CA`). The panel decides the final scope.

How it was made: an agent listed each outlet's name, main web host(s) and country. No source page was opened while
preparing it, so **every outlet is `verified: false` with `facts: []`**, and its domains are unverified too. A fact
(owner, parent company, founding, headquarters) is added later only by someone who opened its source page and read it
there, with that page's link and the day it was checked.

What it is not: not an endorsement, not a ranking, not a grouping. Outlets are sorted by id, so the file's order means
nothing. **No outlet has a lean label** (every `lean: null`), the registry stays `draft` with an empty panel, and
perspectives stays hidden with this data. Labels come only from the panel's review.

## Commands

Run from the repository root:

```sh
node packages/outlets/src/cli.ts validate            # print every problem; exit 1 when any
node packages/outlets/src/cli.ts sign --key <path>   # panel only: sign a sound reviewed registry
node packages/outlets/src/cli.ts verify              # exit 0 only when the signature verifies
pnpm outlets:check                                   # the build gate (also run by the extension's build and zip)
```

`--file`, `--sig` and `--pub` override the defaults `data/registry.json`, `data/registry.sig` and
`keys/panel-ed25519.pub`.

## Signing

The panel signs the canonical form of the registry (object keys sorted at every level, no whitespace) with Ed25519.
The public key lives at `keys/panel-ed25519.pub` (PEM text, named `.pub` so the repo's `*.pem` ignore and secret-scan rules never catch it); until the panel creates its key pair, no registry can pass the
gate as reviewed. **The private key is never committed**: keep it offline with the panel, pass its path to `sign`, and
commit only `data/registry.json`, `data/registry.sig` and the public key.

## Tests

Tests use `FIXTURE_REGISTRY` from `@unalgorithm/outlets/testing`: fictional outlets on `.example` domains only.
