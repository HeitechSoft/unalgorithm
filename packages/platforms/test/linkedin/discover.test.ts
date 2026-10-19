import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultSettings, moduleFilter, type PlatformSettings, ruleFilter } from '@unalgorithm/core';
import { describe, expect, it, vi } from 'vitest';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  POST_WITH_COMMENTS,
  PROMOTED_FOLLOWS_PAGE,
} from '../../fixtures/linkedin/y2026.ts';
import { linkedinAdapter } from '../../src/linkedin/adapter.ts';
import { cardOf, rediscoverItems } from '../../src/linkedin/discover.ts';
import { checkAdapterContract } from '../../src/testing/contract.ts';

/**
 * Item discovery (ADR 0009 §9, phase B), on mutated copies of the "For you" captures: each mutation is one the
 * 2026-10 probe found would leave 0 items, stall the infinite scroll or hide several posts as one.
 */
const balanced: PlatformSettings = defaultSettings().platforms.linkedin;
const NOW = new Date(2026, 9, 19, 12);
const markers = linkedinAdapter.markersFor('en');

const capture = (file: string) =>
  readFileSync(join(import.meta.dirname, '../../fixtures/linkedin', file), 'utf8')
    .replaceAll('Promoted • Xxxxxxxxxxx xxxx', 'Promoted • Partnership with')
    .replaceAll('>finds this xxxxx<', '>finds this funny<');
const LOAD_1 = capture('2026-10-foryou-1.html');
const LOAD_2 = capture('2026-10-foryou-2.html');

/** LinkedIn renames the card key's prefix. */
const renamePrefix = (html: string) => html.replaceAll('componentkey="update-card-focus', 'componentkey="feed-unit-focus');
/** LinkedIn drops `role="listitem"` from the cards. */
const dropListItem = (html: string) => html.replaceAll(' role="listitem"', '');
/** LinkedIn drops the feed list's test id. */
const dropMainFeed = (html: string) => html.replace(' data-testid="mainFeed"', '');
/** LinkedIn drops the feed list's role too. */
const dropFeedRole = (html: string) => html.replace('<div role="list"', '<div');
/** New hashed class names on every element. */
const rehashClasses = (html: string) => {
  let n = 0;
  return html.replace(/class="[^"]*"/g, () => `class="h${(n++ * 7919).toString(36)} q${(n % 13).toString(36)}"`);
};

/** The feed list in the captures: the first child of main, whatever its markers. */
const feedList = () => document.querySelector('main')?.firstElementChild as HTMLElement;

/**
 * One entry per child of the feed list: "-" (not an item), "panel", "ignore", or a post's decision and relationship,
 * as in capture-2026-10.test.ts. Ids are left out: some mutations take away the card key they are made from.
 */
function decide(html: string): string[] {
  document.body.innerHTML = html;
  const scope = linkedinAdapter.feedScope(document) as HTMLElement;
  const items = linkedinAdapter.findItems(scope);
  return Array.from(feedList().children).map((child) => {
    const item = items.find((it) => child === it || child.contains(it));
    if (!item) {
      const module = linkedinAdapter.siblingModules?.(items, { markers, now: NOW }).find((s) => s.el === child);
      return module ? 'panel' : '-';
    }
    const r = linkedinAdapter.inspect(item, { markers, now: NOW });
    if (r.kind === 'module') return moduleFilter(r.module, balanced) ? 'panel' : 'show';
    if (r.kind !== 'post') return r.kind;
    return `${ruleFilter(r.post, balanced)?.reason ?? 'show'}/${r.post.author.relationship}`;
  });
}

/** The post ids, in page order. */
function ids(html: string): string[] {
  document.body.innerHTML = html;
  const scope = linkedinAdapter.feedScope(document) as HTMLElement;
  return linkedinAdapter.findItems(scope).flatMap((el) => {
    const r = linkedinAdapter.inspect(el, { markers, now: NOW });
    return r.kind === 'post' ? [r.post.id] : [];
  });
}

