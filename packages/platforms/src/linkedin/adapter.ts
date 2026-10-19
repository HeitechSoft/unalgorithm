import type { ModuleInfo } from '@unalgorithm/core';
import { getLines, luminance } from '../shared/dom.ts';
import type { InspectContext, InspectResult, PlatformAdapter } from '../types.ts';
import { cardOf, discoverItems, discoveryState, itemRootFor, loadMoreFor, rediscoverItems } from './discover.ts';
import { contentLines, findPostRoots, moduleInfo, readPost } from './extract.ts';
import { LINKEDIN_IDS } from './ids.ts';
import { LINKEDIN_EN, type LinkedInMarkers } from './markers/en.ts';
import { LINKEDIN_MARKERS } from './markers/index.ts';
import { classifyLinkedInRoute, linkedinHomeSignature, linkedinSignedIn } from './routes.ts';
import { POST_ROOT_SELECTOR, SEL } from './selectors.ts';
import { isInCommentsArea } from './slots.ts';

/**
 * Post-level action bars in an item, outside comments: an item with two holds two posts (a wrapper the discovery took
 * for an item), and must never be hidden as one. A reshared post inside a card shows no action bar of its own.
 */
function postBars(el: HTMLElement, m: LinkedInMarkers): number {
  const count = (selector: string) => Array.from(el.querySelectorAll(selector)).filter((b) => !isInCommentsArea(b)).length;
  return Math.max(count(m.postCommentSelector), count(m.postRepostSelector));
}

/** The page's main region, or the body when the feed sits outside one. */
function feedScope(doc: Document): HTMLElement | null {
  const main = doc.querySelector<HTMLElement>('main');
  if (main) return main;
  return doc.querySelector(`${POST_ROOT_SELECTOR}, ${SEL.feedList}`) ? doc.body : null;
}

export const linkedinAdapter: PlatformAdapter<LinkedInMarkers> = {
  id: 'linkedin',
  version: 'linkedin@2026.10.2',
  ids: LINKEDIN_IDS,

  isFeedPage(url) {
    return classifyLinkedInRoute(url) === 'feed';
  },

  classifyRoute: classifyLinkedInRoute,
  homeSignature: linkedinHomeSignature,
  signedIn: linkedinSignedIn,

  discovery: discoveryState,

  rediscover(doc) {
    const scope = feedScope(doc);
    if (scope) rediscoverItems(scope);
  },

  feedScope,

  findItems(scope) {
    return discoverItems(scope);
  },

  itemRootOf(node, scope) {
    return itemRootFor(node, scope);
  },

  inspect(el, ctx): InspectResult {
    const m = ctx.markers;
    if (!m) {
      // Unsupported UI language: we cannot read labels, so leave every item alone (fail open).
      return { kind: 'ignore' };
    }
    const card = cardOf(el);
    const lines = contentLines(card, m);
    if (!lines.length) return { kind: 'pending' }; // skeleton still loading
    // One post per item: an item holding several is never hidden as one (ADR 0009 §9).
    if (postBars(el, m) >= 2) return { kind: 'ignore', observations: ['li.item.multi-post'] };
    const module = moduleInfo(card, m);
    if (module) return { kind: 'module', module };
    const { post, observations } = readPost(card, m, ctx.now);
    return observations.length ? { kind: 'post', post, observations } : { kind: 'post', post };
  },

  siblingModules(items, ctx: InspectContext<LinkedInMarkers>) {
    const m = ctx.markers;
    if (!m || items.length < 2) return [];
    const [a, b] = items;
    let container: HTMLElement | null = a?.parentElement ?? null;
    while (container && b && !container.contains(b)) container = container.parentElement;
    if (!container) return [];
    const isItem = new Set<Element>(items);
    const out: Array<{ el: HTMLElement; module: ModuleInfo }> = [];
    for (const child of Array.from(container.children) as HTMLElement[]) {
      if (isItem.has(child) || items.some((it) => child.contains(it))) continue;
      if (child.matches(POST_ROOT_SELECTOR) || child.querySelector(POST_ROOT_SELECTOR)) continue;
      const info = moduleInfo(child, m);
      if (info) out.push({ el: child, module: info });
    }
    return out;
  },

  loadMoreMarker(scope, doc) {
    return loadMoreFor(scope, doc);
  },

  expanderSelector: SEL.expander,

  probe(doc, scope) {
    return {
      main: doc.querySelectorAll('main').length,
      feedList: doc.querySelectorAll(SEL.feedList).length,
      postRoots: scope ? findPostRoots(scope).length : 0,
      authorMenus: scope ? scope.querySelectorAll(LINKEDIN_EN.authorMenuSelector).length : 0,
      textBoxes: scope ? scope.querySelectorAll(SEL.text).length : 0,
      signedIn: linkedinSignedIn(doc) ? 1 : 0,
    };
  },

  theme(doc) {
    if (doc.documentElement.classList.contains('theme--dark')) return 'dark';
    const bg = doc.defaultView?.getComputedStyle(doc.body).backgroundColor ?? '';
    const l = luminance(bg);
    return l !== undefined && l < 0.2 ? 'dark' : 'light';
  },

  markersFor(lang) {
    const primary = (lang || 'en').toLowerCase().split('-')[0] ?? 'en';
    return Object.hasOwn(LINKEDIN_MARKERS, primary) ? (LINKEDIN_MARKERS[primary] ?? null) : null;
  },
};

/** For diagnostics: whether the page's action-bar labels are in a language we read. */
export function linkedinLocaleSelfTest(scope: HTMLElement, m: LinkedInMarkers): boolean {
  const buttons = Array.from(scope.querySelectorAll('button')).slice(0, 200);
  return buttons.some((b) => m.chrome.test(getLines(b).join(' ')) || m.chrome.test(b.getAttribute('aria-label') ?? ''));
}
