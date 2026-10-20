import { applyPreset, defaultSettings, ruleFilter, toPostForAI } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AD_2026,
  EMPTIED_2026,
  FOLLOW_PAGE_2026,
  FRIEND_ACTIVITY,
  FRIEND_POST,
  FRIEND_POST_2026,
  FRIEND_RESHARE,
  fbFeed,
  fbFeed2026,
  JOINED_GROUP_POST,
  NOT_FOLLOWED_PAGE_POST,
  ORGANIC_LINK_SHARE,
  PHOTO_POST_2026,
  PYMK,
  REELS_TRAY,
  SKELETON,
  SPONSORED_ADLINK,
  SPONSORED_ARIA,
  SPONSORED_LABELLEDBY,
  SPONSORED_SPLIT,
  SPONSORED_SVG,
  SUGGESTED_PAGE_POST,
  TRUNCATED_POST,
  UNJOINED_GROUP_POST,
  VIRTUALIZED_2026,
} from '../../fixtures/facebook/synthetic.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 10) };
const balanced = defaultSettings().platforms.facebook;
const calm = applyPreset('facebook', balanced, 'calm');

function inspectOnly(item: string) {
  document.body.innerHTML = fbFeed(item);
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const items = facebookAdapter.findItems(scope);
  expect(items).toHaveLength(1);
  return facebookAdapter.inspect(items[0] as HTMLElement, ctx);
}

function post(item: string) {
  const r = inspectOnly(item);
  if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
  return r.post;
}

