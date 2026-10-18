# unAlgorithm privacy policy

*Last updated: October 2026. This policy covers unAlgorithm Feed ("unAlgorithm"), the browser extension (public
preview) for Chrome, Microsoft Edge and Firefox, and its website, unalgorithmfeed.com. It is also the privacy policy
linked from the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons listings.*

unAlgorithm is made by HeitechSoft (Ontario, Canada). It hides noise in your LinkedIn and Facebook feeds. **The
extension does not collect your data, and it has no analytics or tracking.** The website counts visits without
cookies; see [This website](#this-website).

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
- Nothing is sent anywhere unless you turn on AI, or you click **Report a problem** (see below).

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

**Fact-check (off by default).** When you turn on Settings → AI → Fact-check, use your own Anthropic or OpenAI
key and confirm a check on a public post, unAlgorithm sends that one post to that provider, directly from your browser
with your key: the same post fields classification sends, with the same masking described above (email addresses and
phone numbers always masked, @mentions and tagged names masked unless you turned that off in Settings → AI, at most
2,000 characters, a shared link's domain and title). Your interests are not sent. The provider then runs web searches
based on the claims it found in the post (for UnEcho Chamber, below, on the story's search words). Requests to
OpenAI ask it not to store responses (`store: false`), and no approximate location is sent with OpenAI's web search.
The result stays in this browser's temporary session storage for that tab and is removed when the tab closes or the
browser restarts. Facebook posts that aren't public are never checked, and nothing goes to HeitechSoft.

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
fact-check's does, and nothing goes to HeitechSoft.

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

Those versions also list *technical and interaction data*, which Firefox offers when you install unAlgorithm (on unless
you turn it off) and lets you change in its add-ons page. unAlgorithm never asks for it and nothing depends on it: it
decides only whether signing in to a server sends this device's name, such as "Firefox on Linux". A device that signs
in without it has no name on that server, and a change applies from the next sign-in. Versions without the server
sign-in don't list it, and Firefox offers no choice at install.

## Report a problem

**Report a problem** (in the popup, and under *Why? → Wrong call?*) opens a new GitHub issue form in your browser,
prefilled with diagnostics about the page: the extension and detection versions, your browser's name and major
version number (such as Firefox 147), the page's language, whether detection looked healthy, and counts of what was
found and hidden. It contains no post text, names, ids or links. These diagnostics are part of the link your browser
opens on GitHub; nothing is filed until you review the issue and submit it yourself, under GitHub's terms and privacy
statement. unAlgorithm itself sends and keeps nothing here, and nothing reaches HeitechSoft unless you submit the issue,
so it is not data collection and Firefox's consent (above) doesn't cover it.

A finished fact-check or UnEcho Chamber result in the side panel has a **Report a wrong verdict** (or **Report a
mistake**) link. It opens our correction form on GitHub with only these filled in: the feature's name, unAlgorithm's
version, the version of the AI instructions and, for UnEcho Chamber, whether it used unAlgorithm Cloud's source list or
your own. Never the post, the claims, the sources, the link, your list or anything about you. You describe the problem
in your own words, and nothing is filed until you submit it yourself, under GitHub's terms and privacy statement. The
result's *How it works* link opens our website, and the link on *unAlgorithm Cloud's source list* opens the Cloud's
public list.

## Permissions

| Permission | Why |
|---|---|
| Read and change linkedin.com and facebook.com | To find feed posts and fold away the ones you don't want |
| Storage | To keep your settings and statistics in your browser |
| Side panel (Chrome and Edge), sidebar (Firefox) | To show Highlights: the posts picked for you and the ones that were hidden |
| Scripting (Chrome and Edge) | To start working in LinkedIn/Facebook tabs that were already open when you installed it. Firefox does this by itself, without this permission |
| Optional: access to an AI server | Asked only when you set up AI, for that one server |
| Optional: access to a web search service | Asked only when you save a Brave or Tavily key in Settings → AI, for that one service |
| Change requests to your local AI server (optional in Chrome and Edge; Firefox grants it with the extension, since it can't be optional there) | Asked for in Chrome and Edge, and used in every browser, only if you click Fix it for me because a local server (such as Ollama) refuses unAlgorithm. It removes the `Origin` header from unAlgorithm's own requests to that one server |
| Firefox only, optional: share website content and personal communications; with the unAlgorithm server sign-in, also personally identifying information, authentication information and technical and interaction data | As described in [Firefox's consent](#when-you-turn-on-ai). Technical and interaction data is never asked for: it only decides whether a sign-in sends the device's name |

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

We will describe material changes in the release notes and update the date above. Questions:
**privacy@heitechsoft.com**.

*unAlgorithm Cloud (a future, optional service with accounts and sync) will have its own terms and privacy notice
before it launches.*
