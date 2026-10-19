import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyPreset, defaultSettings, moduleFilter, type PlatformSettings, ruleFilter } from '@unalgorithm/core';
import { describe, expect, it } from 'vitest';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

/**
 * Two anonymized captures of the "For you" feed (/feed/foryou/, 2026-10), each holding every child of the feed list
 * in page order: the "Start a post" box, the "Sort by" control, a "New posts" button, the cards and the empty
 * load-more marker. The expected decisions were checked against each item's visible label on the live page.
 */
const balanced: PlatformSettings = defaultSettings().platforms.linkedin;
const light = applyPreset('linkedin', balanced, 'light');
const NOW = new Date(2026, 9, 19, 12);

/**
 * The scrambler keeps LinkedIn's own labels, but in 2026-10 its list missed two of them, so they are put back here:
 * "Partnership with" after "Promoted", and "funny" in "X finds this funny". Each must be found the number of times
 * given, so a new capture cannot quietly drop the case.
 */
const SCRAMBLED_LABELS: Array<[scrambled: string, label: string]> = [
  ['Promoted • Xxxxxxxxxxx xxxx', 'Promoted • Partnership with'],
  ['>finds this xxxxx<', '>finds this funny<'],
];

function load(file: string, restored: [partnership: number, funny: number]): string {
  // Not new URL(…, import.meta.url): under jsdom that resolves against http://localhost.
  let html = readFileSync(join(import.meta.dirname, '../../fixtures/linkedin', file), 'utf8');
  SCRAMBLED_LABELS.forEach(([scrambled, label], i) => {
    expect(html.split(scrambled).length - 1, label).toBe(restored[i]);
    html = html.replaceAll(scrambled, label);
  });
  return html;
}

const LOAD_1 = load('2026-10-foryou-1.html', [2, 1]);
const LOAD_2 = load('2026-10-foryou-2.html', [0, 0]);

/**
 * One entry per child of the feed list: "-" (not a feed item), "panel" (a hidden feed panel), or for a post the
 * decision ("show" or the reason it is hidden) and the author's relationship, as "decision/relationship".
 */
function decide(html: string, ps: PlatformSettings): string[] {
  document.body.innerHTML = html;
  const markers = linkedinAdapter.markersFor('en');
  const scope = linkedinAdapter.feedScope(document);
  expect(scope?.tagName).toBe('MAIN');
  const items = linkedinAdapter.findItems(scope as HTMLElement);
  const feed = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
  return Array.from(feed.children).map((child) => {
    const item = items.find((it) => child === it || child.contains(it));
    if (!item) return '-';
    const r = linkedinAdapter.inspect(item, { markers, now: NOW });
    if (r.kind === 'module') return moduleFilter(r.module, ps) ? 'panel' : 'show';
    if (r.kind !== 'post') return r.kind;
    return `${ruleFilter(r.post, ps)?.reason ?? 'show'}/${r.post.author.relationship}`;
  });
}

const tally = (rows: string[]) =>
  rows.reduce<Record<string, number>>((n, r) => {
    const decision = r.split('/')[0] as string;
    n[decision] = (n[decision] ?? 0) + 1;
    return n;
  }, {});

