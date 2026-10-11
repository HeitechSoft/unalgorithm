# ADR 0004: Reaching local and self-hosted AI servers

- Status: Accepted
- Date: 2026-10-10

## Context

Requests from an extension's service worker carry `Origin: chrome-extension://<id>`. Ollama rejects unknown origins
with HTTP 403 unless `OLLAMA_ORIGINS` is set. LM Studio needs CORS enabled. Asking for all-hosts access up front
would add a scary install warning and network access the rules-only mode never needs.

## Decision

- AI endpoints are **optional host permissions** (`https://*/*`, `http://*/*` declared as optional) requested **one
  origin at a time** from the user's click on Test/Connect.
- For Ollama, **Fix it for me** requests the optional `declarativeNetRequestWithHostAccess` permission and adds one
  dynamic rule (`ORIGIN_RULE_ID`) that removes the `Origin` header **only for requests initiated by this extension**
  (`initiatorDomains: [extension id]`) **to that server's origin**. Web pages gain nothing from it. Saving a different
  AI source removes the rule. The documented fallback is starting Ollama with
  `OLLAMA_ORIGINS=chrome-extension://*`.
- A fixed development `key` keeps the unpacked extension id stable (`aokmlebkpkeniofcnbeajmgabinicggm`), so an
  `OLLAMA_ORIGINS` allowlist written once keeps working.

## Consequences

- Install asks only for linkedin.com and facebook.com.
- The DNR rule is narrow and goes away with the source that needed it.
- To verify on a real Ollama install: Test fails with 403 before Fix it for me and passes after.
- The Phase 2 server will be reached with CORS, so enabling Cloud adds no new permission warning.
