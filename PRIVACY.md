# UnAlgorithm privacy policy

*Last updated: October 2026. This policy covers UnAlgorithm Feed ("UnAlgorithm"), the browser extension (public
preview). It is also the privacy policy linked from the Chrome Web Store listing.*

UnAlgorithm is made by HeitechSoft (Ontario, Canada). It hides noise in your LinkedIn and Facebook feeds. **It does
not collect your data, and it has no analytics or tracking.**

## What happens on your computer

- UnAlgorithm reads the LinkedIn and Facebook pages you open, in your browser, to decide which posts to fold away.
  It only reads what is already on your screen. It never clicks, scrolls, posts, follows or browses on your behalf.
- Your settings, interests, exceptions ("always show/hide", which hold the names or profile links you chose),
  feedback ("more/less like this"), daily statistics and cached AI results are stored in your browser. Cached results
  contain no post text and no names.
- While a LinkedIn or Facebook tab is open, the lists in the popup and side panel (the author, a short snippet and a
  link for each hidden or highlighted post) are kept in the browser's temporary session storage. They are removed
  when the tab closes, when the browser restarts, or when you choose Erase everything.
- Nothing is sent anywhere unless you turn on AI, or you click **Report a problem** (see below).

## When you turn on AI

You choose where AI runs. UnAlgorithm then sends **only what is needed to classify a post** to that place:

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
| On this device (Chrome built-in AI) | Nowhere: it runs on your computer |
| Local or self-hosted (Ollama, LM Studio, your server) | Only to the server address you entered |
| Your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq) | Directly from your browser to that provider, under their terms and privacy policy. HeitechSoft never sees it. OpenAI requests ask OpenAI not to store responses. |

**Fact-check (Labs, off by default).** When you turn on Settings → Labs → Fact-check, use your own Anthropic or OpenAI
key and confirm a check on a public post, UnAlgorithm sends that one post to that provider, directly from your browser
with your key: the same post fields classification sends, with the same masking described above (email addresses and
phone numbers always masked, @mentions and tagged names masked unless you turned that off in Settings → AI, at most
2,000 characters, a shared link's domain and title). Your interests are not sent. The provider then runs web searches
based on the claims it found in the post (for Other perspectives, below, on the story's search words). Requests to
OpenAI ask it not to store responses (`store: false`), and no approximate location is sent with OpenAI's web search.
The result stays in this browser's temporary session storage for that tab and is removed when the tab closes or the
browser restarts. Facebook posts that aren't public are never checked, and nothing goes to HeitechSoft.

**Fact-check on your UnAlgorithm server.** If your AI option is an UnAlgorithm server (self-hosted, or UnAlgorithm
Cloud) and it offers fact-check, turning on Settings → Labs → Fact-check and confirming a check on a public post sends
that one post to **that server only**, with your device's sign-in: the same post fields and masking as above (at most
2,000 characters, a shared link's domain and title, no author names, no interests). The server keeps the check in its
memory only, for at most 10 minutes, and stores no post content; its usage records hold the time, model, outcome and
cost, never the post. To check the claims it may search the web through the search service its operator configured,
sending it the claims, not the post. On a server that charges for checks, a check costs at most the price shown before
you confirm it; a check that stops early is not charged. Closing the tab cancels a check that is still running. The
result is kept in this browser exactly as above.

**Other perspectives (Labs, off by default).** When you turn on Settings → Labs → Other perspectives, use your own
Anthropic or OpenAI key and ask to compare a public post's shared link, the shared link's address (with tracking and
per-click parameters removed first) and its link-card title go from your browser to that provider, which searches news
sites from our outlet list for coverage of the same story and compares it. The post's text is never sent, nor its
author, your interests or anything else about you. Lean labels come only from UnAlgorithm's reviewed outlet list,
never from the AI. The result stays in this browser's temporary session storage for that tab, as a fact-check's does,
and nothing goes to HeitechSoft.

**Fact-check and Other perspectives with your own AI server and a web search key.** If your AI option is a local or
self-hosted AI server (or another OpenAI-compatible service) and you saved a Brave or Tavily key in Settings → Labs,
a fact-check sends the post (with the same fields and masking as above) and Other perspectives sends the link and
title (with tracking parameters removed) **only to the AI server address you entered**. The web searches go from your
browser to Brave or Tavily with your key: for a fact-check, the claims the AI found in the post; for Other
perspectives, the story's search words and the outlet sites to search. The post itself is never sent to Brave or
Tavily. Saving the key sends one test search for the word "UnAlgorithm". The key is stored only in this browser, like
an API key, and Facebook posts that aren't public are never checked.

**Other perspectives on your UnAlgorithm server.** If your AI option is an UnAlgorithm server and it offers Other
perspectives, the same comparison sends the link and title (with tracking parameters removed) to **that server only**,
with your device's sign-in, never the post's text. The server follows the link's redirects to find the story's address
and searches through the search provider its operator configured; it keeps the comparison in its memory only, for at
most 10 minutes. Closing the tab cancels a comparison that is still running. This browser shows a result only when
every outlet's lean in it matches this version's own reviewed outlet list.

Your API key is stored only in this browser, in storage that web pages cannot read. It is never synced, exported or
sent to HeitechSoft.

## Report a problem

**Report a problem** (in the popup, and under *Why? → Wrong call?*) opens a new GitHub issue form in your browser,
prefilled with diagnostics about the page: the extension and detection versions, your Chrome version number, the
page's language, whether detection looked healthy, and counts of what was found and hidden. It contains no post text,
names, ids or links. These diagnostics are part of the link your browser opens on GitHub; nothing is filed until you
review the issue and submit it yourself, under GitHub's terms and privacy statement.

## Permissions

| Permission | Why |
|---|---|
| Read and change linkedin.com and facebook.com | To find feed posts and fold away the ones you don't want |
| Storage | To keep your settings and statistics in your browser |
| Side panel | To show Highlights: the posts picked for you and the ones that were hidden |
| Scripting | To start working in LinkedIn/Facebook tabs that were already open when you installed it |
| Optional: access to an AI server | Asked only when you set up AI, for that one server |
| Optional: access to a web search service | Asked only when you save a Brave or Tavily key in Settings → Labs, for that one service |
| Optional: change requests to your local AI server | Asked only if you click Fix it for me because a local server (such as Ollama) refuses UnAlgorithm. It removes the `Origin` header from UnAlgorithm's own requests to that one server |

## Children

UnAlgorithm is not directed at children under 16.

## Changes and contact

We will describe material changes in the release notes and update the date above. Questions:
**privacy@heitechsoft.com**.

*UnAlgorithm Cloud (a future, optional service with accounts and sync) will have its own terms and privacy notice
before it launches.*
