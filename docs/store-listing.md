# Chrome Web Store listing

The text and graphics for UnAlgorithm Feed's Chrome Web Store entry, ready to paste into the developer dashboard
(HeitechSoft developer account). Nothing here is submitted automatically; see [release.md](release.md#chrome-web-store-listing)
for when and how a release goes to the store.

This is for store builds **without the Cloud card** (`UA_CLOUD` unset): the manifest is
`manifestFor('production')` in `apps/extension/wxt.config.ts`, with no `identity`, no `alarms` and no sync. Before a
store build carries the Cloud card, these answers change too ([release.md](release.md#before-a-store-build-carries-the-cloud-card)).

Keep this file in step with [PRIVACY.md](../PRIVACY.md) and the manifest: when a permission or what is sent changes,
update both here and in the dashboard in the same release.

## Store listing tab

| Field | Value |
|---|---|
| Name | **UnAlgorithm Feed** (from `extName` in `apps/extension/public/_locales/en/messages.json`; the dashboard reads it from the zip) |
| Summary | From `extDescription` in the same file (the dashboard reads it from the zip): *See the posts you came for. Folds away ads, suggested posts and other noise on LinkedIn and Facebook.* |
| Category | Lifestyle → **Social Networking**: it works on social feeds, which is where people look for it |
| Language | English |
| Mature content | No |
| Homepage URL | `https://unalgorithmfeed.com/` |
| Support URL | `https://unalgorithmfeed.com/help/` |

### Description

Paste as plain text. It opens with the full name and byline and ends with the non-affiliation line
([brand.md](brand.md)).

```text
UnAlgorithm Feed by HeitechSoft

See the posts you came for.

Social feeds are ranked to keep you scrolling. They mix in ads, posts "suggested for you", "Jane liked this" activity and content from people you never chose to follow. UnAlgorithm Feed folds that noise into a thin line, so you can still peek, and it never touches posts from the people you follow.

Works with LinkedIn and Facebook, in English.

WHAT IT DOES
• Folds away the noise, with no setup: ads (Promoted and Sponsored), suggested posts, network activity, feed panels like People You May Know, groups you haven't joined and, on LinkedIn, people and pages you don't follow.
• Three strengths: Light (just the clutter), Balanced (what you didn't ask for) and Calm (only what matters). Change it from the toolbar and the feed updates live.
• Always explains itself: every folded post has Why?, with what was detected and one-click fixes such as "Always show this person" or "Stop hiding suggested posts", with Undo.
• For you: pick a few interests and matching posts get a quiet highlight. Highlights, in the side panel, lists the posts picked for you and the ones folded away on the page.
• Fails open: if a site changes its layout and detection looks wrong, UnAlgorithm stops hiding and tells you.

OPTIONAL AI, YOUR CHOICE
Rules run in your browser and need no AI. To also spot off-topic posts, engagement bait and rage bait, choose where AI runs:
• Chrome's built-in AI, on your computer, where your computer supports it
• your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq)
• a local or self-hosted model (Ollama, LM Studio or any OpenAI-compatible server)

FACT-CHECK AND UNECHO CHAMBER (OFF BY DEFAULT)
For posts in your feed, with your own Anthropic or OpenAI key, or your own AI server and a Brave or Tavily search key:
• Fact-check: checks the claims in a public post against sources on the web, and shows each verdict with its sources and quotes. A check runs only when you confirm it.
• UnEcho Chamber: on a public post that shares a news link, see how outlets across the spectrum covered the story, sorted by UnAlgorithm Cloud's source list or your own.

PRIVATE BY DESIGN
• No analytics, no tracking, no account.
• Nothing leaves your browser unless you turn on AI. Then only what's needed to classify a post goes to the AI you chose: its text (with email addresses, phone numbers, @mentions and tagged names masked), the kind of media, a shared link's site and title, and your interests. Never author names, profile links, comments or images.
• Your API keys stay in this browser.
• UnAlgorithm only reads what is already on your screen. It never clicks, scrolls, posts, follows or browses for you.

FREE AND OPEN SOURCE
UnAlgorithm Feed is in public preview and open source under the AGPL-3.0 licence: https://github.com/HeitechSoft/unalgorithm

Help: https://unalgorithmfeed.com/help/
Privacy policy: https://unalgorithmfeed.com/privacy/

UnAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.
```

### Graphics

All made from fixtures, never from real feeds, and committed in [`store/`](store/). Upload them in this order.

| File | Size | Dashboard field | Shows |
|---|---|---|---|
| `apps/extension/public/icon/128.png` | 128×128 | Store icon | The mark |
| [`store/screenshot-1-feed.png`](store/screenshot-1-feed.png) | 1280×800 | Screenshot 1 | The LinkedIn fixture feed: two posts marked For you, a folded ad, and three more posts folded into one line |
| [`store/screenshot-2-why.png`](store/screenshot-2-why.png) | 1280×800 | Screenshot 2 | Why? on the folded ad: what was seen, Show this post, Stop hiding ads |
| [`store/screenshot-3-popup.png`](store/screenshot-3-popup.png) | 1280×800 | Screenshot 3 | The toolbar popup on a brand canvas: posts hidden by reason, Strength |
| [`store/screenshot-4-highlights.png`](store/screenshot-4-highlights.png) | 1280×800 | Screenshot 4 | Highlights in the side panel beside the feed |
| [`store/screenshot-5-settings.png`](store/screenshot-5-settings.png) | 1280×800 | Screenshot 5 | Settings → LinkedIn: Strength and what to hide |
| [`store/promo-small-440x280.png`](store/promo-small-440x280.png) | 440×280 | Small promo tile (required) | The mark, "UnAlgorithm Feed" and the tagline |
| [`store/promo-marquee-1400x560.png`](store/promo-marquee-1400x560.png) | 1400×560 | Marquee promo tile (optional) | The lockup, the tagline and an abstract folded feed |

All are 24-bit PNGs without alpha, as the store asks. To make them again, from the repository root:

```bash
pnpm --filter @unalgorithm/extension store:screens
```

```bash
node scripts/make-icons.mjs --store
```

The first builds the e2e extension and runs `apps/extension/e2e/store.spec.ts` (light mode, the fixture feed, the mock
AI server for the For you picks). The second renders the promo tiles from the same drawing as the icons. Look at the
results before committing: fonts come from the machine that renders them.

## Privacy practices tab

### Single purpose

```text
UnAlgorithm Feed curates the user's LinkedIn and Facebook feed. It folds away the posts the user didn't ask for (ads, suggested posts, network activity, groups they haven't joined, people and pages they don't follow), explains each fold with Why?, and highlights the posts that match the user's interests, in the feed and in Highlights in the side panel. Its optional AI classifies the same feed posts more finely (off-topic posts, engagement bait, rage bait). Fact-check, off by default, is a feed feature too: it checks the claims in a public post the user picks in their feed.
```

### Permission justifications

One field per permission in `manifestFor('production')`. These follow the permissions table in
[PRIVACY.md](../PRIVACY.md#permissions).

**storage**

```text
Keeps the user's settings, interests, exceptions ("always show/hide"), feedback ("more/less like this"), daily counts and cached AI results in the browser. While a LinkedIn or Facebook tab is open, it also keeps the lists the popup and side panel show in session storage, which is cleared when the tab closes. An API key the user enters for their own AI provider is stored only in the extension's storage, which web pages cannot read. Nothing in storage is sent to HeitechSoft.
```

**sidePanel**

```text
Shows Highlights in Chrome's side panel: the posts picked for the user and the posts folded away on the current LinkedIn or Facebook page, each with a link to go to it, and the results of the fact-checks the user asked for. The user opens it from the popup, or from a fact-check result in the feed.
```

**scripting**

```text
When the extension is first installed, it starts its own content script, packaged in the extension, in LinkedIn and Facebook tabs that were already open, so the user does not have to reload them before it works. It runs only on www.linkedin.com and www.facebook.com tabs, which the host permissions already cover, and never runs remote code or code from a page.
```

**Host permissions: `https://www.linkedin.com/*` and `https://www.facebook.com/*`**

```text
The content scripts read the feed on these two sites to find posts and fold away the ones the user doesn't want, and add the Why?, Show and For you controls to the page. They read only what is already on the screen and never click, scroll, post, follow or browse for the user. What they read stays in the browser unless the user turns on AI, and then only the fields needed to classify a post go to the AI service the user chose.
```

**Optional host permissions: `https://*/*` and `http://*/*`**

```text
Not granted at install. The extension asks for one origin at a time, from the user's own click, only for a service the user chose: the AI service they set up (an AI provider's API used with their own key, such as api.anthropic.com or api.openai.com, or their own OpenAI-compatible server), or, in Settings → AI, the web search service (Brave or Tavily) whose key they saved. http is needed for local models on the user's own computer, such as Ollama or LM Studio on localhost, which don't serve https. The address can't be known in advance because the user enters it, so the patterns are optional. Settings → Privacy & Data lists every granted origin, and the user can remove each one there.
```

**Optional permission: `declarativeNetRequestWithHostAccess`**

```text
Not granted at install. Asked for only if the user clicks "Fix it for me" because their local AI server (such as Ollama) refuses requests from the extension. It adds one rule that removes the Origin header from the extension's own requests to that one server, a host the user already granted. The rule applies only to requests the extension itself makes. It doesn't block, redirect or change any other request.
```

### Remote code

**No, I am not using remote code.** All JavaScript ships in the extension package. The AI and search services the
user chooses answer with data (JSON), which is never run as code. UnAlgorithm Cloud's published source list is JSON
data, never run as code.

### Data usage

What user data does UnAlgorithm Feed collect? Tick only **Website content**; leave every other category unticked.

| Category | Answer | Why |
|---|---|---|
| Website content | **Yes** | Only when the user turns on AI, and only to the AI service the user chose: the text of feed posts (capped, with email addresses and phone numbers always masked and @mentions and tagged names masked unless the user turns that off), the kind of media and a shared link's domain and title. Fact-check and UnEcho Chamber, when the user turns them on and confirms a check or a comparison, send to that same service one post (Fact-check) or the shared link, its title and the chosen source list's web addresses and leans (UnEcho Chamber), and the claims or the story's search words to Brave or Tavily with the user's own key. None of it goes to HeitechSoft |
| Personally identifiable information, health, financial and payment, authentication, personal communications, location, web history, user activity | No | Author names, profile links, comments, images and browsing history are never sent. API keys stay in the browser and go only to the provider they belong to |

With each classification, the AI service also receives the user's interests, the optional "About you" note and, if
the user turned on learning from ratings, short AI-written summaries of up to 4 posts they rated. These are the user's
own settings for the same feed, sent to the service the user chose, not one of the categories above. If a reviewer
asks, point to *When you turn on AI* in the privacy policy. While UnEcho Chamber is on, the extension downloads
UnAlgorithm Cloud's public source list at most once a day; the request carries no user data.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

`https://unalgorithmfeed.com/privacy/` (built from [PRIVACY.md](../PRIVACY.md)).