describe('item discovery on the "For you" captures', { timeout: 30_000 }, () => {
  it("keeps today's selector on the healthy page, where every strategy finds the same posts", () => {
    for (const html of [LOAD_1, LOAD_2]) {
      document.body.innerHTML = html;
      const scope = linkedinAdapter.feedScope(document) as HTMLElement;
      linkedinAdapter.findItems(scope);
      expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.card-key', fallback: false });
      // A full discovery right after attach runs every strategy: ties go to the cheapest.
      const scores = rediscoverItems(scope);
      expect(new Set(scores.map((s) => s.score)).size).toBe(1);
      expect(scores[0]?.score).toBeGreaterThan(0.9);
      linkedinAdapter.rediscover?.(document);
      expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.card-key', fallback: false });
    }
  });

  it('a renamed card key prefix: a fallback finds the same posts, panels and decisions', () => {
    for (const html of [LOAD_1, LOAD_2]) {
      const before = decide(html);
      expect(decide(renamePrefix(html))).toEqual(before);
      expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.feed-list', fallback: true });
    }
  });

  it('a renamed prefix and an unmarked feed list: the anatomy strategy finds the same posts', () => {
    const before = decide(LOAD_1);
    expect(decide(dropFeedRole(dropMainFeed(renamePrefix(LOAD_1))))).toEqual(before);
    expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.anatomy', fallback: true });
  });

  it('without the post menus, Repost and Send, the "Feed post" headings still find the posts', () => {
    const html = dropFeedRole(dropMainFeed(renamePrefix(LOAD_1)))
      .replaceAll('aria-label="Open control menu for post by ', 'aria-label="Post options: ')
      .replaceAll('aria-label="Hide post by ', 'aria-label="Not interested: ')
      .replaceAll('aria-label="Repost"', 'aria-label="Share again"')
      .replaceAll('aria-label="Send"', 'aria-label="Message"');
    document.body.innerHTML = html;
    const items = linkedinAdapter.findItems(linkedinAdapter.feedScope(document) as HTMLElement);
    expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.sr-heading', fallback: true });
    expect(items).toHaveLength(23);
  });

  it('dropped role="listitem": a fallback finds the same posts, with the same ids', () => {
    const before = { decisions: decide(LOAD_2), ids: ids(LOAD_2) };
    const html = dropListItem(LOAD_2);
    expect(decide(html)).toEqual(before.decisions);
    expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.feed-list', fallback: true });
    expect(ids(html)).toEqual(before.ids);
  });

  it('a dropped feed list test id: the load-more marker is still found, as the list of the cards', () => {
    for (const html of [LOAD_1, LOAD_2]) {
      document.body.innerHTML = dropMainFeed(html);
      expect(document.querySelector('[data-testid="mainFeed"]')).toBeNull();
      const scope = linkedinAdapter.feedScope(document) as HTMLElement;
      linkedinAdapter.findItems(scope);
      const marker = linkedinAdapter.loadMoreMarker?.(scope, document);
      expect(marker).toBe(feedList().lastElementChild);
      expect(marker?.childElementCount).toBe(0);
    }
    // And under a fallback strategy too.
    document.body.innerHTML = dropMainFeed(renamePrefix(LOAD_1));
    const scope = linkedinAdapter.feedScope(document) as HTMLElement;
    linkedinAdapter.findItems(scope);
    expect(linkedinAdapter.discovery?.()?.fallback).toBe(true);
    expect(linkedinAdapter.loadMoreMarker?.(scope, document)).toBe(feedList().lastElementChild);
  });

  it('rehashed class names change nothing', () => {
    for (const html of [LOAD_1, LOAD_2]) {
      const before = decide(html);
      expect(decide(rehashClasses(html))).toEqual(before);
      expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.card-key', fallback: false });
    }
    expect(ids(rehashClasses(LOAD_1))).toEqual(ids(LOAD_1));
  });

  it('keeps the adapter contract under a fallback strategy', () => {
    for (const html of [renamePrefix(LOAD_1), dropListItem(LOAD_2), dropFeedRole(dropMainFeed(renamePrefix(LOAD_2)))])
      expect(checkAdapterContract(linkedinAdapter, html)).toEqual([]);
  });

  it('switches only after a challenger wins two full discoveries in a row', () => {
    document.body.innerHTML = LOAD_1;
    const scope = linkedinAdapter.feedScope(document) as HTMLElement;
    expect(linkedinAdapter.findItems(scope)).toHaveLength(23);
    // LinkedIn changes the markup under the running page: today's selector now finds nothing.
    for (const card of Array.from(scope.querySelectorAll('[componentkey^="update-card-focus"]')))
      card.setAttribute('componentkey', `feed-unit-focus${card.getAttribute('componentkey')?.slice(17)}`);
    expect(linkedinAdapter.findItems(scope)).toHaveLength(0);
    linkedinAdapter.rediscover?.(document);
    expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.card-key', fallback: false });
    linkedinAdapter.rediscover?.(document);
    expect(linkedinAdapter.discovery?.()).toEqual({ strategy: 'li.items.feed-list', fallback: true });
    const items = linkedinAdapter.findItems(scope);
    expect(items).toHaveLength(23);
    // Items are the list's children now; a node inside one maps back to it.
    for (const item of items) expect(linkedinAdapter.itemRootOf(item.querySelector('h2') ?? item, scope)).toBe(item);
    expect(linkedinAdapter.itemRootOf(scope, scope)).toBeNull();
  });
});

