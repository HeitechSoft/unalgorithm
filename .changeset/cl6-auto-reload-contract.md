---
'@unalgorithm/protocol': patch
'@unalgorithm/web': patch
---

Auto-reload contract (additive): the ledger reason `auto-reload` (kind `purchase`, always adds credit) is appended to
`CREDIT_ENTRY_REASONS`, and the account answer gains an optional `autoReload` summary (`AutoReloadSummarySchema`: the
server's auto-reload page, and `off`, `on` with its amount, threshold and monthly limit, or `stopped` after a failed
payment). The account page titles these history lines "Auto-reload" and, when the server sends the summary, says whether
auto-reload is off, on or stopped, with a link to set it up or change it.
