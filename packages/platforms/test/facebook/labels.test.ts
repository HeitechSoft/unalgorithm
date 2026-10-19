import { applyPreset, atLeast, defaultSettings, type Evidence, ruleFilter, signalStrength } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { feed, filler, item, perCharacter, post, svgText } from '../../fixtures/facebook/live2026.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { isSponsored } from '../../src/facebook/extract.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';
import type { InspectResult } from '../../src/types.ts';

/** Tolerant labels in label positions only (ADR 0009 §9): the age slot, the header's elements and its buttons. */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 19) };
const balanced = defaultSettings().platforms.facebook;
const calm = applyPreset('facebook', balanced, 'calm');

function inspectAll(...items: string[]): InspectResult[] {
  document.body.innerHTML = feed(...items);
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const found = facebookAdapter.findItems(scope);
  expect(found).toHaveLength(items.length);
  return found.map((el) => facebookAdapter.inspect(el, ctx));
}

function read(html: string) {
  const [r] = inspectAll(html);
  if (r?.kind !== 'post') throw new Error(`expected a post, got ${r?.kind}`);
  return { post: r.post, observations: r.observations ?? [] };
}

const detectors = (evidence: readonly Evidence[]) => evidence.map((e) => `${e.detector}:${e.strength}`);
const AD = { author: 'Shop Example', text: 'Autumn sale.' };

