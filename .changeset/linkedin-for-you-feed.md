---
'@unalgorithm/platforms': patch
'@unalgorithm/extension': patch
---

LinkedIn filtering works on the new "For you" feed. LinkedIn now sends some accounts from /feed/ to /feed/foryou/, and
unAlgorithm didn't take that address for the feed, so it never started there; it now runs on both, and still never on
a single post or other pages under /feed/. On that feed it also hides ads run as a person's post, labelled "Promoted •
Partnership with LinkedIn", even on Light; reads "• Following" next to an author as someone you follow, so their posts
stay when a connection's reaction is shown above them; and gives a post the same id however the feed is sorted.
