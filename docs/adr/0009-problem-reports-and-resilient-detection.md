# ADR 0009: Problem reports in the extension, and detection that notices when it breaks

- Status: Accepted. The owner decided the open items on 2026-10-19 ([Owner decisions](#owner-decisions)); the
  implementation's departures from the text below are under [As built](#as-built).
- Date: 2026-10-18
- Amends: [ADR 0002](0002-read-only-adapters-and-fail-open.md) (consequences), [ADR 0008](0008-firefox-and-edge.md)
  (data collection: where `technicalAndInteraction` is declared, and *Report a problem*)

## Context

Today every way to report a problem opens a GitHub issue form: *Report a problem* in the popup and its paused banner,
*Why? → Wrong call?*, Settings → About, and the side panel's *Report a wrong verdict* / *Report a mistake*
(`content/report.ts`, `lib/report-links.ts`). The people who use unAlgorithm are not technical. Most have no GitHub
account, and a correction filed there makes their username public.

The owner decided on 2026-10-18:

1. Problems are reported **inside the extension** and go to **unAlgorithm Cloud** (`cloud.unalgorithm.app`), for
   everyone, in every browser, with or without an account or Cloud AI. Nobody is sent to GitHub.
2. Reports are **user-submitted only**. The extension may notice breakage and say so, but nothing is sent until the
   person clicks to send, after seeing exactly what will be sent. "No analytics or tracking" stays true.
3. The purpose is for HeitechSoft to learn quickly when LinkedIn or Facebook change their feed in a way that breaks
   detection, because store releases take days.
4. Detection must survive feed tweaks (layered, semantic signals, failing open per ADR 0002), and the extension must
   notice when it has stopped working, including silent failures.

What failed silently in the 2026-10-18 live session (both LinkedIn failures are fixed in the 0.4.0 working tree):

- LinkedIn sent some accounts from `/feed/` to `/feed/foryou/`. `isFeedPage` rejected it, so the controller never
  started and nothing noticed. The popup said "Go to feed" while the person was on it.
- Ads labelled "Promoted • Partnership with LinkedIn" didn't match the label pattern. Health stayed `ok`, because every
  current check looks for over-detection.
- On Facebook, virtualised and emptied slots raised `stuck-skeletons` in all 11 snapshots: a false alarm.

A read-only mutation probe against today's anonymized captures found more:

| Change to the page | Result | Noticed? |
|---|---|---|
| LinkedIn: `componentkey` prefix renamed, or `role="listitem"` dropped | 0 items | after 10 s (`no-items`) |
| LinkedIn: `data-testid="mainFeed"` dropped | infinite scroll stalls while posts are folded | no |
| LinkedIn: a new suffix after "Promoted" / a "\|" separator | 6 of 6 / 2 of 6 ads shown | no |
| LinkedIn: post text with a line "Sponsored by Example Labs", or a bold "Promoted" | the post is hidden as an ad | no (false positive) |
| Facebook: hidden "Feed posts" heading or `aria-posinset` removed | no feed found | after 10 s (`no-feed`) |
| Facebook: "Ad" becomes "Ad · Paid" | 3 of 3 ads shown | no |
| Facebook: one extra wrapper around the list | items hold several posts and get hidden | no (over-hiding) |

Constraints: ADR 0002 (read-only adapters, evidence strength, fail open); ADR 0008 (Firefox `required: ['none']`;
`technicalAndInteraction` is optional only, offered at install, never requested and gates nothing, decision D6); the
Chrome Web Store user data policy (Limited Use); Edge Add-ons; Mozilla's add-on policies 6.2 and 6.3 (private
browsing); PIPEDA, Quebec's Law 25 and the GDPR for people outside Canada.

## Decision

### 1. Rules that hold everywhere

1. **User-submitted only.** Nothing about a page, a check or a report leaves the browser until the person clicks
   **Send report** on the report page, which first shows exactly what will be sent. There is no beacon, queue,
   automatic retry, update check or remote configuration. An e2e guard fails any test run in which `/v1/reports` is
   requested without a Send click.
2. **One destination.** `REPORTS_URL = CLOUD_ORIGIN + '/v1/reports'` (a protocol constant), from every build and
   browser, whatever AI source or server the person uses. Never the person's own server, never GitHub, never a third
   party. Only e2e builds point it at the test server.
3. **Content-free by construction.** A report holds versions, codes, counts and the person's choices. A correction
   adds the person's own words and, if they want a reply, an email address. Never post text, names, profile or post
   links, ids, URLs, query strings, images, time on page, scrolling, or an identifier for the person, browser or
   install.
4. **Fail open, and say so.** Reporting never changes what is hidden. Unsure detection shows posts (ADR 0002). When
   detection degrades, it says so: always in the popup, and in the feed when there is positive evidence (§3).

### 2. Reporting in the extension

**Entry points.** Each opens the report page; none opens GitHub.

| Where | Kind |
|---|---|
| Popup footer *Report a problem* | `detection` (`other` off LinkedIn and Facebook) |
| Popup banner *Filtering is paused on this page* → *Let us know* | `detection` |
| In-feed notice card (§3) → *Let us know* | `detection` |
| *Why? → Wrong call?* | `wrong-call`, with that post's summary |
| Settings → About → *Report a problem*, which asks "What's it about?" (LinkedIn / Facebook / Something else) | `detection` without page facts, or `other` |
| Side panel *Report a wrong verdict* (Fact-check) / *Report a mistake* (UnEcho Chamber) | `correction` |

`reportProblemUrl`, `correctionUrl`, `LIST_OPTIONS`, the popup's `NEW_ISSUE` and the `reportUrl` message go. A build
test fails if `github.com/HeitechSoft/unalgorithm/issues` appears in any built bundle. `SOURCE_REPO` stays for
*Source code* links.

**The report page** is an extension page, `report.html`, opened in a new tab next to the feed tab. It isn't the popup
(which closes on blur and has no room for the preview), it isn't inside LinkedIn's or Facebook's page (their scripts
can watch it, and Firefox has no `permissions` API in content scripts), and it isn't the side panel (Firefox can't open
its sidebar from a click in the page).

1. At the click, the content script builds a draft (`buildReportDraft`). The background checks it against the
   schema, adds `env`, keeps it in `storage.session` (1 hour, at most 5 drafts) and opens the tab next to the sender.
   Settings → About, and the popup when its tab doesn't answer, send only what the report is about, and the background
   builds the drafts from the settings (`draftsAbout`).
