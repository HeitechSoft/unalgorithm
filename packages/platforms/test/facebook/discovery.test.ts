import { defaultSettings, moduleFilter, ruleFilter } from '@unalgorithm/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { feed, item, PYMK, post, postBody, svgText, VIRTUALIZED } from '../../fixtures/facebook/live2026.ts';
import {
  AD_2026,
  EMPTIED_2026,
  FRIEND_POST,
  FRIEND_POST_2026,
  fbFeed,
  fbFeed2026,
  SKELETON,
  SPONSORED_SPLIT,
  SUGGESTED_PAGE_POST,
} from '../../fixtures/facebook/synthetic.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

/** Item discovery strategies, the one-post-per-item guard and offscreen slots (ADR 0009 §9). */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 19) };
const balanced = defaultSettings().platforms.facebook;

const FEED_ITEMS = [
  post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'Tomatoes, finally.', menu: true }),
  post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.', menu: true }),
  post({ author: 'Gadget Daily', slot: svgText('SvgT1'), text: 'Six phones compared.', follow: true, menu: true }),
  PYMK,
  post({ author: 'Morgan Lee', slot: svgText('SvgT7'), text: 'First snow on the ridge.', menu: true }),
  post({ author: 'Shop Example', slot: svgText('SvgT3'), text: 'Free shipping this week.', menu: true }),
  VIRTUALIZED,
];

/** Each item's kind and decision on Balanced, in page order. */
function decisions(): string[] {
  const scope = facebookAdapter.feedScope(document);
  if (!scope) return [];
  return facebookAdapter.findItems(scope).map((el) => {
    const r = facebookAdapter.inspect(el, ctx);
    if (r.kind === 'post') return ruleFilter(r.post, balanced)?.reason ?? 'show';
    if (r.kind === 'module') return moduleFilter(r.module, balanced) ? 'panel' : 'show';
    return r.kind === 'pending' && r.offscreen ? 'offscreen' : r.kind;
  });
}

const EXPECTED = ['show', 'sponsored', 'show', 'panel', 'show', 'sponsored', 'offscreen'];

const feedList = () =>
  (Array.from(document.querySelectorAll('h3')).find((h) => h.textContent === 'Feed posts') as Element).nextElementSibling
    ?.nextElementSibling as HTMLElement;

const mutations: Record<string, () => void> = {
  'the screen-reader heading removed': () => {
    Array.from(document.querySelectorAll('h3'))
      .find((h) => h.textContent === 'Feed posts')
      ?.remove();
  },
  'aria-posinset dropped': () => {
    for (const el of Array.from(document.querySelectorAll('[aria-posinset]'))) el.removeAttribute('aria-posinset');
  },
};

describe('Facebook item discovery', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it("uses today's strategies on today's layouts, with no fallback", () => {
    document.body.innerHTML = feed(...FEED_ITEMS);
    expect(decisions()).toEqual(EXPECTED);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.heading-list', fallback: false });
    document.body.innerHTML = fbFeed(FRIEND_POST, SPONSORED_SPLIT, SUGGESTED_PAGE_POST);
    expect(decisions()).toEqual(['show', 'sponsored', 'suggested']);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.role-feed', fallback: false });
  });

  it.each([
    ['the screen-reader heading removed', 'fb.items.posinset'],
    ['aria-posinset dropped', 'fb.items.anatomy'],
  ])('still finds every post with %s, as a fallback (%s)', (name, strategy) => {
    document.body.innerHTML = feed(...FEED_ITEMS);
    mutations[name]?.();
    expect(decisions()).toEqual(EXPECTED);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy, fallback: true });
    expect(checkAdapterContract(facebookAdapter, document.body.innerHTML)).toEqual([]);
  });

  it('finds the posts by their own parts with both the heading and aria-posinset gone', () => {
    document.body.innerHTML = feed(...FEED_ITEMS);
    for (const mutate of Object.values(mutations)) mutate();
    expect(decisions()).toEqual(EXPECTED);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.anatomy', fallback: true });
  });

  it('maps a node back to its item under a fallback strategy too', () => {
    document.body.innerHTML = feed(...FEED_ITEMS);
    mutations['the screen-reader heading removed']?.();
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const items = facebookAdapter.findItems(scope);
    const text = items[2]?.querySelector('[data-ad-rendering-role="story_message"] div[dir="auto"]') as Node;
    expect(facebookAdapter.itemRootOf(text, scope)).toBe(items[2]);
    expect(facebookAdapter.itemRootOf(items[2]?.parentElement as Node, scope)).toBeNull();
  });

  it('with one extra wrapper around the list, finds the posts inside it and never hides the wrapper', () => {
    document.body.innerHTML = feed(...FEED_ITEMS);
    const list = feedList();
    const wrapper = document.createElement('div');
    wrapper.append(...Array.from(list.childNodes));
    list.append(wrapper);
    expect(decisions()).toEqual(EXPECTED);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.posinset', fallback: true });
  });

  it('reads an item holding several posts as one to leave alone, and says so', () => {
    const several = item(
      postBody({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Autumn sale.' }) +
        postBody({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'Tomatoes.' }),
    );
    document.body.innerHTML = feed(several);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const [only] = facebookAdapter.findItems(scope);
    expect(facebookAdapter.inspect(only as HTMLElement, ctx)).toEqual({ kind: 'ignore', observations: ['fb.item.multi-post'] });
    // Without the like_button hooks, the buttons named Like count instead, and that is noted too.
    for (const hook of Array.from(document.querySelectorAll('[data-ad-rendering-role="like_button"]'))) hook.remove();
    expect(facebookAdapter.inspect(only as HTMLElement, ctx)).toEqual({
      kind: 'ignore',
      observations: ['fb.item.multi-post', 'fb.slot.action-bar.aria'],
    });
  });

  it("does not count a comment's Like button as a second post", () => {
    const comment =
      '<ul><li><div role="article" aria-label="Comment by Sam Rivera"><div dir="auto">Nice!</div><div aria-label="Like" role="button" tabindex="0"><div data-ad-rendering-role="like_button"></div></div></div></li></ul>';
    document.body.innerHTML = feed(post({ author: 'Riley Chen', slot: svgText('SvgT1'), text: 'Tomatoes.', media: comment }));
    expect(decisions()).toEqual(['show']);
  });
});

