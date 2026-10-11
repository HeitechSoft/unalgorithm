# Fixtures

Detection is tested against fixtures in the structure of each site's feed markup. Fixtures must never contain a
real person's name, photo, profile link or post text: hand-written fixtures use invented content, and captures from
the live sites are **anonymized before they leave the browser**.

## Kinds of fixtures

| File | What |
|---|---|
| `packages/platforms/fixtures/linkedin/legacy.ts` | Builders for the pre-2026 LinkedIn feed markup, with invented content |
| `packages/platforms/fixtures/linkedin/y2026.ts` | Builders for the 2026 LinkedIn feed structure, with invented names, text and counts |
| `packages/platforms/fixtures/facebook/synthetic.ts` | **Synthetic** Facebook items written by hand from known patterns, including obfuscated "Sponsored" labels. They are a stand-in until live captures exist |
| `packages/platforms/fixtures/<platform>/*.html` | Raw captures from the capture scripts |

## Capturing

1. Open the feed in the dev profile (`pnpm dev` / `pnpm dev:fb`) and scroll a little so items render.
2. Open DevTools → Console and paste `scripts/capture/linkedin.js` or `scripts/capture/facebook.js`.
3. Choose how many items. The script copies anonymized HTML to the clipboard:
   - every word is replaced with `x`/`X`/`0` of the same shape, except the site's own UI labels ("Sponsored",
     "Follow", "Suggested"…), so detectors still work;
   - links, ids, images, videos, scripts and styles are removed or replaced with stable fakes;
   - layout facts the tests need are kept as attributes: `data-ua-block` (rendered as a block) and `data-ua-hidden`
     (invisible; Facebook hides decoy letters inside labels); `aria-labelledby` targets are copied into an appendix.
4. Paste into `packages/platforms/fixtures/<platform>/<yyyy-mm>-<what>.html`.
5. Run `pnpm fixtures:check`. It fails on any word of four or more letters that is not scrambled and not a known UI
   label, in the text and in labels, links and test ids. **Read the file yourself as well** before committing.

`fixtures:check` only covers captured `.html` files. The hand-written `.ts` builders contain readable text by design,
so reviewers check that every name, group, company, sentence and count in them is invented. Never paste text from a
real post into them, even with the names changed.

Nothing is sent anywhere by the capture scripts.

## Using a fixture in a test

```ts
import { readFileSync } from 'node:fs';
import { linkedinAdapter } from '../src/index.ts';

document.body.innerHTML = readFileSync(new URL('../fixtures/linkedin/2026-11-promoted.html', import.meta.url), 'utf8');
const scope = linkedinAdapter.feedScope(document)!;
const [item] = linkedinAdapter.findItems(scope);
const result = linkedinAdapter.inspect(item!, { markers: linkedinAdapter.markersFor('en'), now: new Date() });
```

Every adapter's tests also run `checkAdapterContract(adapter, html)` on its fixtures.

## Facebook accuracy gate

Before "people and pages you don't follow" is turned on by default for Facebook, a maintainer captures 20–40 live
items across several sessions and verifies: no friend or joined-group post is hidden by mistake (0 of 100), every
visible "Sponsored" post is caught, and at least 95 % of suggested posts and feed panels are caught. Then
`FACEBOOK_NOT_FOLLOWED_VERIFIED` in `packages/core/src/presets.ts` can flip.
