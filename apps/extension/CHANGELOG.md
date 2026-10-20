# @unalgorithm/extension

## 0.4.0

### Minor Changes

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - unAlgorithm Cloud in every store version: Chrome, Edge and Firefox can sign in to unAlgorithm Cloud (invite-only beta)
  or another unAlgorithm server, use it for AI, and sync settings between your browsers. PRIVACY.md describes what
  signing in and sync send, to whom, and what unAlgorithm Cloud keeps.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook's Balanced now hides posts from people and pages you don't follow, as LinkedIn's does. Until now it was only
  in Calm while it was checked on live feeds. If your Facebook strength is Balanced, it gets the new rule when you
  update. If you chose Custom, or changed a filter, your filters stay as they are, and Settings → Facebook → People and
  pages you don't follow turns it off. It goes by the Follow button Facebook shows next to an author you don't follow,
  so your friends' posts, the pages and people you follow and groups you're in stay. A friend sharing a page's post or
  reel should stay too: a Follow button inside what they shared doesn't count, nor, in a group you're in, one after the
  member's name. If a post you wanted is folded, Why? on it shows what was detected, with a one-click fix. With sync on,
  each computer sends the setting once when it updates, so computers that update or start syncing later show the same,
  and Balanced picked on a computer that hasn't updated yet still means the new Balanced on one that has.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - unAlgorithm Feed now runs in Microsoft Edge and in Firefox 147 or newer, with everything the Chrome build has. In
  Firefox, Highlights opens in the sidebar (Open Highlights in the popup, or Alt+Shift+U), Firefox asks for your consent
  before post text, your settings or your account details go to any service, even one on your computer, and there is no
  on-device AI; in Edge, on-device AI is Edge's own preview. In builds with the unAlgorithm server card, signing in works
  in all three browsers, and each device is named for its browser, such as "Firefox on Linux" (in Firefox, while its
  technical and interaction data choice, offered at install, is on). Report a problem names your browser and its major
  version, and the Ollama tip covers Firefox: `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*`. Each release now
  carries the Edge and Firefox zips, the Firefox sources, a sideload zip for Chrome and Edge and, when Firefox Add-ons
  signs it, a Firefox file to install from the release.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Each hidden post now has its own thin line, with Why? and Show, even when several are hidden one after another, so
  you can see what was hidden without an extra click. To show them as one line with Show all, as before, turn on
  Settings → Display → Group hidden posts in a row. It's off for everyone when you update, unless you had changed that
  switch yourself, and then your choice stays. With sync on, turning it on or off carries to your other computers like
  the rest of Display.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Report a problem from inside unAlgorithm, without GitHub or an account. Report a problem in the popup, Let us know on a
  note that something stopped working, Why? → Wrong call? and Settings → About open a page that asks what's wrong, shows
  what will be sent in plain words and exactly, and sends it to HeitechSoft through unAlgorithm Cloud only when you click
  Send report. A report holds versions, counts and your answers, never what posts say, names, links or anything that
  identifies you, and it is deleted after 90 days. To ask us to correct a Fact-check or UnEcho Chamber result, choose
  Report a wrong verdict or Report a mistake under it and say what's wrong in your own words, with your email if you'd
  like a reply. In Firefox, reports are sent while its technical and interaction data choice, offered at install, is on;
  otherwise the page offers to email the report from your own email program. PRIVACY.md describes what a report holds,
  who reads it and how long it is kept.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Topics are one list in onboarding and Settings → Interests: mark any topic More or Less, or leave it alone. Politics,
  Crypto and the other topics that were only under Less of can now be More, and your own topics can be either. What you
  had marked before keeps working.

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

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Facebook detection now matches the live 2026 feed. A post whose own text read like "… likes a …" or "… commented on …"
  was folded as friend activity, and is shown again. People you may know, Reels and "Your group suggestions" are
  recognised as feed panels and folded in Balanced. Ads are hidden on their "Ad" label alone, video ads included. Post
  ages drawn as images count as timestamps, so ordinary posts no longer carry a weak "no timestamp" ad signal. Labels
  with hidden decoy letters, or spelled one character at a time, are read as they appear on screen. Reading each post
  also takes less work.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - On Facebook, after Show all on a long run of hidden posts, scrolling through them made the page jump up and down
  without stopping. Facebook empties posts that have scrolled far away and fills them in again when they come back, and
  each time the opened run could fold into one line again, which moved the page and made Facebook empty or fill in posts
  again. Posts opened with Show all now stay open, each on its own line, while you scroll. Hidden posts that load after
  them get a line of their own. Peek at hidden posts now shows every post that was folded into a run, and a post that
  stops being hidden is never left folded away with its run.

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

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - Moving between the feed and other pages without a reload, such as opening a profile and coming back, turns the feed's
  controls on and off on the right page again. They used to follow the page you had just left, in every browser.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - LinkedIn filtering works on the new "For you" feed. LinkedIn now sends some accounts from /feed/ to /feed/foryou/, and
  unAlgorithm didn't take that address for the feed, so it never started there; it now runs on both, and still never on
  a single post or other pages under /feed/. On that feed it also hides ads run as a person's post, labelled "Promoted •
  Partnership with LinkedIn", even on Light; reads "• Following" next to an author as someone you follow, so their posts
  stay when a connection's reaction is shown above them; and gives a post the same id however the feed is sorted.