2. The page shows the choices, **What we'll send** (plain lines from `describeReport`) and **Show exactly what's
   sent** (the JSON body, byte for byte).
3. On **Send report**, the background:
   - checks that the sender is `report.html`;
   - parses the body with the schema and refuses it unless it equals the stored draft plus what the page may add
     (choices, and a correction's text and email);
   - checks the local limit and, on Firefox, consent (§5);
   - makes one `fetch`, with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `redirect: 'error'`,
     `cache: 'no-store'`, a 15 s timeout and, on Firefox, `keepAwake`.

   *Try again* resends the same report id, and the server answers a repeat with the same reference.

More rules for the page:

- When the popup's tab doesn't answer, the background builds the draft from the settings for the tab's site, with
  `page.route: 'unknown'` and the issue `no-content-script`.
- From a private window (`sender.tab.incognito`), the draft holds only its kind, where it started, `env`, the choices
  and `private: true` (Mozilla 6.3). The page says: "This is a private window, so the report includes nothing about the
  page."
- Local limits, kept in `storage.local` as timestamps only and never sent: 3 sends an hour and 10 a day. Each draft
  sends once, and a double click can't send twice.
- The in-feed card acts only on `event.isTrusted` clicks, and the background opens at most one report tab per feed
  tab per minute. While that tab's report is unsent, the same report again brings the tab back and another one (*Wrong
  call?* on another post) takes its place there; once it is sent, the next report gets its own tab.
- *Erase everything* clears the drafts and the local log.

**What each kind asks.** Only corrections take free text or an email address.

| Kind | Asks | Choice codes |
|---|---|---|
| `detection` | "What's wrong?" Checkboxes. At least one is needed, except from the notice card or a tab whose content script didn't answer, where the finding speaks for itself. | `ads-showing` Ads are still showing · `unwanted-showing` Posts I didn't want are still showing · `wanted-hidden` Posts I wanted are hidden · `not-working` unAlgorithm isn't doing anything on this page · `page-broken` The page looks broken or slow · `other` Something else |
| `wrong-call` | Radio, required | `should-show` This post shouldn't have been hidden · `wrong-reason` It was hidden for the wrong reason |
| `correction` | Radio, required. Then **In your own words** (required, 1 to 1000 characters), then an optional reply email. | Fact-check: `verdict-wrong` The verdict is wrong · `source-wrong` A source is wrong or doesn't say that · `other`. UnEcho Chamber: `comparison-wrong` The comparison is wrong or unfair · `outlet-wrong` An outlet or its lean is wrong · `other` |
| `other` | "What's it about?" Radio, required | `sign-in-sync` Signing in or sync · `ai` AI labels, Fact-check or UnEcho Chamber · `credits` Credits · `other` Something else |

Correction copy:

- The text field's hint: "Describe the claim as you understood it and why the result is wrong. Please don't paste the
  post or a link to it, and leave out names and any health, political or other sensitive details about you or anyone
  else. Email addresses, phone numbers and links are removed."
- The email field: "Only if you'd like a reply. We keep it until 30 days after we answer, and never more than 60
  days."
- Without an email: "Without an email we can't reply, but we review every correction and count it in our transparency
  report."

The text is cleaned as the person types (NFKC; control, zero-width and bidi characters stripped; `redact()` with
mentions masked; every link, with or without `https://` or `www.`, reduced to its site, so a personal subdomain goes
too, and a profile or post address on its own such as `/in/jane` or `profile.php?id=…` made `[link]`), so the preview
shows `[email]`, `[phone]`, `@someone` and `[link: example.org]`. The server cleans it again, and the wire schema
refuses words that still hold a link.

**Copy** (draft; strings live in one `REPORT_COPY` table so tests pin them):

- **Title:** "Report a problem".
- **Lead:** "This goes to HeitechSoft, who make unAlgorithm, so we can fix it in the next update."
- **What we'll send**, an example:
  - "unAlgorithm 0.4.0 from the Chrome Web Store · LinkedIn detection 2026.10.2"
  - "Chrome 141"
  - "Page: LinkedIn home feed (a new address: foryou), in English"
  - "Your settings: Balanced, AI off"
  - "unAlgorithm noticed: LinkedIn's feed is on a page unAlgorithm doesn't recognise"
  - "On this page: 22 posts, 2 panels, 15 folded away (5 ads, 5 not followed, 5 network activity)"
  - "Detection rules that matched: ad label 5, Follow button 12, …"
  - "Your answer: Ads are still showing"
  - For *Wrong call?*: "The post: hidden as Suggested by a rule; seen: suggested header (strong); author: a person you
    don't follow; long text."
- **Never sent:** "Not sent: what posts say, names, links, pictures or your account. Nothing in the report identifies
  you or this browser." For a correction, which carries the person's words and maybe their email: "Not sent: the post,
  the result or your account. Your own words are sent as shown above, and your email only if you give it."
- **Destination:** "Sent to unAlgorithm Cloud (cloud.unalgorithm.app), HeitechSoft's server, whatever AI you use.
  HeitechSoft's team reads each report to fix unAlgorithm. Kept for 90 days. Privacy policy"
- **Buttons:** **Send report** and **Cancel**. Send is never disabled: a missing required choice shows "Choose at least
  one" (or "Choose one") next to the group and moves focus to it.

| State | Copy |
|---|---|
| Sent | **Thanks, we got it.** We read every report. When LinkedIn or Facebook change something, the fix comes in an update, usually within a few days. Reference **7KQ3-M2PA**. Want to tell us more, or get a reply? Email {support address} and mention your reference. *(mailto with that subject)* · Back to {site} / Close |
| Network error or timeout | **Couldn't send the report.** Check your internet connection, then try again. · Try again |
| 429 | **You've sent several reports in a short time.** Please try again in about an hour. · Try again |
| 503, or any other 5xx (a database failure, the proxy during a deploy) | **We can't take reports right now.** Please try again later. · Try again · Email it instead |
| 400, 403, 404 or 413 | **This report couldn't be sent.** Update unAlgorithm and try again, or email it to us. · Email it instead |
| Local limit | **You've sent several reports today.** Thank you, we have what we need. · Close |
| Firefox without consent (§5) | **Firefox is set not to share technical data from unAlgorithm.** Email this report instead, or allow *Technical and interaction data* in Firefox: menu → Add-ons and themes → unAlgorithm → Permissions. · Email this report |
| Draft expired | This report has expired. Go back to the page and choose Report a problem again. |

