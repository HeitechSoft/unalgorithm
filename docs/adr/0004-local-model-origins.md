# ADR 0004: Reaching local and self-hosted AI servers

- Status: Accepted
- Date: 2026-10-10; Firefox added 2026-10-18 (ADR 0008)

## Context

Requests from an extension's background carry `Origin: chrome-extension://<id>` in Chrome and Edge, and
`Origin: moz-extension://<uuid>` in Firefox, where the UUID is random per install. Ollama rejects unknown origins with
HTTP 403 unless `OLLAMA_ORIGINS` is set. LM Studio needs CORS enabled. Asking for all-hosts access up front would add a
scary install warning and network access the rules-only mode never needs.

## Decision

- AI endpoints are **optional host permissions** (`https://*/*`, `http://*/*` declared as optional) requested **one
  origin at a time** from the user's click on Test/Connect. In Firefox the same prompt asks for consent to send post
  text there (`websiteContent` and `personalCommunications`), for a server on this computer too (ADR 0008).
- For Ollama, **Fix it for me** adds one dynamic rule (`ORIGIN_RULE_ID`) that removes the `Origin` header **only for
  requests initiated by this extension** (`initiatorDomains`: the host of the extension's own pages,
  `new URL(runtime.getURL('/')).hostname`) **to that server's origin**. Web pages gain nothing from it. Saving a
  different AI source removes the rule.
  - Chrome and Edge: the click requests the optional `declarativeNetRequestWithHostAccess` permission first. The
    initiator host is the extension id.
  - Firefox: the permission can't be optional there, so the manifest has it from the install (no prompt) and the click
    only checks it. The initiator host is the per-install UUID; Firefox refuses the add-on id as a domain.
- The documented fallback is starting Ollama with `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*`, which
  covers every browser.
- A fixed development `key` keeps the unpacked extension id stable in Chrome and Edge
  (`aokmlebkpkeniofcnbeajmgabinicggm`), so an `OLLAMA_ORIGINS` allowlist written for that id keeps working. Firefox's
  UUID changes with each install, so the wildcard is the only allowlist that lasts there.
- Firefox's extension pages declare `content_security_policy.extension_pages: "script-src 'self'"`: Firefox's default
  adds `upgrade-insecure-requests`, which would send `http://` local servers to https.

## Consequences

- Install asks only for linkedin.com and facebook.com. Firefox grants the request-changing permission at install,
  without a prompt, and it is used only after Fix it for me.
- The DNR rule is narrow and goes away with the source that needed it.
- To verify on a real Ollama install: Test fails with 403 before Fix it for me and passes after. In Firefox 158 the
  rule was checked against a local server (the extension's POST lost its `Origin`), not a real Ollama.
- The Phase 2 server will be reached with CORS, so enabling Cloud adds no new permission warning.
