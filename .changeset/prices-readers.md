---
'@unalgorithm/server': minor
'@unalgorithm/protocol': minor
---

Every price the server shows or charges now comes from its price book, so a change saved on the Pricing page applies
at once, without a restart: discovery and the fact-check and UnEcho Chamber offers, and the billing module through
the billing host's `prices` (which replaces `priceSchedule`). The book is published at `/prices.json`, public and
cacheable with an ETag, on a server that charges. Discovery also gives a billing server's price of 1,000 classified
posts (`classifyPrice`). No price changes.