*Email it instead* opens a `mailto:` to the support address with the same `describeReport` lines in the body. The
person's own email program sends it; the extension transmits nothing.

### 3. Noticing breakage

**Routes.** Each adapter classes a URL as `feed`, `feed-candidate` or `not-feed` (`classifyRoute`). `isFeedPage` stays,
as `classifyRoute(url) === 'feed'`.

| | `feed` | `feed-candidate` |
|---|---|---|
| LinkedIn | `/feed/`, `/feed/foryou/` | `/`, `/feed/<word>/`, `/home/`, `/home/<word>/`. A word matches `^[a-z][a-z0-9-]{1,24}$` and isn't `update`, `hashtag`, `following`, `followers`, `saved` or `news`. |
| Facebook | `/`, `/home.php` (so `?sk=h_chr` too) | `/home`, `/feed`, `/feeds`, each optionally with one more word. Usernames, groups, pages and Watch never qualify. |

On a candidate route:

- **Strong home signature** (`homeSignature(doc)`): LinkedIn has `[data-testid="mainFeed"]` or `FeedType_MAIN_FEED`
  card keys; Facebook has an `aria-current="page"` home link plus the feed list. The controller starts normally and
  records the report-only issue `route-new`. A move like `/feed/foryou/` then keeps working with no release, and the
  next report tells us about it.
- **Otherwise**, a read-only watchdog (`content/watchdog.ts`) probes at 5 s, 12 s and 19 s of *visible* time (the third
  gives a slow page a second chance) and stops at 25 s. A probe passes when the feed scope is found, there are at least
  3 items, and at least 2 of the first 10 inspect as posts with an author. Two passing probes raise
  `feed-not-started`. Nothing is hidden, nothing goes to AI, and no statistics are
  kept.

The popup pings the tab. With no answer within 1.5 s on a platform tab that has finished loading and has no tab state,
it shows "unAlgorithm isn't running on this page. Reloading the page usually fixes this." with *Reload page* and
*Still not working? Let us know* (issue `no-content-script`).

**Health checks.** `evaluateHealth` stays pure. All time limits count visible time only. Thresholds come from the live
numbers: LinkedIn showed 25% ads (5 of 20) with Balanced hiding 75%; Facebook showed about 18% ads.

