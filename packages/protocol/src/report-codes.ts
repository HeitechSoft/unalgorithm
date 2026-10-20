/**
 * The code registry (ADR 0009 §4): every issue, choice, origin, count and landmark key, filter reason, module kind and
 * adapter id a problem report may carry, as the server stores it. The wire schema checks codes by pattern only, so a
 * newer extension is never refused; `keepKnownCodes` then drops anything not listed here and counts it, so a bug or a
 * forged request can't store a name or a slug.
 *
 * This list is the contract: an adapter may emit only the ids listed here (a platforms test checks it). A new code goes
 * into the registry, and the Cloud is deployed, before an extension that sends it ships.
 */
import { PLATFORM_PREFIX, type PlatformId } from './platform.ts';
import type { ProblemReport, ReportDetection, ReportKind } from './report.ts';

/** Every health issue the extension can report: today's checks, then ADR 0009's. */
export const REPORT_ISSUES = [
  'no-feed',
  'no-items',
  'author-detection',
  'text-detection',
  'stuck-skeletons',
  'module-overmatch',
  'sponsored-overmatch',
  'over-filtering',
  'unsupported-locale',
  'feed-not-started',
  'route-new',
  'no-content-script',
  'adapter-error',
  'ad-label-near-miss',
  'no-ads-seen',
  'ad-cue-unlabelled',
  'header-unrecognised',
  'items-not-growing',
  'multi-post-items',
  'fallback-discovery',
  'load-more-missing',
] as const;
export type ReportIssue = (typeof REPORT_ISSUES)[number];

/** Issues raised by something the page did, not by something missing: they can open a "broken" alert. */
export const POSITIVE_EVIDENCE_ISSUES = [
  'feed-not-started',
  'adapter-error',
  'over-filtering',
  'module-overmatch',
  'text-detection',
  'ad-label-near-miss',
] as const satisfies readonly ReportIssue[];

const FIRST_ISSUES = [
  'feed-not-started',
  'adapter-error',
  'no-content-script',
  'over-filtering',
  'module-overmatch',
  'text-detection',
  'ad-label-near-miss',
] as const satisfies readonly ReportIssue[];

/** Every issue, most telling first: a detection report's topic is its first issue in this order. */
export const ISSUE_PRIORITY: readonly ReportIssue[] = Object.freeze([
  ...FIRST_ISSUES,
  ...REPORT_ISSUES.filter((i) => !(FIRST_ISSUES as readonly string[]).includes(i)),
]);

