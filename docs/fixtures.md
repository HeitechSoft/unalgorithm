# Fixtures

Detection is tested against fixtures in the structure of each site's feed markup. Fixtures must never contain a
real person's name, photo, profile link or post text: hand-written fixtures use invented content, and captures from
the live sites are **anonymized before they leave the browser**.

## Kinds of fixtures

| File | What |
|---|---|
| `packages/platforms/fixtures/linkedin/legacy.ts` | Builders for the pre-2026 LinkedIn feed markup, with invented content |
| `packages/platforms/fixtures/linkedin/y2026.ts` | Builders for the 2026 LinkedIn feed structure, with invented names, text and counts |
| `packages/platforms/fixtures/facebook/synthetic.ts` | **Synthetic** Facebook items written by hand from known patterns, including obfuscated "Sponsored" labels |
| `packages/platforms/fixtures/facebook/live2026.ts` | Builders for the 2026 Facebook feed as the captures showed it, with invented names and text |
| `packages/platforms/fixtures/<platform>/*.html` | Raw captures from the capture scripts |

## Capturing

1. Open the feed in the dev profile (`pnpm dev` / `pnpm dev:fb`) and scroll a little so items render. Turn
   unAlgorithm off for the site first: the scripts leave out items unAlgorithm folded away, and its own elements.
