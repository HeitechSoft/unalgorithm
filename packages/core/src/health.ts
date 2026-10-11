import type { PostSignals } from './post.ts';
import type { PresetOrCustom } from './settings/schema.ts';

export type HealthIssue =
  | 'no-feed'
  | 'no-items'
  | 'author-detection'
  | 'text-detection'
  | 'stuck-skeletons'
  | 'module-overmatch'
  | 'sponsored-overmatch'
  | 'over-filtering'
  | 'unsupported-locale';

export interface HealthSample {
  kind: 'post' | 'module' | 'pending';
  authorFound: boolean;
  textFound: boolean;
  sponsored: boolean;
  /** Would be hidden by the current settings. */
  hidden: boolean;
  /** How long ago the item was first seen. */
  ageMs: number;
}

export interface HealthReport {
  /** ok, degraded (some rules switched off), broken (stop hiding on this page), unsupported-locale. */
  status: 'ok' | 'degraded' | 'broken' | 'unsupported-locale';
  issues: HealthIssue[];
  /** Signals the rules should stop trusting on this page (fail open). */
  degraded: (keyof PostSignals | 'relationship')[];
}

export const HEALTHY: HealthReport = { status: 'ok', issues: [], degraded: [] };

/** Share of items that may be hidden before we suspect detection is wrong and stop hiding. */
const OVER_FILTER_LIMIT: Record<PresetOrCustom, number> = { light: 0.5, balanced: 0.8, calm: 0.95, custom: 0.9 };

/**
 * Decide whether detection on this page can be trusted, from a rolling window of recent items. When in doubt we
 * show posts: hiding a friend's post by mistake costs far more trust than showing an ad.
 */
export function evaluateHealth(input: {
  feedFound: boolean;
  elapsedMs: number;
  samples: readonly HealthSample[];
  localeSupported: boolean;
  preset: PresetOrCustom;
}): HealthReport {
  const issues: HealthIssue[] = [];
  const degraded = new Set<keyof PostSignals | 'relationship'>();
  if (!input.localeSupported) return { status: 'unsupported-locale', issues: ['unsupported-locale'], degraded: [] };
  if (!input.feedFound) {
    return input.elapsedMs >= 10_000 ? { status: 'broken', issues: ['no-feed'], degraded: [] } : HEALTHY;
  }
  if (input.samples.length === 0) {
    return input.elapsedMs >= 10_000 ? { status: 'broken', issues: ['no-items'], degraded: [] } : HEALTHY;
  }
  const posts = input.samples.filter((s) => s.kind === 'post');
  const stuck = input.samples.filter((s) => s.kind === 'pending' && s.ageMs >= 15_000).length;
  if (stuck / input.samples.length > 0.3) issues.push('stuck-skeletons');
  if (posts.length >= 10) {
    if (posts.filter((p) => !p.authorFound).length / posts.length > 0.5) {
      issues.push('author-detection');
      degraded.add('relationship');
    }
    if (posts.filter((p) => !p.textFound).length / posts.length > 0.6) issues.push('text-detection');
    if (posts.filter((p) => p.sponsored).length / posts.length > 0.4) {
      issues.push('sponsored-overmatch');
      degraded.add('sponsored');
    }
  }
  const judged = input.samples.filter((s) => s.kind !== 'pending');
  if (judged.length >= 10 && judged.filter((s) => s.kind === 'module').length / judged.length > 0.5) {
    issues.push('module-overmatch');
  }
  if (judged.length >= 20 && judged.filter((s) => s.hidden).length / judged.length > OVER_FILTER_LIMIT[input.preset]) {
    issues.push('over-filtering');
  }
  const broken = issues.some((i) => i === 'over-filtering' || i === 'module-overmatch' || i === 'text-detection');
  return { status: broken ? 'broken' : issues.length ? 'degraded' : 'ok', issues, degraded: [...degraded] };
}
