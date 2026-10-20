import type { ModuleInfo } from '@unalgorithm/core';
import { getLines, luminance, normalizeText } from '../shared/dom.ts';
import { matchLabel } from '../shared/labels.ts';
import type { InspectResult, PlatformAdapter } from '../types.ts';
import { discover, discoveryState, itemLists, knownLists } from './discover.ts';
import { FB_SEL, moduleOf, readFacebookPost } from './extract.ts';
import { FACEBOOK_IDS, type FacebookLandmark, type FacebookObservation } from './ids.ts';
import { FACEBOOK_EN, type FacebookMarkers } from './markers/en.ts';
import { classifyFacebookRoute, currentHomeLinks, facebookHomeSignature, facebookSignedIn } from './routes.ts';
import { actionBars } from './slots.ts';

const MARKERS: Record<string, FacebookMarkers> = { en: FACEBOOK_EN };

/**
 * Items that inspected as posts. When Facebook empties one of these slots after it scrolls away, it is offscreen, not
 * a skeleton still loading. A WeakSet, so a removed item is forgotten with it.
 */
const seenPosts = new WeakSet<Element>();

/**
 * Facebook's home feed: one list inside `[role="main"]` with a direct child per feed item (posts and panels alike).
 * Until 2026 the list was `[role="feed"]`; the 2026 layout drops the role and puts the list right after a
 * screen-reader "Feed posts" heading, every post marked `[aria-posinset]`, items far from the viewport emptied
 * (virtualized) until they scroll back. Class names are generated, so everything here keys on roles, aria
 * attributes, data-ad-* hooks and links, never on English heading text. When those change, discovery (discover.ts)
 * finds the list by its repeated post markers or by each post's own parts instead.
 */
export const facebookAdapter: PlatformAdapter<FacebookMarkers> = {
  id: 'facebook',
  version: 'facebook@2026.10.5',
  ids: FACEBOOK_IDS,

  isFeedPage(url) {
    return classifyFacebookRoute(url) === 'feed';
  },

  classifyRoute: classifyFacebookRoute,
  homeSignature: facebookHomeSignature,
  signedIn: facebookSignedIn,

  discovery: discoveryState,

  rediscover(doc) {
    discover(doc);
  },

  feedScope(doc) {
    const lists = itemLists(doc);
    if (!lists.length) return null;
    const main = doc.querySelector<HTMLElement>('[role="main"]');
    return main && lists.every((list) => main.contains(list)) ? main : doc.body;
  },

  findItems(scope) {
    const items: HTMLElement[] = [];
    for (const list of itemLists(scope.ownerDocument)) {
      if (!scope.contains(list)) continue;
      for (const child of Array.from(list.children) as HTMLElement[]) {
        if (child.tagName === 'UNALGO-POST') continue;
        items.push(child);
      }
    }
    return items;
  },

  itemRootOf(node, scope) {
    const lists = knownLists();
    let el: Element | null = node instanceof Element ? node : node.parentElement;
    while (el && el !== scope) {
      const parent: HTMLElement | null = el.parentElement;
      if (parent && lists.has(parent)) return el as HTMLElement;
      el = parent;
    }
    return null;
  },

  inspect(el, ctx): InspectResult {
    const m = ctx.markers;
    if (!m) return { kind: 'ignore' };
    // Emptied or virtualised after it scrolled away: keep its decision, leave it out of health.
    if (el.matches(FB_SEL.virtualized) || el.querySelector(FB_SEL.virtualized)) return { kind: 'pending', offscreen: true };
    const text = normalizeText(el.textContent ?? '');
    if (text.length < 3) return seenPosts.has(el) ? { kind: 'pending', offscreen: true } : { kind: 'pending' };
    // One post per item: an item with several posts' action bars is a wrapper we misread, and never hides.
    const bars = actionBars(el, m.like);
    const barObservations: FacebookObservation[] = bars.locator === 'aria' ? ['fb.slot.action-bar.aria'] : [];
    if (bars.count >= 2) return { kind: 'ignore', observations: ['fb.item.multi-post', ...barObservations] };
    const module = moduleOf(el, m);
    if (module) return { kind: 'module', module };
    const hasPost = !!el.querySelector(`${FB_SEL.message}, ${FB_SEL.profileName}, h2 a, h3 a, h4 a, [aria-posinset]`);
    if (!hasPost) return { kind: 'pending' };
    const { post, observations } = readFacebookPost(el, m);
    seenPosts.add(el);
    const all = [...observations, ...barObservations];
    return all.length ? { kind: 'post', post, observations: all } : { kind: 'post', post };
  },

  extraRegions(doc, ctx) {
    const m = ctx.markers;
    const out: Array<{ el: HTMLElement; module: ModuleInfo }> = [];
    // Stories tray above the feed.
    const stories = doc.querySelector<HTMLElement>('[aria-label="Stories"], [data-pagelet*="Stories"]');
    if (stories) out.push({ el: stories, module: { kind: 'stories', title: 'Stories' } });
    // "Sponsored" block in the right-hand column: its heading is the label itself, never a near miss.
    if (m) {
      for (const rail of Array.from(doc.querySelectorAll<HTMLElement>('[role="complementary"]'))) {
        const heading = Array.from(rail.querySelectorAll('h2, h3, span')).find((h) => {
          if (h.childElementCount !== 0) return false;
          const hit = matchLabel(normalizeText(h.textContent ?? ''), m.labels.sponsored);
          return !!hit && hit.match !== 'near';
        });
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
    const counts: Record<FacebookLandmark, number> = {
      main: doc.querySelectorAll('[role="main"]').length,
      feeds: doc.querySelectorAll(FB_SEL.feed).length,
      lists: itemLists(doc).length,
      items: scope ? this.findItems(scope).length : 0,
      posinset: doc.querySelectorAll(FB_SEL.post).length,
      messages: doc.querySelectorAll(FB_SEL.message).length,
      profileNames: doc.querySelectorAll(FB_SEL.profileName).length,
      homeNav: currentHomeLinks(doc).length,
      signedIn: facebookSignedIn(doc) ? 1 : 0,
    };
    return counts;
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
