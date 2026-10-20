---
'@unalgorithm/server': minor
---

Firefox sign-in. `EXTENSION_IDS` takes Firefox add-on ids (`name@domain` or `{uuid}`) as well as Chrome and Edge ids,
and when unset lists the development id and both Firefox ids, `feed@unalgorithmfeed.com` and
`feed-dev@unalgorithmfeed.com`. Once a Firefox id is listed, `/v1` answers CORS for any `moz-extension://` origin,
whose id Firefox picks at random per install, still never with credentials. Discovery lists `auth.clients`, so a
browser the server doesn't take says so before it opens the sign-in window. Upgrade the server before you list a
Firefox id: older releases refuse to start with one, so take the Firefox ids out before rolling back to one.
