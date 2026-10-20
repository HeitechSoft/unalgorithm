import { type Device, type HealthReport, isPaused, presetOf, type Settings } from '@unalgorithm/core';
import { type PlatformAdapter, reportRouteOf } from '@unalgorithm/platforms';
import {
  type NoticeKind,
  REPORT_CODE_PATTERN,
  REPORT_ID_PATTERN,
  REPORT_KEY_PATTERN,
  type ReportDetection,
  type ReportFrom,
  type ReportHealth,
  type ReportPage,
} from '@unalgorithm/protocol';
import type { ReportDraftInput } from '../lib/messages.ts';
import { aiKindOf } from '../lib/report-links.ts';
import type { PageDiagnostics, ReportSource } from './feed-controller.ts';

/**
 * Report drafts from a feed tab (ADR 0009 §2, §4): what the page is and how unAlgorithm saw it at the moment of the
 * click, as codes, counts and the person's settings. Never post text, names, links, ids or the address: the route class
 * and, for a feed at an address unAlgorithm doesn't know, its one word. The background adds the versions, checks the
 * draft against the schema and opens the report page; nothing is sent from here, or until the person sends it there.
 */

export interface DraftOptions {
  kind: 'detection' | 'wrong-call';
  /** Where it started: the popup, its banner, the in-feed card, *Why? → Wrong call?*. */
  from: ReportFrom;
  /** The post a *Wrong call?* is about: a lookup key for the source, never part of the draft. */
  key?: string;
  /** The in-feed card it came from; the background snoozes that card once the report is sent. */
  notice?: NoticeKind;
}

/** The page around the source: what the content script knows without asking anyone. */
export interface DraftPage {
  adapter: Pick<PlatformAdapter, 'id' | 'version' | 'classifyRoute' | 'isFeedPage'>;
  url: URL;
  /** `document.documentElement.lang`. */
  lang: string;
  settings: Settings;
  device: Device;
  /** A private window (`extension.inIncognitoContext`): the draft then says nothing about the page (Mozilla 6.3). */
  incognito: boolean;
}

const MAX_ISSUES = 16;
const MAX_DEGRADED = 8;
const MAX_COUNT = 1_000_000;

/** The page's language, primary subtag only (`en` of `en-GB`), or `unknown`. */
export function primaryLang(lang: string): string {
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'unknown';
}

/** The page part of a report: the platform, its detection version, the route class, the language and the settings. */
export function pageFacts(page: DraftPage): ReportPage {
  const platform = page.adapter.id;
  const ps = page.settings.platforms[platform];
  return {
    platform,
    adapter: page.adapter.version,
    ...reportRouteOf(page.adapter, page.url),
    lang: primaryLang(page.lang),
    preset: presetOf(platform, ps),
    ai: aiKindOf(page.device.aiSource),
    paused: isPaused(page.device, platform) || !ps.enabled,
  };
}

/** Distinct entries that fit `pattern`, at most `max`: a code the wire would refuse never makes a draft invalid. */
function codes(list: readonly string[], pattern: RegExp, max: number): string[] {
  return [...new Set(list.filter((c) => typeof c === 'string' && pattern.test(c) && c.length <= 64))].slice(0, max);
}

/** A record of counts with keys that fit `pattern`, whole non-negative numbers only, at most `max` keys. */
function counts(record: Readonly<Record<string, number>> | undefined, pattern: RegExp, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of Object.entries(record ?? {})) {
    if (Object.keys(out).length >= max) break;
    if (!pattern.test(key) || key.length > 64 || !Number.isFinite(n) || n < 0) continue;
    out[key] = Math.min(Math.floor(n), MAX_COUNT);
  }
  return out;
}

/** The health part: status, issues and degraded signals, as the wire takes them. */
export function healthFacts(health: HealthReport): ReportHealth {
  return {
    status: health.status,
    issues: codes(health.issues, REPORT_CODE_PATTERN, MAX_ISSUES),
    degraded: codes(health.degraded, REPORT_KEY_PATTERN, MAX_DEGRADED),
  };
}

/** The detection part: counts, folded posts by reason, and the ids that matched, within the wire's limits. */
export function detectionFacts(d: PageDiagnostics): ReportDetection {
  const optional = (record: Record<string, number>) => (Object.keys(record).length ? record : undefined);
  const hiddenBy = optional(counts(d.hiddenBy, REPORT_CODE_PATTERN, 16));
  const detectors = optional(counts(d.detectors, REPORT_ID_PATTERN, 64));
  const landmarks = optional(counts(d.landmarks, REPORT_KEY_PATTERN, 16));
  const observations = optional(counts(d.observations, REPORT_ID_PATTERN, 32));
  const errors = optional(counts(d.errors, REPORT_KEY_PATTERN, 8));
  const strategy = d.strategy && REPORT_ID_PATTERN.test(d.strategy) && d.strategy.length <= 64 ? d.strategy : undefined;
  return {
    counts: counts(d.counts, REPORT_KEY_PATTERN, 16),
    ...(hiddenBy ? { hiddenBy } : {}),
    ...(detectors ? { detectors } : {}),
    ...(landmarks ? { landmarks } : {}),
    ...(observations ? { observations } : {}),
    ...(errors ? { errors } : {}),
    ...(strategy ? { strategy } : {}),
  };
}

/** A page unAlgorithm isn't running on and isn't watching: nothing checked it, nothing counted. */
const IDLE_HEALTH: HealthReport = { status: 'not-started', issues: [], degraded: [] };

/**
 * A report draft of this page (ADR 0009 §2): from the controller where unAlgorithm runs, the watchdog where it watches a
 * page that may be the feed, or nothing (`source` null) on any other page. A *Wrong call?* carries the post's summary
 * (`postReportSummary`), never the key it was looked up by; when that post is gone, the draft becomes a detection
 * report from the same place. From a private window, only the kind and where it started.
 */
export function buildReportDraft(source: ReportSource | null, opts: DraftOptions, page: DraftPage): ReportDraftInput {
  const post = opts.kind === 'wrong-call' && opts.key ? (source?.postReportSummary?.(opts.key) ?? null) : null;
  const kind = opts.kind === 'wrong-call' && !post ? 'detection' : opts.kind;
  if (page.incognito) return { kind, from: opts.from, private: true };
  return {
    kind,
    from: opts.from,
    page: pageFacts(page),
    health: healthFacts(source?.getHealth() ?? IDLE_HEALTH),
    detection: detectionFacts(source?.diagnostics() ?? { counts: {}, landmarks: {} }),
    ...(post ? { post } : {}),
  };
}
