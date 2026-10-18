# ADR 0003: Where Chrome's on-device model runs

- Status: Proposed (needs verification on capable hardware)
- Date: 2026-10-10; browsers updated 2026-10-18 (ADR 0008)

## Context

Chrome's Prompt API (`LanguageModel`, Gemini Nano) is available to extensions from Chrome 138. Documentation covers
extension pages; availability inside the MV3 **service worker** is not clearly documented. The alternative is an
**offscreen document**, which costs an extra permission and lifecycle management.

Microsoft Edge offers the same Prompt API with its own model as a developer preview: Edge Canary or Dev,
with the API turned on in `edge://flags`, on Windows or macOS. Firefox has no built-in model that extensions can use.

## Decision

- Run the on-device client in the **service worker** first (`packages/ai/src/chrome-builtin`), behind the same
  `AIClient` interface as the other sources, so the host can change without touching callers.
- `onDeviceAvailability()` reports `unavailable` when `LanguageModel` is missing in the worker, so the UI shows a clear
  "not available on this device" rather than failing silently.
- The model download is started from a click on an extension page (user activation is required).
- Batch 2 posts per call, 1,200 characters each, one call at a time (small context window).
- The same client serves Edge, where `LanguageModel` exists; the card says it is Edge's preview and what it needs.
  Firefox builds hide the on-device card. Copy calls the model "Built-in AI"; the model id stays `chrome-built-in`,
  since cache keys use it.

## To verify

On a machine that meets Chrome's requirements (Chrome 138+, 22 GB free disk, a GPU with more than 4 GB VRAM or
16 GB RAM and 4 cores), with the model downloaded:

1. `LanguageModel` exists in the service worker and `availability()` returns `available`.
2. A classification with `responseConstraint` succeeds from the worker.
3. It still works after the worker is suspended and restarted.

Then the same three steps in Edge Canary or Dev with the Prompt API flag on (about 20 GB free disk, a GPU with at least
5.5 GB of memory). Nobody has run Edge's yet.

If any step fails, add an `offscreen` entrypoint that hosts the session and forward requests to it (reason
`WORKERS`), and update this ADR to Accepted with that design.

## Consequences

- No extra permission while the worker works.
- Until verified, on-device AI is labelled as depending on hardware and the browser's version, and Edge's as a
  preview.
- Firefox users choose their own key, a local or self-hosted model, or a server.
