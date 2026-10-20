import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPreset, defaultSettings, moduleFilter, type PlatformSettings, ruleFilter } from '@unalgorithm/core';
import { DETECTOR_IDS, LANDMARK_KEYS, OBSERVATION_IDS, platformIds, STRATEGY_IDS } from '@unalgorithm/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_IDS } from '../../src/facebook/ids.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

/**
 * Nine anonymized captures of the home feed (/, 2026-10-19), taken one after another while scrolling, each holding the
 * feed list's items that had content at that moment (17 posts in all, aria-posinset 10 to 27). In the live session the
 * adapter read all 17 as each post's visible label said: 10 Page posts with a Follow button (not followed), 3 "Ad"
 * posts, 3 posts from groups the account isn't in, and a shared reel. Offline, the captures must give the same
 * per-item results. Balanced hid the ads and the groups then; since settings version 2 it hides the 10 Pages too.
 */
const balanced: PlatformSettings = defaultSettings().platforms.facebook;
const calm = applyPreset('facebook', balanced, 'calm');
const NOW = new Date(2026, 9, 19, 12);

/**
 * The scrambler keeps Facebook's own labels, but in 2026-10 its list missed the words of relative ages. Two are put
 * back here (the scrambled shapes are unambiguous), each the number of times given per capture, so a new capture
 * cannot quietly drop the case.
 */
const SCRAMBLED_AGES: Array<[scrambled: string, age: string]> = [
  ['>xxxxx xx xxxx xxx</text>', '>about an hour ago</text>'],
  ['>a xxx xxx</text>', '>a day ago</text>'],
];
const RESTORED: Record<number, [hour: number, day: number]> = { 6: [1, 0], 7: [1, 0], 8: [0, 1], 9: [0, 1] };

function load(n: number): string {
  // Not new URL(…, import.meta.url): under jsdom that resolves against http://localhost.
  let html = readFileSync(join(import.meta.dirname, '../../fixtures/facebook', `2026-10-home-${n}.html`), 'utf8');
  SCRAMBLED_AGES.forEach(([scrambled, age], i) => {
    expect(html.split(scrambled).length - 1, `${age} in capture ${n}`).toBe(RESTORED[n]?.[i] ?? 0);
    html = html.replaceAll(scrambled, age);
  });
  return html;
}

const CAPTURES = Array.from({ length: 9 }, (_, i) => load(i + 1));

/** The nine captures as one page: the first, with the others' feed items and SVG label texts added in order. */
function oneFeed(): string {
  document.body.innerHTML = CAPTURES[0] as string;
  const list = feedList();
  for (const html of CAPTURES.slice(1)) {
    const page = new DOMParser().parseFromString(html, 'text/html');
    const theirs = Array.from(page.querySelectorAll('h3')).find((h) => h.textContent === 'Feed posts')?.nextElementSibling
      ?.nextElementSibling as Element;
    list.append(...Array.from(theirs.children).map((el) => document.importNode(el, true)));
    for (const labels of Array.from(page.querySelectorAll('[data-ua-external]')))
      document.body.append(document.importNode(labels, true));
  }
  return document.body.innerHTML;
}

function feedList(): Element {
  const heading = Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Feed posts') as Element;
  return heading.nextElementSibling?.nextElementSibling as Element;
}

interface ItemRead {
  /** For a post, the decision ("show" or the reason it is hidden) and the author's relationship; else the kind. */
  balanced: string;
  calm: string;
  observations: readonly string[];
  detectors: string[];
}

