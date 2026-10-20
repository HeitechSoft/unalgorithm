# unAlgorithm privacy policy

*Last updated: October 2026. This policy covers unAlgorithm Feed ("unAlgorithm"), the browser extension (public
preview) for Chrome, Microsoft Edge and Firefox, and its website, unalgorithmfeed.com. It is also the privacy policy
linked from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons listings.*

unAlgorithm is made by HeitechSoft (Ontario, Canada). It hides noise in your LinkedIn and Facebook feeds. **The
extension has no analytics or tracking, and it sends nothing unless you choose to:** to the AI you pick; if you sign in
to an unAlgorithm server such as unAlgorithm Cloud, to that server (see [When you sign in to an unAlgorithm
server](#when-you-sign-in-to-an-unalgorithm-server)); or a problem report you send to HeitechSoft (see [Report a
problem](#report-a-problem)). The website counts visits without cookies; see [This website](#this-website).

## What happens on your computer

- unAlgorithm reads the LinkedIn and Facebook pages you open, in your browser, to decide which posts to fold away.
  It only reads what is already on your screen. It never clicks, scrolls, posts, follows or browses on your behalf.
- Your settings, interests, exceptions ("always show/hide", which hold the names or profile links you chose),
  your own UnEcho Chamber source list (outlets, their web addresses and the leans you gave them), feedback ("more/less
  like this"), daily statistics and cached AI results are stored in your browser. Cached results contain no post text
  and no names.
- While a LinkedIn or Facebook tab is open, the lists in the popup and side panel (the author, a short snippet and a
  link for each hidden or highlighted post) are kept in the browser's temporary session storage. They are removed
  when the tab closes, when the browser restarts, or when you choose Erase everything.
- unAlgorithm also checks, on your computer, that it still works on the page: that it found the feed and its posts,
  and that what it hides looks right. When LinkedIn or Facebook seem to have changed in a way that stops it working,
  it says so in the popup and may show a short note in your feed. On a page that looks like a feed at an address it
  doesn't know yet: when it is clearly your home feed, unAlgorithm works there as usual and the next report says so;
  otherwise it only reads the page to check, for at most 25 seconds while you look at it, and hides nothing. These
  checks send nothing, and keep nothing but how long a note stays away after you choose *Not now* or send a report, in
  this browser and never synced. Settings → Display → *Tell me when something breaks* turns the note in the feed off.
- Nothing is sent anywhere unless you turn on AI, sign in to an unAlgorithm server, or send a problem report:
  **Report a problem** (and *Let us know* on a note) only opens a page that shows the report, and nothing is sent
  until you click **Send report** there (see [Report a problem](#report-a-problem)).

## When you turn on AI

You choose where AI runs. unAlgorithm then sends **only what is needed to classify a post** to that place:

- the post's text, capped in length, with email addresses and phone numbers always masked, @mentions and the names
  of people or pages tagged in the post masked unless you turn that off (Settings → AI), and web addresses reduced
  to the site's name,
- the kind of media (image, video, link) and, for shared links, the website's domain and title,
- whether the author is a person or a page, and whether the post is a reshare,
- your interests: the topics you want more and less of, the optional "About you" note, and, if "Learn from More like
  this and Not for me" is on (Settings → Interests), short AI-written summaries of up to 4 posts you rated, with
  your rating.

It **never** sends author names, profile links, group names, comments, images or your browsing history.

| AI option | Where post text goes |
|---|---|
| Rules only (default) | Nowhere |
| On this device (your browser's built-in AI: Chrome's, or Edge's in its preview builds; not in Firefox) | Nowhere: it runs on your computer |
| Local or self-hosted (Ollama, LM Studio, your server) | Only to the server address you entered |
| Your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq) | Directly from your browser to that provider, under their terms and privacy policy. HeitechSoft never sees it. OpenAI requests ask OpenAI not to store responses. |
| An unAlgorithm server (unAlgorithm Cloud, or one you or your organization run) | Only to that server, then to the AI provider its operator configured. See [When you sign in to an unAlgorithm server](#when-you-sign-in-to-an-unalgorithm-server). |

**Fact-check (off by default).** When you turn on Settings → AI → Fact-check, use your own Anthropic or OpenAI
key and confirm a check on a public post, unAlgorithm sends that one post to that provider, directly from your browser
with your key: the same post fields classification sends, with the same masking described above (email addresses and
phone numbers always masked, @mentions and tagged names masked unless you turned that off in Settings → AI, at most
2,000 characters, a shared link's domain and title). Your interests are not sent. The provider then runs web searches
based on the claims it found in the post (for UnEcho Chamber, below, on the story's search words). Requests to
OpenAI ask it not to store responses (`store: false`), and no approximate location is sent with OpenAI's web search.
The result stays in this browser's temporary session storage for that tab and is removed when the tab closes or the
browser restarts. Facebook posts that aren't public are never checked, and nothing goes to HeitechSoft unless you ask us
to correct a result ([Report a problem](#report-a-problem)).

**Fact-check's cache on this device.** So that meeting the same public post again doesn't pay for the same research
twice, a check on your own key (Anthropic, OpenAI, or your own AI server with a web search key) keeps, for each claim
that two independent sources settled, a row in this browser's own storage: a keyed hash of the claim (under a random key
created on this device and never synced or exported), the verdict, the AI's short explanation of it (left out when it
repeats six or more words in a row of the post or of any claim the check found), the public sources' addresses, titles
and short quotes (a title or quote repeating a claim that way is left out), and the hour it was checked. Never the claim, the post's text, the post or its author, and no source on Facebook or LinkedIn. For 24
hours, a later check of the same claim on this device still sends the post to find its claims, then shows the kept
verdict and explanation instead of searching and judging again, marked with when it was checked. Feed pages can't read
this storage. Settings → Clear AI results cache removes the rows; Erase everything removes the rows and the key. Checks
on an unAlgorithm server never use or fill it.

**Fact-check on your unAlgorithm server.** If your AI option is an unAlgorithm server (self-hosted, or unAlgorithm
Cloud) and it offers fact-check, turning on Settings → AI → Fact-check and confirming a check on a public post sends
that one post to **that server only**, with your device's sign-in: the same post fields and masking as above (at most
2,000 characters, a shared link's domain and title, no author names, no interests). The server keeps the check in its
memory only, for at most 10 minutes, and stores no post content; its usage records hold the time, model, outcome and
cost, never the post. To check the claims it may search the web through the search service its operator configured,
sending it the claims, not the post. On a server that charges for checks, a check costs at most the price shown before
you confirm it; a check that stops early is not charged. Closing the tab cancels a check that is still running. The
result is kept in this browser exactly as above. Unless its operator turned it off, the server keeps a claim cache: for
each claim that two independent sources settled, a row with a keyed hash of the claim, the verdict, the AI's short
explanation of it (left out when it repeats six or more words in a row of the post or of any claim the check found),
the public sources' addresses, titles and short quotes (a title or quote repeating a claim that way is left out), and the
hour it was checked, for 24 hours. Never the claim, the post's text, who checked, or a
source on Facebook or LinkedIn. A later check of the same claim on that server, by anyone, still sends the post to find
its claims, then gets the kept verdict and explanation, marked with when it was checked, and costs only that one step.
So a result dated earlier tells the person who asked that someone on that server checked the same public claim within
the last day, never who. The cache stays on that server and is never shared with another.

**UnEcho Chamber (off by default).** When you turn on Settings → AI → UnEcho Chamber, use your own
Anthropic or OpenAI key and ask to compare a public post's shared link, the shared link's address (with tracking and
per-click parameters removed first) and its link-card title go from your browser to that provider, which searches the
outlets your chosen source list gives a lean (unAlgorithm Cloud's list or your own), by their web addresses, for
coverage of the same story and compares it. The post's text is never sent, nor its author, your interests or anything
else about you. Lean labels come only from unAlgorithm Cloud's source list, set by its admins with evidence, or from
your own list, never from the AI. The result stays in this browser's temporary session storage for that tab, as a
fact-check's does, and nothing goes to HeitechSoft unless you ask us to correct it.

**UnEcho Chamber's source list.** While UnEcho Chamber is on, unAlgorithm downloads unAlgorithm Cloud's published
source list (the outlets and their leans) from `cloud.unalgorithm.app` at most once a day, whatever AI option you use.
The request carries no account, cookie or sign-in and nothing about you, your feeds or your settings; like any web
request it comes from your IP address. The Cloud's logs record the time and the address asked for, never your IP
address; if a request fails, its web server's error log can keep your IP address for up to 14 days. unAlgorithm keeps
the last good copy in this browser.

**Fact-check and UnEcho Chamber with your own AI server and a web search key.** If your AI option is a local or
self-hosted AI server (or another OpenAI-compatible service) and you saved a Brave or Tavily key in Settings → AI,
a fact-check sends the post (with the same fields and masking as above) and UnEcho Chamber sends the link and
title (with tracking parameters removed) **only to the AI server address you entered**. The web searches go from your
browser to Brave or Tavily with your key: for a fact-check, the claims the AI found in the post; for
UnEcho Chamber, the story's search words and the outlet sites to search. The post itself is never sent to Brave or
Tavily. Saving the key sends one test search for the word "unAlgorithm". The key is stored only in this browser, like
an API key, and Facebook posts that aren't public are never checked.

**UnEcho Chamber on your unAlgorithm server.** If your AI option is an unAlgorithm server and it offers
UnEcho Chamber, the same comparison sends the link and title (with tracking parameters removed) and your chosen list's
outlets with a lean, as web addresses and leans without names, to **that server only**, with your device's sign-in,
never the post's text. The server follows the link's redirects to find the story's address and searches those outlets
through the search provider its operator configured. The list is kept in its memory for the comparison and never
stored or logged; the comparison stays in its memory only, for at most 10 minutes. Closing the tab cancels a comparison
that is still running. This browser shows a result only when every lean in it matches the list it sent.

Your API key is stored only in this browser, in storage that web pages cannot read. It is never synced, exported or
sent to HeitechSoft.

**Firefox's consent.** In Firefox, unAlgorithm also asks for your consent in Firefox's own prompt before it sends post
text, your settings or account details to any service, including one on this computer (such as Ollama on `localhost`): a
local server is outside the browser and can pass on what it receives. The source list download above carries none of
these and needs no consent. unAlgorithm asks to share *website content* and *personal communications* (the posts are
other people's social media posts) when you set up your own API key or an AI server, or save a web search key, in the
same prompt that asks to reach that service. Versions that can sign in to an unAlgorithm server also ask, for that
server, for those two and for *personally identifying information* and *authentication information* (the names of the
people you always show or hide, which sync sends with your settings, and your account and this device's sign-in), from
the click that signs in to it, turns it on or turns on sync. You can withdraw any of them in Firefox's add-ons page
(unAlgorithm Feed → Permissions and data): unAlgorithm then stops sending them there and offers to ask again. For an
unAlgorithm server that covers your balance and devices list too: nothing about you or your account goes to it then,
except a sign-out, which ends this device's sign-in there. Two things still go ahead, since neither carries anything
about you: reading the server's public description of itself, and the source list download above.

Every version also lists *technical and interaction data*, which Firefox offers when you install unAlgorithm (on unless
you turn it off) and lets you change in its add-ons page. unAlgorithm never asks for it, and nothing else depends on it.
It decides two things only: whether **Send report** sends a problem report you chose to send (without it, the report
page offers to email the report instead; see [Report a problem](#report-a-problem)), and, in versions that can sign in
to an unAlgorithm server, whether signing in sends this device's name, such as "Firefox on Linux". A device that signs
in without it has no name on that server, and a change applies from the next sign-in.

## When you sign in to an unAlgorithm server

Instead of an API key, you can choose an unAlgorithm server as your AI option and sign in to it. **unAlgorithm Cloud**
is HeitechSoft's own server at `cloud.unalgorithm.app` (invite-only beta). Anyone can also run an unAlgorithm server;
the extension shows every other server by its address, never as unAlgorithm Cloud.

**What is sent.** To sign in: your email address, to which the server emails a one-time code. To classify posts: the
same post fields and interests as any AI option (see above), to that server only; Facebook posts that aren't public are
never sent. The extension also reads your credit balance from the server, sending only your sign-in token.

**Who receives it.** With unAlgorithm Cloud: HeitechSoft, which forwards post fields to Anthropic in the United States
to classify them and sends sign-in emails through SMTP2GO. With any other unAlgorithm server: that server's operator and
the AI provider they configured, under their own terms and privacy policy, not HeitechSoft's.

**What unAlgorithm Cloud keeps.** Your email address, your signed-in devices, sign-in tokens by hash only, usage counts
and costs, your credit ledger and, if you turn sync on, your synced settings (your own UnEcho Chamber source list
included). Never post text, link titles, interests, the source list a comparison sends, prompts or AI answers. The
[unAlgorithm Cloud beta privacy notice](https://unalgorithmfeed.com/cloud/beta-privacy) has the details, how long each
item is kept, and how to download your data or delete your account.

**Sign-in.** Signing in opens the server's own sign-in page with the browser's identity permission. In Chrome and Edge
the extension requests it only when you click Sign in, and they grant it without a prompt; Firefox grants it with the
extension. In Firefox the same click asks for the consent described in [Firefox's consent](#when-you-turn-on-ai). Your refresh token is stored in the
extension's own storage, which web pages cannot read; signing out or Erase everything ends it on the server.

### Sync between your computers

If you turn on settings sync, your settings, interests and exceptions (the names and profile identifiers you chose to
always show or hide) and your own UnEcho Chamber source list (outlet names, web addresses and the leans you gave them)
go to the server you signed in to, and your other signed-in browsers fetch them from there; never API keys or post
text. Sync runs on a short timer only while you have it turned on.

## Report a problem

You can tell HeitechSoft, who make unAlgorithm, when something is wrong, from inside the extension and without an
account. Every way to report opens a report page in a new tab, and **nothing is sent until you click Send report**
there, after the page has shown you exactly what will be sent.

**Where you can report:**

- **Report a problem** at the bottom of the popup, on any page (on LinkedIn and Facebook, about that page);
- **Let us know** on a note that something stopped working: in your feed, in the popup or in the side panel;
- **Why? → Wrong call?** on a post unAlgorithm hid;
- Settings → About → **Report a problem**;
- **Report a wrong verdict** (Fact-check) or **Report a mistake** (UnEcho Chamber) under a finished result in
  Highlights, to ask us to correct it. The result's *How it works* link opens our website, and the link on
  *unAlgorithm Cloud's source list* opens the Cloud's public list.

**The report page** shows its questions, the report in plain words under *What we'll send*, and *Show exactly what's
sent*, the report exactly as it would be sent. *Cancel*, or closing the tab, sends nothing. Until you send it, the
report waits in this browser's temporary session storage for at most an hour, and goes when its tab closes or you choose
Erase everything.

**Where it goes:** to unAlgorithm Cloud (`cloud.unalgorithm.app`), HeitechSoft's server, whatever AI you use and
whether or not you have an account there. Never to your own AI provider or server, never to GitHub and never to anyone
else. The report carries no account, cookie or sign-in.

**What a report contains**, each part only where it applies:

- unAlgorithm's version and where it came from (the Chrome Web Store, Microsoft Edge Add-ons, Firefox Add-ons, a GitHub
  release or a development build), and your browser's name and major version, such as Chrome 141. From Firefox, also
  the add-on's id, which is the same for everyone who installed it from the same place; unAlgorithm Cloud reads it to
  check the report came from our own add-on, and doesn't keep it.
- The kind of report, where you started it (such as the popup or *Why?*), and your answers to the page's questions.
- About a LinkedIn or Facebook page: the site and the version of its detection; what kind of page it was (the home
  feed, a page that looks like a feed, or another page) and, for a feed at an address unAlgorithm doesn't know yet,
  the one word of that address, such as "foryou"; the page's language; your Strength; which kind of AI you use (off,
  on this device, your own key, your own server or unAlgorithm Cloud), never the provider, server or key; and whether
  unAlgorithm was paused there.
- What unAlgorithm noticed on that page: whether detection looked healthy, the codes of any problems it found and of
  the signals it stopped relying on, and counts: the posts, panels and other items it found, how many it folded away
  and why, how many times each detection rule matched, which parts of the page it recognised (such as the feed's list),
  what it saw where labels go (such as a label that almost reads like an ad label), and how many times reading the page
  failed, by step; and which way of finding posts it used.
- For *Wrong call?*, about that one post only: why it was hidden and by what (a rule, your own choice or AI), which
  detection signals matched and how strongly, whether the author is a person, a page or a group and whether you follow
  them, the kind of media, and whether the post has no text, a short text or a long one.
- For a correction: the feature, the version of its AI instructions, whether UnEcho Chamber used unAlgorithm Cloud's
  source list or your own, and which kind of AI made the result; your own words about what's wrong (at most 1,000
  characters, with email addresses and phone numbers masked, web addresses reduced to the site's name, with or without
  https:// or www., a profile or post address on its own removed, and @mentions masked, in the preview as you type and
  again on the server); and, only if you'd like a reply, your email address.

**Never sent:** what posts say, the names of people or pages, profile or post links, ids, the page's address (only its
kind and, for a new feed address, that one word), pictures, how long you spent on the page or how you scrolled, or your
account. Nothing in the report itself identifies you, this browser or this install, except what a correction adds: the
words you write and, if you give it, your email address. In Firefox, the browser adds an address unique to this install
to the request (see below).

**From a private window**, the report includes nothing about the page: only unAlgorithm's version, your browser, the
kind of report and where you started it, that it came from a private window, and your answers.

**Sending.** This browser sends at most 3 reports an hour and 10 a day: to count them, it keeps the times of the
reports it sent in the last day, never sends them, and Erase everything removes them. Nothing is sent again on its
own: *Try again* sends the same report only when you click it, and unAlgorithm Cloud keeps it once. When a report
can't be sent, *Email it instead* (or *Email this report*) opens your own email program with a message to
support@heitechsoft.com holding the lines under *What we'll send*. Your email program sends it if you choose to;
unAlgorithm sends nothing.

**In Firefox**, a problem report is *technical and interaction data* (see [Firefox's consent](#when-you-turn-on-ai)).
unAlgorithm sends one only while Firefox allows that type, which Firefox offers when you install unAlgorithm, on unless
you turn it off. unAlgorithm never asks for it: without it, the page offers *Email this report* instead and sends
nothing. A correction's words are also *personal communications*, which you allowed for the result you're correcting;
and the field for a reply email shows only while *personally identifying information* is allowed (signing in to an
unAlgorithm server allows it), otherwise the page asks you to email us with your reference. A report never asks for
any of these types, and never changes them.

**What unAlgorithm Cloud does with it.** It answers with a reference, such as 7KQ3-M2PA, which the page shows. Keep
it: nothing else in a report can tell us it's yours. The server keeps only the codes it knows and drops anything else,
cleans a correction's words again, and stores the hour the report arrived, not the minute. HeitechSoft's team reads
each report on unAlgorithm Cloud's admin page, to find what broke and fix it in an update, and reviews each correction
and answers it if you left an email. When reports show that detection broke on LinkedIn or Facebook, the alert email
HeitechSoft gets (through SMTP2GO) holds only counts. Reports are never sold, shared, published or posted on GitHub;
corrections are counted, never quoted, in the quarterly transparency report.

**Your IP address and the extension's address.** Like any web request, a report comes from your IP address, and your
browser adds the extension's own address (its Origin). In Chrome and Edge that address is the same for everyone who
installed unAlgorithm from the same store; in Firefox it holds a random id unique to this install, which unAlgorithm
Cloud reads only to check that the report came from an extension page, and never logs. unAlgorithm Cloud stores neither.
From the Origin it keeps one yes or no: whether the report came from one of our own versions (from a store or a GitHub
release); a correction from any other copy is refused, and the page offers email instead. It uses your IP address only
in its memory, to limit how many reports one address or network can send, under a code made with a random key that is
replaced at midnight UTC every day and never written down. With the report it stores one more yes or no: whether it was
the first report of its kind that day about that site from your network (the first three parts of an IPv4 address, or
the first 48 bits of an IPv6 one), so that one person can't raise an alarm alone. Neither can be turned back into an
address. The Cloud's access log keeps no IP address; if a request fails, its web server's error log can keep your IP
address for up to 14 days.

**How long it's kept.** A report is deleted 90 days after it arrives. A reply email is deleted 30 days after we
answer, and never kept more than 60 days after it arrives; ask us and we delete it sooner. After 90 days, a correction
remains only as one more in a count for its quarter, feature and outcome (such as "Fact-check, corrected"), with
nothing else. Deleted reports stay in the encrypted nightly backups for up to 14 more nights. Emails about a report to
support@heitechsoft.com are deleted 60 days after the last reply. Deleting your unAlgorithm Cloud account also removes
your email address from any report that gave it.

**Who is responsible, and your rights.** HeitechSoft, in Ontario, Canada, is responsible for reports, and uses them
only to fix unAlgorithm, to review and answer corrections, and to count corrections in the transparency report. We
keep and use a report because you chose to send it: clicking **Send report** is your consent. To withdraw it, or to
see a report or have it deleted, email privacy@heitechsoft.com with your reference; we answer within 30 days. Our
person in charge of personal information is named under [Changes and contact](#changes-and-contact). Reports are stored
on unAlgorithm Cloud's server, which OVHcloud hosts in Beauharnois, Quebec, Canada.

## Permissions

| Permission | Why |
|---|---|
| Read and change linkedin.com and facebook.com | To find feed posts and fold away the ones you don't want |
| Storage | To keep your settings and statistics in your browser |
| Side panel (Chrome and Edge), sidebar (Firefox) | To show Highlights: the posts picked for you and the ones that were hidden |
| Scripting (Chrome and Edge) | To start working in LinkedIn/Facebook tabs that were already open when you installed it. Firefox does this by itself, without this permission |
| Identity | Used only when you click Sign in on an unAlgorithm server: it opens that server's sign-in page and receives a one-time code back. In Chrome and Edge the extension requests it only from that click, and they grant it without a prompt; Firefox grants it with the extension. unAlgorithm Feed does not access your Google, Microsoft or Firefox account |
| Alarms | To run settings sync on a short timer, only while you have sync turned on |
| Optional: access to an AI server | Asked only when you set up AI, for that one server |
| Optional: access to a web search service | Asked only when you save a Brave or Tavily key in Settings → AI, for that one service |
| Change requests to your local AI server (optional in Chrome and Edge; Firefox grants it with the extension, since it can't be optional there) | Requested in Chrome and Edge (granted without a prompt), and used in every browser, only if you click Fix it for me because a local server (such as Ollama) refuses unAlgorithm. It removes the `Origin` header from unAlgorithm's own requests to that one server |
| Firefox only, optional: share website content, personal communications and technical and interaction data; with the unAlgorithm server sign-in, also personally identifying information and authentication information | As described in [Firefox's consent](#when-you-turn-on-ai). Technical and interaction data is never asked for: it only decides whether Send report sends a problem report or offers to email it, and whether a sign-in sends the device's name |

## This website

The website at unalgorithmfeed.com counts visits with Matomo, which HeitechSoft runs on its own server
(analytics.heitechsoft.com). It sets no cookies. It records the pages you view, the page that linked you here, the
links you follow (such as downloads), your browser, device type and approximate location, with your IP address
shortened before it is stored. It doesn't run at all when your browser sends Do Not Track or Global Privacy Control.
We use these counts only to see which pages help people, never for advertising, and we don't share them.

Like any website, our server keeps short-lived access logs (IP address, page, time and browser) to keep the site
running and secure; they are deleted after about two weeks. The site loads no other third-party scripts, fonts or
trackers, and the extension never sends anything to this website.

## Children

unAlgorithm is not directed at children under 16.

## Changes and contact

We will describe material changes in the release notes and update the date above.

Questions about privacy, and requests about your personal information: **privacy@heitechsoft.com**. They reach Tom
Heiber, HeitechSoft's person in charge of the protection of personal information. Anything else about unAlgorithm:
support@heitechsoft.com.
