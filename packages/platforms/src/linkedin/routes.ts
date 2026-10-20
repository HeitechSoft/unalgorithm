import { routeWord } from '@unalgorithm/core';
import type { HomeSignature, RouteClass } from '../types.ts';
import { findPostRoots } from './extract.ts';
import { MAIN_FEED_KEY, SEL } from './selectors.ts';

/**
 * Where LinkedIn's home feed lives, and how to tell when it moves (ADR 0009 §3). In 2026-10 LinkedIn sent some
 * accounts from /feed/ to /feed/foryou/: unAlgorithm didn't know the address, so it never started and nothing
 * noticed. A move like that is now a candidate route: unAlgorithm starts there when the page is clearly the home feed,
 * and says so in the next report.
 */

const HOST = /(^|\.)linkedin\.com$/;
/** Relative links on LinkedIn's pages lead to LinkedIn. */
const ORIGIN = 'https://www.linkedin.com';
/** The home feed: /feed/, and /feed/foryou/, where some accounts are sent from /feed/ (a 2026 LinkedIn experiment). */
const FEED_PATH = /^\/feed(?:\/foryou)?\/?$/;
/** A candidate route's words that are never the home feed: a post, a hashtag, people lists, saved items, news. */
export const LINKEDIN_NOT_FEED_WORDS: readonly string[] = Object.freeze([
  'update',
  'hashtag',
  'following',
  'followers',
  'saved',
  'news',
]);
const CANDIDATE_PREFIXES: readonly string[] = Object.freeze(['/feed/', '/home/']);

/**
 * `feed` for /feed/ and /feed/foryou/; `feed-candidate` for /, /feed/<word>/, /home/ and /home/<word>/ (a new
 * address the feed may have moved to); `not-feed` for everything else, so the controller never starts on a single
 * post (/feed/update/…), a hashtag, "Manage follows" (/feed/following/), a profile or a company page.
 */
export function classifyLinkedInRoute(url: URL): RouteClass {
  if (!HOST.test(url.hostname)) return 'not-feed';
  if (FEED_PATH.test(url.pathname)) return 'feed';
  if (url.pathname === '/') return 'feed-candidate';
  return routeWord(url, { prefixes: CANDIDATE_PREFIXES, deny: LINKEDIN_NOT_FEED_WORDS }) ? 'feed-candidate' : 'not-feed';
}

/**
 * Whether the page is LinkedIn's home feed by its structure, for a candidate route. `strong`: the main feed list
 * (`data-testid="mainFeed"`), or a card keyed for the main feed (`…FeedType_MAIN_FEED_RELEVANCE`), which only the
 * home feed has. `weak`: a main list of at least 3 posts, as a profile's activity page also has. Read-only.
 */
export function linkedinHomeSignature(doc: Document): HomeSignature {
  if (doc.querySelector(SEL.feedList)) return 'strong';
  for (const el of Array.from(doc.querySelectorAll('[componentkey*="FeedType_MAIN_FEED_"]'))) {
    if (MAIN_FEED_KEY.test(el.getAttribute('componentkey') ?? '')) return 'strong';
  }
  const main = doc.querySelector('main');
  return main && findPostRoots(main).length >= 3 ? 'weak' : null;
}

/** Sections only a signed-in member's navigation links to; the guest pages, sign-in and checkpoints have none. */
const MEMBER_SECTIONS = ['/mynetwork/', '/messaging/', '/notifications/'];
const MEMBER_LINKS = MEMBER_SECTIONS.map((p) => `a[href*="${p.slice(0, -1)}"]`).join(', ');

/**
 * LinkedIn's signed-in shell is on the page: its global navigation, found by where its links go rather than by their
 * words (any language) or class names (hashed). At least two of My Network, Messaging and Notifications, outside the
 * feed, so a missing feed on a sign-in page, a checkpoint or a consent wall never reads as breakage. Read-only.
 */
export function linkedinIsSignedIn(doc: Document): boolean {
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll<HTMLAnchorElement>(MEMBER_LINKS))) {
    if (a.closest('main')) continue;
    let path: string;
    try {
      const u = new URL(a.getAttribute('href') ?? '', ORIGIN);
      if (!HOST.test(u.hostname)) continue;
      path = u.pathname;
    } catch {
      continue;
    }
    const section = MEMBER_SECTIONS.find((p) => path.startsWith(p) || `${path}/` === p);
    if (section) seen.add(section);
    if (seen.size >= 2) return true;
  }
  return false;
}
