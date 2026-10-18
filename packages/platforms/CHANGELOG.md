# @unalgorithm/platforms

## 0.0.5

### Patch Changes

- [#23](https://github.com/HeitechSoft/unalgorithm/pull/23) [`07f613c`](https://github.com/HeitechSoft/unalgorithm/commit/07f613c2a5d2fdf1452d195605388bf623d658b8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook posts from friends are less likely to be mistaken for ads. Facebook's 2026 feed no longer shows a post's link up
  front: the timestamp links to the home page until you hover it, and its age ("6 hours ago") is a screen-reader label.
  unAlgorithm read that as "no timestamp", a weak sign of an ad, so one more uncertain sign was enough to hide an ordinary
  post. The timestamp now counts as a timestamp. Photo posts keep Facebook's own id; other posts still get a stable id made
  from the author, text and media, because nothing else on the page identifies them before you hover.

## 0.0.4

### Patch Changes

- Updated dependencies [[`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8), [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8)]:
  - @unalgorithm/protocol@0.2.0
  - @unalgorithm/core@0.2.0

## 0.0.3

### Patch Changes

- [#22](https://github.com/HeitechSoft/unalgorithm/pull/22) [`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook filtering works again. Facebook's home feed no longer marks its post list with `role="feed"`, so unAlgorithm
  found no feed, paused itself on every page and showed "Facebook's layout looks different". It now also finds the list
  the 2026 layout uses (the block after the screen-reader "Feed posts" heading, without reading that English text), hides
  ads labelled "Ad" as well as "Sponsored", and reads "Shared with …'s friends" as a friends-only post.

## 0.0.2

### Patch Changes

- Updated dependencies [[`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237)]:
  - @unalgorithm/core@0.1.1

## 0.0.1

### Patch Changes

- Updated dependencies [[`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072), [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072)]:
  - @unalgorithm/protocol@0.1.0
  - @unalgorithm/core@0.1.0