2. Open DevTools → Console and paste `scripts/capture/linkedin.js` or `scripts/capture/facebook.js`.
3. Choose how many items. The script copies anonymized HTML to the clipboard:
   - every word is replaced with `x`/`X`/`0` of the same shape, except the site's own UI words (its `KEEP` list:
     "Sponsored", "Follow", "Suggested", panel titles, header sentences) and relative ages ("3h", "Edited", "Just
     now", "about an hour ago"), so detectors still work. Absolute dates ("Oct 5") are scrambled;
   - links, ids, images, videos, scripts and styles are removed or replaced with stable fakes. LinkedIn's card keys keep
     their prefix and feed sort (`update-card-focus<fake>FeedType_MAIN_FEED_RELEVANCE`); other component keys and test
     ids become fakes, except the few static test ids the adapter reads;
   - element ids, and the `aria-labelledby`, `aria-describedby` and `<use href="#…">` references to them, become the
     same opaque fakes (`id100012`), and the elements they point at are copied into an appendix;
   - layout facts the tests need are kept as attributes: `data-ua-block` (rendered as a block) and `data-ua-hidden`
     (invisible; Facebook hides decoy letters inside labels).
4. Read the console. The script lists short header lines and labels that still hold scrambled words ("Promoted •
   Xxxxxxxxxxx xxxx"): if one is a label, add its words to the script's `KEEP` list and capture again. It never puts
   this list on the clipboard.
5. Paste into `packages/platforms/fixtures/<platform>/<yyyy-mm>-<what>.html`.
6. Run `pnpm fixtures:check`. It fails on any word of four or more letters that is not scrambled and not a kept UI
   word, in the text and in labels, links, test ids, keys and ids (React's generated ids are opaque). **Read the file
   yourself as well** before committing.

`fixtures:check` only covers captured `.html` files (`node scripts/check-fixtures.mjs <file or folder>` checks one).
The hand-written `.ts` builders contain readable text by design, so reviewers check that every name, group, company,
sentence and count in them is invented. Never paste text from a real post into them, even with the names changed.

Nothing is sent anywhere by the capture scripts.

### The vocabulary rule

A word the capture's `KEEP` list lacks reaches the fixture scrambled, and detection is then tested against a label the
site never showed. In 2026-10, LinkedIn's "Promoted • Partnership with LinkedIn" became "Promoted • Xxxxxxxxxxx xxxx"
and "finds this funny" lost its last word. So every word an adapter reads in text must be in its script's `KEEP`
list: the heads, tails, excluded tails and prefixes of its label patterns, its panel titles, its header sentences and
its age words (and Facebook's ad buttons and audiences). `packages/platforms/test/capture-vocab.test.ts` enforces it,
and runs both scripts on a page holding every one of those words. `fixtures:check` reads the `KEEP` lists too, so a
kept word never counts as a leak.

### Reports a user sent are never fixtures

A problem report a user sent is never committed, attached to an issue or published (ADR 0009). Reports carry no page
markup anyway; to reproduce one, a maintainer captures the page themselves from the report's address class, detection
version and issues. `fixtures:check` refuses any file with a comment that names a report or a report reference
(`7KQ3-M2PA`), or with a `data-ua-state` attribute.

## Using a fixture in a test

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedinAdapter } from '../src/index.ts';

// Not new URL(…, import.meta.url): under jsdom that resolves against http://localhost.
document.body.innerHTML = readFileSync(join(import.meta.dirname, '../fixtures/linkedin/2026-11-promoted.html'), 'utf8');
const scope = linkedinAdapter.feedScope(document)!;
const [item] = linkedinAdapter.findItems(scope);
const result = linkedinAdapter.inspect(item!, { markers: linkedinAdapter.markersFor('en'), now: new Date() });
```

Every adapter's tests also run `checkAdapterContract(adapter, html)` on its fixtures.

## Golden pages

A golden page is a whole feed page, a capture or one built from the builders, read the way the feed controller reads
it (`runGolden` in `packages/platforms/src/testing/golden.ts`). The pages are listed in
`packages/platforms/test/golden/goldens.ts`, and each has `test/golden/<platform>/<name>.expect.json`:

| Field | What |
|---|---|
| `setup.url` | The address the page was on: it decides whether unAlgorithm runs there |
| `setup.list` | Selector of the feed list: each child is one row, in page order |
| `setup.restore` | Labels an older capture script scrambled, put back before reading; each must occur exactly `count` times |
| `setup.slice` | One screen of a longer page (Facebook's captures): checked as captured, mutated only as part of the whole page |
| `setup.lang`, `setup.now` | The UI language (`en`) and the time the page is read at (2026-10-19 12:00) |
| `notes` | What each row is, for the reviewer (not checked) |
| `decisions.light/balanced/calm` | Per row: `-` (not a feed item), `panel`/`show` for a feed panel, `reason/relationship` for a post (`sponsored/unknown`, `show/followed`), or `pending`, `offscreen`, `ignore` |
| `ids`, `idsStable` | Each row's post id, and that a second read gives the same ids (ids keep a person's votes and reveals) |
| `health` | What `evaluateHealth` says at 20 s of visible time, per preset, after the checks at 10 s and 20 s |
| `discovery` | The item discovery strategy that won, and whether it is a fallback (cautious mode) |
| `page` | The route class, whether the controller, the watchdog or nothing runs, the home signature, the signed-in shell, the load-more marker |
| `emitted` | How many items each detector and observation id was seen on |
| `errors` | Adapter exceptions caught, per operation (always empty) |

`packages/platforms/test/golden.test.ts` checks every page against its file and runs the adapter contract on it. After
a deliberate change, rewrite the files and review the diff like code:

```sh
GOLDEN_UPDATE=1 pnpm vitest run packages/platforms/test/golden.test.ts
```

To add a page: add it to `goldens.ts`, write its expect file with just `setup` and `notes`, and run the update. A page
holds one layout, as the site serves it (the older LinkedIn markup and its `feed-full-update` layout are two pages).

## The mutation suite

`packages/platforms/src/testing/mutate.ts` changes a golden page the ways a site might and reads it again. Mutations
come in four groups:

- **markup**: class names hashed anew; component keys, test ids, view names, `data-ad-*`, `aria-posinset`,
  `role="feed"` or `role="listitem"` dropped; the card key prefix renamed; one more wrapper around each item, around
  the list or between the list and its items; one wrapper removed; the screen-reader headings dropped; the age line
  moved up; the action bar renamed; every hook dropped at once;
- **label**: hidden decoy letters inside labels; a new word after Promoted, Sponsored or Ad; separators swapped (`•`
  `·` `|` `—`); "+ Follow" buttons; a header verb never seen before; ages written a new way;
- **false positive**: "Promoted", "Sponsored by …", "Suggested", "Follow" and "Ad" as lines and bold runs in post
  text, as a link card's title and in a comment;
- **route**: the feed moved to a new address word, or to `/home`.

Each run gets a verdict: `survived` (every row decided as before, on every preset), `flagged` (decisions changed, and
the health status, a report-only issue or an observation says so, so reports tell us), `silent` (changed, and nothing
says so) or `over-hide` (a row that was shown is now hidden). `packages/platforms/test/mutation.test.ts` runs every
page × every mutation that applies to it and fails on `silent` or `over-hide`, and on any change from a false-positive
probe or another mutation that must read the same. The verdict matrix is snapshotted
(`test/__snapshots__/mutation.test.ts.snap`): review its diff, and update it with `pnpm vitest run
packages/platforms/test/mutation.test.ts -u` when the change is intended.

jsdom takes about half a second to read a 300 KB capture, so the suite runs the big pages' mutations in worker threads,
side by side. `MUTATION_WORKERS=0` runs everything in the test process (slower, easier to debug).

The ids each page and mutation emits also feed `packages/platforms/test/report-codes.test.ts`: every id in the
protocol registry is emitted somewhere, or listed there as reserved with the reason.

## Live accuracy gate for "people you don't follow"

Before "people and pages you don't follow" joins Balanced on a platform, a maintainer captures 20–40 live items across
several sessions and verifies: no friend or joined-group post is hidden by mistake (0 of 100), every visible
"Sponsored" post is caught, and at least 95 % of suggested posts and feed panels are caught. Until then the
platform's Balanced leaves the rule to Calm (`presetValues` in `packages/core/src/presets.ts`); turning it on moves
people still on the old Balanced with a settings migration (`packages/core/src/settings/migrate.ts`).

Facebook's rule joined Balanced on 2026-10-19 (settings version 2) after a smaller live check than this gate asks for,
which the owner judged enough to turn it on:

- **What was checked.** 45 live items: in each, a Follow button in the post's own header meant the account doesn't
  follow the author, and posts from friends and followed accounts showed none. On the live feed at Balanced before the
  change, 4 shown posts had a Follow button (the rule now folds them) and 7 from friends and followed accounts had
  none (they stay). The one wrong fold found (post text that read like an activity line) was fixed first.
- **What the captures hold.** `packages/platforms/fixtures/facebook/2026-10-home-*.html` keep 17 of those items: 10
  page posts with a Follow button, 3 ads, 3 posts from groups the account isn't in and 1 page sharing a reel. None is
  from a friend or a group the account is in, so the 0-of-100 count above was not reached.
- **What only synthetic fixtures cover.** The posts that must stay shown (friends, followed pages and people, groups
  the account is in, a friend's share of a page's post or reel, friends' reels) are modelled on the captures' layout
  in the golden page `facebook/not-followed-2026` and in `packages/platforms/test/facebook/not-followed.test.ts`. No
  live friend's share of a page's post has been captured yet: capture one when it shows up, and add it to the goldens.
