# @unalgorithm/outlets

The open outlet registry that "Other perspectives" sorts coverage with: which news outlets exist, their domains and
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

## Commands

Run from the repository root:

```sh
node packages/outlets/src/cli.ts validate            # print every problem; exit 1 when any
node packages/outlets/src/cli.ts sign --key <path>   # panel only: sign a sound reviewed registry
node packages/outlets/src/cli.ts verify              # exit 0 only when the signature verifies
pnpm outlets:check                                   # the build gate (also run by the extension's build and zip)
```

`--file`, `--sig` and `--pub` override the defaults `data/registry.json`, `data/registry.sig` and
`keys/panel-ed25519.pub.pem`.

## Signing

The panel signs the canonical form of the registry (object keys sorted at every level, no whitespace) with Ed25519.
The public key lives at `keys/panel-ed25519.pub.pem`; until the panel creates its key pair, no registry can pass the
gate as reviewed. **The private key is never committed**: keep it offline with the panel, pass its path to `sign`, and
commit only `data/registry.json`, `data/registry.sig` and the public key.

## Tests

Tests use `FIXTURE_REGISTRY` from `@unalgorithm/outlets/testing`: fictional outlets on `.example` domains only.
