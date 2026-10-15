---
'@unalgorithm/server': minor
---

The server syncs settings between a person's signed-in devices: `GET /v1/sync/spaces`, `GET /v1/sync/changes` and
`POST /v1/sync/push`, with 120 sync requests a minute per account. A changes request with nothing new waits up to 20
seconds for a push from another device. The discovery document now says `sync: true`. A stopping server answers
waiting changes requests at once and closes each connection after its answer, so a stop is not held open by them.
