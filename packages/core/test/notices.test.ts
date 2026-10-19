/**
 * The in-feed notice card's rules (ADR 0009 §3): when a card may show, and the snoozes *Not now* and a sent report set
 * in device settings.
 */
import type { NoticeKind } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  defaultDevice,
  NOT_NOW_SNOOZE_MS,
  type NoticePrefs,
  NoticePrefsSchema,
  type NoticeVisibleInput,
  noticeIssues,
  noticeSnoozeKey,
  noticeVisible,
  REPORT_SNOOZE_MS,
  snooze,
  snoozed,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 19, 12);
const ADAPTER = 'linkedin@2026.10.2';
const KEY = noticeSnoozeKey('linkedin', 'ads-through');

const prefs = (over: Partial<NoticePrefs> = {}): NoticePrefs => ({ ...defaultDevice('d').notices, ...over });

function visible(over: Partial<NoticeVisibleInput> = {}): boolean {
  return noticeVisible({
    kind: 'ads-through',
    platform: 'linkedin',
    adapter: ADAPTER,
    now: NOW,
    prefs: prefs(),
    shownThisLoad: new Set<NoticeKind>(),
    ...over,
  });
}

describe('noticeVisible', () => {
  it('test_notice_shows_by_default', () => {
    expect(defaultDevice('d').notices).toStrictEqual({ enabled: true, snoozed: {} });
    expect(visible()).toBe(true);
  });

  it('test_notice_hidden_by_the_settings_switch_pause_and_coach_mark', () => {
    expect(visible({ prefs: prefs({ enabled: false }) })).toBe(false);
    expect(visible({ paused: true })).toBe(false);
    expect(visible({ coachMark: true })).toBe(false);
    expect(visible({ paused: false, coachMark: false })).toBe(true);
  });

  it('test_notice_shows_once_per_page_load', () => {
    expect(visible({ shownThisLoad: new Set<NoticeKind>(['ads-through']) })).toBe(false);
    expect(visible({ shownThisLoad: ['ads-through'] })).toBe(false);
    // Another kind that was shown doesn't hold this one back.
    expect(visible({ shownThisLoad: ['paused'] })).toBe(true);
  });

  it('test_notice_snoozes_by_platform_kind_and_adapter_version', () => {
    const running = prefs({ snoozed: { [KEY]: { until: NOW + 1, adapter: ADAPTER } } });
    expect(visible({ prefs: running })).toBe(false);
    // Over at `until`.
    expect(visible({ prefs: running, now: NOW + 1 })).toBe(true);
    // A new detection version may have fixed it: the snooze ends early.
    expect(visible({ prefs: running, adapter: 'linkedin@2026.11.0' })).toBe(true);
    // Per platform and per kind.
    expect(visible({ prefs: running, platform: 'facebook', adapter: 'facebook@2026.10.2' })).toBe(true);
    expect(visible({ prefs: running, kind: 'paused' })).toBe(true);
  });
});

describe('snooze', () => {
  it('test_not_now_snoozes_for_a_day', () => {
    const next = snooze(prefs(), KEY, NOT_NOW_SNOOZE_MS, ADAPTER, NOW);
    expect(next.snoozed[KEY]).toStrictEqual({ until: NOW + 24 * 3_600_000, adapter: ADAPTER });
    expect(snoozed(next, KEY, ADAPTER, NOW + 24 * 3_600_000 - 1)).toBe(true);
    expect(snoozed(next, KEY, ADAPTER, NOW + 24 * 3_600_000)).toBe(false);
    expect(NoticePrefsSchema.safeParse(next).success).toBe(true);
  });

  it('test_a_sent_report_snoozes_for_a_week', () => {
    const next = snooze(prefs(), KEY, REPORT_SNOOZE_MS, ADAPTER, NOW);
    expect(next.snoozed[KEY]?.until).toBe(NOW + 7 * 24 * 3_600_000);
  });

  it('test_snooze_keeps_a_longer_one_under_the_same_version', () => {
    const week = snooze(prefs(), KEY, REPORT_SNOOZE_MS, ADAPTER, NOW);
    const after = snooze(week, KEY, NOT_NOW_SNOOZE_MS, ADAPTER, NOW + 1000);
    expect(after.snoozed[KEY]).toStrictEqual(week.snoozed[KEY]);
    // Under a new version the old week no longer counts: the new snooze replaces it.
    const v2 = snooze(week, KEY, NOT_NOW_SNOOZE_MS, 'linkedin@2026.11.0', NOW + 1000);
    expect(v2.snoozed[KEY]).toStrictEqual({ until: NOW + 1000 + NOT_NOW_SNOOZE_MS, adapter: 'linkedin@2026.11.0' });
  });

  it('test_snooze_drops_ended_ones_and_is_pure', () => {
    const other = noticeSnoozeKey('facebook', 'paused');
    const ended = noticeSnoozeKey('linkedin', 'paused');
    const before = prefs({
      snoozed: { [other]: { until: NOW + 5, adapter: 'facebook@1' }, [ended]: { until: NOW - 1, adapter: ADAPTER } },
    });
    const copy = structuredClone(before);
    const next = snooze(before, KEY, NOT_NOW_SNOOZE_MS, ADAPTER, NOW);
    expect(Object.keys(next.snoozed).sort()).toEqual([other, KEY].sort());
    expect(before).toStrictEqual(copy);
    expect(next.enabled).toBe(true);
    // A negative length can't snooze into the past or the future.
    expect(snooze(prefs(), KEY, -5, ADAPTER, NOW).snoozed[KEY]?.until).toBe(NOW);
  });

  it('test_a_snooze_round_trip_hides_then_shows', () => {
    const next = snooze(prefs(), KEY, NOT_NOW_SNOOZE_MS, ADAPTER, NOW);
    expect(visible({ prefs: next })).toBe(false);
    expect(visible({ prefs: next, now: NOW + NOT_NOW_SNOOZE_MS })).toBe(true);
  });
});

describe('noticeIssues', () => {
  it('test_notice_issues_name_what_raised_the_card', () => {
    const issues = ['stuck-skeletons', 'over-filtering', 'adapter-error', 'ad-label-near-miss'];
    expect(noticeIssues('paused', issues)).toEqual(['adapter-error', 'over-filtering']);
    expect(noticeIssues('ads-through', issues)).toEqual(['ad-label-near-miss']);
    expect(noticeIssues('not-running', ['feed-not-started'])).toEqual(['feed-not-started']);
    expect(noticeIssues('not-running', issues)).toEqual([]);
  });
});
