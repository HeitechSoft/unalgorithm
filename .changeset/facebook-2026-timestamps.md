---
'@unalgorithm/platforms': patch
'@unalgorithm/extension': patch
---

Facebook posts from friends are less likely to be mistaken for ads. Facebook's 2026 feed no longer shows a post's link up
front: the timestamp links to the home page until you hover it, and its age ("6 hours ago") is a screen-reader label.
unAlgorithm read that as "no timestamp", a weak sign of an ad, so one more uncertain sign was enough to hide an ordinary
post. The timestamp now counts as a timestamp. Photo posts keep Facebook's own id; other posts still get a stable id made
from the author, text and media, because nothing else on the page identifies them before you hover.
