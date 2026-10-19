# ADR 0003: Where Chrome's on-device model runs

- Status: Accepted (the service worker host was checked in a real browser on 2026-10-18; Gemini Nano's own answers
  still need a run in Google Chrome, see "Still to verify")
- Date: 2026-10-10; browsers updated 2026-10-18 (ADR 0008); accepted 2026-10-18

## Context

Chrome's Prompt API (`LanguageModel`, Gemini Nano) is available to extensions from Chrome 138. Documentation covers
extension pages; availability inside the MV3 **service worker** is not clearly documented. The alternative is an
**offscreen document**, which costs an extra permission and lifecycle management.

Microsoft Edge offers the same Prompt API with its own model as a developer preview: Edge Canary or Dev,
with the API turned on in `edge://flags`, on Windows or macOS. Firefox has no built-in model that extensions can use.

Open-source Chromium builds (Linux distributions' packages, Playwright's bundled Chromium) also expose
`LanguageModel`, but they are built without Google's model runtime: Chromium's on-device model service falls back to a
stand-in (`services/on_device_model/fake`) when `enable_ml_internal` is off, which only Google's own builds turn on.
The model component still downloads, so `availability()` honestly says `available`, but every prompt is answered by
an echo of the formatted prompt ("CPU backend…System: … End.User: … End.Model: {…}"), whatever the options, and never
by a model.

## Decision

- Run the on-device client in the **service worker** (`packages/ai/src/chrome-builtin`), behind the same `AIClient`
  interface as the other sources, so the host can change without touching callers. No offscreen document and no extra
  permission.
- `onDeviceAvailability()` reports `no-api` when `LanguageModel` is missing in the worker (Firefox, older Chromium), so
  the UI shows a clear "not available on this device" rather than failing silently.
- **An answer must look like a model's.** With `responseConstraint` a model can only answer with the schema's JSON
  object, so the client checks every answer before returning it. One that doesn't start as a JSON object came from no
  model: the client throws `not-available` with `NO_WORKING_MODEL`, which stops the run and pauses AI
  (`BLOCKING_AI_ERRORS`) instead of failing post by post. One that starts as JSON but doesn't parse was cut off and is
  `truncated`, which splits the batch like any other source's. The check is about behaviour, not brand names, so it
  holds for any browser; brand names only choose the wording.
- Failures name what is wrong with this browser, never that "Chrome rejected the request"
  (`errorMessage` in `apps/extension/src/background/ai.ts`): in a build without Google's or Edge's brand, that
  Chromium builds don't include the model and built-in AI needs Google Chrome or Edge's preview; in Chrome or Edge,
  that no model answered. An answer classify can't use reads as one the built-in AI gave, not as a rejection. A model
  that is still downloading, or not downloaded yet, says so.
- The model download is started from a click on an extension page (user activation is required).
- Batch 2 posts per call, 1,200 characters each, one call at a time (small context window).
- The same client serves Edge, where `LanguageModel` exists; the card says it is Edge's preview and what it needs.
  Firefox builds hide the on-device card. Copy calls the model "Built-in AI"; the model id stays `chrome-built-in`,
  since cache keys use it.

## Verified

2026-10-18, in Chromium 154 (a Linux distribution's package: brands `Chromium` only) with the store build loaded
unpacked, on a computer with 31 GB of RAM and 20 cores (CPU backend), the Gemini Nano component downloaded:

1. `LanguageModel` exists in the service worker, and `availability()` with the client's languages returns
   `available`, the same as in an extension page.
2. From the worker, `create` with the system prompt as `initialPrompts`, `clone`, and `prompt` with
   `responseConstraint` (the client's exact calls, with the compact classify prompt and the strict batch schema) all
   resolve, the same as in an extension page. `LanguageModel.params()` and the session's context window answer too.
   So the worker hosts the Prompt API as well as a page does, and no offscreen document is needed.
3. The answers come from Chromium's stand-in, not a model (see Context): with every option tried (no options,
   languages, `topK` 1 and temperature 0, a small schema, `omitResponseConstraintInput`, a plain-text prompt). The
   answer check above turns that into `not-available`, and *Turn on* now says the browser has no on-device model
   instead of "Chrome rejected the request".

## Still to verify

In **Google Chrome** itself (Chromium builds and Playwright's bundled Chromium only have the stand-in), on a machine
that meets Chrome's requirements (Chrome 138+, 22 GB free disk, a GPU with more than 4 GB VRAM or 16 GB RAM and
4 cores), with the model downloaded:

1. A classification with `responseConstraint` from the worker returns the schema's JSON, and *Turn on* succeeds.
2. It still works after the worker is suspended and restarted.

Then the same in Edge Canary or Dev with the Prompt API flag on (about 20 GB free disk, a GPU with at least 5.5 GB of
memory). Nobody has run Edge's yet.

If either fails in a way an extension page doesn't, add an `offscreen` entrypoint that hosts the session and forward
requests to it (reason `WORKERS`), and update this ADR with that design.

## Consequences

- No extra permission: the worker hosts the session.
- A browser without a working model can't be turned on, and one that loses its model pauses AI with the reason, so
  rules keep working and nothing is retried against it.
- Until Google Chrome is verified, on-device AI is labelled as depending on hardware and the browser's version, and
  Edge's as a preview.
- Firefox users choose their own key, a local or self-hosted model, or a server.
