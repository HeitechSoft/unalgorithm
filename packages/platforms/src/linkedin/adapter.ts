import type { ModuleInfo } from '@unalgorithm/core';
import { getLines, luminance } from '../shared/dom.ts';
import type { InspectContext, InspectResult, PlatformAdapter } from '../types.ts';
import { contentLines, extractPost, findPostRoots, moduleInfo } from './extract.ts';
import { LINKEDIN_EN, type LinkedInMarkers } from './markers/en.ts';
import { POST_ROOT_SELECTOR, SEL } from './selectors.ts';

const MARKERS: Record<string, LinkedInMarkers> = { en: LINKEDIN_EN };

export const linkedinAdapter: PlatformAdapter<LinkedInMarkers> = {
  id: 'linkedin',
  version: 'linkedin@2026.10.1',

  isFeedPage(url) {
    return url.hostname.endsWith('linkedin.com') && /^\/feed\/?$/.test(url.pathname);
  },

  feedScope(doc) {
    const main = doc.querySelector<HTMLElement>('main');
    if (main) return main;
    return doc.querySelector(POST_ROOT_SELECTOR) ? doc.body : null;
  },

  findItems(scope) {
    return findPostRoots(scope);
  },

  itemRootOf(node, scope) {
    const el = node instanceof Element ? node : node.parentElement;
    const root = el?.closest<HTMLElement>(POST_ROOT_SELECTOR);
    if (!root || !scope.contains(root)) return null;
    // Outermost: a reshared inner post belongs to its outer card.
    const outer = root.parentElement?.closest<HTMLElement>(POST_ROOT_SELECTOR);
    return outer && scope.contains(outer) ? outer : root;
  },

  inspect(el, ctx): InspectResult {
    const m = ctx.markers;
    if (!m) {
      // Unsupported UI language: we cannot read labels, so leave every item alone (fail open).
      return { kind: 'ignore' };
    }
    const lines = contentLines(el, m);
    if (!lines.length) return { kind: 'pending' }; // skeleton still loading
    const module = moduleInfo(el, m);
    if (module) return { kind: 'module', module };
    return { kind: 'post', post: extractPost(el, m, ctx.now) };
  },

  siblingModules(items, ctx: InspectContext<LinkedInMarkers>) {
    const m = ctx.markers;
    if (!m || items.length < 2) return [];
    const [a, b] = items;
    let container: HTMLElement | null = a?.parentElement ?? null;
    while (container && b && !container.contains(b)) container = container.parentElement;
    if (!container) return [];
    const out: Array<{ el: HTMLElement; module: ModuleInfo }> = [];
    for (const child of Array.from(container.children) as HTMLElement[]) {
      if (child.matches(POST_ROOT_SELECTOR) || child.querySelector(POST_ROOT_SELECTOR)) continue;
      const info = moduleInfo(child, m);
      if (info) out.push({ el: child, module: info });
    }
    return out;
  },

  loadMoreMarker(_scope, doc) {
    const marker = doc.querySelector(SEL.feedList)?.lastElementChild as HTMLElement | null | undefined;
    return marker && marker.childElementCount === 0 ? marker : null;
  },

  expanderSelector: SEL.expander,

  probe(doc, scope) {
    return {
      main: doc.querySelectorAll('main').length,
      feedList: doc.querySelectorAll(SEL.feedList).length,
      postRoots: scope ? findPostRoots(scope).length : 0,
      authorMenus: scope ? scope.querySelectorAll(LINKEDIN_EN.authorMenuSelector).length : 0,
      textBoxes: scope ? scope.querySelectorAll(SEL.text).length : 0,
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
    return MARKERS[primary] ?? null;
  },
};

/** For diagnostics: whether the page's action-bar labels are in a language we read. */
export function linkedinLocaleSelfTest(scope: HTMLElement, m: LinkedInMarkers): boolean {
  const buttons = Array.from(scope.querySelectorAll('button')).slice(0, 200);
  return buttons.some((b) => m.chrome.test(getLines(b).join(' ')) || m.chrome.test(b.getAttribute('aria-label') ?? ''));
}
