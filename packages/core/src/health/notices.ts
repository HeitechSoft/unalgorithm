import { NOTICE_KINDS, type NoticeKind, type PlatformId } from '@unalgorithm/protocol';
import type { HealthIssue, HealthReport } from '../health.ts';
import { type NoticePrefs, type NoticeSnoozeKey, noticeSnoozeKey } from '../settings/schema.ts';

/** *Not now* (and ✕, and Escape) puts a card away for this long, on this platform. */
export const NOT_NOW_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** A report sent from any surface puts the card away for this long: we already know. */
export const REPORT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Issues that pause filtering and raise the `paused` card: positive evidence that detection reads the page wrongly.
 * Absence-based issues (no feed, no items, no ads seen, stuck skeletons, items not growing) never raise a card.
 */
const PAUSED_BY: readonly HealthIssue[] = ['adapter-error', 'over-filtering', 'module-overmatch', 'text-detection'];

/** The issues behind each card. */
function raisedBy(kind: NoticeKind, status: HealthReport['status']): readonly HealthIssue[] {
  switch (kind) {
    case 'not-running':
      return ['feed-not-started'];
    case 'paused':
      return status === 'broken' ? PAUSED_BY : [];
    case 'ads-through':
      return ['ad-label-near-miss'];
  }
}

/** Every card these issues raise, in priority order (`NOTICE_KINDS`: not running, paused, ads getting through). */
export function noticeKinds(issues: readonly string[], status: HealthReport['status']): NoticeKind[] {
  return NOTICE_KINDS.filter((kind) => raisedBy(kind, status).some((i) => issues.includes(i)));
}

/** The one card these issues raise, if any: the first in priority order. */
export function noticeFor(issues: readonly string[], status: HealthReport['status']): NoticeKind | undefined {
  return noticeKinds(issues, status)[0];
}

/** The issues that raised `kind`, for the popup's banner and the report (`TabState.notice.issues`). */
export function noticeIssues(kind: NoticeKind, issues: readonly string[]): HealthIssue[] {
  const by = raisedBy(kind, 'broken');
  return by.filter((i) => issues.includes(i));
}

export interface NoticeVisibleInput {
  kind: NoticeKind;
  platform: PlatformId;
  /** The adapter version now: a snooze set under another version has ended. */
  adapter: string;
  now: number;
  prefs: NoticePrefs;
  /** Cards this page load already showed and put away: each kind shows at most once per load. */
  shownThisLoad: ReadonlySet<NoticeKind> | readonly NoticeKind[];
  /** The coach mark is up: one thing at a time. */
  coachMark?: boolean;
  /** The site is paused or switched off. */
  paused?: boolean;
}

/**
 * Whether the in-feed card for `kind` may show now (ADR 0009 §3): the person hasn't turned the notices off, the site
 * isn't paused, the coach mark isn't up, the card hasn't been shown on this page load, and no snooze for this platform
 * and kind is running under this adapter version. The popup and side panel show the notice whatever this says.
 */
export function noticeVisible(input: NoticeVisibleInput): boolean {
  if (!input.prefs.enabled || input.paused || input.coachMark) return false;
  const shown = input.shownThisLoad;
  if (Array.isArray(shown) ? shown.includes(input.kind) : (shown as ReadonlySet<NoticeKind>).has(input.kind)) return false;
  return !snoozed(input.prefs, noticeSnoozeKey(input.platform, input.kind), input.adapter, input.now);
}

/** A snooze for `key` is running: set under this adapter version and not yet over. */
export function snoozed(prefs: NoticePrefs, key: NoticeSnoozeKey, adapter: string, now: number): boolean {
  const s = prefs.snoozed[key];
  return !!s && s.adapter === adapter && s.until > now;
}

/**
 * `prefs` with `key` snoozed for `ms` under `adapter` (24 hours after *Not now*, 7 days after a sent report). A longer
 * snooze already running under the same version is kept; one set under another version is replaced, since a new
 * version may have fixed the problem. Snoozes that have ended are dropped. Pure.
 */
export function snooze(prefs: NoticePrefs, key: NoticeSnoozeKey, ms: number, adapter: string, now = Date.now()): NoticePrefs {
  const kept: NoticePrefs['snoozed'] = {};
  for (const [k, s] of Object.entries(prefs.snoozed)) if (s.until > now) kept[k] = s;
  const current = kept[key];
  const until = now + Math.max(0, ms);
  kept[key] = current && current.adapter === adapter && current.until > until ? current : { until, adapter };
  return { ...prefs, snoozed: kept };
}
