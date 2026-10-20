import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPreset, defaultSettings, type PostData, ruleFilter, signalStrength } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { feed, post } from '../../fixtures/facebook/live2026.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';

/**
 * Since 2026-10 Facebook draws a post's age, and "Ad" on ads, through a chain of SVG references: the `<use>` after the
 * author's name points at an `<svg>` holding another `<use>`, and so on, 7 references deep in the captures, before the
 * `<text>`. The adapter follows such a chain in label positions only, at most 8 deep, within the page, and reads
 * nothing from one that loops or goes deeper (the post then shows, and the slot is reported as unrecognised).
 */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 19, 12) };
const balanced = defaultSettings().platforms.facebook;
const light = applyPreset('facebook', balanced, 'light');
const calm = applyPreset('facebook', balanced, 'calm');

const FIXTURES = join(import.meta.dirname, '../../fixtures/facebook');
const capture = (file: string) => readFileSync(join(FIXTURES, file), 'utf8');

/** The page's only item, read. */
function read(html: string): { post: PostData; observations: readonly string[] } {
  document.body.innerHTML = html;
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const items = facebookAdapter.findItems(scope);
  expect(items).toHaveLength(1);
  const r = facebookAdapter.inspect(items[0] as HTMLElement, ctx);
  if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
  return { post: r.post, observations: r.observations ?? [] };
}

/** The decision on Light, Balanced and Calm, and the relationship read. */
const decisions = (p: PostData) =>
  [light, balanced, calm].map((ps) => `${ruleFilter(p, ps)?.reason ?? 'show'}/${p.author.relationship}`);
const detectors = (p: PostData) => p.evidence.map((e) => `${e.detector}:${e.strength}`);

/**
 * A label drawn the 2026-10 way: the slot's `<use>` points at an `<svg>` holding another `<use>`, `hops` references in
 * all, the last at a `<text>` holding `label`. `slot` goes in the post, `defs` elsewhere in the page.
 */
function chain(name: string, label: string, hops = 7): { slot: string; defs: string } {
  const svgs = Array.from({ length: hops - 1 }, (_, i) => `<svg id="${name}${i + 1}"><use href="#${name}${i + 2}"></use></svg>`);
  return {
    slot: `<span><span><svg><use href="#${name}1"></use></svg></span></span>`,
    defs: `<div hidden>${svgs.join('')}<svg><text id="${name}${hops}">${label}</text></svg></div>`,
  };
}

/** How many references the first `<use>` in `root` goes through before it reaches an element with no `<use>`. */
function hops(root: Element): number {
  let n = 0;
  for (let use = root.querySelector('use'); use; n++) {
    const target = document.getElementById((use.getAttribute('href') ?? '').slice(1));
    use = target?.querySelector('use') ?? null;
  }
  return n;
}

const PAGE = { author: 'City Library', text: 'Open late on Thursdays from next week.' };

