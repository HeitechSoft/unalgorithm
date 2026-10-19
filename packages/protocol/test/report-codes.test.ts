import { describe, expect, it } from 'vitest';
import {
  CORRECTION_CHOICES,
  COUNT_KEYS,
  DEGRADED_SIGNALS,
  DETECTOR_IDS,
  ERROR_OPS,
  FILTER_REASONS,
  ISSUE_PRIORITY,
  keepKnownCodes,
  LANDMARK_KEYS,
  MODULE_KINDS,
  NOTICE_KINDS,
  OBSERVATION_IDS,
  POSITIVE_EVIDENCE_ISSUES,
  type ProblemReport,
  ProblemReportSchema,
  platformIds,
  REPORT_CHOICES,
  REPORT_CODE_PATTERN,
  REPORT_FROM,
  REPORT_ID_PATTERN,
  REPORT_ISSUES,
  REPORT_KEY_PATTERN,
  REPORT_KINDS,
  reportTopic,
  STRATEGY_IDS,
  UNKNOWN_CODE,
} from '../src/index.ts';

const ENV = { extension: '0.4.1', channel: 'chrome-store', browser: 'chrome', browserMajor: 141 } as const;
const PAGE = {
  platform: 'linkedin',
  adapter: 'linkedin@2026.11.0',
  route: 'feed',
  lang: 'en',
  preset: 'balanced',
  ai: 'off',
  paused: false,
} as const;

/** A report that only uses registry codes. */
const KNOWN = ProblemReportSchema.parse({
  v: 1,
  id: '0b6f7d3c-5a2e-4f1b-9c8d-7e6a5b4c3d2e',
  kind: 'wrong-call',
  from: 'why',
  choices: ['should-show'],
  env: ENV,
  page: PAGE,
  health: { status: 'degraded', issues: ['sponsored-overmatch'], degraded: ['sponsored'] },
  detection: {
    counts: { items: 24, posts: 22, hidden: 15, offscreen: 2 },
    hiddenBy: { sponsored: 5, 'not-followed': 10 },
    detectors: { 'li.promoted.age-slot': 5, 'li.follow-button': 12 },
    landmarks: { main: 1, feedList: 1 },
    observations: { 'li.label.promoted.near': 2, 'li.slot.actor.structure': 1 },
    errors: { inspect: 1 },
    strategy: 'li.items.anatomy',
  },
  post: {
    reason: 'module',
    source: 'rule',
    evidence: [{ detector: 'li.header.suggested', strength: 'strong' }],
    authorKind: 'unknown',
    relationship: 'unknown',
    media: 'none',
    text: 'none',
    module: 'people-you-may-know',
  },
});

