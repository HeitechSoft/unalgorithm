import { signalStrength } from './evidence.ts';
import type { ModuleInfo, PostData, PostSignals } from './post.ts';
import type { FilterDecision } from './reasons.ts';
import type { PlatformSettings } from './settings/schema.ts';

/** Signals (or 'relationship') the health monitor has stopped trusting on this page; rules using them fail open. */
export type DegradedSignals = ReadonlySet<keyof PostSignals | 'relationship'>;

const NONE: DegradedSignals = new Set();

/**
 * Key used to match an author against "always show" / "always hide": the profile path when there is one
 * ("/in/janedoe"), otherwise the lower-cased display name.
 */
export function authorKey(post: Pick<PostData, 'author'>): string | undefined {
  const { url, name } = post.author;
  if (url) {
    try {
      return new URL(url).pathname.replace(/\/+$/, '').toLowerCase() || undefined;
    } catch {
      // fall through to the name
    }
  }
  return name ? `name:${name.trim().toLowerCase()}` : undefined;
}

function matchesRule(rules: PlatformSettings['alwaysShow'], key: string | undefined): boolean {
  if (!key) return false;
  return Object.values(rules).some((r) => r.match === key);
}

/**
 * Rule-based decision (no AI, no network). Same order as the proven LinkedIn tool: an ad is decided first
 * (when ads are allowed, nothing else hides it), then suggested, network activity, reshares, groups, reels,
 * and finally "not followed", which only fires on positive evidence.
 *
 * `cautious` (ADR 0009 §9): the adapter is finding items with a fallback strategy, so an item may not be one whole
 * post. Only a signal some detector saw strongly hides, and "not followed" is off. The person's own lists still apply.
 */
export function ruleFilter(
  post: PostData,
  ps: PlatformSettings,
  degraded: DegradedSignals = NONE,
  cautious = false,
): FilterDecision | null {
  const f = ps.filters;
  const s = post.signals;
  const key = authorKey(post);
  /** The signal is on, trusted on this page, and in cautious mode seen by a strong detector. */
  const on = (signal: keyof PostSignals) =>
    s[signal] && !degraded.has(signal) && (!cautious || signalStrength(post.evidence, signal) === 'strong');
  if (matchesRule(ps.alwaysHide, key)) return { reason: 'always-hide', source: 'user' };
  if (on('sponsored')) return f.sponsored ? { reason: 'sponsored', source: 'rule' } : null;
  if (matchesRule(ps.alwaysShow, key)) return null;
  if (on('suggested') && f.suggested) return { reason: 'suggested', source: 'rule' };
  if (on('networkActivity') && f.networkActivity && (post.author.relationship !== 'followed' || degraded.has('relationship'))) {
    return { reason: 'network-activity', source: 'rule' };
  }
  if (on('reshare') && f.reshares) return { reason: 'reshare', source: 'rule' };
  if (on('unjoinedGroup') && f.unjoinedGroups) return { reason: 'unjoined-group', source: 'rule' };
  if (on('reel') && f.reels) return { reason: 'reel', source: 'rule' };
  if (f.notFollowed && !cautious && post.author.relationship === 'not-followed' && !degraded.has('relationship')) {
    return { reason: 'not-followed', source: 'rule' };
  }
  return null;
}

/** Feed panels (People You May Know, Reels trays, jobs) are hidden by the single "feed panels" switch. */
export function moduleFilter(module: ModuleInfo, ps: PlatformSettings): FilterDecision | null {
  if (module.kind === 'sponsored-rail') return ps.filters.sponsored ? { reason: 'sponsored', source: 'rule', module } : null;
  return ps.filters.modules ? { reason: 'module', source: 'rule', module } : null;
}