// jsdom reads these 300 KB pages slowly, more so while other suites run: the timeout is about the machine, not the code.
describe('LinkedIn "For you" feed captures (2026-10)', { timeout: 30_000 }, () => {
  it('first load: each item on Balanced', () => {
    expect(decide(LOAD_1, balanced)).toEqual([
      '-', // "Start a post"
      '-', // empty spacer
      '-', // "Sort by: Top"
      '-', // "New posts" button
      'show/followed', // 1st-degree connection
      'sponsored/not-followed', // person's post, "Promoted • Partnership with LinkedIn", Follow button
      'show/unknown', // "<Name>’s job update": no post text
      'show/followed', // "• Following" instead of a degree
      'panel', // LinkedIn Ads offer
      'sponsored/not-followed', // person's post, "Promoted • Partnership with LinkedIn", Follow button
      'network-activity/not-followed', // "Followed by X", 2nd-degree, Follow button
      'network-activity/unknown', // "X finds this funny", joined group, 3rd+
      'panel', // "Jobs recommended for you"
      'sponsored/unknown', // "X, Y and N other connections follow this page", Promoted
      'network-activity/not-followed', // "Followed by X", page with a Follow button
      'show/followed', // page you follow
      'not-followed/not-followed', // 2nd-degree with a Follow button, no header
      'sponsored/followed', // "… follow this page", Promoted
      'show/unknown', // "New comment in your group", 3rd+
      'network-activity/not-followed', // "Followed by X"
      'show/followed', // 1st-degree connection
      'sponsored/followed', // Promoted page
      'network-activity/not-followed', // "Followed by X"
      'show/unknown', // joined group, 3rd+, no header
      'network-activity/not-followed', // "Followed by X", page
      'sponsored/followed', // Promoted page
      'show/followed', // 1st-degree connection
      '-', // empty load-more marker
    ]);
  });

  it('second load: each item on Balanced', () => {
    expect(decide(LOAD_2, balanced)).toEqual([
      '-', // "Start a post"
      '-', // empty spacer
      '-', // "Sort by: Top"
      '-', // "New posts" button
      'show/followed', // 1st-degree connection
      'sponsored/followed', // Promoted page
      'network-activity/not-followed', // "Followed by X"
      'panel', // LinkedIn Ads offer
      'sponsored/followed', // Promoted page
      'network-activity/not-followed', // "Followed by X", page
      'network-activity/unknown', // "X loves this", joined group, 3rd+
      'panel', // "Jobs recommended for you"
      'sponsored/followed', // Promoted page
      'not-followed/not-followed', // 3rd+ with a Follow button, no header
      'show/followed', // 1st-degree connection
      'network-activity/not-followed', // "Followed by X"
      'sponsored/followed', // Promoted page
      'network-activity/unknown', // "X likes this", joined group, 3rd+
      'network-activity/not-followed', // "Followed by X"
      'show/followed', // 1st-degree connection
      'sponsored/followed', // Promoted page
      'not-followed/not-followed', // page with a Follow button, no header
      'show/unknown', // joined group, 3rd+, no header
      'not-followed/not-followed', // 2nd-degree with a Follow button, no header
      'sponsored/followed', // Promoted page
      'show/followed', // 1st-degree connection
      'network-activity/not-followed', // "Followed by X", page
      'panel', // "Recommended for you": a person to follow
      'sponsored/followed', // Promoted page
      'not-followed/not-followed', // 3rd+ with a Follow button, no header
      'show/unknown', // "New comment in your group", 2nd-degree
      '-', // empty load-more marker
    ]);
  });

  it('Light hides only the ads and panels', () => {
    expect(tally(decide(LOAD_1, light))).toEqual({ '-': 5, sponsored: 6, panel: 2, show: 15 });
    expect(tally(decide(LOAD_2, light))).toEqual({ '-': 5, sponsored: 7, panel: 3, show: 17 });
  });

  it('finds the cards, the load-more marker and no stray panels, and keeps the adapter contract', () => {
    for (const [html, cards] of [
      [LOAD_1, 23],
      [LOAD_2, 27],
    ] as const) {
      document.body.innerHTML = html;
      const scope = linkedinAdapter.feedScope(document) as HTMLElement;
      const items = linkedinAdapter.findItems(scope);
      expect(items).toHaveLength(cards);
      // The composer, the sort control and the "New posts" button are not feed panels.
      expect(linkedinAdapter.siblingModules?.(items, { markers: linkedinAdapter.markersFor('en'), now: NOW })).toEqual([]);
      const feed = document.querySelector('[data-testid="mainFeed"]') as HTMLElement;
      expect(linkedinAdapter.loadMoreMarker?.(scope, document)).toBe(feed.lastElementChild);
      expect(checkAdapterContract(linkedinAdapter, html)).toEqual([]);
    }
  });
});
