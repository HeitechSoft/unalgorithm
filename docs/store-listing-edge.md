# Microsoft Edge Add-ons listing

The text for unAlgorithm Feed's listing on Microsoft Edge Add-ons, ready to paste into Partner Center (HeitechSoft's
Microsoft Edge program). The first version and its listing are published by hand; later versions are uploaded by each
release as a draft that a person submits ([release.md](release.md#microsoft-edge-add-ons-credentials)).

This is for store builds **without the Cloud card** (`UA_CLOUD` unset). The Edge build has Chrome's manifest
(`manifestFor('production', 'edge')` in `apps/extension/wxt.config.ts` is `manifestFor('production', 'chrome')`), so
the Chrome Web Store's permission justifications, remote code answer and data-use answers in
[store-listing.md](store-listing.md#privacy-practices-tab) apply word for word: paste them wherever Partner Center asks.
Before a store build carries the Cloud card, those answers change too
([release.md](release.md#before-a-store-build-carries-the-cloud-card)).

The description repeats the Chrome Web Store's line for line, except the line about built-in AI, which is a preview in
Edge. Keep the stores in step with each other, with [PRIVACY.md](../PRIVACY.md) and with the manifest.

## Extension details

| Page | Field | Value |
|---|---|---|
| Availability | Visibility | **Public**. For the first version, **Hidden** if the extension's id only shows once it is published ([release.md](release.md#microsoft-edge-add-ons-credentials)) |
| Availability | Markets | All markets |
| Properties | Category | **Social** |
| Properties | Privacy policy | Required: yes, `https://unalgorithmfeed.com/privacy/` (built from [PRIVACY.md](../PRIVACY.md)) |
| Properties | Website | `https://unalgorithmfeed.com/` |
| Properties | Support contact | `https://unalgorithmfeed.com/help/` |
| Properties | Mature content | No |
| Store listings | Language | English |
| Store listings | Name | **unAlgorithm Feed** (from `extName` in `apps/extension/public/_locales/en/messages.json`; Partner Center reads it from the zip) |
| Store listings | Description | Below |
| Store listings | Search terms | feed filter, news feed, suggested posts, social media, fact-check, focus |

### Description

Paste as plain text. It opens with the full name and byline and ends with the non-affiliation line
([brand.md](brand.md)).

```text
unAlgorithm Feed by HeitechSoft

See the posts you came for.

Social feeds are ranked to keep you scrolling. They mix in ads, posts "suggested for you", "Jane liked this" activity and content from people you never chose to follow. unAlgorithm Feed folds that noise into a thin line, so you can still peek, and it never touches posts from the people you follow.

Works with LinkedIn and Facebook, in English.

WHAT IT DOES
• Folds away the noise, with no setup: ads (Promoted and Sponsored), suggested posts, network activity, feed panels like People You May Know, groups you haven't joined and, on LinkedIn, people and pages you don't follow.
• Three strengths: Light (just the clutter), Balanced (what you didn't ask for) and Calm (only what matters). Change it from the toolbar and the feed updates live.
• Always explains itself: every folded post has Why?, with what was detected and one-click fixes such as "Always show this person" or "Stop hiding suggested posts", with Undo.
• For you: pick a few interests and matching posts get a quiet highlight. Highlights, in the side panel, lists the posts picked for you and the ones folded away on the page.
• Fails open: if a site changes its layout and detection looks wrong, unAlgorithm stops hiding and tells you.

OPTIONAL AI, YOUR CHOICE
Rules run in your browser and need no AI. To also spot off-topic posts, engagement bait and rage bait, choose where AI runs:
• Edge's built-in AI, on your computer: a preview in Edge Canary and Dev, where your computer supports it
• your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq)
• a local or self-hosted model (Ollama, LM Studio or any OpenAI-compatible server)

FACT-CHECK AND UNECHO CHAMBER (OFF BY DEFAULT)
For posts in your feed, with your own Anthropic or OpenAI key, or your own AI server and a Brave or Tavily search key:
• Fact-check: checks the claims in a public post against sources on the web, and shows each verdict with its sources and quotes. A check runs only when you confirm it.
• UnEcho Chamber: on a public post that shares a news link, see how outlets across the spectrum covered the story, sorted by unAlgorithm Cloud's source list or your own.

PRIVATE BY DESIGN
• No analytics, no tracking, no account.
• Nothing leaves your browser unless you turn on AI or send a report. With AI on, only what's needed to classify a post goes to the AI you chose: its text (with email addresses, phone numbers, @mentions and tagged names masked), the kind of media, a shared link's site and title, and your interests. Never author names, profile links, comments or images.
• Report a problem sends a report you review to HeitechSoft, unAlgorithm's maker. It holds versions, counts and your answers, never what posts say or who wrote them, and goes only when you click Send report.
• Your API keys stay in this browser.
• unAlgorithm only reads what is already on your screen. It never clicks, scrolls, posts, follows or browses for you.

FREE AND OPEN SOURCE
unAlgorithm Feed is in public preview and open source under the AGPL-3.0 licence: https://github.com/HeitechSoft/unalgorithm

Help: https://unalgorithmfeed.com/help/
Privacy policy: https://unalgorithmfeed.com/privacy/

unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.
```

### Graphics

The Chrome Web Store's set from [`store/`](store/), in the same order ([store-listing.md](store-listing.md#graphics)):

| File | Partner Center field |
|---|---|
| `apps/extension/public/icon/128.png` | Extension Store logo |
| `store/screenshot-1-feed.png` to `store/screenshot-5-settings.png` (1280×800) | Screenshots |
| `store/promo-small-440x280.png` | Small promotional tile |
| `store/promo-marquee-1400x560.png` | Large promotional tile |

### Remote code

All JavaScript ships in the extension package. The AI and search services the user chooses answer with data (JSON),
which is never run as code. unAlgorithm Cloud's published source list is JSON data, never run as code.

### Notes for certification

Paste with each submission (Partner Center keeps the last one). Certification can take up to seven business days.

```text
unAlgorithm Feed folds away ads, suggested posts and other noise on LinkedIn and Facebook. Its rules run in the browser and send nothing. No account is needed.

To try it: open https://www.linkedin.com/feed/ or https://www.facebook.com/ signed in with an English-language account. Ads and suggested posts fold into thin lines, each with Why?. The toolbar popup shows the counts, and Open Highlights in the popup opens the side panel.

AI is optional (Settings → AI): the person's own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq), an AI server they run, or Edge's built-in AI where Edge offers it (a preview in Edge Canary and Dev). Each AI service is an optional host permission, asked for one origin at a time from the click that sets it up; nothing is sent before. "Fix it for me" asks for the optional declarativeNetRequestWithHostAccess permission to remove the Origin header from the extension's own requests to the person's local AI server (such as Ollama).

Report a problem (popup, Why? → Wrong call?, Settings → About, and a note in the feed when detection stops working) opens an extension page that shows every field of the report; only the Send report click posts it, to cloud.unalgorithm.app/v1/reports, with no account, cookie or identifier. It holds versions, the browser, counts and the person's answers; a correction of a Fact-check or UnEcho Chamber result adds their own words and, if they want a reply, an email address.

The extension loads no remote code. With UnEcho Chamber on, it downloads unAlgorithm Cloud's public source list (JSON, no cookie or user data) from cloud.unalgorithm.app at most once a day.

The source is public: https://github.com/HeitechSoft/unalgorithm (the release tag of this version). The package is the same build as the Chrome Web Store's.
```

With the Cloud card, the notes also explain `identity` and `alarms` and give the reviewer account
([release.md](release.md#before-a-store-build-carries-the-cloud-card), item 10). That text is drafted with the store
answers in HeitechSoft's private repository.
