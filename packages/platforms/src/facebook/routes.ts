import { accessibleName } from '../shared/dom.ts';
import type { HomeSignature, RouteClass } from '../types.ts';
import { hasFeedList } from './discover.ts';
import { FACEBOOK_HOSTS, FB_ORIGIN } from './selectors.ts';

/** Where Facebook might move the home feed: `/home`, `/feed` or `/feeds`, alone or with one more word. */
const CANDIDATE_PARENTS: ReadonlySet<string> = new Set(['home', 'feed', 'feeds']);
const CANDIDATE_WORD = /^[a-z_]{1,24}$/;

/**
 * The route class of a Facebook address (ADR 0009 §3). The feed is `/` and `/home.php`, whatever the query
 * (`?sk=h_chr` is "Most recent"). A candidate may be the feed at a new address: the controller starts there only on a
 * strong home signature, and otherwise the watchdog watches. Usernames, groups, pages, Watch and Marketplace never
 * qualify. Only Facebook's own hosts count, so `evilfacebook.com` is not Facebook.
 */
export function classifyFacebookRoute(url: URL): RouteClass {
  if (!FACEBOOK_HOSTS.has(url.hostname)) return 'not-feed';
  if (url.pathname === '/' || url.pathname === '/home.php') return 'feed';
  const segments = url.pathname.split('/').filter(Boolean);
  const [parent, word] = segments as [string, string | undefined];
  if (segments.length > 2 || !CANDIDATE_PARENTS.has(parent)) return 'not-feed';
  return word === undefined || CANDIDATE_WORD.test(word) ? 'feed-candidate' : 'not-feed';
}

/** "Home" in English: the name of the home tab when its link doesn't point at `/`. */
const HOME_NAME = /^home$/i;

/** Links to the home feed marked as the current page: Facebook's Home tab while the feed is showing. */
export function currentHomeLinks(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('a[aria-current="page"]')).filter((a) => {
    try {
      const u = new URL(a.getAttribute('href') ?? '', FB_ORIGIN);
      if (FACEBOOK_HOSTS.has(u.hostname) && (u.pathname === '/' || u.pathname === '/home.php')) return true;
    } catch {
      // Not a link we can read; its name may still say Home.
    }
    return HOME_NAME.test(accessibleName(a));
  });
}

/**
 * Whether the page is Facebook's home feed by its structure: `strong` with the Home tab marked current and the feed
 * list present, `weak` with the feed list alone. A candidate route starts the controller only on `strong`.
 */
export function facebookHomeSignature(doc: Document): HomeSignature {
  if (!hasFeedList(doc)) return null;
  return currentHomeLinks(doc).length ? 'strong' : 'weak';
}

/** Sections of the app that only the signed-in navigation links to, by the first word of the address. */
const SIGNED_IN_SECTIONS: ReadonlySet<string> = new Set([
  'friends',
  'watch',
  'video',
  'marketplace',
  'groups',
  'gaming',
  'bookmarks',
  'notifications',
  'messages',
  'reel',
  'reels',
]);

/**
 * A signed-in page shell: the top bar's navigation (or the left column's) links to at least two sections of the app,
 * and the page asks for no password. The logged-out page, its cookie wall and checkpoints ask for a password or show
 * only a logo, so a missing feed there is never reported as breakage. Addresses only, so it works in any language.
 */
export function facebookSignedIn(doc: Document): boolean {
  if (doc.querySelector('input[type="password"], form[action*="/login"]')) return false;
  const sections = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll('[role="banner"] a[href], [role="navigation"] a[href]'))) {
    try {
      const u = new URL(a.getAttribute('href') ?? '', FB_ORIGIN);
      const first = u.pathname.split('/').filter(Boolean)[0];
      if (FACEBOOK_HOSTS.has(u.hostname) && first && SIGNED_IN_SECTIONS.has(first)) sections.add(first);
    } catch {
      // Not a link we can read.
    }
    if (sections.size >= 2) return true;
  }
  return false;
}
