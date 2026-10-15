# UnAlgorithm privacy policy

*Last updated: October 2026. This policy covers UnAlgorithm Feed ("UnAlgorithm"), the browser extension (public
preview), and its website, unalgorithmfeed.com. It is also the privacy policy linked from the Chrome Web Store
listing.*

UnAlgorithm is made by HeitechSoft (Ontario, Canada). It hides noise in your LinkedIn and Facebook feeds. **The
extension does not collect your data, and it has no analytics or tracking.** The website counts visits without
cookies; see [This website](#this-website).

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
| Optional: change requests to your local AI server | Asked only if you click Fix it for me because a local server (such as Ollama) refuses UnAlgorithm. It removes the `Origin` header from UnAlgorithm's own requests to that one server |

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

UnAlgorithm is not directed at children under 16.

## Changes and contact

We will describe material changes in the release notes and update the date above. Questions:
**privacy@heitechsoft.com**.

*UnAlgorithm Cloud (a future, optional service with accounts and sync) will have its own terms and privacy notice
before it launches.*
