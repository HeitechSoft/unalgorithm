import type { ModuleInfo } from '@unalgorithm/core';
import { getLines, luminance, normalizeText } from '../shared/dom.ts';
import type { InspectResult, PlatformAdapter } from '../types.ts';
import { extractFacebookPost, FB_SEL, moduleOf } from './extract.ts';
import { FACEBOOK_EN, type FacebookMarkers } from './markers/en.ts';

const MARKERS: Record<string, FacebookMarkers> = { en: FACEBOOK_EN };

/** Within a few siblings after a heading: the 2026 list follows a screen-reader "Feed posts" h3 and a spacer. */
function afterHeading(el: Element): boolean {
  let s = el.previousElementSibling;
  for (let i = 0; s && i < 3; i++, s = s.previousElementSibling) if (s.matches('h2, h3')) return true;
  return false;
}

/**
 * The outermost `[role="feed"]`, or the unlabelled list the 2026 home feed uses instead: a block right after a
 * heading, not inside a post, holding posts. Checks the cheap sibling walk first so `itemRootOf` stays O(depth).
 */
function isFeedList(el: Element): boolean {
  if (el.matches(FB_SEL.feed)) return !el.parentElement?.closest(FB_SEL.feed);
  return afterHeading(el) && !el.closest(FB_SEL.post) && !!el.querySelector(FB_SEL.post);
}

function feedLists(scope: ParentNode): HTMLElement[] {
  const feeds = Array.from(scope.querySelectorAll<HTMLElement>(FB_SEL.feed)).filter(isFeedList);
  if (feeds.length) return feeds;
  // No role="feed": climb from a post to the list that holds it.
  for (const post of Array.from(scope.querySelectorAll(FB_SEL.post))) {
    for (let el = post.parentElement; el && el !== scope; el = el.parentElement) if (isFeedList(el)) return [el];
  }
  return [];
}

/**
 * Facebook's home feed: one list inside `[role="main"]` with a direct child per feed item (posts and panels alike).
 * Until 2026 the list was `[role="feed"]`; the 2026 layout drops the role and puts the list right after a
 * screen-reader "Feed posts" heading, every post marked `[aria-posinset]`, items far from the viewport emptied
 * (virtualized) until they scroll back. Class names are generated, so everything here keys on roles, aria
 * attributes, data-ad-* hooks and links, never on English heading text.
 */
export const facebookAdapter: PlatformAdapter<FacebookMarkers> = {
  id: 'facebook',
  version: 'facebook@2026.10.1',

  isFeedPage(url) {
    return url.hostname.endsWith('facebook.com') && (/^\/(home\.php)?$/.test(url.pathname) || url.pathname === '/?sk=h_chr');
  },

  feedScope(doc) {
    const main = doc.querySelector<HTMLElement>('[role="main"]');
    if (main && feedLists(main).length) return main;
    return feedLists(doc).length ? doc.body : null;
  },

  findItems(scope) {
    const items: HTMLElement[] = [];
    for (const list of feedLists(scope)) {
      for (const child of Array.from(list.children) as HTMLElement[]) {
        if (child.tagName === 'UNALGO-POST') continue;
        items.push(child);
      }
    }
    return items;
  },

  itemRootOf(node, scope) {
    let el: Element | null = node instanceof Element ? node : node.parentElement;
    while (el && el !== scope) {
      const parent: HTMLElement | null = el.parentElement;
      if (parent && isFeedList(parent)) return el as HTMLElement;
      el = parent;
    }
    return null;
  },

  inspect(el, ctx): InspectResult {
    const m = ctx.markers;
    if (!m) return { kind: 'ignore' };
    const text = normalizeText(el.textContent ?? '');
    if (text.length < 3) return { kind: 'pending' };
    const module = moduleOf(el, m);
    if (module) return { kind: 'module', module };
    const hasPost = !!el.querySelector(`${FB_SEL.message}, ${FB_SEL.profileName}, h2 a, h3 a, h4 a, [aria-posinset]`);
    if (!hasPost) return { kind: 'pending' };
    return { kind: 'post', post: extractFacebookPost(el, m) };
  },

  extraRegions(doc, ctx) {
    const m = ctx.markers;
    const out: Array<{ el: HTMLElement; module: ModuleInfo }> = [];
    // Stories tray above the feed.
    const stories = doc.querySelector<HTMLElement>('[aria-label="Stories"], [data-pagelet*="Stories"]');
    if (stories) out.push({ el: stories, module: { kind: 'stories', title: 'Stories' } });
    // "Sponsored" block in the right-hand column.
    if (m) {
      for (const rail of Array.from(doc.querySelectorAll<HTMLElement>('[role="complementary"]'))) {
        const heading = Array.from(rail.querySelectorAll('h2, h3, span')).find(
          (h) => h.childElementCount === 0 && m.sponsored.test(normalizeText(h.textContent ?? '')),
        );
        if (!heading) continue;
        let block: HTMLElement | null = heading as HTMLElement;
        while (block.parentElement && block.parentElement !== rail && block.parentElement.querySelectorAll('h2, h3').length <= 1)
          block = block.parentElement;
        if (block && block !== rail) out.push({ el: block, module: { kind: 'sponsored-rail', title: 'Sponsored' } });
      }
    }
    return out;
  },

  expanderSelector: `${FB_SEL.message} [role="button"]`,

  probe(doc, scope) {
    return {
      main: doc.querySelectorAll('[role="main"]').length,
      feeds: doc.querySelectorAll(FB_SEL.feed).length,
      lists: feedLists(doc).length,
      items: scope ? this.findItems(scope).length : 0,
      posinset: doc.querySelectorAll('[aria-posinset]').length,
      messages: doc.querySelectorAll(FB_SEL.message).length,
      profileNames: doc.querySelectorAll(FB_SEL.profileName).length,
    };
  },

  theme(doc) {
    if (doc.documentElement.classList.contains('__fb-dark-mode')) return 'dark';
    const bg = doc.defaultView?.getComputedStyle(doc.body).backgroundColor ?? '';
    const l = luminance(bg);
    return l !== undefined && l < 0.2 ? 'dark' : 'light';
  },

  markersFor(lang) {
    const primary = (lang || 'en').toLowerCase().split('-')[0] ?? 'en';
    return MARKERS[primary] ?? null;
  },
};

/** Whether the page's action-bar labels are in a language we read. */
export function facebookLocaleSelfTest(scope: HTMLElement, m: FacebookMarkers): boolean {
  return Array.from(scope.querySelectorAll('[role="button"]'))
    .slice(0, 300)
    .some((b) => m.chrome.test(normalizeText(b.getAttribute('aria-label') ?? getLines(b).join(' '))));
}
