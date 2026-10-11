# ADR 0005: API key storage and the privacy boundary

- Status: Accepted
- Date: 2026-10-10

## Context

Users can bring their own API keys. Content scripts run inside LinkedIn and Facebook pages; `chrome.storage.local`
is readable from content scripts, so anything stored there is one compromised content script away from the page.

## Decision

- API keys are stored in the **extension origin's IndexedDB** (`secrets` store), which content scripts cannot open.
  They are read only by the background, never sent in messages to content scripts, never synced, exported or
  included in diagnostics.
- Content scripts never build prompts. They build each post's `PostForAI` with `toPostForAI()` (no author names,
  emails and phone numbers masked, @handles and tagged names masked unless the user turned that off, capped text) and send
  `{key, input}` items to the background. The background parses every input again with `PostForAISchema`, which
  drops any field the schema does not list, applies the per-source length cap, builds the prompt and calls the AI
  source.
- Every background message handler validates the sender: feed messages only from LinkedIn/Facebook tabs; in-feed
  actions from those tabs or extension pages; key, AI setup, model listing and data deletion messages only from
  extension pages.
- The classification cache stores verdicts keyed by hashes, never post text or names.

## Consequences

- A malicious page cannot read keys through the extension, and a confused content script cannot exfiltrate them.
- Phase 2 sync has an explicit list of what syncs; keys are excluded by construction, not by filtering.
