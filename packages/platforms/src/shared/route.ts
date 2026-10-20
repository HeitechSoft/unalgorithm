import { routeWord } from '@unalgorithm/core';
import type { ReportRoute } from '@unalgorithm/protocol';
import type { PlatformAdapter, RouteClass } from '../types.ts';

/** The candidate-route word helper; it lives in core so the popup's report draft can use it without an adapter. */
export { FEED_WORD_PREFIXES, type RouteWordRules, routeWord } from '@unalgorithm/core';

/**
 * The address's route class (ADR 0009 §3): the adapter's `classifyRoute`, or `isFeedPage` for an adapter without it.
 * An adapter that throws classes the address as not the feed, so nothing starts on a page it can't read (fail open).
 */
export function routeOf(adapter: Pick<PlatformAdapter, 'classifyRoute' | 'isFeedPage'>, url: URL): RouteClass {
  try {
    if (adapter.classifyRoute) return adapter.classifyRoute(url);
    return adapter.isFeedPage(url) ? 'feed' : 'not-feed';
  } catch {
    return 'not-feed';
  }
}

/**
 * What a report says about the address: its route class in the wire's words (`other` for not the feed) and, on a
 * candidate route, the new address's word (`foryou`). Never the address itself.
 */
export function reportRouteOf(
  adapter: Pick<PlatformAdapter, 'classifyRoute' | 'isFeedPage'>,
  url: URL,
): { route: Exclude<ReportRoute, 'unknown'>; feedWord?: string } {
  const route = routeOf(adapter, url);
  if (route === 'not-feed') return { route: 'other' };
  if (route === 'feed') return { route };
  const feedWord = routeWord(url);
  return feedWord ? { route, feedWord } : { route };
}