describe('Facebook discovery over time', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  /** A second list of posts elsewhere in the main column, not after a heading. */
  function addOtherList(count: number, menu = true): void {
    const posts = Array.from({ length: count }, (_, i) =>
      post({ author: `Author ${i}`, slot: svgText('SvgT1'), text: `Post number ${i} of the other list.`, menu }),
    );
    document
      .querySelector('[role="main"]')
      ?.insertAdjacentHTML('beforeend', `<div><div><div>${posts.join('')}</div></div></div>`);
  }

  /** Strips the action bar and message of every post in the heading's list: still posts, but poorer ones. */
  function degradeFeedList(): void {
    for (const el of Array.from(
      feedList().querySelectorAll('[data-ad-rendering-role="story_message"], [role="button"][aria-label="Like"]'),
    ))
      el.parentElement?.remove();
  }

  const fourPosts = () =>
    Array.from({ length: 4 }, (_, i) =>
      post({ author: `Friend ${i}`, slot: svgText('SvgT1'), text: `Friend post ${i}.`, menu: true }),
    );

  it('switches only after another strategy wins by 0.15 on two discoveries in a row', () => {
    document.body.innerHTML = feed(...fourPosts());
    facebookAdapter.feedScope(document);
    expect(facebookAdapter.discovery?.()?.strategy).toBe('fb.items.heading-list');
    addOtherList(6);
    degradeFeedList();
    facebookAdapter.rediscover?.(document);
    expect(facebookAdapter.discovery?.()?.strategy).toBe('fb.items.heading-list');
    facebookAdapter.rediscover?.(document);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.posinset', fallback: true });
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    expect(facebookAdapter.findItems(scope)).toHaveLength(6);
  });

  it('never switches on a small lead', () => {
    // The heading's list: one of four posts has no text (0.9625); the other list is perfect (1.0).
    document.body.innerHTML = feed(...fourPosts());
    facebookAdapter.feedScope(document);
    feedList().querySelector('[data-ad-rendering-role="story_message"]')?.parentElement?.remove();
    addOtherList(6);
    for (let i = 0; i < 4; i++) facebookAdapter.rediscover?.(document);
    expect(facebookAdapter.discovery?.()?.strategy).toBe('fb.items.heading-list');
  });

  it('gives way at once when the strategy in use no longer finds the feed', () => {
    document.body.innerHTML = feed(...fourPosts());
    facebookAdapter.feedScope(document);
    expect(facebookAdapter.discovery?.()?.strategy).toBe('fb.items.heading-list');
    mutations['the screen-reader heading removed']?.();
    facebookAdapter.rediscover?.(document);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.posinset', fallback: true });
  });

  it('starts over on a new page, back on the cheapest strategy that works', () => {
    document.body.innerHTML = feed(...fourPosts());
    mutations['the screen-reader heading removed']?.();
    facebookAdapter.feedScope(document);
    expect(facebookAdapter.discovery?.()?.strategy).toBe('fb.items.posinset');
    document.body.innerHTML = feed(...fourPosts());
    facebookAdapter.feedScope(document);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.heading-list', fallback: false });
  });

  it('with too few posts to score, keeps the cheapest strategy that found the list', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026, AD_2026);
    expect(decisions()).toEqual(['show', 'sponsored']);
    expect(facebookAdapter.discovery?.()).toEqual({ strategy: 'fb.items.heading-list', fallback: false });
  });

  it('finds no feed on a page without one, and reports no strategy', () => {
    document.body.innerHTML = '<div role="banner"></div><div role="main"><h2>Riley Chen</h2><div>Photos</div></div>';
    expect(facebookAdapter.feedScope(document)).toBeNull();
    expect(facebookAdapter.discovery?.()).toBeNull();
  });
});

describe('Facebook offscreen slots', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
  });

  it('reads a virtualised slot as offscreen, and a skeleton or a slot never seen as plain pending', () => {
    document.body.innerHTML = fbFeed2026(EMPTIED_2026, FRIEND_POST_2026, SKELETON, VIRTUALIZED);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    expect(facebookAdapter.findItems(scope).map((el) => facebookAdapter.inspect(el, ctx))).toEqual([
      { kind: 'pending' },
      expect.objectContaining({ kind: 'post' }),
      { kind: 'pending' },
      { kind: 'pending', offscreen: true },
    ]);
  });

  it('reads a slot emptied after it was a post as offscreen', () => {
    document.body.innerHTML = fbFeed2026(FRIEND_POST_2026);
    const scope = facebookAdapter.feedScope(document) as HTMLElement;
    const [slot] = facebookAdapter.findItems(scope) as [HTMLElement];
    expect(facebookAdapter.inspect(slot, ctx).kind).toBe('post');
    slot.replaceChildren();
    expect(facebookAdapter.inspect(slot, ctx)).toEqual({ kind: 'pending', offscreen: true });
  });
});
