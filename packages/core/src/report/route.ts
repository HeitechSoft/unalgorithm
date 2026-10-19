import { FEED_WORD_DENY, FEED_WORD_PATTERN } from '@unalgorithm/protocol';

/** Where a feed's new address can start on LinkedIn and Facebook today (ADR 0009 §3's candidate routes). */
export const FEED_WORD_PREFIXES: readonly string[] = Object.freeze(['/feed/', '/feeds/', '/home/']);

export interface RouteWordRules {
  /** Path prefixes a word may follow (default FEED_WORD_PREFIXES); the prefix's own word counts too (`/home/` is `home`). */
  prefixes?: readonly string[];
  /** Words that never count (LinkedIn's `update`, `hashtag`...). The wire's own deny list always applies too. */
  deny?: readonly string[];
}

/**
 * The one word of a feed address unAlgorithm doesn't know yet, `foryou` in `/feed/foryou/`, or undefined. Only the
 * path is read (never the query or fragment): a prefix, then at most one more segment. The word must fit the report's
 * `FEED_WORD_PATTERN` and not be denied, so a profile, post or hashtag address never yields one. Adapters use it to
 * class candidate routes; report drafts use it for `page.feedWord`.
 */
export function routeWord(url: URL | string, rules: RouteWordRules = {}): string | undefined {
  let path: string;
  try {
    path = (typeof url === 'string' ? new URL(url) : url).pathname;
  } catch {
    return undefined;
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > 2) return undefined;
  const [parent, child] = segments as [string, string | undefined];
  const parents = (rules.prefixes ?? FEED_WORD_PREFIXES).map((p) => p.replace(/^\/+|\/+$/g, ''));
  if (!parents.includes(parent)) return undefined;
  const word = child ?? parent;
  if (!FEED_WORD_PATTERN.test(word) || FEED_WORD_DENY.includes(word) || rules.deny?.includes(word)) return undefined;
  return word;
}