describe('keepKnownCodes', () => {
  it('test_keeps_a_known_report_whole', () => {
    const kept = keepKnownCodes(KNOWN);
    expect(kept.unknown).toBe(0);
    expect(kept.report).toStrictEqual(KNOWN);
    expect(ProblemReportSchema.safeParse(kept.report).success).toBe(true);
  });

  it('test_drops_names_and_unknown_codes_and_counts_them', () => {
    const before = structuredClone(KNOWN);
    const forged = ProblemReportSchema.parse({
      ...KNOWN,
      from: 'jane-doe',
      choices: ['should-show', 'jane-doe-123'],
      health: { status: 'degraded', issues: ['sponsored-overmatch', 'jane-doe'], degraded: ['sponsored', 'JaneDoe'] },
      detection: {
        counts: { items: 24, JaneDoe: 1 },
        hiddenBy: { sponsored: 5, 'jane-doe': 1 },
        detectors: { 'li.follow-button': 12, 'li.jane-doe-123': 1, 'fb.sponsored.slot-label': 3 },
        landmarks: { main: 1, JaneDoe: 1 },
        observations: { 'li.label.promoted.near': 2, 'li.in.jane-doe-123': 1 },
        errors: { inspect: 1, JaneDoe: 1 },
        strategy: 'li.items.jane-doe',
      },
      post: {
        ...KNOWN.post,
        reason: 'jane-doe',
        module: 'jane-doe',
        evidence: [
          { detector: 'li.header.suggested', strength: 'strong' },
          { detector: 'li.jane-doe-123', strength: 'weak' },
        ],
      },
    });
    const { report, unknown } = keepKnownCodes(forged);
    // 1 from, 1 choice, 1 issue, 1 degraded, 6 record keys, 1 other platform's detector, 1 strategy, 1 reason,
    // 1 module, 1 evidence entry.
    expect(unknown).toBe(15);
    expect(JSON.stringify(report)).not.toMatch(/jane|JaneDoe/i);
    expect(report.from).toBe(UNKNOWN_CODE);
    expect(report.choices).toEqual(['should-show']);
    expect(report.health).toEqual({ status: 'degraded', issues: ['sponsored-overmatch'], degraded: ['sponsored'] });
    expect(report.detection).toEqual({
      counts: { items: 24 },
      hiddenBy: { sponsored: 5 },
      // A Facebook detector in a LinkedIn report is dropped too.
      detectors: { 'li.follow-button': 12 },
      landmarks: { main: 1 },
      observations: { 'li.label.promoted.near': 2 },
      errors: { inspect: 1 },
    });
    expect(report.post?.reason).toBe(UNKNOWN_CODE);
    expect(report.post?.module).toBeUndefined();
    expect(report.post?.evidence).toEqual([{ detector: 'li.header.suggested', strength: 'strong' }]);
    // Pure: neither the input nor the known report changed.
    expect(KNOWN).toStrictEqual(before);
    expect(forged.from).toBe('jane-doe');
  });

  it('test_choices_are_checked_against_the_kind', () => {
    const detection = {
      ...KNOWN,
      kind: 'detection',
      from: 'popup',
      choices: ['ads-showing', 'should-show', 'credits'],
      post: undefined,
    } as ProblemReport;
    expect(keepKnownCodes(detection).report.choices).toEqual(['ads-showing']);
    const correction = (feature: 'factcheck' | 'perspectives', choices: string[]) =>
      keepKnownCodes({
        v: 1,
        id: KNOWN.id,
        kind: 'correction',
        from: 'sidepanel',
        choices,
        env: ENV,
        correction: { feature, promptVersion: 3, via: 'cloud', message: 'Wrong year.' },
      });
    expect(correction('factcheck', ['verdict-wrong', 'outlet-wrong'])).toMatchObject({
      report: { choices: ['verdict-wrong'] },
      unknown: 1,
    });
    expect(correction('perspectives', ['outlet-wrong', 'source-wrong'])).toMatchObject({
      report: { choices: ['outlet-wrong'] },
      unknown: 1,
    });
    const other = keepKnownCodes({
      v: 1,
      id: KNOWN.id,
      kind: 'other',
      from: 'settings',
      choices: ['ai', 'ads-showing'],
      env: ENV,
    });
    expect(other).toMatchObject({ report: { choices: ['ai'] }, unknown: 1 });
  });

  it('test_report_topic', () => {
    const detection = (issues: string[], choices: string[]) =>
      reportTopic({
        ...KNOWN,
        kind: 'detection',
        from: 'popup',
        choices,
        health: { status: 'broken', issues, degraded: [] },
        post: undefined,
      });
    expect(detection(['route-new', 'no-ads-seen', 'feed-not-started'], ['ads-showing'])).toBe('feed-not-started');
    expect(detection(['over-filtering', 'adapter-error'], [])).toBe('adapter-error');
    expect(detection(['ad-label-near-miss', 'stuck-skeletons'], [])).toBe('ad-label-near-miss');
    expect(detection(['no-ads-seen'], ['ads-showing'])).toBe('no-ads-seen');
    expect(detection([], ['ads-showing', 'page-broken'])).toBe('ads-showing');
    expect(detection([], [])).toBeNull();
    expect(reportTopic(KNOWN)).toBe('module');
    expect(
      reportTopic({
        v: 1,
        id: KNOWN.id,
        kind: 'correction',
        from: 'sidepanel',
        choices: ['other'],
        env: ENV,
        correction: { feature: 'perspectives', promptVersion: 1, via: 'own-key', message: 'x' },
      }),
    ).toBe('perspectives');
    expect(reportTopic({ v: 1, id: KNOWN.id, kind: 'other', from: 'settings', choices: ['credits'], env: ENV })).toBe('credits');
  });
});

