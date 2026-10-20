import type { HealthIssue, HealthReport } from '../health.ts';

/**
 * Issues that, once they pause filtering, hold for the rest of the page load: over-filtering. Showing every post makes
 * the page far taller, the platform empties or refills slots in answer, and the next check could find the share back
 * under the limit and fold everything again, then over it and open everything, without end (Facebook, 2026-10-20,
 * live). So the page stays paused until it reloads or the person changes their settings, and its card shows at once.
 * Every other issue is checked afresh each time.
 */
export const HELD_ISSUES: readonly HealthIssue[] = ['over-filtering'];

/** What a page load holds after failing open: the held issues, and the settings they were raised under. */
export interface HealthHold {
  issues: readonly HealthIssue[];
  /** A key for the settings at the time (their JSON, say): when the person changes them, the hold ends. */
  settings: string;
}

/**
 * The issues `hold` still holds under `settings` (`HealthInput.held`): none without a hold, or once the settings
 * changed, so the next check judges the page afresh. A reload starts with no hold.
 */
export function heldIssues(hold: HealthHold | null, settings: string): HealthIssue[] {
  return hold && hold.settings === settings ? [...hold.issues] : [];
}

/**
 * The hold after a check under `settings`: what was still held, and any held issue the report raised. Null when there
 * is nothing to hold. Pure.
 */
export function holdAfter(hold: HealthHold | null, report: HealthReport, settings: string): HealthHold | null {
  const issues = heldIssues(hold, settings);
  for (const i of report.issues) if (HELD_ISSUES.includes(i) && !issues.includes(i)) issues.push(i);
  return issues.length > 0 ? { issues, settings } : null;
}