describe('one post per item', () => {
  /** Two posts in one wrapper, as when a fallback strategy takes a level too high. */
  const pairs = (...cards: string[]) =>
    `<main><div>${[0, 2]
      .map((i) => `<div>${cards[i] ?? ''}${cards[i + 1] ?? ''}</div>`)
      .join('')}<div>${cards[4] ?? ''}</div></div></main>`;

  it('an item holding two posts is never hidden as one, and says so', () => {
    document.body.innerHTML = pairs(FOLLOWED_BY_POST, PROMOTED_FOLLOWS_PAGE, COMPANY_NOT_FOLLOWED, FIRST_DEGREE_POST);
    const pair = document.querySelector('main > div > div') as HTMLElement;
    expect(linkedinAdapter.inspect(pair, { markers, now: NOW })).toEqual({
      kind: 'ignore',
      observations: ['li.item.multi-post'],
    });
  });

  it('a fallback that lists wrappers of two posts hides none of them', () => {
    const html = renamePrefix(
      pairs(FOLLOWED_BY_POST, PROMOTED_FOLLOWS_PAGE, COMPANY_NOT_FOLLOWED, FIRST_DEGREE_POST, POST_WITH_COMMENTS),
    );
    document.body.innerHTML = html;
    const scope = linkedinAdapter.feedScope(document) as HTMLElement;
    const items = linkedinAdapter.findItems(scope);
    expect(linkedinAdapter.discovery?.()?.fallback).toBe(true);
    const kinds = items.map((el) => linkedinAdapter.inspect(el, { markers, now: NOW }).kind);
    expect(kinds).toEqual(['ignore', 'ignore', 'post']);
  });

  it('a post with its comments open, or a reshared post inside it, is one post', () => {
    const reshared = FIRST_DEGREE_POST.replace(
      '<div class="e0sbar">',
      '<div><div aria-label="Sam Stranger 3rd+"><a href="https://www.linkedin.com/in/sam-stranger/"><p>Sam Stranger</p></a></div><div data-testid="expandable-text-box"><span>Inner text</span></div></div><div class="e0sbar">',
    );
    for (const card of [POST_WITH_COMMENTS, reshared]) {
      document.body.innerHTML = feed2026(card);
      const [item] = linkedinAdapter.findItems(linkedinAdapter.feedScope(document) as HTMLElement);
      expect(linkedinAdapter.inspect(item as HTMLElement, { markers, now: NOW }).kind).toBe('post');
    }
  });
});

describe('cardOf', () => {
  it('reads the card inside a wrapper, so a post keeps its id', () => {
    document.body.innerHTML = feed2026(FIRST_DEGREE_POST);
    const card = document.querySelector('[componentkey^="update-card-focus"]') as HTMLElement;
    const wrapper = card.closest('[data-lazy-mount-id]') as HTMLElement;
    expect(cardOf(wrapper)).toBe(card);
    expect(cardOf(card)).toBe(card);
    const id = (el: HTMLElement) => {
      const r = linkedinAdapter.inspect(el, { markers, now: NOW });
      return r.kind === 'post' ? r.post.id : r.kind;
    };
    expect(id(wrapper)).toBe(id(card));
    expect(id(card)).toBe('li:ck:EEEkeyFirstDegree5');
  });
});

describe('discovery state', () => {
  it('is null before any discovery, then names the strategy in use', async () => {
    vi.resetModules();
    const { linkedinAdapter: fresh } = await import('../../src/linkedin/adapter.ts');
    expect(fresh.discovery?.()).toBeNull();
    document.body.innerHTML = feed2026(FIRST_DEGREE_POST);
    fresh.findItems(fresh.feedScope(document) as HTMLElement);
    // One post isn't enough to score a strategy: today's selector stays in use, and isn't a fallback.
    expect(fresh.discovery?.()).toEqual({ strategy: 'li.items.card-key', fallback: false });
  });
});