describe('registries', () => {
  const lists: Record<string, readonly string[]> = {
    REPORT_ISSUES,
    POSITIVE_EVIDENCE_ISSUES,
    ISSUE_PRIORITY,
    NOTICE_KINDS,
    REPORT_FROM,
    COUNT_KEYS,
    ERROR_OPS,
    FILTER_REASONS,
    MODULE_KINDS,
    DEGRADED_SIGNALS,
    LANDMARK_KEYS,
    DETECTOR_IDS,
    OBSERVATION_IDS,
    STRATEGY_IDS,
    ...Object.fromEntries(Object.entries(REPORT_CHOICES).map(([kind, choices]) => [`REPORT_CHOICES.${kind}`, choices])),
    ...Object.fromEntries(Object.entries(CORRECTION_CHOICES).map(([f, choices]) => [`CORRECTION_CHOICES.${f}`, choices])),
  };

  it('test_registries_have_no_duplicates', () => {
    for (const [name, list] of Object.entries(lists)) {
      expect(list.length, name).toBeGreaterThan(0);
      expect(new Set(list).size, name).toBe(list.length);
    }
  });

  it('test_registry_entries_fit_the_wire_patterns', () => {
    const codes = [REPORT_ISSUES, REPORT_FROM, FILTER_REASONS, MODULE_KINDS, ...Object.values(REPORT_CHOICES)].flat();
    for (const code of codes) expect(code, code).toMatch(REPORT_CODE_PATTERN);
    for (const key of [COUNT_KEYS, ERROR_OPS, LANDMARK_KEYS, DEGRADED_SIGNALS].flat())
      expect(key, key).toMatch(REPORT_KEY_PATTERN);
    for (const id of [DETECTOR_IDS, OBSERVATION_IDS, STRATEGY_IDS].flat()) {
      expect(id, id).toMatch(REPORT_ID_PATTERN);
      expect(id.length, id).toBeLessThanOrEqual(64);
    }
  });

  it('test_issue_lists_are_in_the_registry', () => {
    for (const issue of POSITIVE_EVIDENCE_ISSUES) expect(REPORT_ISSUES, issue).toContain(issue);
    for (const issue of ISSUE_PRIORITY) expect(REPORT_ISSUES, issue).toContain(issue);
    // Every issue has a priority, and ADR 0009 §6's come first, in its order.
    expect([...ISSUE_PRIORITY].sort()).toEqual([...REPORT_ISSUES].sort());
    expect(ISSUE_PRIORITY.slice(0, 7)).toEqual([
      'feed-not-started',
      'adapter-error',
      'no-content-script',
      'over-filtering',
      'module-overmatch',
      'text-detection',
      'ad-label-near-miss',
    ]);
    expect(NOTICE_KINDS).toEqual(['not-running', 'paused', 'ads-through']);
  });

  it('test_choices_match_the_report_page', () => {
    expect(Object.keys(REPORT_CHOICES)).toEqual([...REPORT_KINDS]);
    expect(REPORT_CHOICES.detection).toEqual([
      'ads-showing',
      'unwanted-showing',
      'wanted-hidden',
      'not-working',
      'page-broken',
      'other',
    ]);
    expect(REPORT_CHOICES['wrong-call']).toEqual(['should-show', 'wrong-reason']);
    expect(REPORT_CHOICES.other).toEqual(['sign-in-sync', 'ai', 'credits', 'other']);
    // A correction's choices are both features' together.
    expect([...REPORT_CHOICES.correction].sort()).toEqual([...new Set(Object.values(CORRECTION_CHOICES).flat())].sort());
    expect(REPORT_FROM).toEqual(['popup', 'popup-banner', 'popup-no-script', 'notice', 'why', 'settings', 'sidepanel']);
  });

  it('test_adapter_ids_split_by_platform', () => {
    const all = [...DETECTOR_IDS, ...OBSERVATION_IDS, ...STRATEGY_IDS];
    const li = platformIds(all, 'linkedin');
    const fb = platformIds(all, 'facebook');
    expect(li.length + fb.length).toBe(all.length);
    expect(li.every((id) => id.startsWith('li.'))).toBe(true);
    expect(fb.every((id) => id.startsWith('fb.'))).toBe(true);
    // ADR 0009 §9: the new label detectors and today's are all listed.
    for (const id of [
      'li.promoted.age-slot',
      'li.promoted.header',
      'li.promoted.actor',
      'li.promoted.near',
      'fb.sponsored.near',
    ]) {
      expect(DETECTOR_IDS).toContain(id);
    }
    for (const id of ['li.slot.actor.structure', 'fb.slot.age.class', 'li.label.promoted.near', 'fb.offscreen']) {
      expect(OBSERVATION_IDS).toContain(id);
    }
    expect(platformIds(STRATEGY_IDS, 'linkedin')).toEqual([
      'li.items.card-key',
      'li.items.feed-list',
      'li.items.anatomy',
      'li.items.sr-heading',
    ]);
    expect(platformIds(STRATEGY_IDS, 'facebook')).toEqual([
      'fb.items.role-feed',
      'fb.items.heading-list',
      'fb.items.posinset',
      'fb.items.anatomy',
    ]);
  });
});