describe('Facebook adapter (synthetic fixtures)', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('keeps a friend post and reads its id, audience and text', () => {
    const p = post(FRIEND_POST);
    expect(p.id).toBe('fb:pfbid0aBcD123');
    expect(p.author.name).toBe('Riley Chen');
    expect(p.audience).toBe('friends');
    expect(p.text).toContain('tomatoes');
    expect(p.signals).toMatchObject({ sponsored: false, suggested: false, networkActivity: false });
    expect(ruleFilter(p, calm)).toBeNull();
  });

  it.each([
    ['aria-label', SPONSORED_ARIA],
    ['aria-labelledby with hidden decoy letters', SPONSORED_LABELLEDBY],
    ['letters split across hidden spans', SPONSORED_SPLIT],
    ['SVG <use> text', SPONSORED_SVG],
    ['ad transparency link', SPONSORED_ADLINK],
  ])('detects Sponsored via %s', (_name, html) => {
    const p = post(html);
    expect(p.signals.sponsored).toBe(true);
    expect(ruleFilter(p, balanced)?.reason).toBe('sponsored');
  });

  it('never calls an organic link share an ad just because it has a CTA button', () => {
    const p = post(ORGANIC_LINK_SHARE);
    expect(p.signals.sponsored).toBe(false);
    expect(p.evidence.some((e) => e.detector === 'fb.sponsored.cta')).toBe(true);
    expect(p.sharedLink).toEqual({
      url: 'https://news.example.com/transit',
      domain: 'news.example.com',
      title: 'City approves new transit budget',
    });
    expect(p.media).toBe('link');
  });

  it('hides "Suggested for you" as suggested, and a page you don\'t follow without it as not followed, in Balanced', () => {
    const p = post(SUGGESTED_PAGE_POST);
    expect(p.signals.suggested).toBe(true);
    expect(p.author.relationship).toBe('not-followed');
    expect(ruleFilter(p, balanced)?.reason).toBe('suggested');
    const notSuggested = post(NOT_FOLLOWED_PAGE_POST);
    expect(notSuggested.signals.suggested).toBe(false);
    expect(notSuggested.author.relationship).toBe('not-followed');
    expect(ruleFilter(notSuggested, balanced)?.reason).toBe('not-followed');
    expect(ruleFilter(notSuggested, calm)?.reason).toBe('not-followed');
    expect(ruleFilter(notSuggested, applyPreset('facebook', balanced, 'light'))).toBeNull();
  });

  it('treats "X commented on this" as friend activity', () => {
    const p = post(FRIEND_ACTIVITY);
    expect(p.contextLine).toBe('Jamie Park commented on this.');
    expect(ruleFilter(p, balanced)?.reason).toBe('network-activity');
  });

  it('hides groups you are not in and keeps groups you are in', () => {
    const unjoined = post(UNJOINED_GROUP_POST);
    expect(unjoined.group).toEqual({ name: 'Hiking Ontario', joined: false });
    expect(ruleFilter(unjoined, balanced)?.reason).toBe('unjoined-group');
    expect(ruleFilter(post(JOINED_GROUP_POST), balanced)).toBeNull();
  });

  it("ignores the Follow button of a stranger's post a friend reshared", () => {
    const p = post(FRIEND_RESHARE);
    expect(p.author.name).toBe('Riley Chen');
    expect(p.author.relationship).toBe('unknown');
    expect(p.signals.reshare).toBe(true);
    expect(ruleFilter(p, balanced)).toBeNull();
  });

  it('marks "See more" text as incomplete and never clicks it', () => {
    const p = post(TRUNCATED_POST);
    expect(p.textComplete).toBe(false);
    expect(p.text).toMatch(/^Long thoughts on parenting/);
    expect(p.text).not.toMatch(/See more/);
  });

  it('recognizes feed panels and skeletons', () => {
    expect(inspectOnly(REELS_TRAY)).toEqual({ kind: 'module', module: { kind: 'reels', title: 'Reels and short videos' } });
    expect(inspectOnly(PYMK)).toMatchObject({ kind: 'module', module: { kind: 'people-you-may-know' } });
    expect(inspectOnly(SKELETON)).toEqual({ kind: 'pending' });
  });

  it('finds the right-rail Sponsored block without touching Contacts', () => {
    document.body.innerHTML = fbFeed(FRIEND_POST);
    const regions = facebookAdapter.extraRegions?.(document, ctx) ?? [];
    const rail = regions.find((r) => r.module.kind === 'sponsored-rail');
    expect(rail?.el.textContent).toContain('Sponsored');
    expect(rail?.el.textContent).not.toContain('Contacts');
  });

  it('runs only on the home feed', () => {
    expect(facebookAdapter.isFeedPage(new URL('https://www.facebook.com/'))).toBe(true);
    expect(facebookAdapter.isFeedPage(new URL('https://www.facebook.com/groups/abc/'))).toBe(false);
    expect(facebookAdapter.isFeedPage(new URL('https://www.facebook.com/someone'))).toBe(false);
  });

  it('lists tagged people in the message so they can be masked before AI', () => {
    const tagged = FRIEND_POST.replace(
      'Twelve of them',
      'Thanks to <a href="https://www.facebook.com/jamie.park">Jamie Park</a> and <a href="https://www.facebook.com/hashtag/garden">#garden</a>. Twelve of them',
    );
    const p = post(tagged);
    expect(p.mentions).toEqual(['Jamie Park']);
    const masked = toPostForAI(p, { ref: 'p1', redactMentions: true }).text;
    expect(masked).toContain('Thanks to @someone and #garden.');
    expect(masked).not.toContain('Jamie');
  });

  it('without a message box, reads the caption (with its tags) and never a comment', () => {
    const noMessageBox = `<div><div><div aria-posinset="90" aria-describedby="d90"><div>
      <div><div>
        <div data-ad-rendering-role="profile_name"><h4><span><a href="https://www.facebook.com/riley.chen" role="link"><strong><span>Riley Chen</span></strong></a></span></h4></div>
        <div><a href="https://www.facebook.com/riley.chen/posts/pfbid0zZz9" role="link"><span>2h</span></a><span aria-label="Shared with Friends" role="img"></span></div>
      </div></div>
      <div><div dir="auto">Album from our trip with <a href="https://www.facebook.com/jamie.park">Jamie Park</a>.</div></div>
      <div role="article" aria-label="Comment by Sam Rivera"><div dir="auto">This comment is much longer than the caption and must never be read as the post itself.</div></div>
    </div></div></div></div>`;
    const p = post(noMessageBox);
    expect(p.text).toBe('Album from our trip with Jamie Park.');
    expect(p.mentions).toEqual(['Jamie Park']);
    expect(toPostForAI(p, { ref: 'p1', redactMentions: true }).text).toBe('Album from our trip with @someone.');
  });

  it('treats members tagged in group posts as tags', () => {
    const tagged = FRIEND_POST.replace(
      'Twelve of them',
      'Thanks <a href="https://www.facebook.com/groups/123/user/456/">Casey Brooks</a>. Twelve of them',
    );
    expect(post(tagged).mentions).toEqual(['Casey Brooks']);
  });

  it('passes the adapter contract', () => {
    const html = fbFeed(FRIEND_POST, SPONSORED_SPLIT, SUGGESTED_PAGE_POST, REELS_TRAY, UNJOINED_GROUP_POST, FRIEND_RESHARE);
    expect(checkAdapterContract(facebookAdapter, html)).toEqual([]);
  });
});

