---
'@unalgorithm/web': patch
'@unalgorithm/core': patch
---

The admin page uses the screen's width: up to 1120px, with accounts and invites in one column and usage in the other
from 900px wide (one column below that), and the server's status (disk, backups, alerts) above the last 30 days. Sizes
under 1 MB now read in KB, so a new server's backup shows "17 KB" rather than "0 MB".
