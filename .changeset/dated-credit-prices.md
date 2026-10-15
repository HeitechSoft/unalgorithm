---
'@unalgorithm/server': minor
---

Credit prices are dated: each price applies from 00:00 UTC of its effective date. On a server that bills, the account
page shows what AI costs per 1,000 posts and the next scheduled price change, with its date. A billing module now
receives `checkedAt`, the instant the server checked a request, in `check` and `settle`, and prices the request at it.
