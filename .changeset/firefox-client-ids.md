---
'@unalgorithm/protocol': minor
---

Firefox can sign in. `ClientIdSchema` takes a Chrome or Edge id (32 letters a to p) or a Firefox add-on id
(`name@domain` or `{uuid}`) and replaces `ExtensionIdSchema`. `redirectUriFor` gives each its redirect address:
`https://<id>.chromiumapp.org/`, or `https://<SHA-1 of the id>.extensions.allizom.org/` for Firefox (`sha1Hex`,
`geckoRedirectUri`). The authorize request and answer accept both, never Firefox's loopback form. Discovery may list
`auth.clients`, the kinds of extension a server takes sign-ins from; a server that doesn't say takes Chrome and Edge.
`DEV_CHROMIUM_ID`, `FIREFOX_ADDON_ID` and `FIREFOX_DEV_ADDON_ID` name the ids this release knows.
