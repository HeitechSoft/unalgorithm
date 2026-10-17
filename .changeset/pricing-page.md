---
'@unalgorithm/web': minor
'@unalgorithm/server': minor
'@unalgorithm/core': minor
---

The Pricing page at `/admin/prices`, linked from the admin page: an admin sees each task's price now and its scheduled
changes, schedules a change of Classifying posts, Fact-check or UnEcho Chamber from a day, and cancels or moves a
scheduled one. Before saving, the page says whether the change is a raise or a cut, the earliest day it can start, why
the price rules refuse it, and exactly what people will be shown: the account page's, the website's and the extension's
own lines (`taskPriceLines`). The server checks every rule again on save.
