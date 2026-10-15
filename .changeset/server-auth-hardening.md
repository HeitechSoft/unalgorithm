---
'@unalgorithm/server': patch
---

Emailed sign-in codes are limited per email address as well as per client address: 5 codes an address in 15 minutes
(past that the answer is unchanged and no code is sent) and 10 wrong codes an address an hour (then 429). A refresh
whose answer was lost may be replayed within a minute while the token it issued is unused, instead of signing the
device out as a stolen token. An hourly job deletes expired refresh tokens, extension codes and verification rows, so
every server on Postgres now runs graphile-worker.