describe('Facebook ad labels', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('hides "Ad · Paid" with no timestamp as a near miss, and says so', () => {
    const { post: p, observations } = read(post({ ...AD, slot: svgText('SvgT4') }));
    expect(detectors(p.evidence)).toEqual(['fb.sponsored.no-timestamp:weak', 'fb.sponsored.near:medium']);
    expect(p.signals.sponsored).toBe(true);
    expect(ruleFilter(p, balanced)?.reason).toBe('sponsored');
    expect(observations).toContain('fb.label.sponsored.near');
    expect(p.quality.adNearMiss).toMatch(/^[0-9a-z]+$/);
  });

  it('gives every "Ad · Paid" on the page the same in-memory hash, and other wordings another', () => {
    const [a, b, c] = inspectAll(
      post({ ...AD, slot: svgText('SvgT4') }),
      post({ author: 'Gadget Daily', text: 'New phones.', slot: svgText('SvgT4') }),
      post({ ...AD, slot: '<span><span>Sponsored · Paid ad</span></span>' }),
    ).map((r) => (r.kind === 'post' ? r.post.quality.adNearMiss : undefined));
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBeDefined();
    expect(c).not.toBe(a);
  });

  it('still hides "Sponsored" and "Ad" on the label alone, with no near miss', () => {
    for (const id of ['SvgT2', 'SvgT3']) {
      const { post: p, observations } = read(post({ ...AD, slot: svgText(id) }));
      expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
      expect(detectors(p.evidence)).not.toContain('fb.sponsored.near:medium');
      expect(p.quality.adNearMiss).toBeUndefined();
      expect(observations).not.toContain('fb.label.sponsored.near');
      expect(ruleFilter(p, balanced)?.reason).toBe('sponsored');
    }
  });

  it('reads "Sponsored · Paid partnership with …" as a known label', () => {
    const { post: p, observations } = read(post({ ...AD, slot: svgText('SvgT5') }));
    expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.slot-label', strength: 'strong' });
    expect(observations).not.toContain('fb.label.sponsored.near');
  });

  it('never hides on a near miss alone: a video ad with "Ad · Paid" shows, and is still reported', () => {
    const video = '<div><a href="https://www.facebook.com/shopexample/videos/100000/" role="link"><video></video></a></div>';
    const { post: p, observations } = read(post({ ...AD, slot: svgText('SvgT4'), media: video }));
    expect(detectors(p.evidence)).toEqual(['fb.sponsored.near:medium']);
    expect(p.signals.sponsored).toBe(false);
    expect(ruleFilter(p, balanced)).toBeNull();
    expect(observations).toContain('fb.label.sponsored.near');
  });

  it("reads a near miss in a header label too, and prefers the age slot's", () => {
    const extra = '<span><span>Ad · Partner</span></span>';
    const { post: p } = read(post({ ...AD, slot: svgText('SvgT1'), extra }));
    expect(detectors(p.evidence)).toEqual(['fb.sponsored.near:medium']);
    expect(p.signals.sponsored).toBe(false);
    const both = read(post({ ...AD, slot: svgText('SvgT4'), extra })).post;
    const slotOnly = read(post({ ...AD, slot: svgText('SvgT4') })).post;
    expect(both.quality.adNearMiss).toBe(slotOnly.quality.adNearMiss);
  });

  it('never takes a name for a near miss: an author called "Ad Astra"', () => {
    const { post: p, observations } = read(post({ author: 'Ad Astra', slot: svgText('SvgT1'), text: 'Launch day.' }));
    expect(p.evidence).toEqual([]);
    expect(p.quality.adNearMiss).toBeUndefined();
    expect(observations).toEqual([]);
  });

  it('never reads labels in the post text, a bold run or a comment', () => {
    const text =
      'Sponsored by Example Labs<br><strong>Ad</strong><br><b>Sponsored</b> <span>Ad · Paid</span><div role="article" aria-label="Comment by Sam"><span>Sponsored</span></div>';
    const { post: p, observations } = read(post({ author: 'Riley Chen', slot: svgText('SvgT1'), text }));
    expect(p.evidence).toEqual([]);
    expect(p.signals.sponsored).toBe(false);
    expect(observations).toEqual([]);
    expect(ruleFilter(p, calm)).toBeNull();
  });

  it('notes an age slot it does not recognise, and counts it as no timestamp, which never hides alone', () => {
    const { post: p, observations } = read(post({ author: 'Riley Chen', slot: svgText('SvgT6'), text: 'Tomatoes.' }));
    expect(observations).toContain('fb.slot.age.unrecognised');
    expect(detectors(p.evidence)).toEqual(['fb.sponsored.no-timestamp:weak']);
    expect(ruleFilter(p, calm)).toBeNull();
    for (const slot of [svgText('SvgT1'), svgText('SvgT7'), perCharacter('Just now'), perCharacter('Yesterday at 3:00 PM')]) {
      const ok = read(post({ author: 'Riley Chen', slot, text: 'Tomatoes.' }));
      expect(ok.observations, slot).not.toContain('fb.slot.age.unrecognised');
      expect(ok.post.evidence, slot).toEqual([]);
    }
  });

  it('reads "Sponsored" as the name of a header button', () => {
    const extra = '<button type="button"><span>Sponsored</span></button>';
    const { post: p } = read(post({ ...AD, slot: svgText('SvgT1'), extra }));
    expect(p.evidence).toContainEqual({ signal: 'sponsored', detector: 'fb.sponsored.header', strength: 'strong' });
    expect(p.signals.sponsored).toBe(true);
  });

  it("decides with core's rule: one strong, two medium, or medium and weak", () => {
    const e = (detector: string, strength: Evidence['strength']): Evidence => ({ signal: 'sponsored', detector, strength });
    const cases: Evidence[][] = [
      [],
      [e('a', 'weak')],
      [e('a', 'weak'), e('b', 'weak')],
      [e('a', 'medium')],
      [e('a', 'medium'), e('b', 'weak')],
      [e('a', 'medium'), e('b', 'medium')],
      [e('a', 'strong')],
      [{ signal: 'suggested', detector: 'x', strength: 'strong' }],
    ];
    expect(cases.map(isSponsored)).toEqual([false, false, false, false, true, true, true, false]);
    for (const c of cases) expect(isSponsored(c)).toBe(atLeast(signalStrength(c, 'sponsored'), 'medium'));
  });
});

