# ADR 0001: pnpm workspace, WXT and packages as TypeScript source

- Status: Accepted
- Date: 2026-10-10

## Context

UnAlgorithm starts as a Chrome extension but will grow a server (Phase 2: sync, hosted AI), more browsers and more
platforms. The earlier prototype was a single WXT app where rules, prompts and DOM code were mixed.

## Decision

- One **pnpm 10 workspace**: `apps/extension` plus packages `protocol`, `core`, `ai`, `platforms`, `ui`.
- **WXT** (pinned exactly while pre-1.0) for the MV3 extension: file-based entrypoints, manifest generation, HMR,
  zips per browser target for later Edge/Firefox/Safari builds.
- Packages are consumed **as TypeScript source** (`exports` → `src/index.ts`); no per-package build. `protocol`,
  `core` and `ai` contain no `chrome.*` so a Node server can import them unchanged.
- Boundaries are enforced with Biome `noRestrictedImports` per folder, not by convention.
- TypeScript 5.9 strict with `noUncheckedIndexedAccess`; Biome for lint and format; Vitest projects; Playwright for E2E.

## Consequences

- Fast iteration and one typecheck per package; the server can share the prompt builders and wire contracts,
  so the hosted AI cannot drift from the local one.
- Packages cannot be published to npm as-is. That is fine: none are meant to be public libraries yet.
- A WXT upgrade is a deliberate change gated by E2E (Dependabot groups it separately).