/** The in-feed notice cards, in the order one wins over another. */
export const NOTICE_KINDS = ['not-running', 'paused', 'ads-through'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The answers each kind asks for (ADR 0009 §2). Corrections' depend on the feature: see `CORRECTION_CHOICES`. */
export const CORRECTION_CHOICES = {
  factcheck: ['verdict-wrong', 'source-wrong', 'other'],
  perspectives: ['comparison-wrong', 'outlet-wrong', 'other'],
} as const;
export const REPORT_CHOICES = {
  detection: ['ads-showing', 'unwanted-showing', 'wanted-hidden', 'not-working', 'page-broken', 'other'],
  'wrong-call': ['should-show', 'wrong-reason'],
  correction: ['verdict-wrong', 'source-wrong', 'comparison-wrong', 'outlet-wrong', 'other'],
  other: ['sign-in-sync', 'ai', 'credits', 'other'],
} as const satisfies Record<ReportKind, readonly string[]>;
export type ReportChoice = (typeof REPORT_CHOICES)[ReportKind][number];

/** Where a report starts: the popup, its paused banner, its "isn't running" banner, the in-feed card, Why?, Settings, the side panel. */
export const REPORT_FROM = ['popup', 'popup-banner', 'popup-no-script', 'notice', 'why', 'settings', 'sidepanel'] as const;
export type ReportFrom = (typeof REPORT_FROM)[number];

/** The page counts a detection report carries. `offscreen`: virtualised slots, left out of health. */
export const COUNT_KEYS = ['items', 'posts', 'modules', 'pending', 'offscreen', 'hidden', 'classified', 'unknownAuthor'] as const;
/** Adapter operations whose exceptions are counted (never their messages). */
export const ERROR_OPS = ['feedScope', 'findItems', 'inspect', 'itemRootOf', 'probe'] as const;
export type ErrorOp = (typeof ERROR_OPS)[number];

/** core's `FilterReason`, as codes (core's report test keeps the two equal). */
export const FILTER_REASONS = [
  'sponsored',
  'suggested',
  'network-activity',
  'reshare',
  'unjoined-group',
  'reel',
  'not-followed',
  'module',
  'always-hide',
  'muted-keyword',
  'less-like-this',
  'noise',
  'low-relevance',
] as const;
/** core's `MODULE_KINDS`: what a hidden feed panel was. */
export const MODULE_KINDS = [
  'people-you-may-know',
  'reels',
  'stories',
  'jobs',
  'games',
  'groups',
  'pages',
  'newsletters',
  'sponsored-rail',
  'promo',
  'other',
] as const;
/** core's degraded signals (`keyof PostSignals | 'relationship'`): what detection stopped trusting on a page. */
export const DEGRADED_SIGNALS = [
  'sponsored',
  'suggested',
  'networkActivity',
  'reshare',
  'unjoinedGroup',
  'reel',
  'relationship',
] as const;

/** Landmark counts from each adapter's `probe`, and the route checks' (home link, signed-in bar, composer). */
export const LANDMARK_KEYS = [
  // LinkedIn
  'main',
  'feedList',
  'postRoots',
  'authorMenus',
  'textBoxes',
  // Facebook
  'feeds',
  'lists',
  'items',
  'posinset',
  'messages',
  'profileNames',
  // Both, for route recognition
  'homeNav',
  'signedIn',
  'composer',
] as const;

/** Every detector an adapter may name as evidence. */
export const DETECTOR_IDS = [
  'li.follow-button',
  'li.group.join-button',
  'li.header.activity',
  'li.header.repost',
  'li.header.suggested',
  'li.promoted.line',
  'li.promoted.text',
  // ADR 0009 §9: ad labels only in label positions, tolerant patterns.
  'li.promoted.age-slot',
  'li.promoted.header',
  'li.promoted.actor',
  'li.promoted.near',
  'li.age-slot.no-age',
  'fb.follow-button',
  'fb.header.activity',
  'fb.header.suggested',
  'fb.join-button',
  'fb.reshare',
  'fb.sponsored.adlink',
  'fb.sponsored.aria-label',
  'fb.sponsored.cta',
  'fb.sponsored.labelledby',
  'fb.sponsored.no-timestamp',
  'fb.sponsored.paid-partnership',
  'fb.sponsored.rendered-label',
  'fb.sponsored.slot-label',
  'fb.sponsored.near',
  'fb.sponsored.header',
] as const;

/** Parts of a post an adapter locates, and the locators it tries in order (ADR 0009 §9, phase B). */
export const SLOT_NAMES = ['actor', 'text', 'action-bar', 'age', 'header', 'header-buttons', 'nested-post'] as const;
export const SLOT_LOCATORS = ['class', 'testid', 'aria', 'structure'] as const;
const slotIds = (p: 'li' | 'fb') => SLOT_NAMES.flatMap((slot) => SLOT_LOCATORS.map((loc) => `${p}.slot.${slot}.${loc}`));

/** Things an adapter noticed that aren't evidence for a signal: near-miss labels, unknown header lines, which locator won. */
export const OBSERVATION_IDS: readonly string[] = Object.freeze([
  'li.label.promoted.near',
  'li.label.suggested.near',
  'li.slot.age.unrecognised',
  'li.header.unknown',
  'li.ad-cue',
  'li.item.multi-post',
  'fb.label.sponsored.near',
  'fb.label.suggested.near',
  'fb.slot.age.unrecognised',
  'fb.header.unknown',
  'fb.item.multi-post',
  'fb.offscreen',
  ...slotIds('li'),
  ...slotIds('fb'),
]);

/** Item discovery strategies, cheapest first per platform; the first of each is today's (ADR 0009 §9, phase B). */
export const STRATEGY_IDS = [
  'li.items.card-key',
  'li.items.feed-list',
  'li.items.anatomy',
  'li.items.sr-heading',
  'fb.items.role-feed',
  'fb.items.heading-list',
  'fb.items.posinset',
  'fb.items.anatomy',
] as const;

/** The registry ids of one platform (by their `li.`/`fb.` prefix). */
export function platformIds(ids: readonly string[], platform: PlatformId): string[] {
  const prefix = `${PLATFORM_PREFIX[platform]}.`;
  return ids.filter((id) => id.startsWith(prefix));
}

/** The value a required code becomes when the registry doesn't list it. */
export const UNKNOWN_CODE = 'unknown';

/**
 * The report with every code, key and id the registry doesn't list removed, and how many were removed. Choices are
 * checked against the kind (and a correction's feature); detector, observation and strategy ids against the report's
 * platform too. A required code (`from`, the post's reason) becomes `unknown` rather than disappearing. Pure: the input
 * is not changed.
 */
export function keepKnownCodes(input: ProblemReport): { report: ProblemReport; unknown: number } {
  let unknown = 0;
  const has = (list: readonly string[], code: string) => list.includes(code);
  /** `known`, and counts it when it isn't. */
  const kept = (known: boolean) => {
    if (!known) unknown++;
    return known;
  };
  const keepList = (list: readonly string[], known: readonly string[]) => list.filter((code) => kept(has(known, code)));
  const prefix = input.page ? `${PLATFORM_PREFIX[input.page.platform]}.` : null;
  const knownId = (known: readonly string[], id: string) => has(known, id) && (prefix === null || id.startsWith(prefix));
  const keepRecord = (rec: Record<string, number> | undefined, keep: (key: string) => boolean) => {
    if (rec === undefined) return undefined;
    const out: Record<string, number> = {};
    for (const [key, n] of Object.entries(rec)) if (kept(keep(key))) out[key] = n;
    return out;
  };

  const report: ProblemReport = { ...input, env: { ...input.env } };
  if (!has(REPORT_FROM, report.from)) {
    report.from = UNKNOWN_CODE;
    unknown++;
  }
  const choices: readonly string[] =
    report.kind === 'correction' && report.correction
      ? CORRECTION_CHOICES[report.correction.feature]
      : REPORT_CHOICES[report.kind];
  report.choices = keepList(report.choices, choices);
  if (report.page) report.page = { ...report.page };
  if (report.health) {
    report.health = {
      ...report.health,
      issues: keepList(report.health.issues, REPORT_ISSUES),
      degraded: keepList(report.health.degraded, DEGRADED_SIGNALS),
    };
  }
  if (report.detection) {
    const d = report.detection;
    const detection: ReportDetection = { counts: keepRecord(d.counts, (k) => has(COUNT_KEYS, k)) ?? {} };
    const hiddenBy = keepRecord(d.hiddenBy, (k) => has(FILTER_REASONS, k));
    const detectors = keepRecord(d.detectors, (k) => knownId(DETECTOR_IDS, k));
    const landmarks = keepRecord(d.landmarks, (k) => has(LANDMARK_KEYS, k));
    const observations = keepRecord(d.observations, (k) => knownId(OBSERVATION_IDS, k));
    const errors = keepRecord(d.errors, (k) => has(ERROR_OPS, k));
    if (hiddenBy) detection.hiddenBy = hiddenBy;
    if (detectors) detection.detectors = detectors;
    if (landmarks) detection.landmarks = landmarks;
    if (observations) detection.observations = observations;
    if (errors) detection.errors = errors;
    if (d.strategy !== undefined) {
      if (knownId(STRATEGY_IDS, d.strategy)) detection.strategy = d.strategy;
      else unknown++;
    }
    report.detection = detection;
  }
  if (report.post) {
    const p = report.post;
    const evidence = p.evidence.filter((e) => kept(knownId(DETECTOR_IDS, e.detector)));
    const post = { ...p, evidence };
    if (!has(FILTER_REASONS, post.reason)) {
      post.reason = UNKNOWN_CODE;
      unknown++;
    }
    if (post.module !== undefined && !has(MODULE_KINDS, post.module)) {
      delete post.module;
      unknown++;
    }
    report.post = post;
  }
  if (report.correction) report.correction = { ...report.correction };
  return { report, unknown };
}

/**
 * The report's topic, which groups it on the admin page and in alerts: a detection report's first issue in priority
 * order (or else its first choice), a wrong call's reason, a correction's feature, another report's choice. Use it on
 * the result of `keepKnownCodes`.
 */
export function reportTopic(report: ProblemReport): string | null {
  switch (report.kind) {
    case 'detection': {
      const issues = report.health?.issues ?? [];
      return ISSUE_PRIORITY.find((i) => issues.includes(i)) ?? report.choices[0] ?? null;
    }
    case 'wrong-call':
      return report.post?.reason ?? null;
    case 'correction':
      return report.correction?.feature ?? null;
    case 'other':
      return report.choices[0] ?? null;
  }
}