| Issue | Rule | Effect (fail open) | Shown |
|---|---|---|---|
| `feed-not-started` | Watchdog, as above | nothing runs | **card** `not-running`, popup, toolbar title |
| `route-new` | Candidate route started on a strong signature | runs normally | report only |
| `no-content-script` | Popup ping, as above | — | popup |
| `adapter-error` *(new)* | 3 or more adapter exceptions caught on the page (counts per operation, never messages) | broken | **card** `paused`, popup |
| `over-filtering`, `module-overmatch`, `text-detection` | As today (Balanced allows 90% hidden, not counting ads) | broken | **card** `paused` after 2 checks in a row, popup |
| `ad-label-near-miss` *(new)* | 2 or more posts on this page load whose ad label is a near miss (§9) with the same in-memory hash. Ad labels are templates and repeat; one-off lines don't | none: a near miss plus weak evidence still hides | **card** `ads-through`, popup |
| `no-feed` | No feed scope after 10 s visible, **and** a signed-in shell is present (`signedIn(doc)`: LinkedIn's global nav; Facebook's top bar or account menu), so login pages, checkpoints and consent walls stay quiet | broken | popup |
| `no-items` | Feed scope with 0 items after 10 s visible | broken | popup |
| `sponsored-overmatch` *(changed)* | More than 50% of posts are ads, over at least 20 posts (was 40% over 10, a 7.8% false-trip chance per window at LinkedIn's 25% ad rate) | ads stop hiding | popup |
| `author-detection` | As today | relationship stops counting | popup |
| `stuck-skeletons` *(changed)* | Only items that have been near the viewport for 15 s or more | none (was degraded) | report only |
| `no-ads-seen` *(new)* | No ads over at least 40 LinkedIn or 50 Facebook posts (chance at today's rates: about 10⁻⁵) | none | popup line: "No ads found on this page yet." |
| `ad-cue-unlabelled` *(new)* | At least 3 posts with an unlabelled ad cue (LinkedIn: no post age plus a Follow button) while no labelled ad was seen, over at least 20 posts | none | report only, until calibrated on more captures |
| `header-unrecognised` *(new)* | At least 4 unknown header lines, making up at least half of the header lines, over at least 15 posts | none | report only |
| `items-not-growing` *(new)* | The person scrolled at least 5 screens, the feed grew at least 4, and no new item registered | none | report only (an expanded comment thread can cause it) |
| `multi-post-items`, `fallback-discovery`, `load-more-missing` *(phase B, §9)* | An item holding several posts, a fallback discovery strategy winning, or no load-more marker for 30 s | that item never hides / cautious mode | report only |

Visible time and scroll distance are used on the device to decide these issues. They never go into a report.

**The in-feed notice card** (`packages/ui/src/feed/Notice.tsx`) is the "broken" banner. It shows only on positive
evidence. Absence-based issues (`no-feed`, `no-items`, `no-ads-seen`, `stuck-skeletons`, `items-not-growing`) never
raise it.

| Card | Raised by | Title | Body |
|---|---|---|---|
| `not-running` | `feed-not-started` | unAlgorithm isn't running on this feed | {site} seems to have changed this page, so your feed shows as usual. |
| `paused` | `broken` from `adapter-error`, `over-filtering`, `module-overmatch` or `text-detection` | Filtering is paused on this page | {site} looks different today, so we're showing every post rather than hide the wrong ones. |
| `ads-through` | `ad-label-near-miss` | Some ads may be getting through | {site} may have changed how it labels ads. |

- **Buttons:** **Let us know** opens the report page with the snapshot taken at that moment. **Not now** (also ✕ and
  Escape) hides the card. Footnote: "Nothing is sent unless you choose to."
- **Placement:** bottom left, above the toasts, inside our existing shadow-root layer. It is never inserted into the
  platform's feed list. One card at a time, in the priority order of the table. A watchdog page with no controller
  gets a notice-only layer.
- **Showing:** an issue must hold in 2 health checks in a row (10 s apart). Each kind shows at most once per page
  load, and never while the site is paused or off or the coach mark is showing. It goes away silently if the issue
  clears.
- **Snoozes:** *Not now* snoozes that platform and kind for 24 hours. A report sent from any surface snoozes it for 7
  days. A snooze ends early when the adapter version changes. Snoozes live in device settings (`device.notices`,
  never synced) and are shared across tabs.
- **Settings → Display:** the switch **Tell me when something breaks** (on by default). Its footer: "If LinkedIn or
  Facebook changes and unAlgorithm can't keep up, a short note appears in your feed. Nothing is sent unless you choose
  to."
- **Accessibility:** a `region` named "unAlgorithm" around a polite `status`. The card never takes focus; its buttons
  are native. axe runs on the shadow root in both themes.

**Popup, side panel, toolbar.** They show the same state whatever the snoozes:

- The popup has banners from `tabState.notice`. While `tabState.feedLike` is set, the popup says "unAlgorithm isn't
  running on this feed" instead of "Go to feed".
- The side panel has a banner for `not-running` and `paused`.
- The toolbar title for `not-running` is "unAlgorithm isn't running on this {site} page". The badge is never alarming
  (ux-spec).

### 4. Wire contract (`packages/protocol/src/report.ts`)

One schema serves the extension, the server and the admin page. It is a zod `z.object`: unknown keys are stripped,
never stored, and never cause a 400.

```
ProblemReport {
  v: 1; id: uuid                      // random per report; idempotency only
  kind: 'detection' | 'wrong-call' | 'correction' | 'other'
  from: Code                          // popup | popup-banner | notice | why | settings | sidepanel | popup-no-script
  choices: Code[≤6]
  env: { extension: semver; channel: chrome-store | edge-store | firefox-store | sideload | development | other;
         browser: chrome | edge | firefox | other; browserMajor: int; client?: GeckoId }   // client: Firefox only, never stored
  private?: true                      // from a private window: then no page, health, detection or post
  page?: { platform; adapter: 'linkedin@2026.10.2';                // dated in the month it is built
           route: 'feed' | 'feed-candidate' | 'other' | 'unknown';
           feedWord?: /^[a-z][a-z0-9-]{1,24}$/;           // only for feed-candidate, never a deny-listed word
           lang: primary subtag | 'unknown'; preset; ai: off | on-device | own-key | own-server | cloud; paused: bool }
  health?: { status: ok | degraded | broken | unsupported-locale | not-started; issues: Code[≤16]; degraded: Code[≤8] }
  detection?: { counts: {CountKey: n}; hiddenBy: {FilterReason: n}; detectors: {DetectorId: n}≤64;
                landmarks: {LandmarkKey: n}≤16; observations: {ObservationId: n}≤32;
                errors: {feedScope|findItems|inspect|itemRootOf|probe: n}; strategy?: StrategyId }
  post?: { reason; source: rule | user | ai; evidence: {detector, strength}[≤24]; authorKind;
           relationship: followed | not-followed | unknown; media; text: none | short | long; module?: Code }
  correction?: { feature: factcheck | perspectives; promptVersion; list?: cloud | own; via: own-key | own-server | cloud;
                 message: 1..1000 chars; contact?: email }
}
Accepted { ok: true; ref: '7KQ3-M2PA' }
```

- **Codes** are pattern-checked on the wire: `^[a-z][a-z0-9-]{0,39}$`, detector ids `^(li|fb)\.[a-z0-9-]+(\.[a-z0-9-]+){0,4}$`,
  and keys `^[a-zA-Z][a-zA-Z0-9]{0,31}$`. A newer extension's new code is therefore never refused. The server
  **stores only codes listed in `packages/protocol/src/report-codes.ts`**: issues, choices, origins, count and
  landmark keys, filter reasons, module kinds, and each adapter's detector, observation and strategy ids. Anything
  else is dropped and counted in `unknown_codes`, so a bug or a forged request can't store a name in a code. The one
  exception is a candidate route's `feedWord`, held only to its pattern, the deny list and the route: a forged request
  could store a slug there (owner decision 11). A new code goes into the registry, and the Cloud is deployed, before an
  extension that sends it ships. A platforms test checks that every id an adapter can emit is in the registry.
- **Kind rules** (`superRefine`):
  - `wrong-call` needs `page`, `post`, `health` and `detection`.
  - `detection` needs `page`; `health` and `detection` are needed unless `page.route` is `unknown`.
  - `correction` needs `correction`, and never has `page`.
  - `post` appears only on `wrong-call`, and `correction` only on `correction`.
  - The prefix of `page.adapter` equals `page.platform`.
- **Removed** compared with today's GitHub diagnostics: the date (the server stamps the time), any path but the route
  class, per-filter switches and the OS.
- **Shared pure helpers in `packages/core/src/report/`:**
  - `cleanReportMessage`;
  - `summarizePostForReport` (reason, evidence, author kind and relationship, media and text bucket; never text,
    names, ids, keywords or topics);
  - `describeReport`, the plain lines that the page, the email fallback and the admin detail all show;
  - `routeWord`.

  A leak test builds drafts from every fixture and asserts that no fixture name, text, `href`, URN or component key
  appears in the JSON.

### 5. Firefox and the stores

**Firefox.**

- Every report is *technical and interaction data* (versions, browser, counts, codes): Mozilla lists "crash and error
  reports" there. `technicalAndInteraction` is declared optional in **every** Firefox build (no longer only with the
  server card). Firefox offers it at install, on unless the person turns it off.
- **D6 is kept: unAlgorithm never requests it.** Send posts the report while the type is granted. While it isn't,
  Send becomes **Email this report**, the mailto above, so the person can still report and nothing else changes.
  `useConsent` listens for `permissions.onAdded`, so Send comes back as soon as the person allows the type.
- A correction also carries its text, which is *personal communications*, and maybe a reply email, which is
  *personally identifying information*. The report never asks for these types either.
  - Text: anyone with a result to correct already sent post text with that consent (`POST_DATA`). If it was withdrawn
    since, Send becomes *Email it instead* with the text in the body.
  - Email: the field shows only while `personallyIdentifyingInfo` is granted (Cloud sign-in grants it). Without it,
    the page says "To get a reply, email us and mention your reference."
- Since no report requests or returns a type, sending one never changes consent that AI, sync or sign-in check.
- The route class and site are the subject of the report, not browsing history, so no `browsingActivity` is declared.
  If AMO reads it otherwise, Firefox reports drop `page.route` and `feedWord`.
- AMO reviewer note: "Report a problem opens an extension page that shows every field of the report; only the Send
  report click posts it, to cloud.unalgorithm.app/v1/reports, with no account, cookie or identifier in the report (the
  server checks the moz-extension Origin, which is random per install, and never stores or logs it). It is technical
  data and is sent only while technical and interaction data is allowed; otherwise the page offers to email it. The
  add-on never requests that type, and nothing else depends on it."

**Chrome Web Store and Edge.**

- *Personally identifiable information* (already ticked) adds: "an email address the user may type into a correction
  request so HeitechSoft can reply; kept at most 60 days."
- *Personal communications*: tick it for the correction text (owner sign-off), with the justification: "a message the
  user writes to HeitechSoft to correct a fact-check result, with emails, phone numbers and links removed; used only to
  review that result; kept 90 days".
- Not ticked:
  - *Web history*: only the route class of the LinkedIn or Facebook page being reported is sent and, for a feed at a
    new address, that one word (such as `foryou`).
  - *User activity*: no time, clicks or scrolling are sent.

  Versions and counts are technical diagnostics with no category; PRIVACY.md discloses them.
- Every listing description gains: "Report a problem sends a report you review to HeitechSoft, unAlgorithm's maker."
- The certifications still hold: single purpose, never sold, no new subprocessor (OVHcloud hosts; alert emails go
  through SMTP2GO and carry counts only).

**PRIVACY.md**, *Report a problem* (rewritten). It names:

- every entry point, and that nothing is sent until Send;
- the destination, whatever AI is used;
- each field in plain words;
- what is never sent;
- private windows;
- retention, including backups;
- that HeitechSoft's team reads reports;
- the IP address and Origin as seen by any web request, and how limits use them in memory only;
- the one stored "first from this network today" bit;
- the Firefox behaviour;
- the controller (HeitechSoft, Ontario) and the person in charge of personal information (Tom Heiber) with
  privacy@heitechsoft.com;
- the purpose and the legal basis (consent given by clicking Send, withdrawn by emailing the reference);
- access and deletion within 30 days, and hosting in Beauharnois, Quebec.

A privacy-gate test pins the retention numbers to the protocol constants. It fails if a bundle contains
`REPORTS_PATH` while PRIVACY.md lacks the section, or still says "opens a new GitHub issue form".

### 6. Server (`apps/server`, public)

**Configuration.**

| Variable | Default | Meaning |
|---|---|---|
| `REPORTS` | `off` | `on` mounts `POST /v1/reports`, the report alerts and the admin page's reports. unAlgorithm Cloud sets `on`, and its deploy preflight requires it. Self-hosted servers get no anonymous write route. |
| `REPORTS_DAILY_MAX` | `1000` | Reports accepted per UTC day across all clients. After that, 503 with `Retry-After` until 00:00 UTC, and `reports-cap`. |
| `REPORTS_PER_HOUR` | `6` | Per network address (IPv6 by /64). The day limit per address is 20, and per /24 (IPv4) or /48 (IPv6) it is 60. |
| `REPORTS_ALERT_NETWORKS` | `2` | Distinct networks needed to open a broken alert (§8). 0 turns report alerts off. |

**`POST /v1/reports`.**

- **CORS, the route's own:** any `chrome-extension://[a-p]{32}` or `moz-extension://<uuid>` origin, POST and
  `content-type` only, never `Access-Control-Allow-Credentials`. It is independent of `EXTENSION_IDS`, so Edge
  reports work before the Edge store id is listed.
- **Refused:** a missing or web Origin (403, code `origin-blocked`, the existing `WireError` code), a non-JSON body
  (400), and a body over 16 KiB (413).
- **Origin and request headers:** the Origin, User-Agent, Accept-Language and client hints are never logged, stored or
  used as a limiter key. The Origin is reduced to one boolean, `listed`: true for a Chromium id in `EXTENSION_IDS`, or
  a Firefox `env.client` in `EXTENSION_IDS`. The raw id is discarded.
  - Unlisted `detection`, `wrong-call` and `other` reports are kept but never alert. The admin page counts them, which
    shows a missing Edge id.
  - An unlisted `correction` gets 403 `unlisted`, so the page offers email. A fork's users' words never reach
    HeitechSoft under the wrong privacy policy.
- **Handler order:**
  1. Schema.
  2. An id seen before answers 200 with the stored reference and takes no limit tokens.
  3. Limits.
  4. Keep only registry codes, clean the message, lowercase the contact.
  5. Derive `topic`, `adapter_order` (`2026.10.2` → `2026010002`) and `first_from_network`.
  6. Insert.
  7. 201 `{ ok, ref }` with `Cache-Control: no-store`.

  Error bodies are the fixed `WireError` strings. A zod issue is never echoed.
- **Topic:**
  - `detection`: the first issue in priority order (`feed-not-started`, `adapter-error`, `no-content-script`,
    `over-filtering`, `module-overmatch`, `text-detection`, `ad-label-near-miss`, then the others), or else the first
    choice;
  - `wrong-call`: the post's reason;
  - `correction`: the feature;
  - `other`: the choice.
- **Reference:** the server picks it: 40 random bits in Crockford base32 (`7KQ3-M2PA`), with a unique index and a
  retry on collision.
- **Log line:** `report.received { kind, platform, adapter, topic, listed }`. No id, reference, message, contact or
  address.

**Abuse controls without stored addresses.**

- Limiters are in memory (`createRateLimiter`), keyed by HMAC-SHA-256 under a random salt. The salt is replaced at
  each UTC midnight and never written anywhere.
- Global caps: 120 a minute and `REPORTS_DAILY_MAX` a day.
- `first_from_network` is one stored bit: whether this was the first report of its kind that day, about this
  platform, from its /24 or /48. Not per detection version, which a sender can vary at will to make every report a
  first. It is computed from an in-memory set cleared with the salt. It lets alerts tell many people from one person and
  can't be turned back into an address.
- A restart resets the limits, which is acceptable.
- The Cloud's nginx access log has no IP. The error log can hold one for failed requests for up to 14 days, as
  PRIVACY.md already says.

**Storage** (migration `0017`):

- **`problem_reports`:**
  - `id` (client uuid, primary key) and `ref` (unique);
  - `received_at`, **rounded to the hour**;
  - `kind`, `from`, `channel`, `listed`, `extension`, `browser`, `browser_major`;
  - `platform`, `adapter` and `adapter_order` (all nullable), `topic`, `choices`, `first_from_network`;
  - `details` (jsonb: `page`, `health`, `detection`, `post`, `correction`, registry codes only), `unknown_codes`;
  - `message`, `contact`;
  - `handled_at`, `handled_by` (user, `on delete set null`), `resolution`.

  Its indexes cover `received_at`, the group key (`platform`, `adapter_order`, `kind`, `topic`) and open rows.
- **`report_floors`** (`platform` primary key, `adapter`, `adapter_order`, `set_at`, `set_by`): "Fixed in". Reports
  from older detection versions count as handled (`older-version`), so installs that haven't updated don't reopen
  alerts.
- **`correction_counts`** (`quarter`, `feature`, `resolution`, `n`): aggregates for the transparency report, with no
  per-person data.

**Retention:** `reports.purge`, hourly, registered on every Postgres server.

- A reply email is cleared 30 days after the report is handled, and never kept more than 60 days after receipt. An
  admin can forget it sooner.
- At 90 days, rows are deleted. A correction first adds 1 to `correction_counts` for its quarter, feature and
  resolution (`none` if unhandled).
- The `transparency` CLI counts corrections as `correction_counts` plus the live rows of the quarter.
- `deleteAccount` clears any `contact` equal to the account's address.
- Deleted rows stay in the encrypted nightly backups for up to 14 more nights.

### 7. Admin page (`/admin/reports`, `apps/web`)

It follows `AdminSources`: `useAdminSession`, `AdminGate`, routes behind `requireWebSession` and `requireAdmin`, and
POSTs behind `ownPageOnly`. Log lines name the admin by id and carry counts only.

- **Groups** (platform · detection version · kind · topic): total, open, networks (`first_from_network`), last seen,
  and 14 daily counts. Open groups come first; corrections have their own list, showing their age against the
  5-business-day promise.
- **Development builds** are hidden unless asked for. Unlisted builds show as one count.
- **Detail:** the `describeReport` lines; `details` as escaped JSON in a `<pre>`; the message as escaped text with bidi
  and zero-width characters stripped; the contact as a `mailto:` built only from a validated address, with *Forget
  email*.
- **Actions:**
  - *Mark handled*, with a resolution, for one row or a whole group (rows received before the request). Resolutions:
    `fixed`, `duplicate`, `cant-reproduce`, `not-a-bug`, `older-version`, `spam`, and for corrections `corrected`,
    `no-change`, `out-of-scope`.
  - *Reopen*.
  - *Delete* (confirmed; a hard delete for privacy requests or a message holding personal data).
  - "Fixed in" per platform, which also marks open older reports `older-version`.
  - Lookup by reference (exact match) for privacy requests.
- **Overview:** `/admin` links "Problem reports (N open)" and gains `reports: { enabled, open, last24h }`.

### 8. Alerts

The report alerts reuse `ops.check-alerts` (every 5 minutes) and the existing notifier (`ALERT_EMAIL`,
`ALERT_WEBHOOK_URL`). Each sends one email when it opens, a reminder every 24 hours while open, and one "Resolved"
email. Messages carry only the key, the level, a count and the link to `/admin/reports`. They count only listed,
non-development reports whose adapter is at or above the platform's floor and not dated in a future month
(`latestAdapterOrder`), so an adapter version is dated in the month it is built, never ahead; a platforms test checks
the shipped ones. The 24 hours span two UTC days and a network has a bit on each, so the broken alerts count the day
with more networks, never their sum.

| Key | Opens when (last 24 h, unhandled) | Closes when |
|---|---|---|
| `reports-linkedin-broken`, `reports-facebook-broken` (warning; critical from 5 networks) | `detection` reports from at least `REPORTS_ALERT_NETWORKS` (2) distinct networks, at least one with a positive-evidence issue (`feed-not-started`, `adapter-error`, `over-filtering`, `module-overmatch`, `text-detection`, `ad-label-near-miss`); or reports from at least twice that many networks, whatever they say | none qualify |
| `reports-waiting` (warning) | any report unhandled for more than 24 h, corrections included, so a single report is seen within a day without paging anyone at once | all of those are handled |
| `reports-cap` (warning) | today's accepted count reaches `REPORTS_DAILY_MAX` | the next UTC day |

`cli/alerts.ts test --key` accepts these keys, so the Cloud's live alert test covers them.

### 9. Detection that survives feed tweaks

Adapters still only read the page (ADR 0002). Every new hook is optional in `PlatformAdapter`, and the contract test
requires them for LinkedIn and Facebook.

**Phase A** ships with reports:

- **Routes:** `classifyRoute`, `homeSignature` and `signedIn` for each adapter, and the watchdog (§3).
- **`safe()`** wraps every adapter call in the controller (`feedScope`, `findItems`, `itemRootOf`, `inspect`,
  `probe`). It counts failures per operation, never keeps messages, and fails open: an `inspect` failure means
  `ignore`, a `findItems` failure keeps the previous items. A throw inside the MutationObserver callback can no longer
  stop detection unnoticed.
- **Labels only in label positions:**
  - LinkedIn: the age slot (the last short line of the actor block), header lines above the actor, actor lines, and
    the accessible names of header buttons.
  - Facebook: the slot link, header elements and header buttons.

  Never post text, comments, nested posts or link cards. LinkedIn's `lines.slice(0, 16)` and
  `hasTextNode(root, promoted, 300)` strong detectors are removed (the false positives above). Their replacements are
  `li.promoted.age-slot`, `li.promoted.header` and `li.promoted.actor`.
- **Tolerant label patterns** (`shared/labels.ts`):
  - `normaliseLabel`: NFKC; invisible characters stripped, U+034F included; leading and trailing separators trimmed.
  - `LabelPattern { id, heads, tails?, notTails?, nearWords?, prefix? }` and `matchLabel()`. The result is `exact`,
    `known` or `near`, or nothing.
  - **Exact or known: strong evidence.** **Near** (a known head plus at most `nearWords` unknown words): *medium*
    evidence, observation `*.label.*.near` and an in-memory hash for `ad-label-near-miss`. With the weak "no post age"
    (LinkedIn) or `no-timestamp` (Facebook) evidence, it still hides as an ad, as ADR 0002 allows. "Promoted • Brand
    content" or "Ad · Paid" are then still folded, and the change is reported.
  - LinkedIn `promoted`: heads `promoted`, `sponsored`; tails `by …`, `partnership with …`; notTails `to`, `as`, `at`,
    `in`, `from`, `on` (so "Promoted to Director" is never an ad); a near miss needs a separator after the head
    (`nearAfterSeparator`), and an author-block line other than the age slot counts only as the bare label or the label
    and a separator, so a headline starting with "Sponsored" is neither.
  - Facebook `sponsored`: heads `sponsored`, `ad`; tail `paid partnership`.
  - Sentence markers (activity, repost, followed by) stay regexes, evaluated on header lines only.
- **Evidence combination** moves to core (`signalStrength`: one strong; two medium; or medium plus weak). Both
  adapters use it.
- **Facebook virtualised slots** (`[data-virtualized="true"]`, or an emptied slot that was a post) inspect as `pending`
  with `offscreen: true`. The controller keeps the decision, removes our host while the slot is empty (no stale fold
  lines) and leaves the item out of health.

**Phase B** comes in the same release if its goldens and mutation suite pass, otherwise in the next one.

- **Item discovery strategies**, scored per adapter. The fast path still runs on every scan. Full discovery runs at
  attach and on every 10 s health tick, within about 5 ms. A different strategy takes over only after beating the
  current one by 0.15 on 2 ticks in a row.

  | | Strategies, cheapest first |
  |---|---|
  | LinkedIn | `li.items.card-key` (today's selector), `li.items.feed-list`, `li.items.anatomy` (a repeated list over author-menu and Repost/Send anchors, which comments don't have), `li.items.sr-heading` |
  | Facebook | `fb.items.role-feed`, `fb.items.heading-list` (today's), `fb.items.posinset`, `fb.items.anatomy` (`like_button`, Share/Send and `profile_name` anchors) |

  A sample of up to 10 items scores each strategy on how many have an author, an action bar, an age slot, a menu and
  text. The load-more marker becomes the winning list's last empty child, so it no longer depends on `mainFeed`.
- **One post per item:** an item with 2 or more post-level action bars outside comments and nested posts inspects as
  `ignore` and records `*.item.multi-post`. It never hides.
- **Cautious mode:** while a fallback strategy wins, only strong signals hide and `not-followed` is off. Report-only
  issue `fallback-discovery`. There is no separate three-level confidence model.
- **Layered slot locators** for text, action bar, actor, age slot and header: class, then `data-testid`, then
  accessible name, then structure. The locator that won is recorded as an observation (for example
  `li.slot.actor.structure`), so "still works, but the fast path is gone" shows up in reports.

**Phase C** is regression, alongside B:

- **Golden captures:**
  - `packages/platforms/test/golden/<platform>/*.expect.json` holds per-child decisions for each preset, id stability
    and expected issues;
  - the expectations of today's LinkedIn For you captures move out of `capture-2026-10.test.ts`;
  - today's 9 Facebook captures (`fixtures:check` passes; read once by hand before committing) become fixtures;
  - synthetic classic and legacy variants come from the builders.
- **Mutation suite** (`src/testing/mutate.ts`): markup, label, false-positive and route mutators applied to every
  golden. Each result is `survived`, `flagged` (the decisions changed and health or a report-only issue says so),
  `silent` or `over-hide`. CI fails on `silent` or `over-hide`, and the matrix is snapshotted for review.
- **Capture hardening:**
  - a test that every marker head, tail and module-title word is in the capture scripts' KEEP lists (this would have
    caught "Partnership with");
  - relative ages kept, and `<use href="#…">` kept;
  - folded items and our own tags skipped;
  - `check-fixtures.mjs` splits `id` and `aria-labelledby` values.
- **Policy:** a report a user sent is never committed, attached to an issue, or published.

### 10. Release order

1. The public repo lands this ADR's work, in 0.4.0: in-app reports, breakage checks and resilient detection ship
   together, so no released version sends people to GitHub to report.
2. Cloud:
   - pin the commit and set `REPORTS=on`;
   - confirm every store id, Edge included, is in `EXTENSION_IDS`;
   - deploy;
   - run the live report and alert test.
3. Store answers (CWS, Edge, AMO notes), the PIA entry and PRIVACY.md go live before the tag.
4. The extension is released. Installs before 0.4.0 keep opening GitHub until they update.

## Deliberately left out

- **The anonymized page outline** (scrambled markup of the posts on screen). It is pseudonymous rather than anonymous:
  word lengths and post order can fingerprint a feed, and real ids and entity-encoded names passed the fixture checker.
  It would also add `websiteContent` disclosures, gzip and HTML allowlists and a stored blob. Maintainers capture the
  new markup themselves from the report's route, version and issues. It can be revisited only with its own ADR and
  consent.
- **Free text and a reply email in detection, wrong-call and other reports.** The success screen offers email with the
  reference.
- **Automatic telemetry**, breakage beacons, a minimum-version check, and remote selectors or detection hints from the
  Cloud. Any of these would make every install contact HeitechSoft without a click.
- **A per-installation id**, and stored IP addresses or their hashes. A trial run that starts the controller, and with
  it AI, on unconfirmed pages.
- **A Firefox runtime request** for `technicalAndInteraction`, and a request-and-give-back "consent lease" for any type.
- **A "known issue / fixed in version" receipt**, automatic client retries, a three-level page confidence model, OS and
  per-filter fields, page addresses beyond the route class, and a stored-bytes budget.
- **A managed policy to turn reporting off.** It can be added if an organization asks.
- **Fact-check source-list appeals by outlets.** They keep the website's appeal form and email.
- **`ruleFilter` hiding network activity when the relationship is degraded or unknown.** It is reviewed separately
  against ADR 0002.

## Consequences

- HeitechSoft hears about breakage from any person in any browser, within minutes when two networks report positive
  evidence, and within a day for a single report. A Firefox user who turned off technical data reports by email.
- Silent failures like the two on 2026-10-18 raise a card in the feed (`feed-not-started`, `ad-label-near-miss`), and
  route moves keep working when the page carries a strong home signature. Failures that leave no positive evidence
  still depend on someone pressing *Let us know*.
- The open server gains its first anonymous write route. It is off by default and bounded by limits and caps, and
  ARCHITECTURE.md records it as the exception to "every `/v1` route needs a token, session or secret".
- New report codes must reach the protocol registry and the Cloud before the extension that sends them.
- Corrections leave public GitHub issues. Accountability rests on the quarterly transparency report and release notes,
  and corrections.md is rewritten (in-app or email; answered when an email is given).
- ADR 0002, Consequences: diagnostics go to unAlgorithm Cloud through the report page, and the health monitor also
  covers under-detection and page recognition. ADR 0008: `technicalAndInteraction` is declared in every Firefox build
  and covers the device name and problem reports. It is still never requested (D6), and *Report a problem declares no
  type* is replaced.
- Phase B and C cost about 15 developer-days on top of phase A and the report pipeline.

## Owner decisions

Decided by the owner on 2026-10-19; each is final for 0.4.0.

1. **Release:** 0.4.0 waits for this work and ships in-app reports, breakage checks and resilient detection together.
   Nobody is sent to GitHub to report anything.
2. **Firefox:** reports are sent in-app only while *technical and interaction data* is allowed (Firefox's install
   default). Otherwise Send hands the report to the person's email program (a `mailto:` to support@heitechsoft.com).
   unAlgorithm never asks for the type (D6 unchanged).
3. **Free text:** only corrections (Fact-check and UnEcho Chamber results) take the person's words and an optional
   reply email. Detection, *Wrong call?* and other reports are choices only, with the reference and the support
   address for anything more.
4. **Retention:** reports 90 days; a reply email until 30 days after the answer, never more than 60; corrections kept
   only as quarterly counts after 90 days; times stored to the hour; deleted rows stay in the encrypted backups for up
   to 14 more nights.
5. **The stored bit** `first_from_network` is kept and disclosed in PRIVACY.md. It is derived in memory from the IP
   address, which is never stored.
6. **The anonymized page outline:** not shipped.
7. **Store answers:** *Personal communications* is ticked on the Chrome Web Store and Edge for the correction text, and
   the *Personally identifiable information* answer is extended for the reply email.
8. **Corrections** move from public GitHub issues to private Cloud reports. The website's GitHub correction form
   leaves user-facing pages too.
9. **Mailbox:** support@heitechsoft.com, a new mailbox, answers reply emails and takes the email fallback. Report
   threads there are deleted 60 days after the last reply.
10. **PRIVACY.md** names Tom Heiber as the person in charge of personal information under Law 25, as CLOUD-BETA-NOTICE
    does, and states consent given by clicking Send as the legal basis.
11. **The feed word** stays as sent on candidate routes, held to its pattern, the deny list and the route but not to
    the registry, and the privacy model says so. It is the one word a maintainer needs to capture a moved feed.

## As built

Where the implementation departs from, or adds to, the text above:

- **Private windows:** a draft carries `private: true` with its kind, where it started, `env` and the choices; the
  schema then refuses any page part.
- **Refusals:** a missing or web Origin answers 403 with the existing `origin-blocked` code.
- **The watchdog** probes a third time, at 19 s, and stops at 25 s.
- **Drafts built in the background:** Settings → About and the popup without an answering tab send only what the
  report is about; the background builds the drafts from the settings.
- **`first_from_network`** is counted per platform and kind, not per detection version, and the broken alerts take
  the UTC day with more networks: one sender naming several versions, or reporting either side of midnight, is one
  network.
- **Adapter versions** are dated in the month they are built (`linkedin@2026.10.2`, `facebook@2026.10.3`), since the
  alerts ignore a version dated ahead.
- **A correction's words:** links without a scheme, personal subdomains, and profile or post addresses on their own are
  masked too, and the wire schema refuses words that still hold one (`BARE_LINK_PATTERN`, `PROFILE_PATH_PATTERN`).
- **Any 5xx** from the report route shows *We can't take reports right now* with *Try again*, not the refusal.
- **LinkedIn's author block:** a line there other than the age slot counts as an ad label only when it reads as one
  (the bare label, or the label and a separator), so a headline such as "Sponsored by Specialized | Pro cyclist" or
  "Sponsored Products Manager at Amazon" never hides a post or raises `ad-label-near-miss`; a near miss needs a
  separator after the head. The mutation suite's `fp-headline` checks it.
- **The e2e guard** also runs in Firefox: the driver counts Send clicks and the profile's proxy counts report
  requests, and a profile that sent one without a click fails when it closes.
- **Emptied slots in health:** a Facebook slot emptied or virtualised after it was read counts in the health sample as
  what it was last read as (post or panel), with its last decision, instead of being left out as §9 said. Live on
  2026-10-20, after *Show all* made the page tall, Facebook emptied the far-off slots; without them the hidden share
  went past Balanced's 90%, every folded post opened at once, at the next check too few items were left to judge and
  everything folded again, every 10 s. The adapter remembers every slot it read as a post or a panel, so an emptied
  panel reads as offscreen too, not as a skeleton (§9 named posts only); otherwise, with posts misread as panels,
  `module-overmatch` would come and go as Facebook empties and refills far-off panels, and the feed would fold and open
  the same way. A slot emptied before it was ever read still stays out, and none is a stuck skeleton.
- **Over-filtering holds for the page load:** once `over-filtering` pauses filtering, the page stays paused, across
  visits to the feed within that load, until it reloads or the person changes a setting (`HELD_ISSUES`, `HealthHold`
  in `packages/core/src/health/hold.ts`). Its `paused` card shows at the first check, not after two, with the body
  "unAlgorithm would have hidden too many posts, so it's showing every post. Reload the page to try again." and
  *Let us know*; the popup and side panel banners say the same. Every other issue is judged afresh at each check and
  its card still waits for two in a row.
- **The coach mark** holds a card back only while it is on the page: it sits on a fold line, so a page that stopped
  hiding has none. Folded into a run (Settings → Display → *Group hidden posts in a row*, off by default), its post's
  line is out of sight, so the mark moves to a line that shows.
