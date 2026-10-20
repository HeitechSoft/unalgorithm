# @unalgorithm/platforms

## 0.1.0

### Minor Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - unAlgorithm notices when LinkedIn or Facebook change in a way that stops it working, and says so. When it isn't
  running on a page that looks like your feed, when it paused filtering, or when ads may be getting through, a short note
  appears at the bottom left of your feed (once per page; Not now keeps it away for a day), and the popup, the side panel
  and the toolbar button say the same. Settings → Display → Tell me when something breaks turns the note off. Detection
  also survives more of the sites' changes: a feed moved to a new address keeps working when the page is clearly your
  home feed; an ad label with a new word, such as "Promoted • Brand content" or "Ad · Paid", is still folded when the post
  shows other signs of an ad, and the note says some ads may be getting through; a line in a post's own text that reads
  like an ad label no longer hides it; and an error reading the page shows your posts instead of stopping silently. On
  Facebook, posts the site empties while you scroll no longer raise a false warning. These checks run on your computer,
  and nothing is sent unless you choose to.

### Patch Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook's Balanced now hides posts from people and pages you don't follow, as LinkedIn's does. Until now it was only
  in Calm while it was checked on live feeds. If your Facebook strength is Balanced, it gets the new rule when you
  update. If you chose Custom, or changed a filter, your filters stay as they are, and Settings → Facebook → People and
  pages you don't follow turns it off. It goes by the Follow button Facebook shows next to an author you don't follow,
  so your friends' posts, the pages and people you follow and groups you're in stay. A friend sharing a page's post or
  reel should stay too: a Follow button inside what they shared doesn't count, nor, in a group you're in, one after the
  member's name. If a post you wanted is folded, Why? on it shows what was detected, with a one-click fix. With sync on,
  each computer sends the setting once when it updates, so computers that update or start syncing later show the same,
  and Balanced picked on a computer that hasn't updated yet still means the new Balanced on one that has.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook detection now matches the live 2026 feed. A post whose own text read like "… likes a …" or "… commented on …"
  was folded as friend activity, and is shown again. People you may know, Reels and "Your group suggestions" are
  recognised as feed panels and folded in Balanced. Ads are hidden on their "Ad" label alone, video ads included. Post
  ages drawn as images count as timestamps, so ordinary posts no longer carry a weak "no timestamp" ad signal. Labels
  with hidden decoy letters, or spelled one character at a time, are read as they appear on screen. Reading each post
  also takes less work.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - On Facebook, the feed no longer keeps folding and opening every few seconds as you scroll. When unAlgorithm would hide
  too many posts, it now shows every post until you reload the page, and a card in the feed says so right away. Posts
  and panels that Facebook clears far from the screen still count as what they were, so scrolling no longer turns
  filtering off and on.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook's Balanced now also folds a reel that a person or page you don't follow posted as their own, when the reel
  shows a Follow button for its creator and the creator is the post's author (the same profile address; the same name
  only when one of them has no address). This layout is inferred, not yet captured on a live feed. A reel whose creator is
  someone else still shows, whoever shared it and with or without words of their own, and so does a reel by an account
  with the poster's name at another address. Light is unchanged, and Calm still folds every reel.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook now draws a post's age, and "Ad" on ads, through a chain of SVG images that point at one another, and
  unAlgorithm read only the first: an ad labelled this way could show, even on Balanced. The whole chain is now read, up
  to 8 links and only in the label after the author's name, so these ads are hidden again on every strength, and ordinary
  posts' dates read as dates. A chain that loops or runs longer is read as nothing: the post shows, and problem reports
  say the label was not recognised.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook shared links and post links are read in Firefox too, so UnEcho Chamber is offered there. Firefox's content
  scripts couldn't loop over a link's query parameters, which left both empty.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - LinkedIn filtering works on the new "For you" feed. LinkedIn now sends some accounts from /feed/ to /feed/foryou/, and
  unAlgorithm didn't take that address for the feed, so it never started there; it now runs on both, and still never on
  a single post or other pages under /feed/. On that feed it also hides ads run as a person's post, labelled "Promoted •
  Partnership with LinkedIn", even on Light; reads "• Following" next to an author as someone you follow, so their posts
  stay when a connection's reaction is shown above them; and gives a post the same id however the feed is sorted.
- Updated dependencies [[`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096)]:
  - @unalgorithm/core@0.3.0
  - @unalgorithm/protocol@0.3.0

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
