/**
 * The problem report alerts (ADR 0009 §8), checked with the others by `ops.check-alerts` every five minutes and sent by
 * the same notifier. One counts query (`reportAlertCounts`) reads the reports that matter, grouped; a pure rule
 * (`evaluateReportAlerts`) turns the counts into findings:
 *
 * - `reports-linkedin-broken`, `reports-facebook-broken` (warning; critical from 5 networks): unhandled detection
 *   reports of the last 24 hours from at least `REPORTS_ALERT_NETWORKS` distinct networks, one of them with a
 *   positive-evidence issue (`POSITIVE_EVIDENCE_ISSUES`); or from at least twice that many, whatever they say. So one
 *   person can't open it, and a real breakage reported by a few people does within minutes.
 * - `reports-waiting` (warning): a report unhandled for more than 24 hours, corrections included, so a single report is
 *   seen within a day without paging anyone at once. Times are kept to the hour, so this can open up to an hour early.
 * - `reports-cap` (warning): today's reports reached `REPORTS_DAILY_MAX`; it closes the next UTC day.
 *
 * The first two count only reports from a listed extension, from builds other than development ones, whose detection
 * version is at or above the platform's "Fixed in" floor and not dated in a future month (a forged or broken version
 * can't page anyone; `latestAdapterOrder`). A network is a report's `first_from_network` bit: the first report of its
 * kind that UTC day, about that platform, from its /24 or /48, so one sender gets one bit a day whatever detection
 * version it names. Content-free: the findings carry a count, never a report.
 */
import { latestAdapterOrder, PLATFORMS, type PlatformId, POSITIVE_EVIDENCE_ISSUES } from '@unalgorithm/protocol';
import { eq, gte, isNull, or, sql } from 'drizzle-orm';
import { utcDayStart } from '../ai/metering.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { problemReports, reportFloors } from '../db/schema.ts';
import type { Finding } from './alerts.ts';

/** Every report alert key starts with it, as every backup alert's starts with `backup-`. */
export const REPORT_KEY_PREFIX = 'reports-';
/** A broken alert is critical from this many networks. */
export const CRITICAL_NETWORKS = 5;
const DAY_MS = 86_400_000;

/** `reports-<platform>-broken`. */
export function brokenKey(platform: PlatformId): string {
  return `${REPORT_KEY_PREFIX}${platform}-broken`;
}
export const WAITING_KEY = `${REPORT_KEY_PREFIX}waiting`;
export const CAP_KEY = `${REPORT_KEY_PREFIX}cap`;

/** Reports that share every property below, counted: today's, and every one still open. */
export interface ReportBucket {
  platform: PlatformId | null;
  /** The detection version's order (`adapterOrder`); null for a report about no page. */
  adapterOrder: number | null;
  /** The platform's "Fixed in" floor's order, or null without one. */
  floorOrder: number | null;
  listed: boolean;
  development: boolean;
  detection: boolean;
  /** A detection report with a positive-evidence issue. */
  positive: boolean;
  open: boolean;
  /** Received in the last 24 hours. */
  recent: boolean;
  /** Received since 00:00 UTC. */
  today: boolean;
  reports: number;
  /** Of them, the first of their kind that day, about their platform, from their network (`first_from_network`). */
  networks: number;
}

export type ReportAlertThresholds = Pick<Config['reports'], 'enabled' | 'alertNetworks' | 'dailyMax'>;

/** What the report alerts measure, before their thresholds. */
export interface ReportReadings {
  /** Per platform: networks with unhandled detection reports in the last 24 hours, and whether one shows breakage. */
  platforms: Record<PlatformId, { networks: number; positive: boolean }>;
  /** Reports unhandled for more than 24 hours. */
  waiting: number;
  /** Reports accepted today (UTC), all of them, as the daily limit counts them. */
  today: number;
}

/** Networks among `buckets`: one bit per network and UTC day, so a sum within one day counts each network once. */
const networksOf = (buckets: readonly ReportBucket[]) => buckets.reduce((n, b) => n + b.networks, 0);

/**
 * What `reportAlertCounts`'s buckets measure for the alerts. Broken and waiting count only listed reports from builds
 * other than development ones, at or above the platform's floor and not dated in a future month.
 *
 * The last 24 hours span two UTC days, and a network reporting on both has a bit on each: summed, one person reporting
 * at 23:50 and again at 00:10 would be two networks. So the day with more networks counts, today or the part of
 * yesterday in the window.
 */
