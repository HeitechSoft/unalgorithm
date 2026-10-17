---
'@unalgorithm/web': patch
---

The Pricing page at `/admin/prices` now also sets the starter credit new accounts get, the amounts people can buy (the
least, the most, the quick picks and the one preselected) and the auto-reload caps (the most a month and top-ups a
day). Each section shows its figures now and says when a change applies; as the admin types, it checks the change with
the price rules and says why they refuse it. Below them, the history lists every price change, newest first, with when
and which admin made it. The history stays on the admin page and is never published.
