---
'@unalgorithm/server': minor
---

`PUBLIC_URL` must be written without a trailing slash: `https://host`, not `https://host/`. Before upgrading, remove
the slash from an existing `.env`, or `check-config` and the server stop with a `PUBLIC_URL` error ("must be written
without a trailing slash"). Self-hosters can now turn on HTTPS with Compose: `COMPOSE_PROFILES=caddy` in `.env` starts
Caddy on ports 80 and 443 with a Let's Encrypt certificate for the `PUBLIC_URL` host (set `TRUST_PROXY=one-hop` with
it).
