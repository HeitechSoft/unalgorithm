# ADR 0007: Open server, private billing

- Status: Accepted
- Date: 2026-10-12

## Context

Phase 2 of UnAlgorithm Feed adds a server for accounts, sync and hosted AI. People and organizations want to run
their own copy, and privacy-minded users want to read the code that handles their posts. HeitechSoft also runs
UnAlgorithm Cloud, paid for with prepaid credits. The billing code (payments, the credit ledger, abuse controls,
reconciliation) and HeitechSoft's operations configuration are of no use to self-hosters and carry business and
security risk if public.

HeitechSoft holds the copyright in UnAlgorithm, and the [CLA](../../CLA.md) grants it rights to contributions under
any licence. The AGPL binds licensees, not the copyright holder, so HeitechSoft can run the open server together with
code it keeps private.

## Decision

- `apps/server`, `apps/web` and `packages/sync` live in this repository under AGPL-3.0-only. This is the complete
  server: accounts and devices, extension sign-in, sync, the AI gateway (`POST /v1/classify`, later the fact-check and
  perspectives jobs), usage recording, admin caps and rate limits, `/.well-known/unalgorithm.json` and Docker Compose.
- Billing sits behind one `BillingProvider` interface in the server: check before an AI call (allow, hold, or refuse
  with `insufficient-credits`), settle or release after it, report a balance, and mount its own routes and web pages.
  The built-in provider is a no-op (`BILLING=off`): usage is recorded, admins set caps, nobody is charged.
- Billing wire contracts stay public in `packages/protocol` (balance, holds, price cards, `insufficient-credits`)
  because the open extension shows the balance and handles a refusal. The extension shows credits only when a server
  advertises billing in `/.well-known/unalgorithm.json`.
- A private repository, `HeitechSoft/unalgorithm-cloud`, holds the billing module (credit ledger, Stripe checkout and
  webhooks, the starter credit and its abuse checks, auto-reload, refunds, reconciliation, invoicing for
  organizations, the billing pages) and HeitechSoft's deployment and operations configuration. It builds the Cloud
  image from a tagged release of this repository plus that module, and reaches the server only through
  `BillingProvider`. It never patches the server.
- Everything that touches post content stays in the open server: what is accepted, how prompts are built, which
  models are called, what is logged. The billing module sees accounts, amounts and usage counts, never posts. The Cloud
  reports the server release it runs in `/.well-known/unalgorithm.json`.

## Consequences

- Self-hosters and organizations run the same server as the Cloud, without payments.
- Users can read what happens to their posts in the Cloud. They cannot read how they are billed; receipts, the
  published price multipliers and the ledger on the account page cover that.
- The billing module can stay private only while HeitechSoft can license all the server code it builds on: outside
  contributions are merged only with a signed CLA, and no third-party copyleft code goes into the server or the module.
- Security fixes may reach the Cloud before their public release, as in any coordinated disclosure.
- Two release trains: server releases here, then a Cloud release that pins one.

## Amendment (2026-10-16)

Tom: the server is for UnAlgorithm Cloud and its billing. There are no public server releases: no `server-v*` tags, no
GitHub Releases and no public image. The private repository builds the Cloud image from a pinned commit of this
repository (not from a tagged release or a published image), adds the billing module through `BillingProvider`, and
still never patches the server. The Cloud reports the server version it runs in `/.well-known/unalgorithm.json`, and
its `SOURCE_URL` links to the pinned commit. The source stays public under the AGPL, and the website doesn't publish
the self-hosting guide. This replaces "Two release trains" above: the extension is the only train released here.
