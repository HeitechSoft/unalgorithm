# @unalgorithm/platforms

## 0.0.3

### Patch Changes

- [#22](https://github.com/HeitechSoft/unalgorithm/pull/22) [`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook filtering works again. Facebook's home feed no longer marks its post list with `role="feed"`, so UnAlgorithm
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