/** Every item the adapter finds, read once and decided on both presets. */
function readAll(html: string): ItemRead[] {
  document.body.innerHTML = html;
  const markers = facebookAdapter.markersFor('en');
  const scope = facebookAdapter.feedScope(document);
  if (!scope) return [];
  return facebookAdapter.findItems(scope).map((el) => {
    const r = facebookAdapter.inspect(el, { markers, now: NOW });
    const observations = (r.kind !== 'pending' && r.observations) || [];
    if (r.kind === 'module') {
      const decide = (ps: PlatformSettings) => (moduleFilter(r.module, ps) ? 'panel' : 'show');
      return { balanced: decide(balanced), calm: decide(calm), observations, detectors: [] };
    }
    if (r.kind !== 'post') return { balanced: r.kind, calm: r.kind, observations, detectors: [] };
    const decide = (ps: PlatformSettings) => `${ruleFilter(r.post, ps)?.reason ?? 'show'}/${r.post.author.relationship}`;
    return { balanced: decide(balanced), calm: decide(calm), observations, detectors: r.post.evidence.map((e) => e.detector) };
  });
}

/** Balanced decisions, each followed by the item's observations. */
const withObservations = (rows: ItemRead[]) => rows.map((r) => [r.balanced, ...r.observations].join(' '));

const EXPECTED: string[][] = [
  [
    'show/unknown', // a Page sharing a reel; the reel's own Follow button is not the Page's
    'unjoined-group/unknown', // group post, "Join" next to the group's name
  ],
  ['not-followed/not-followed', 'not-followed/not-followed'], // Page posts with a Follow button
  ['sponsored/unknown', 'not-followed/not-followed'], // "Ad" in the age slot (SVG text)
  ['not-followed/not-followed', 'not-followed/not-followed'],
  [
    'not-followed/not-followed fb.slot.text.structure fb.slot.header.structure', // a photo post whose caption has no message box
    'sponsored/unknown',
  ],
  ['not-followed/not-followed', 'not-followed/not-followed'],
  ['unjoined-group/unknown', 'not-followed/not-followed'],
  ['unjoined-group/unknown', 'sponsored/unknown'],
  ['not-followed/not-followed'],
];

/** Read once: each capture alone, and the nine as one page. */
let perCapture: ItemRead[][] | undefined;
const capturesRead = () => (perCapture ??= CAPTURES.map(readAll));

describe('Facebook home feed captures (2026-10)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it("each capture gives the live session's result for every item, on Balanced", () => {
    expect(capturesRead().map(withObservations)).toEqual(EXPECTED);
  });

  it('17 of 17: 3 ads, 3 unjoined groups and 10 Pages not followed hidden, the shared reel shown', () => {
    const rows = capturesRead().flat();
    expect(rows).toHaveLength(17);
    const tally = rows.reduce<Record<string, number>>((n, r) => {
      n[r.balanced] = (n[r.balanced] ?? 0) + 1;
      return n;
    }, {});
    expect(tally).toEqual({
      'not-followed/not-followed': 10,
      'show/unknown': 1,
      'sponsored/unknown': 3,
      'unjoined-group/unknown': 3,
    });
    // Each Page hidden as not followed has its own Follow button, next to its name, and nothing else hides it.
    for (const r of rows.filter((x) => x.balanced.startsWith('not-followed'))) expect(r.detectors).toEqual(['fb.follow-button']);
  });

  it('on Calm also hides the reel', () => {
    const rows = capturesRead()
      .flat()
      .map((r) => r.calm);
    expect(rows.filter((r) => r.startsWith('show'))).toEqual([]);
    expect(rows.filter((r) => r === 'not-followed/not-followed')).toHaveLength(10);
  });

  it("finds the list after the heading on every capture, with today's strategy", () => {
    for (const html of CAPTURES) {
      document.body.innerHTML = html;
      expect(facebookAdapter.feedScope(document)?.getAttribute('role')).toBe('main');
      expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.heading-list', fallback: false });
      // The capture holds the feed column only: no top bar, so no Home tab and no signed-in shell.
      expect(facebookAdapter.homeSignature?.(document)).toBe('weak');
      expect(facebookAdapter.signedIn?.(document)).toBe(false);
    }
  });

  it('passes the adapter contract on every capture', () => {
    for (const html of CAPTURES) expect(checkAdapterContract(facebookAdapter, html)).toEqual([]);
  });

  it('emits only the ids the adapter declares', () => {
    const detectors = new Set<string>(FACEBOOK_IDS.detectors);
    const observations = new Set<string>(FACEBOOK_IDS.observations);
    for (const r of capturesRead().flat()) {
      for (const d of r.detectors) expect(detectors).toContain(d);
      for (const o of r.observations) expect(observations).toContain(o);
    }
  });
});

