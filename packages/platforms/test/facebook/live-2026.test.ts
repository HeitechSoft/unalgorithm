import { applyPreset, defaultSettings, moduleFilter, ruleFilter } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  feed,
  GROUP_SUGGESTIONS,
  labelledBy,
  PYMK,
  perCharacter,
  post,
  REELS,
  svgText,
} from '../../fixtures/facebook/live2026.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

/**
 * The 2026 home feed as anonymized captures of the live site showed it (October 2026), rebuilt by hand with invented
 * names and text (fixtures/facebook/live2026.ts): every item opens with off-screen aria-hidden filler, the age (or
 * "Ad") after the author's name is SVG text, the message box is wrapped in a div[dir=auto], and panels have their
 * title behind the filler.
 */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 18) };
const balanced = defaultSettings().platforms.facebook;
const calm = applyPreset('facebook', balanced, 'calm');

function inspectAll(...items: string[]) {
  document.body.innerHTML = feed(...items);
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const found = facebookAdapter.findItems(scope);
  expect(found).toHaveLength(items.length);
  return found.map((el) => facebookAdapter.inspect(el, ctx));
}

function onePost(html: string) {
  const [r] = inspectAll(html);
  if (r?.kind !== 'post') throw new Error(`expected a post, got ${r?.kind}`);
  return r.post;
}

const detectors = (p: { evidence: { detector: string }[] }) => p.evidence.map((e) => e.detector);

describe('Facebook adapter (2026 layout as captured live)', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('reads an age drawn as SVG text as a timestamp, so a page post is not one step from being hidden as an ad', () => {
    for (const slot of [svgText('SvgT1'), svgText('SvgT1', 'href')]) {
      const p = onePost(post({ author: 'Gadget Daily', slot, text: 'Six phones compared.', follow: true }));
      expect(detectors(p)).toEqual(['fb.follow-button']);
      expect(p.signals.sponsored).toBe(false);
      expect(p.author.relationship).toBe('not-followed');
      expect(ruleFilter(p, balanced)).toBeNull();
    }
  });

  it('hides a post whose age is replaced by "Ad" in SVG text, on that label alone', () => {
    for (const id of ['SvgT2', 'SvgT3']) {
      const p = onePost(post({ author: 'Shop Example', slot: svgText(id), text: 'Autumn sale.' }));
      expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
      expect(p.signals.sponsored).toBe(true);
      expect(ruleFilter(p, balanced)?.reason).toBe('sponsored');
    }
  });

  it('still hides a video ad, whose video link counts as a permalink', () => {
    const p = onePost(
      post({
        author: 'Shop Example',
        slot: svgText('SvgT2'),
        text: 'Watch the new range.',
        media: '<div><a href="https://www.facebook.com/shopexample/videos/100000/" role="link"><video></video></a></div>',
      }),
    );
    expect(detectors(p)).not.toContain('fb.sponsored.no-timestamp');
    expect(p.signals.sponsored).toBe(true);
  });

  it('never reads the message (wrapped in a div[dir=auto]) as a "likes a / shared a video" header', () => {
    const p = onePost(
      post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Our dog likes a long walk on Sundays.', follow: true }),
    );
    expect(p.signals.networkActivity).toBe(false);
    expect(p.contextLine).toBeUndefined();
    expect(ruleFilter(p, balanced)).toBeNull();
    const shared = onePost(post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'Grandpa shared a video of the parade.' }));
    expect(shared.signals).toMatchObject({ networkActivity: false, reshare: false });
    expect(ruleFilter(shared, calm)).toBeNull();
  });

  it('still reads a real "commented on this" line above the author, past many filler blocks', () => {
    const p = onePost(
      post({
        author: 'Policy Watch',
        slot: svgText('SvgT1'),
        text: 'The new zoning rules take effect next month.',
        context: 'Jamie Park commented on this.',
        fillerCount: 30,
      }),
    );
    expect(p.contextLine).toBe('Jamie Park commented on this.');
    expect(ruleFilter(p, balanced)?.reason).toBe('network-activity');
  });

  it('finds panel titles behind the aria-hidden filler and folds the panels in Balanced', () => {
    const results = inspectAll(PYMK, REELS, GROUP_SUGGESTIONS);
    expect(results).toEqual([
      { kind: 'module', module: { kind: 'people-you-may-know', title: 'People you may know' } },
      { kind: 'module', module: { kind: 'reels', title: 'Reels' } },
      { kind: 'module', module: { kind: 'groups', title: 'Your group suggestions' } },
    ]);
    for (const r of results) if (r.kind === 'module') expect(moduleFilter(r.module, balanced)?.reason).toBe('module');
  });

  it('reads an aria-labelledby label even though the label element itself is hidden', () => {
    const p = onePost(post({ author: 'Shop Example', slot: labelledBy('_r_1_'), text: 'Autumn sale.' }));
    expect(detectors(p)).toContain('fb.sponsored.labelledby');
    expect(p.signals.sponsored).toBe(true);
  });

  it('reads labels spelled one character per span with U+034F', () => {
    const friend = onePost(post({ author: 'Riley Chen', slot: perCharacter('3d'), text: 'Tomatoes, finally.' }));
    expect(detectors(friend)).toEqual([]);
    const ad = onePost(post({ author: 'Shop Example', slot: perCharacter('Ad'), text: 'Autumn sale.' }));
    expect(detectors(ad)).toEqual(
      expect.arrayContaining(['fb.sponsored.rendered-label', 'fb.sponsored.slot-label', 'fb.sponsored.no-timestamp']),
    );
    expect(ad.signals.sponsored).toBe(true);
  });

  it('skips decoy letters hidden with display:none', () => {
    const decoy = '<span><span>Spon</span><span style="display: none">q</span><span>sored</span></span>';
    const p = onePost(post({ author: 'Shop Example', slot: svgText('SvgT1'), text: 'Autumn sale.', extra: decoy }));
    expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.rendered-label', strength: 'medium' });
  });

  it('reads the labels of an item unAlgorithm has folded the same way', () => {
    const html = feed(post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.' }));
    document.body.innerHTML = `<style>[data-unalgo="collapsed"] > :not(unalgo-post) { display: none !important; }</style>${html}`;
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const [el] = facebookAdapter.findItems(scope) as [HTMLElement];
    el.setAttribute('data-unalgo', 'collapsed');
    expect(getComputedStyle(el.firstElementChild as Element).display).toBe('none');
    const r = facebookAdapter.inspect(el, ctx);
    if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
    expect(detectors(r.post)).toEqual(
      expect.arrayContaining(['fb.sponsored.rendered-label', 'fb.sponsored.slot-label', 'fb.sponsored.no-timestamp']),
    );
  });

  it('passes the adapter contract', () => {
    const html = feed(
      post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Six phones compared.', follow: true }),
      post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.' }),
      post({ author: 'Riley Chen', slot: perCharacter('3d'), text: 'Tomatoes, finally.' }),
      PYMK,
      REELS,
      GROUP_SUGGESTIONS,
    );
    expect(checkAdapterContract(facebookAdapter, html)).toEqual([]);
  });
});
