---
'@unalgorithm/core': patch
'@unalgorithm/extension': patch
---

A feed that is mostly noise keeps its noise hidden. The safety check that stops hiding when detection looks wrong now
allows up to 90% of a page's items at Balanced (was 80%), and hidden ads no longer count toward it, since they have a
check of their own. LinkedIn feeds of mostly suggested, promoted and unfollowed posts no longer trip it.