describe('Facebook home feed captures as one page, changed the ways the ADR lists', { timeout: 30_000 }, () => {
  const ONE = oneFeed();
  const ALL = EXPECTED.flat().map((row) => row.split(' ')[0]);

  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  const change = (mutate: () => void) => {
    document.body.innerHTML = ONE;
    mutate();
    return document.body.innerHTML;
  };

  it('reads the 17 items in order, and passes the adapter contract', () => {
    expect(readAll(ONE).map((r) => r.balanced)).toEqual(ALL);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.heading-list', fallback: false });
    expect(Object.keys(facebookAdapter.probe(document, facebookAdapter.feedScope(document)))).toEqual([
      ...FACEBOOK_IDS.landmarks,
    ]);
    expect(checkAdapterContract(facebookAdapter, ONE)).toEqual([]);
  });

  it.each([
    [
      'hidden "Feed posts" heading',
      () =>
        Array.from(document.querySelectorAll('h3'))
          .find((h) => h.textContent === 'Feed posts')
          ?.remove(),
      'fb.items.posinset',
    ],
    [
      'aria-posinset removed',
      () => {
        for (const el of Array.from(document.querySelectorAll('[aria-posinset]'))) el.removeAttribute('aria-posinset');
      },
      'fb.items.anatomy',
    ],
    [
      'one extra wrapper around the list',
      () => {
        const list = feedList();
        const wrapper = document.createElement('div');
        wrapper.append(...Array.from(list.childNodes));
        list.append(wrapper);
      },
      'fb.items.posinset',
    ],
  ])('with a %s, still finds every post with the same results', (_name, mutate, strategy) => {
    expect(readAll(change(mutate)).map((r) => r.balanced)).toEqual(ALL);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy, fallback: true });
  });

  it('hides all three ads when "Ad" becomes "Ad · Paid", and reports the near miss on each', () => {
    const html = change(() => {
      for (const text of Array.from(document.querySelectorAll('text')))
        if (text.textContent === 'Ad') text.textContent = 'Ad · Paid';
    });
    const ads = readAll(html).filter((r) => r.balanced.startsWith('sponsored'));
    expect(ads.map((r) => [r.balanced, ...r.observations].join(' '))).toEqual(
      Array(3).fill('sponsored/unknown fb.label.sponsored.near'),
    );
    const markers = facebookAdapter.markersFor('en');
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const hashes = facebookAdapter
      .findItems(scope)
      .map((el) => facebookAdapter.inspect(el, { markers, now: NOW }))
      .flatMap((r) => (r.kind === 'post' && r.post.quality.adNearMiss ? [r.post.quality.adNearMiss] : []));
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(1);
  });
});

describe('Facebook adapter ids', () => {
  it('declares only ids in the protocol registry', () => {
    expect(platformIds(DETECTOR_IDS, 'facebook')).toEqual(expect.arrayContaining([...FACEBOOK_IDS.detectors]));
    expect(platformIds(OBSERVATION_IDS, 'facebook')).toEqual(expect.arrayContaining([...FACEBOOK_IDS.observations]));
    expect(platformIds(STRATEGY_IDS, 'facebook')).toEqual([...FACEBOOK_IDS.strategies]);
    expect(LANDMARK_KEYS).toEqual(expect.arrayContaining([...FACEBOOK_IDS.landmarks]));
    expect(facebookAdapter.ids).toBe(FACEBOOK_IDS);
  });
});
