import type { Evidence } from './post.ts';

/** How sure a detector is (ADR 0002): a strong one hides on its own, weaker ones only together. */
export type Strength = 'strong' | 'medium' | 'weak';

const RANK: Record<Strength, number> = { weak: 1, medium: 2, strong: 3 };

/**
 * How strongly the evidence shows `signal`, combining every detector that saw it: one strong detector is strong; two
 * medium ones, or a medium and a weak one, are medium; anything less is weak; none is null. The one rule both adapters
 * use, so a signal hides (`atLeast(s, 'medium')`) under the same conditions on every platform.
 */
export function signalStrength(evidence: readonly Evidence[], signal: Evidence['signal']): Strength | null {
  let strong = 0;
  let medium = 0;
  let weak = 0;
  for (const e of evidence) {
    if (e.signal !== signal) continue;
    if (e.strength === 'strong') strong++;
    else if (e.strength === 'medium') medium++;
    else weak++;
  }
  if (strong >= 1) return 'strong';
  if (medium >= 2 || (medium >= 1 && weak >= 1)) return 'medium';
  return medium + weak > 0 ? 'weak' : null;
}

/** True when `s` is at least `min`; no evidence never is. */
export function atLeast(s: Strength | null, min: Strength): boolean {
  return s !== null && RANK[s] >= RANK[min];
}
