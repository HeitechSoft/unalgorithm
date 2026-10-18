# Firefox Add-ons listing

The text for unAlgorithm Feed's listing on Firefox Add-ons (addons.mozilla.org, AMO), ready to paste into the
Developer Hub (HeitechSoft's AMO developer account). The first version and its listing are submitted by hand; later
versions go up with each release, and the listing stays as saved ([release.md](release.md#firefox-add-ons-credentials)).

This is for store builds **without the Cloud card** (`UA_CLOUD` unset): the manifest is
`manifestFor('production', 'firefox')` in `apps/extension/wxt.config.ts`, with no `identity`, no `alarms` and no sync.
Before a store build carries the Cloud card, the privacy policy and the reviewer notes change too
([release.md](release.md#before-a-store-build-carries-the-cloud-card)).

The description repeats the Chrome Web Store's ([store-listing.md](store-listing.md)) line for line, except where
Firefox differs: no built-in AI, and Highlights in the sidebar. Keep the stores in step with each other, with
[PRIVACY.md](../PRIVACY.md) and with the manifest.

## Add-on details

| Field | Value |
|---|---|
| Add-on id | `feed@unalgorithmfeed.com`, from `browser_specific_settings.gecko.id`. It is fixed by the first upload and never changes: unAlgorithm servers key devices and the sign-in address to it |
| Name | **unAlgorithm Feed** (from `extName` in `apps/extension/public/_locales/en/messages.json`; AMO reads it from the zip) |
| Add-on URL | `https://addons.mozilla.org/firefox/addon/unalgorithm-feed/` (slug `unalgorithm-feed`) |
| Summary | From `extDescription` in the same file (AMO reads it from the zip on the first upload): *See the posts you came for. Folds away ads, suggested posts and other noise on LinkedIn and Facebook.* |
| Categories | **Social & Communication**, and **Feeds, News & Blogging** |
| Compatibility | Firefox for desktop. The minimum version, Firefox 147, comes from `strict_min_version` |
| License | GNU Affero General Public License v3.0 (the code is `AGPL-3.0-only`) |
| Homepage | `https://unalgorithmfeed.com/` |
| Support site | `https://unalgorithmfeed.com/help/` |
| Privacy policy | Yes. Paste the released [PRIVACY.md](../PRIVACY.md), the same text as `https://unalgorithmfeed.com/privacy/`. AMO keeps its own copy: paste it again whenever PRIVACY.md changes |
| Requires payment, non-free services or software | No. The rules are free and need nothing else; AI is optional, and an AI provider used with the person's own key bills them directly |
| Release notes (each version) | The version's section of `apps/extension/CHANGELOG.md` |

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
• For you: pick a few interests and matching posts get a quiet highlight. Highlights, in Firefox's sidebar, lists the posts picked for you and the ones folded away on the page. Open it from the toolbar button or with Alt+Shift+U.
• Fails open: if a site changes its layout and detection looks wrong, unAlgorithm stops hiding and tells you.

OPTIONAL AI, YOUR CHOICE
Rules run in your browser and need no AI. To also spot off-topic posts, engagement bait and rage bait, choose where AI runs:
• your own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq)
• a local or self-hosted model (Ollama, LM Studio or any OpenAI-compatible server)

FACT-CHECK AND UNECHO CHAMBER (OFF BY DEFAULT)
For posts in your feed, with your own Anthropic or OpenAI key, or your own AI server and a Brave or Tavily search key:
• Fact-check: checks the claims in a public post against sources on the web, and shows each verdict with its sources and quotes. A check runs only when you confirm it.
• UnEcho Chamber: on a public post that shares a news link, see how outlets across the spectrum covered the story, sorted by unAlgorithm Cloud's source list or your own.

PRIVATE BY DESIGN
• No analytics, no tracking, no account.
• Nothing leaves your browser unless you turn on AI. Then only what's needed to classify a post goes to the AI you chose: its text (with email addresses, phone numbers, @mentions and tagged names masked), the kind of media, a shared link's site and title, and your interests. Never author names, profile links, comments or images.
• Firefox asks for your consent before post text goes to the AI or web search service you chose, even one on your computer.
• Your API keys stay in this browser.
• unAlgorithm only reads what is already on your screen. It never clicks, scrolls, posts, follows or browses for you.

FREE AND OPEN SOURCE
unAlgorithm Feed is in public preview and open source under the AGPL-3.0 licence: https://github.com/HeitechSoft/unalgorithm

Help: https://unalgorithmfeed.com/help/
Privacy policy: https://unalgorithmfeed.com/privacy/

unAlgorithm Feed is not affiliated with, endorsed by, or sponsored by LinkedIn or Meta.
```

### Graphics

AMO takes the icon from the zip. Upload the five screenshots from [`store/`](store/) in the order the Chrome Web Store
listing gives ([store-listing.md](store-listing.md#graphics)): they are made from fixtures, and screenshot 4 shows
Highlights beside the feed, as Firefox's sidebar shows it too. AMO has no promo tiles.

### Permissions

AMO has no justification fields: Firefox shows the permissions from the manifest at install, and reviewers read the
notes below. Every permission in `manifestFor('production', 'firefox')`:

**storage**: the person's settings, interests, exceptions, feedback, daily counts and cached AI results, in the
browser; the popup's and sidebar's lists in session storage while a feed tab is open. An API key is stored only in
the add-on's own storage, which pages can't read.

**declarativeNetRequestWithHostAccess**: required, because Firefox can't make it optional; it shows no prompt. Used
only after the person clicks Fix it for me because their local AI server (such as Ollama) refuses the add-on: one rule
removes the Origin header from the add-on's own requests to that one server, a host the person already granted.

**Host permissions: `https://www.linkedin.com/*` and `https://www.facebook.com/*`**: the content scripts read the
feed to fold posts away and add the Why?, Show and For you controls. They read only what is on the screen and never
click, scroll, post, follow or browse.

**Optional host permissions: `https://*/*` and `http://*/*`**: not granted at install. Asked for one origin at a time,
from the person's click, only for a service they chose: their AI provider's API, their own AI server (http for local
models such as Ollama on localhost), or the web search service whose key they saved. Settings → Privacy & Data lists
and removes them.

The Firefox build has no `scripting` permission (Firefox starts the content scripts in open tabs itself) and no
`sidePanel` permission (Highlights is a `sidebar_action`, with the `_execute_sidebar_action` shortcut Alt+Shift+U).

### Data collection

AMO and Firefox read these from `browser_specific_settings.gecko.data_collection_permissions`; Firefox shows them in
its add-ons page. The manifest declares only the types its build uses. The add-on asks for an optional type only from a
click, in Firefox's own prompt, and asks for a service on this computer (such as Ollama on `localhost`) as for any
other: a local server is outside the browser and can pass on what it receives.

| Key | Type | When and what |
|---|---|---|
| `required` | `none` | Rules alone send nothing anywhere |
| `optional` | `websiteContent` | Asked, with `personalCommunications`, in the click that turns on any AI source but on-device AI (which Firefox doesn't have): the person's own key, or an AI server on this computer, their network or the internet; and in the click that saves a web search key. Same prompt as that service's host permission. The two cover what goes there: the text of feed posts (capped, with email addresses and phone numbers always masked and @mentions and tagged names masked unless the person turns that off), the kind of media, a shared link's domain and title, and, for Fact-check and UnEcho Chamber, one post, or the shared link, its title and the chosen source list's web addresses and leans (UnEcho Chamber), and the claims or the story's search words to Brave or Tavily |
| `optional` | `personalCommunications` | Asked with `websiteContent`, in the same clicks: the posts are other people's social media posts, which Mozilla lists under personal communications |

Consent withdrawn in Firefox's add-ons page stops that sending, like a removed permission, and the add-on offers to ask
again. In this build none of it goes to HeitechSoft. The download of unAlgorithm Cloud's public source list (below)
carries no user data and needs no type.

**No data choice at install.** Firefox's install prompt offers an optional data type only when the manifest declares
*technical and interaction data*, which Firefox shows as a choice that is on unless the person turns it off. This build
declares neither that type nor any other it doesn't use, so the prompt has no data choice, and nothing is granted until
the person turns on an AI source or saves a web search key.

**With the server card** (`UA_CLOUD=1`), the manifest declares three more optional types, and the add-on uses them as
follows (the store answers for that build are drafted in HeitechSoft's private repository):

| Type | When and what |
|---|---|
| `personallyIdentifyingInfo` | Asked, with `websiteContent`, `personalCommunications` and `authenticationInfo`, in the click that signs in to an unAlgorithm server (one on this computer included), and again from *Turn on*, *Turn on sync* or *Allow* if it was withdrawn: with sync, the names and profile identifiers of the people the person chose to always show or hide, in the synced settings |
| `authenticationInfo` | Asked in the same clicks: the account the sign-in registers with that server, and this device's sign-in to it, whose tokens go only back to that server |
| `technicalAndInteraction` | Never asked for, and nothing depends on it, as Mozilla's add-on policies require. Firefox's install prompt offers it, on unless the person turns it off, and its add-ons page changes it at any time. It decides one thing: whether signing in sends the device name, such as "Firefox on Linux" (from Firefox's name for itself and the operating system). A sign-in without it leaves the device unnamed on the server ("Unnamed device" in the devices list), a change applies from the next sign-in, and everything works the same |

The server, with its AI labels, Fact-check, UnEcho Chamber, settings sync, credit balance and device list, is used only
while `websiteContent`, `personalCommunications`, `personallyIdentifyingInfo` and `authenticationInfo` are all granted.
Withdrawing any of them stops every request that carries the person's data or this device's sign-in, and the add-on
offers *Allow*; only signing out still sends this device's sign-in, to end the device there. Two anonymous reads (no
cookie, token or user data) need no type and don't wait for consent: the server's public
`/.well-known/unalgorithm.json`, read whenever the add-on checks what a server offers, starting when the person chooses
one; and, with UnEcho Chamber on, the download of unAlgorithm Cloud's public source list (below), a request to the Cloud
whether or not the person signed in to it.

**Report a problem is not data collection.** The link (in the popup, and under *Why? → Wrong call?*) opens a new GitHub
issue form in a new tab, with diagnostics in its address: the versions, the browser's name and major version, the page's
language, whether detection looked healthy, counts and detector names, and the date. No post text, names, ids or links.
The add-on itself sends and keeps nothing: the browser opens the github.com page the person asked for, as for any link,
and GitHub handles that page load under its own terms. The person sees every diagnostic in the form, and can change or
delete it, before anything is filed; it is filed only when they submit it themselves, under their own GitHub account.
Until then nothing reaches HeitechSoft, and what HeitechSoft then reads is a public issue the person chose to post. So no
data type covers it.

### Remote code

All JavaScript ships in the add-on. The AI and search services the person chooses answer with data (JSON), which is
never run as code. unAlgorithm Cloud's published source list is JSON data, never run as code.

### Source code

The release uploads `unalgorithm-<version>-sources.zip` with each version, since the code is bundled and minified. Its
`docs/amo-build.md` ([here](amo-build.md)) gives the reviewer the exact build: Node.js 22, pnpm through corepack,
`pnpm install --frozen-lockfile`, then `pnpm --filter @unalgorithm/extension exec wxt build -b firefox`. CI rebuilds
the Firefox zip from the sources zip on every change and compares the two byte for byte.

### Notes for Reviewers

Paste them with the first upload. The release's uploads send only the files, so paste them on each new version's page
in the Developer Hub too, where a reviewer of that version reads them.

```text
unAlgorithm Feed folds away ads, suggested posts and other noise on LinkedIn and Facebook. Its rules run in the browser and send nothing. No account is needed.

To try it: open https://www.linkedin.com/feed/ or https://www.facebook.com/ signed in with an English-language account. Ads and suggested posts fold into thin lines, each with Why?. The toolbar popup shows the counts; Open Highlights in the popup, or Alt+Shift+U, opens the sidebar.

AI is optional (Settings → AI): the person's own API key (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq) or an AI server they run. The click that turns on a source asks for that site's host permission and, in the same prompt, consent to share website content and personal communications (the feed posts are other people's social media posts); nothing is sent before. A local server such as Ollama on localhost is asked for in the same way, since it is outside the browser. "Fix it for me" uses declarativeNetRequestWithHostAccess to remove the Origin header from the add-on's own requests to that one local server.

Data collection: required is none, and the only optional types are website content and personal communications, asked for as above and when a web search key is saved. The manifest declares no other type, so Firefox offers no data choice at install.

Report a problem (popup, and Why? → Wrong call?) opens a prefilled GitHub issue form in a new tab, with counts and versions in its address and no post text, names, ids or links. Nothing is filed until the person submits the issue on GitHub themselves, and nothing reaches us before that, so we don't count it as data collection.

Source code: the uploaded sources zip. docs/amo-build.md in it has the build: Node.js 22, pnpm 10.34.6 through corepack, "pnpm install --frozen-lockfile", then "pnpm --filter @unalgorithm/extension exec wxt build -b firefox". The output, apps/extension/.output/firefox-mv3, is identical to the uploaded zip.

Linter warnings: DANGEROUS_EVAL is zod's check for eval support and its parser compiler. The add-on sets zod's jitless option before anything else in every entry point, so zod never runs them and no code is made from strings. UNSAFE_VAR_ASSIGNMENT is react-dom's code for dangerouslySetInnerHTML and SVG, which the add-on doesn't use.

The add-on loads no remote code. With UnEcho Chamber on, it downloads unAlgorithm Cloud's public source list (JSON, no cookie or user data) from cloud.unalgorithm.app at most once a day.
```

With the Cloud card, the notes also explain `identity` (it opens the chosen server's sign-in page with
`launchWebAuthFlow` and receives a one-time code back), `alarms` (settings sync on a short timer) and the three data
types the build adds ([above](#data-collection)), and give the reviewer account
([release.md](release.md#before-a-store-build-carries-the-cloud-card), item 10). That text is drafted with the store
answers in HeitechSoft's private repository.