describe('Facebook header buttons and lines', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('reads "+ Follow" and a Follow button named after the author, never "Following"', () => {
    const named = post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Phones.', follow: true }).replace(
      '<div role="button" tabindex="0"><span>Follow</span></div>',
      '<div aria-label="Follow Gadget Daily" role="button" tabindex="0"><span>+ Follow</span></div>',
    );
    expect(read(named).post.author.relationship).toBe('not-followed');
    const following = post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Phones.', follow: true }).replace(
      '<span>Follow</span>',
      '<span>Following</span>',
    );
    expect(read(following).post.author.relationship).toBe('unknown');
  });

  it('finds a Follow button that lost its role, and says the fallback found it', () => {
    const html = post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Phones.', follow: true }).replace(
      '<div role="button" tabindex="0"><span>Follow</span></div>',
      '<div tabindex="0"><span>Follow</span></div>',
    );
    const { post: p, observations } = read(html);
    expect(p.author.relationship).toBe('not-followed');
    expect(observations).toContain('fb.slot.header-buttons.structure');
    expect(ruleFilter(p, calm)?.reason).toBe('not-followed');
  });

  it('tells a known line above the author from a new one', () => {
    const known = read(
      post({ author: 'Policy Watch', slot: svgText('SvgT1'), text: 'Zoning.', context: 'Jamie Park commented on this.' }),
    );
    expect(known.post.quality).toMatchObject({ headerKnown: true, headerUnknown: false });
    expect(known.observations).not.toContain('fb.header.unknown');
    const unknown = read(
      post({ author: 'Policy Watch', slot: svgText('SvgT1'), text: 'Zoning.', context: 'Jamie Park is talking about this.' }),
    );
    expect(unknown.post.quality).toMatchObject({ headerKnown: false, headerUnknown: true });
    expect(unknown.observations).toContain('fb.header.unknown');
    expect(ruleFilter(unknown.post, balanced)).toBeNull();
    const none = read(post({ author: 'Policy Watch', slot: svgText('SvgT1'), text: 'Zoning.' }));
    expect(none.post.quality.headerKnown).toBeUndefined();
    expect(none.post.quality.headerUnknown).toBeUndefined();
  });
});

describe('Facebook panels and slots', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it("takes a panel's title from its first heading only, so a later line never makes a post a panel", () => {
    // No message box: the caption is a span, and its text happens to be a panel's title.
    const html =
      item(`${filler()}<div><div data-ad-rendering-role="profile_name"><h4><a href="https://www.facebook.com/rileychen"><span>Riley Chen</span></a></h4></div></div>
      <div><span dir="auto">Reels</span></div><a href="https://www.facebook.com/reel/100000/"><video></video></a>`);
    const [r] = inspectAll(html);
    expect(r?.kind).toBe('post');
  });

  it('finds the author by its heading when the profile_name hook is gone, and says so', () => {
    const html = post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'Tomatoes.' }).replace(
      ' data-ad-rendering-role="profile_name"',
      '',
    );
    const { post: p, observations } = read(html);
    expect(p.author.name).toBe('Riley Chen');
    expect(observations).toContain('fb.slot.actor.structure');
    expect(p.evidence).toEqual([]);
  });

  it("without hooks, still tells a shared post's link and Follow button from the sharer's", () => {
    const shared = `<div><h4><a href="https://www.facebook.com/funnypage"><span>Funny Page</span></a></h4><div role="button" tabindex="0"><span>Follow</span></div><a href="https://www.facebook.com/funnypage/posts/777"><span>2h</span></a><div dir="auto">A cat that thinks it is a dog.</div></div>`;
    const html = post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'This made me laugh.', media: shared })
      .replaceAll(' data-ad-rendering-role="profile_name"', '')
      .replace(/ data-ad-comet-preview="message" data-ad-preview="message"| data-ad-rendering-role="story_message"/g, '');
    const { post: p, observations } = read(html);
    expect(p.author.name).toBe('Riley Chen');
    expect(p.author.relationship).toBe('unknown');
    expect(p.id).not.toBe('fb:777');
    expect(p.permalink).toBeUndefined();
    expect(observations).toEqual(expect.arrayContaining(['fb.slot.actor.structure', 'fb.slot.nested-post.structure']));
  });

  it('says when the text was found without its message box', () => {
    const caption = '<div><div dir="auto">A long caption that sits outside any message box.</div></div>';
    const { post: p, observations } = read(post({ author: 'Riley Chen', slot: svgText('SvgT1'), media: caption }));
    expect(p.text).toBe('A long caption that sits outside any message box.');
    expect(observations).toEqual(['fb.slot.text.structure', 'fb.slot.header.structure']);
  });
});
