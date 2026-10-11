# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Preferred: use GitHub's **Report a vulnerability** button on the Security tab of
  [HeitechSoft/unalgorithm](https://github.com/HeitechSoft/unalgorithm/security/advisories/new).
- Or email **security@heitechsoft.com**.

Include steps to reproduce, the affected version (Settings → About), and the impact you see. We acknowledge reports
within 3 business days, keep you updated, and credit you in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes during the preview.

## What we care about most

- Anything that sends post content, author names or API keys somewhere the user did not choose.
- Anything that lets a web page or a post's text control the extension (prompt injection that escapes the post
  fence, messages accepted from the wrong sender, script injection into extension pages).
- API keys readable outside the extension's own pages.
- Anything that makes the extension act on a platform (click, post, follow) on the user's behalf.

## Design notes

- API keys live in the extension's own IndexedDB, which content scripts (running in the page's origin) cannot read.
  They are never synced, exported or included in diagnostics.
- Only UnAlgorithm's own content scripts (which run only on LinkedIn and Facebook) and its extension pages can
  message the background; there is no `externally_connectable`. Every handler also checks the sender: classification
  and tab state only from LinkedIn/Facebook tabs; keys, AI setup and data deletion only from extension pages.
- The background re-validates every post sent for classification against the `PostForAI` schema, dropping any extra
  field, so a faulty content script cannot add fields such as author names or profile links to an AI request.
- Post text is untrusted: it is normalized, stripped of control and bidi characters, escaped and fenced with a random
  nonce before it reaches a model, and model output must match a strict schema.
- No remote code. AI hosts are optional permissions requested one origin at a time.