describe('Facebook labels drawn through a chain of SVG <use>', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('folds the live video ad whose "Ad" is 7 references deep, on strong evidence, on Light, Balanced and Calm', () => {
    const { post: p, observations } = read(capture('2026-10-ads-1.html'));
    expect(hops(document.querySelector('[aria-posinset]') as Element)).toBe(7);
    expect(p.media).toBe('reel');
    expect(p.signals.sponsored).toBe(true);
    expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
    expect(signalStrength(p.evidence, 'sponsored')).toBe('strong');
    expect(observations).toEqual([]);
    expect(decisions(p)).toEqual(['sponsored/unknown', 'sponsored/unknown', 'sponsored/unknown']);
  });

  it.each([1, 2])(
    'reads the chained date on the live reel share 2026-10-reels-%i as its age: no ad, no missing timestamp',
    (n) => {
      const html = capture(`2026-10-reels-${n}.html`);
      const shown = read(html);
      expect(hops(document.querySelector('[aria-posinset]') as Element)).toBe(7);
      expect(shown.post.signals.sponsored).toBe(false);
      expect(shown.post.evidence.filter((e) => e.signal === 'sponsored')).toEqual([]);
      expect(shown.observations).toEqual([]);
      expect(decisions(shown.post)).toEqual(['show/unknown', 'show/unknown', 'reel/unknown']);
      // The reel's link is a permalink too. Without it, the chained date alone is the post's timestamp.
      const reel = 'href="https://www.facebook.com/reel/100002/"';
      expect(html.split(reel)).toHaveLength(2);
      const { post: p, observations } = read(html.replace(reel, 'href="https://www.facebook.com/"'));
      expect(p.evidence.filter((e) => e.signal === 'sponsored')).toEqual([]);
      expect(observations).not.toContain('fb.slot.age.unrecognised');
    },
  );

  it.each(['9 hours ago', 'about an hour ago', 'October 5 at 3:45 PM', 'Yesterday at 3:00 PM', '3d'])(
    'reads "%s" drawn 7 references deep as the age of an ordinary post with no other timestamp',
    (age) => {
      const { slot, defs } = chain('Age', age);
      const { post: p, observations } = read(`${feed(post({ ...PAGE, slot }))}${defs}`);
      expect(p.evidence).toEqual([]);
      expect(p.signals.sponsored).toBe(false);
      expect(observations).toEqual([]);
      expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
    },
  );

  it.each([
    ['Ad', 7],
    ['Ad', 8],
    ['Sponsored', 8],
  ])('reads "%s" drawn %i references deep as an ad label', (label, depth) => {
    const { slot, defs } = chain('Lbl', label, depth);
    const { post: p } = read(`${feed(post({ author: 'Shop Example', text: 'Autumn sale.', slot }))}${defs}`);
    expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
    expect(decisions(p)).toEqual(['sponsored/unknown', 'sponsored/unknown', 'sponsored/unknown']);
  });

  const use = (id: string) => `<use href="#${id}"></use>`;
  /** A chain that starts at `#Bad1`, and the post it is the age of (with an id, so a chain can point at it). */
  const broken = (defs: string, text = 'Autumn sale.') =>
    `${feed(post({ author: 'Shop Example', text, slot: `<span><span><svg>${use('Bad1')}</svg></span></span>` })).replace(
      '<div aria-posinset=',
      '<div id="ThePost" aria-posinset=',
    )}<div hidden>${defs}</div>`;
  /** Each step holds a `<use>` of the next one twice, so the references double at every step. */
  const doubling = Array.from({ length: 7 }, (_, i) => `<svg id="Bad${i + 1}">${use(`Bad${i + 2}`)}${use(`Bad${i + 2}`)}</svg>`);

  it.each([
    ['a loop, "Ad" in it', `<svg id="Bad1">${use('Bad2')}</svg><svg id="Bad2"><text>Ad</text>${use('Bad1')}</svg>`],
    ['a reference to itself, "Ad" in it', `<svg id="Bad1"><text>Ad</text>${use('Bad1')}</svg>`],
    ['a reference to the post around it', `<svg id="Bad1">${use('ThePost')}</svg>`],
    ['9 references, one more than followed, to "Ad"', chain('Bad', 'Ad', 9).defs.replace(/^<div hidden>|<\/div>$/g, '')],
    ['more references than one label may follow, to "Ad"', `${doubling.join('')}<svg><text id="Bad8">Ad</text></svg>`],
  ])('fails safe on %s: nothing of it is read, the post shows, and the slot is reported', (_name, defs) => {
    const { post: p, observations } = read(broken(defs, 'Ad'));
    expect(p.signals.sponsored).toBe(false);
    expect(detectors(p)).toEqual(['fb.sponsored.no-timestamp:weak']);
    expect(observations).toContain('fb.slot.age.unrecognised');
    expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
  });

  it('follows references within the page only', () => {
    const page = (href: string) =>
      broken(`<svg id="Bad1"><use href="${href}"></use></svg><svg><text id="AdText">Ad</text></svg>`);
    expect(read(page('#AdText')).post.signals.sponsored).toBe(true);
    for (const href of ['https://www.facebook.com/icons.svg#AdText', 'icons.svg#AdText', 'AdText']) {
      const { post: p, observations } = read(page(href));
      expect(p.signals.sponsored, href).toBe(false);
      expect(detectors(p), href).toEqual(['fb.sponsored.no-timestamp:weak']);
      expect(observations, href).toEqual([]);
    }
  });

  it('reads a chain in label positions only: a chained "Ad" in the post text or a comment is never a label', () => {
    const age = chain('Age', '9 hours ago');
    const ad = chain('Ad', 'Ad');
    const drawn = `<svg>${use('Ad1')}</svg>`;
    const text = `New hours. <span>${drawn}</span><div aria-label="Comment by Sam Ortiz" role="article"><span>${drawn}</span></div>`;
    const { post: p, observations } = read(`${feed(post({ ...PAGE, text, slot: age.slot }))}${age.defs}${ad.defs}`);
    expect(p.evidence).toEqual([]);
    expect(p.signals.sponsored).toBe(false);
    expect(observations).toEqual([]);
    expect(decisions(p)).toEqual(['show/unknown', 'show/unknown', 'show/unknown']);
  });
});