export function readReportCounts(buckets: readonly ReportBucket[], now: number): ReportReadings {
  const latest = latestAdapterOrder(now);
  const counted = (b: ReportBucket) =>
    b.listed &&
    !b.development &&
    (b.adapterOrder === null || ((b.floorOrder === null || b.adapterOrder >= b.floorOrder) && b.adapterOrder <= latest));
  const platforms = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const broken = buckets.filter((b) => b.platform === platform && b.detection && b.open && b.recent && counted(b));
      const networks = Math.max(networksOf(broken.filter((b) => b.today)), networksOf(broken.filter((b) => !b.today)));
      return [platform, { networks, positive: broken.some((b) => b.positive && b.reports > 0) }];
    }),
  ) as ReportReadings['platforms'];
  return {
    platforms,
    waiting: buckets.filter((b) => b.open && !b.recent && counted(b)).reduce((n, b) => n + b.reports, 0),
    today: buckets.filter((b) => b.today).reduce((n, b) => n + b.reports, 0),
  };
}

/**
 * The report alerts that fire, from `reportAlertCounts`'s buckets. None while reports are off or
 * `REPORTS_ALERT_NETWORKS` is 0.
 */
export function evaluateReportAlerts(buckets: readonly ReportBucket[], t: ReportAlertThresholds, now: number): Finding[] {
  if (!t.enabled || t.alertNetworks === 0) return [];
  const { platforms, waiting, today } = readReportCounts(buckets, now);
  const findings: Finding[] = [];
  for (const platform of PLATFORMS) {
    const { networks, positive } = platforms[platform];
    if ((networks >= t.alertNetworks && positive) || networks >= 2 * t.alertNetworks) {
      findings.push({ key: brokenKey(platform), level: networks >= CRITICAL_NETWORKS ? 'critical' : 'warning', value: networks });
    }
  }
  if (waiting > 0) findings.push({ key: WAITING_KEY, level: 'warning', value: waiting });
  if (today >= t.dailyMax) findings.push({ key: CAP_KEY, level: 'warning', value: today });
  return findings;
}

/**
 * The one counts query: today's reports and every open one, grouped by what `evaluateReportAlerts` tells apart, with
 * the platform's floor. Reads codes and counts only.
 */
export async function reportAlertCounts(db: Db, now: number): Promise<ReportBucket[]> {
  const r = problemReports;
  const dayStart = utcDayStart(new Date(now));
  const dayAgo = new Date(now - DAY_MS);
  const issues = sql.join(
    POSITIVE_EVIDENCE_ISSUES.map((issue) => sql`${issue}`),
    sql`, `,
  );
  const flag = (condition: ReturnType<typeof sql>) => sql<boolean>`coalesce(${condition}, false)`.mapWith(Boolean);
  const columns = {
    platform: r.platform,
    adapterOrder: r.adapterOrder,
    floorOrder: reportFloors.adapterOrder,
    listed: r.listed,
    development: flag(sql`${r.channel} = 'development'`),
    detection: flag(sql`${r.kind} = 'detection'`),
    positive: flag(
      sql`${r.kind} = 'detection' and jsonb_exists_any(${r.details} -> 'health' -> 'issues', array[${issues}]::text[])`,
    ),
    open: flag(sql`${r.handledAt} is null`),
    recent: flag(sql`${r.receivedAt} >= ${dayAgo}`),
    today: flag(sql`${r.receivedAt} >= ${dayStart}`),
  };
  const rows = await db
    .select({
      ...columns,
      reports: sql<number>`count(*)`.mapWith(Number),
      networks: sql<number>`count(*) filter (where ${r.firstFromNetwork})`.mapWith(Number),
    })
    .from(r)
    .leftJoin(reportFloors, eq(reportFloors.platform, r.platform))
    .where(or(gte(r.receivedAt, dayStart), isNull(r.handledAt)))
    // By position: Postgres matches a grouped expression to the selected one by its text, and the two copies of an
    // expression with a parameter (a time, the issues) get different parameter numbers.
    .groupBy(
      sql.raw(
        Object.keys(columns)
          .map((_key, i) => i + 1)
          .join(', '),
      ),
    );
  return rows.map((row) => ({
    ...row,
    adapterOrder: row.adapterOrder === null ? null : Number(row.adapterOrder),
    floorOrder: row.floorOrder === null ? null : Number(row.floorOrder),
  }));
}