- [#33](https://github.com/HeitechSoft/unalgorithm/pull/33) [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096) Thanks [@OwenHeiber](https://github.com/OwenHeiber)! - A feed that is mostly noise keeps its noise hidden. The safety check that stops hiding when detection looks wrong now
  allows up to 90% of a page's items at Balanced (was 80%), and hidden ads no longer count toward it, since they have a
  check of their own. LinkedIn feeds of mostly suggested, promoted and unfollowed posts no longer trip it.
- Updated dependencies [[`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096), [`35609f0`](https://github.com/HeitechSoft/unalgorithm/commit/35609f0b532ed6e1c77023c3bf01644be7545096)]:
  - @unalgorithm/core@0.3.0
  - @unalgorithm/sync@0.0.4
  - @unalgorithm/platforms@0.1.0
  - @unalgorithm/ai@0.0.4
  - @unalgorithm/protocol@0.3.0
  - @unalgorithm/ui@0.1.0
  - @unalgorithm/research@0.0.4
  - @unalgorithm/outlets@0.0.3

## 0.3.1

### Patch Changes

- [#23](https://github.com/HeitechSoft/unalgorithm/pull/23) [`07f613c`](https://github.com/HeitechSoft/unalgorithm/commit/07f613c2a5d2fdf1452d195605388bf623d658b8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook posts from friends are less likely to be mistaken for ads. Facebook's 2026 feed no longer shows a post's link up
  front: the timestamp links to the home page until you hover it, and its age ("6 hours ago") is a screen-reader label.
  unAlgorithm read that as "no timestamp", a weak sign of an ad, so one more uncertain sign was enough to hide an ordinary
  post. The timestamp now counts as a timestamp. Photo posts keep Facebook's own id; other posts still get a stable id made
  from the author, text and media, because nothing else on the page identifies them before you hover.

## 0.3.0

### Minor Changes

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check is out of Labs. Turn it on in Settings → AI. It still runs only when you click, on public posts, and shows the price first.

- [#27](https://github.com/HeitechSoft/unalgorithm/pull/27) [`553babb`](https://github.com/HeitechSoft/unalgorithm/commit/553babbde368378fcfc4871cf93d12bf4946b623) Thanks [@TomHeiber](https://github.com/TomHeiber)! - UnEcho Chamber and fact-check on unAlgorithm Cloud are priced from 18 October 2026 (00:00 UTC), at the same prices as
  announced: a comparison costs about $0.27 at 2× and at most $0.50, a check about $0.24 at 2× and at most $0.40. The price
  schedule prices both in one entry from 2026-10-18, which replaces the 2026-11-01 and 2026-12-01 entries before either
  took effect. The classify price is unchanged.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - While UnEcho Chamber is on, unAlgorithm downloads unAlgorithm Cloud's source list once a day, with nothing about you.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Keep your own source list for UnEcho Chamber in Settings → AI: start from unAlgorithm Cloud's list or the candidates, and set leans yourself.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - UnEcho Chamber runs on unAlgorithm Cloud's source list or your own, with warnings when a list isn't balanced. The comparison request carries the list.

### Patch Changes

- [#30](https://github.com/HeitechSoft/unalgorithm/pull/30) [`a6c924c`](https://github.com/HeitechSoft/unalgorithm/commit/a6c924c5050f902e2d696c33b7ab77b7d3e7dfc8) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The balance's estimate follows your server's current price. The account page reads its price lines and the amounts
  one purchase may add from the server's `/prices.json`, and the extension's "about N posts" uses the price in the
  server's discovery document (`classifyPrice`), falling back to the bundled schedule for a server that sends none.
  The extension reads that document again at most every 5 minutes while the server classifies for it, not only when
  you sign in, so its price lines follow a price change too. No price changes.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - A finished fact-check or UnEcho Chamber result links to how it works and to a form for reporting a mistake. The form is filled in with versions only, never anything from the post.

- [#29](https://github.com/HeitechSoft/unalgorithm/pull/29) [`7c240dd`](https://github.com/HeitechSoft/unalgorithm/commit/7c240dd79dfbd2277194a5ceb3750b436a837a07) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The name is now written unAlgorithm, with a lowercase u: in Chrome ("unAlgorithm Feed"), the toolbar, onboarding,
  Settings, messages, the sign-in and account pages, and the wordmark.

- [#28](https://github.com/HeitechSoft/unalgorithm/pull/28) [`4952da0`](https://github.com/HeitechSoft/unalgorithm/commit/4952da0604dfaf947eb2a2d47d4bec19b66e462b) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives is now called UnEcho Chamber. Only its name changed.

## 0.2.3

### Patch Changes

- [#22](https://github.com/HeitechSoft/unalgorithm/pull/22) [`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Facebook filtering works again. Facebook's home feed no longer marks its post list with `role="feed"`, so unAlgorithm
  found no feed, paused itself on every page and showed "Facebook's layout looks different". It now also finds the list
  the 2026 layout uses (the block after the screen-reader "Feed posts" heading, without reading that English text), hides
  ads labelled "Ad" as well as "Sponsored", and reads "Shared with …'s friends" as a friends-only post.
- Updated dependencies [[`681d1b5`](https://github.com/HeitechSoft/unalgorithm/commit/681d1b52131985580ce6cdbd715837ffb860712c)]:
  - @unalgorithm/platforms@0.0.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`cc177d8`](https://github.com/HeitechSoft/unalgorithm/commit/cc177d85def2c43a854e97c4c0b786fab3040237)]:
  - @unalgorithm/core@0.1.1
  - @unalgorithm/ai@0.0.2
  - @unalgorithm/platforms@0.0.2
  - @unalgorithm/research@0.0.2
  - @unalgorithm/sync@0.0.2
  - @unalgorithm/ui@0.0.2

## 0.2.1

### Patch Changes

- [#17](https://github.com/HeitechSoft/unalgorithm/pull/17) [`f2c45ea`](https://github.com/HeitechSoft/unalgorithm/commit/f2c45eabc82acd39e8a6b2d600a32a9894a78072) Thanks [@TomHeiber](https://github.com/TomHeiber)! - See what each batch of posts cost on a server that bills, in Why? and Settings → AI. The Why? popover of a post the AI
  hid says what its batch cost ("This batch of 12 posts cost $0.0018 of your credit."), and Settings → AI shows today's
  charged total and the day's batches from this browser, newest first. The figures are the server's own charges.

- When AI on unAlgorithm Cloud (or another unAlgorithm server) pauses because the balance ran out, it resumes by itself
  once credit is added: paused LinkedIn and Facebook tabs pick up again without a reload.

- Fact-check (Labs): a verdict kept from an earlier check of the same claim now shows its short explanation too, not only
  when it was checked. The explanation is left out when it repeats six or more words in a row of the post or of a claim the
  check found, and so is a source's title or quote that repeats a claim. Servers keep it in their claim cache (migration
  0014). The privacy policy says exactly what a kept result holds.

## 0.2.0

### Minor Changes

- **Labs** (Settings → Labs, off by default): **Fact-check** checks the claims in a public post against independent
  sources, and **Other perspectives** compares how other outlets covered a post's shared link, with lean labels only
  from unAlgorithm's reviewed outlet list. Both run on your own Anthropic or OpenAI key, or on your own AI server with a
  Brave or Tavily search key. Results stay in the tab, and nothing goes to HeitechSoft. The privacy policy describes
  exactly what each sends.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`58fc51c`](https://github.com/HeitechSoft/unalgorithm/commit/58fc51cb934b351f40d149c416181a3c77b978b1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check (Labs) can run on a billing server such as unAlgorithm Cloud from 2026-12-01, at the same 2× our AI cost
  as everything else: typically about $0.24 a check, never more than $0.40. Before that date a billing server doesn't
  offer it.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`11e2b77`](https://github.com/HeitechSoft/unalgorithm/commit/11e2b77047cfa52c279f5d9a00b612b954d1e7fb) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Fact-check researches more cheaply: one search per claim plus one (at most 5), at low research effort, and the verdict
  step sees only sources it can quote. The fact-check prompt version is now 2. Upgrade note for servers: fact-check and
  Other perspectives stay off until the admin runs `route-eval factcheck` again, about $3 with Anthropic.

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`17a8385`](https://github.com/HeitechSoft/unalgorithm/commit/17a8385ded5f776693a6cdf5a6b41d9062d4a924) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Other perspectives (Labs) can run on a billing server such as unAlgorithm Cloud from 2026-11-01, at the same 2× our AI
  cost as everything else: typically about $0.27 a comparison, never more than $0.50. Classifying is unchanged, so the
  account page shows no new price line for it. The discovery document can
  advertise `capabilities.perspectives` and `jobPrices.perspectives`; older documents still parse.

### Patch Changes

- [#6](https://github.com/HeitechSoft/unalgorithm/pull/6) [`7ab0b59`](https://github.com/HeitechSoft/unalgorithm/commit/7ab0b59a1bad17882a68dca1292d63dd9ab13d33) Thanks [@TomHeiber](https://github.com/TomHeiber)! - When AI pauses (today's limit reached, a key out of credit, sign-in needed), posts it already sorted stay sorted, and
  posts it sorted before are still sorted from the saved results. Only new AI requests stop until it resumes.

- [#13](https://github.com/HeitechSoft/unalgorithm/pull/13) [`17dae73`](https://github.com/HeitechSoft/unalgorithm/commit/17dae73078927bbf96c67660a8edd47a58e233f1) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Settings → AI: the API key and server address fields inside the selected option can be clicked and typed into again.

- [#1](https://github.com/HeitechSoft/unalgorithm/pull/1) [`8af8f3a`](https://github.com/HeitechSoft/unalgorithm/commit/8af8f3a06ddb79e0fa2f67b52547619eb66871fc) Thanks [@TomHeiber](https://github.com/TomHeiber)! - The extension is now named unAlgorithm Feed in Chrome and on the Chrome Web Store. Inside the extension it is still
  unAlgorithm for short.

- [#5](https://github.com/HeitechSoft/unalgorithm/pull/5) [`81b3978`](https://github.com/HeitechSoft/unalgorithm/commit/81b39785b1e210646ced139e24988c4b47d8005e) Thanks [@TomHeiber](https://github.com/TomHeiber)! - Help, the privacy policy and What's new now open on the unAlgorithm Feed website, unalgorithmfeed.com, which is also
  the extension's homepage in Chrome. Settings → About adds Website and Help links. Source code, licenses and Report a
  problem still go to GitHub.

## 0.1.0

First public preview.

- Hides ads, suggested posts, network activity ("Jane liked this") and feed panels such as People You May Know on
  LinkedIn, plus posts from people and pages you don't follow (on by default in Balanced). Facebook support is in
  preview, with "people you don't follow" limited to Calm until it is verified on live feeds.
- Three strengths: Light, Balanced and Calm.
- Why? on every hidden post, with one-click fixes and Undo.
- For you highlights based on your interests, using keywords or AI.
- A toolbar popup, a Highlights side panel, Settings and a one-minute setup.
- Optional AI: Chrome's on-device model, your own key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq), or a local
  or self-hosted model. Only the post text and a few facts about it are sent; never author names.
- A health monitor that stops hiding when a layout looks different, and Report a problem with content-free
  diagnostics.