describe('Facebook adapter (2026 layout, no role="feed")', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  function only2026(item: string) {
    document.body.innerHTML = fbFeed2026(item);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const items = facebookAdapter.findItems(scope);
    expect(items).toHaveLength(1);
    const r = facebookAdapter.inspect(items[0] as HTMLElement, ctx);
    if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
    return r.post;
  }

  it('finds the list after the "Feed posts" heading, one item per slot, and skips the composer and Stories', () => {
    document.body.innerHTML = fbFeed2026(EMPTIED_2026, FRIEND_POST_2026, AD_2026, VIRTUALIZED_2026);
    const scope = facebookAdapter.feedScope(document);
    expect(scope?.getAttribute('role')).toBe('main');
    const items = facebookAdapter.findItems(scope as HTMLElement);
    expect(items).toHaveLength(4);
    expect(items.map((el) => facebookAdapter.inspect(el, ctx).kind)).toEqual(['pending', 'post', 'post', 'pending']);
    expect(facebookAdapter.probe(document, scope)).toMatchObject({ feeds: 0, lists: 1, items: 4 });
  });

  it('does not depend on the heading being in English', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026).replace('Feed posts', 'Publications du fil');
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    expect(facebookAdapter.findItems(scope)).toHaveLength(1);
  });

  it('maps any node in a post back to its item, never to a block inside it', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026, FOLLOW_PAGE_2026);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const [first, second] = facebookAdapter.findItems(scope) as [HTMLElement, HTMLElement];
    // A link preview inside a post: a heading followed by a block, like the feed list itself.
    const msg = second.querySelector('[data-ad-rendering-role="story_message"]') as HTMLElement;
    msg.insertAdjacentHTML('afterend', '<div><h3>Preview title</h3><div><span id="deep">example.com</span></div></div>');
    expect(facebookAdapter.itemRootOf(first.querySelector('[data-ad-rendering-role="profile_name"] b') as Node, scope)).toBe(
      first,
    );
    expect(facebookAdapter.itemRootOf(document.getElementById('deep') as Node, scope)).toBe(second);
    const composer = document.querySelector('[role="main"] h3') as HTMLElement;
    expect(facebookAdapter.itemRootOf(composer, scope)).toBeNull();
  });

  it('reads a friend post: author, text and "Shared with Riley’s friends" from the SVG title', () => {
    const p = only2026(FRIEND_POST_2026);
    expect(p.author.name).toBe('Riley Chen');
    expect(p.text).toBe('Our garden finally produced tomatoes this year.');
    expect(p.audience).toBe('friends');
    expect(p.signals.sponsored).toBe(false);
    expect(ruleFilter(p, calm)).toBeNull();
  });

  it('hides posts labelled "Ad" (the 2026 wording of "Sponsored")', () => {
    const p = only2026(AD_2026);
    expect(p.evidence.map((e) => e.detector)).toContain('fb.sponsored.labelledby');
    expect(p.signals.sponsored).toBe(true);
    expect(ruleFilter(p, balanced)?.reason).toBe('sponsored');
  });

  it('reads the Follow button next to the author as "not followed", and hides the post in Balanced', () => {
    const p = only2026(FOLLOW_PAGE_2026);
    expect(p.author.name).toBe('Gadget Daily');
    expect(p.author.relationship).toBe('not-followed');
    expect(ruleFilter(p, balanced)?.reason).toBe('not-followed');
  });

  it('counts the timestamp link (href "/" until hovered, age in an aria-labelledby span) as a timestamp', () => {
    for (const html of [FRIEND_POST_2026, FOLLOW_PAGE_2026]) {
      expect(only2026(html).evidence.map((e) => e.detector)).not.toContain('fb.sponsored.no-timestamp');
    }
  });

  it('does not hide an organic 2026 post on one medium sponsored signal', () => {
    // Before, the missing permalink added the weak no-timestamp signal, and medium + weak hid the post.
    const html = FRIEND_POST_2026.replace(
      '<span> · </span>',
      '<span> · </span><span><span>A</span><span data-ua-hidden>x</span><span>d</span></span>',
    );
    const p = only2026(html);
    expect(p.evidence).toContainEqual(expect.objectContaining({ detector: 'fb.sponsored.rendered-label', strength: 'medium' }));
    expect(p.signals.sponsored).toBe(false);
    expect(ruleFilter(p, balanced)).toBeNull();
  });

  it('still notes a 2026 post with no timestamp at all, which never hides it alone', () => {
    const html = FRIEND_POST_2026.replace(/<a href="https:\/\/www\.facebook\.com\/\?__cft__[^"]*"[^>]*>.*?<\/a>/s, '');
    const p = only2026(html);
    expect(p.evidence.map((e) => e.detector)).toContain('fb.sponsored.no-timestamp');
    expect(p.signals.sponsored).toBe(false);
  });

  it("takes Facebook's id from a photo link, else a hash that survives a re-render", () => {
    const photo = only2026(PHOTO_POST_2026);
    expect(photo.id).toBe('fb:2026101601');
    expect(photo.permalink).toBe('https://www.facebook.com/photo/?fbid=2026101601&set=a.20261016010');
    expect(photo.media).toBe('image');
    // Text posts have no id up front. A re-render brings a new tracking token and slot number; the id stays.
    const p = only2026(FRIEND_POST_2026);
    expect(p.id).toMatch(/^fb:h:/);
    const rerendered = FRIEND_POST_2026.replace(/__cft__\[0\]=AZ/g, '__cft__[0]=AZq9x').replace(
      /aria-posinset="\d+"/,
      'aria-posinset="42"',
    );
    expect(only2026(rerendered).id).toBe(p.id);
  });

  it('passes the adapter contract', () => {
    const html = fbFeed2026(FRIEND_POST_2026, AD_2026, FOLLOW_PAGE_2026, PHOTO_POST_2026, VIRTUALIZED_2026);
    expect(checkAdapterContract(facebookAdapter, html)).toEqual([]);
  });
});
