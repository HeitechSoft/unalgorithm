/**
 * Problem reports in tests (ADR 0009): one valid report of each kind, as the extension's report page sends them, a test
 * app with `REPORTS=on`, and a POST the way the page makes it (an extension Origin, JSON). Rows can also be written
 * straight into `problem_reports` (`insertReport`), at any time, for the purge, the admin page and the alerts.
 */
import { randomUUID } from 'node:crypto';
import {
  DEV_CHROMIUM_ID,
  FIREFOX_DEV_ADDON_ID,
  type ProblemReport,
  REPORTS_PATH,
  type ReportDetails,
} from '@unalgorithm/protocol';
import type { Db } from '../../src/db/client.ts';
import { problemReports } from '../../src/db/schema.ts';
import { createApp } from '../../src/http/app.ts';
import { countReportsSince } from '../../src/reports/intake.ts';
import { createReportLimits, type ReportLimits } from '../../src/reports/limits.ts';
import { createTestApp, testConfig } from './test-app.ts';

/** The development build's Origin in Chrome and Edge: listed in `EXTENSION_IDS` by default. */
export const LISTED_ORIGIN = `chrome-extension://${DEV_CHROMIUM_ID}`;
/** A Chrome or Edge extension the test server doesn't list (an Edge store id before it is added, or a fork). */
export const UNLISTED_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
/** A Firefox page's Origin: a random UUID that says nothing of the add-on. */
export const MOZ_ORIGIN = 'moz-extension://5d0c1f3a-7b2e-4c6d-9e8f-0a1b2c3d4e5f';
/** The Firefox development build's add-on id, listed by default. */
export const LISTED_GECKO_ID = FIREFOX_DEV_ADDON_ID;
/** A browser's User-Agent and Accept-Language, which nothing may keep. */
export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/158.0 QXZ7-ua-marker';
export const ACCEPT_LANGUAGE = 'fr-CA,fr;q=0.9,qxz7-lang-marker';

const ENV = { extension: '0.4.1', channel: 'chrome-store', browser: 'chrome', browserMajor: 141 } as const;
const PAGE = {
  platform: 'linkedin',
  adapter: 'linkedin@2026.10.2',
  route: 'feed',
  lang: 'en',
  preset: 'balanced',
  ai: 'off',
  paused: false,
} as const;
const DETECTION = {
  counts: { items: 24, posts: 22, modules: 2, hidden: 15 },
  hiddenBy: { sponsored: 5, 'not-followed': 5, 'network-activity': 5 },
  detectors: { 'li.promoted.age-slot': 5, 'li.follow-button': 12 },
  landmarks: { main: 1, feedList: 1, postRoots: 22 },
  observations: { 'li.label.promoted.near': 2 },
  errors: { inspect: 0 },
  strategy: 'li.items.card-key',
};

type Kind = ProblemReport['kind'];

/** A valid report of `kind` with a fresh id; `extra` replaces top-level parts. */
export function report(kind: Kind, extra: Record<string, unknown> = {}): ProblemReport & Record<string, unknown> {
  const base = { v: 1 as const, id: randomUUID(), env: { ...ENV } };
  const byKind: Record<Kind, Record<string, unknown>> = {
    detection: {
      kind,
      from: 'popup',
      choices: ['ads-showing'],
      page: { ...PAGE },
      health: { status: 'broken', issues: ['ad-label-near-miss'], degraded: [] },
      detection: structuredClone(DETECTION),
    },
    'wrong-call': {
      kind,
      from: 'why',
      choices: ['should-show'],
      page: { ...PAGE },
      health: { status: 'ok', issues: [], degraded: [] },
      detection: structuredClone(DETECTION),
      post: {
        reason: 'suggested',
        source: 'rule',
        evidence: [{ detector: 'li.header.suggested', strength: 'strong' }],
        authorKind: 'person',
        relationship: 'not-followed',
        media: 'none',
        text: 'long',
      },
    },
    correction: {
      kind,
      from: 'sidepanel',
      choices: ['verdict-wrong'],
      correction: {
        feature: 'factcheck',
        promptVersion: 3,
        via: 'cloud',
        message: 'The claim was about 2024, not 2023.',
        contact: 'Ann@Example.org',
      },
    },
    other: { kind, from: 'settings', choices: ['sign-in-sync'] },
  };
  return { ...base, ...byKind[kind], ...extra } as ProblemReport & Record<string, unknown>;
}

export interface SendOptions {
  /** Default: the listed development build's. `null`: no Origin. */
  origin?: string | null;
  /** Default: `application/json`. */
  contentType?: string;
  /** The client's address, through `X-Forwarded-For` (the app must trust one hop). */
  ip?: string;
  /** More headers, such as a User-Agent. */
  headers?: Record<string, string>;
}

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/**
 * A test app with `REPORTS=on` (and `env` on top), its report limits held here so a test can read their keys, and
 * `send`, which posts a report (or any body) as the report page does.
 */
export async function reportApp(env: Record<string, string | undefined> = {}) {
  const t: TestApp = await createTestApp({ config: testConfig({ REPORTS: 'on', ...env }) });
  const config = t.deps.config;
  const limits: ReportLimits = createReportLimits({
    perHour: config.reports.perHour,
    dailyMax: config.reports.dailyMax,
    countSince: (since) => countReportsSince(t.deps.db.db, since),
  });
  const app = createApp({ ...t.deps, reportLimits: limits });
  const send = (body: unknown, opts: SendOptions = {}): Promise<Response> => {
    const origin = opts.origin === undefined ? LISTED_ORIGIN : opts.origin;
    return Promise.resolve(
      app.request(REPORTS_PATH, {
        method: 'POST',
        headers: {
          'Content-Type': opts.contentType ?? 'application/json',
          ...(origin === null ? {} : { Origin: origin }),
          ...(opts.ip === undefined ? {} : { 'X-Forwarded-For': opts.ip }),
          ...opts.headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  };
  return { t, app, limits, send, db: t.deps.db.db };
}

/** One stored report, as the intake would write it, at `receivedAt`; `row` replaces columns. Answers its id. */
export async function insertReport(
  db: Db,
  receivedAt: Date,
  row: Partial<typeof problemReports.$inferInsert> = {},
): Promise<string> {
  const id = row.id ?? randomUUID();
  const details: ReportDetails = {
    page: { ...PAGE },
    health: { status: 'broken', issues: ['ad-label-near-miss'], degraded: [] },
    detection: structuredClone(DETECTION),
  };
  await db.insert(problemReports).values({
    id,
    ref: refFor(id),
    receivedAt,
    kind: 'detection',
    from: 'popup',
    channel: 'chrome-store',
    listed: true,
    extension: '0.4.1',
    browser: 'chrome',
    browserMajor: 141,
    platform: 'linkedin',
    adapter: 'linkedin@2026.10.2',
    adapterOrder: 2026010002,
    topic: 'ad-label-near-miss',
    choices: ['ads-showing'],
    firstFromNetwork: true,
    details,
    ...row,
  });
  return id;
}

/** A reference made from an id, so rows written straight into the table get distinct, valid ones. */
function refFor(id: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const hex = id.replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** A correction's details as stored (no words or reply address). */
export function correctionDetails(feature: 'factcheck' | 'perspectives' = 'factcheck'): ReportDetails {
  return { correction: { feature, promptVersion: 3, via: 'cloud' } };
}
