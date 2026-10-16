---
'@unalgorithm/platforms': patch
'@unalgorithm/extension': patch
---

Facebook filtering works again. Facebook's home feed no longer marks its post list with `role="feed"`, so UnAlgorithm
found no feed, paused itself on every page and showed "Facebook's layout looks different". It now also finds the list
the 2026 layout uses (the block after the screen-reader "Feed posts" heading, without reading that English text), hides
ads labelled "Ad" as well as "Sponsored", and reads "Shared with …'s friends" as a friends-only post.
