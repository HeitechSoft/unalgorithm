/**
 * Alerts (R43, CL4-15): five content-free rules over the server's own status (`readOpsStatus`, CL4-14) and the spend
 * breaker, checked every five minutes by the `ops.check-alerts` task on the server's job registry (CL2-03). The alerts
 * open now are rows of `ops_alerts`: an alert opens once, stays open (its row seen again) while its rule still fires, and
 * closes (its row deleted) when it no longer does. The admin page lists them (`listOpenAlerts`); CL4-16 tells someone.
 *
 * Content-free: fixed keys, levels, times and numbers. The `alert.*` log lines are warnings and information, never
 * errors, so an alert never feeds `errors-high`.
 */
import type { StatsFs } from 'node:fs';
import type { ALERT_LEVELS, OpenAlert, OpsStatus } from '@unalgorithm/protocol';
import { asc, eq, inArray } from 'drizzle-orm';
import { spendBreakerTripped } from '../ai/limits.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { opsAlerts } from '../db/schema.ts';
import type { JobRegistry } from '../jobs/worker.ts';
import type { Logger } from '../log.ts';
import type { ErrorWindow } from './error-window.ts';
import { readOpsStatus } from './status.ts';

/** The fixed keys; each watched backup kind adds `backup-<kind>`. */
export const ALERT_RULE_KEYS = ['disk-free-low', 'database-size-high', 'errors-high', 'spend-breaker'] as const;
const BACKUP_KEY_PREFIX = 'backup-';

export const OPS_ALERTS_TASK = 'ops.check-alerts';
/** Every five minutes, UTC. */
export const OPS_ALERTS_SCHEDULE = '*/5 * * * *';

/** `OpsStatusSchema`'s bound on `openAlerts`. */
const MAX_OPEN_ALERTS = 50;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type AlertLevel = (typeof ALERT_LEVELS)[number];

export interface AlertInputs {
  status: Pick<OpsStatus, 'diskFreeBytes' | 'databaseBytes' | 'errors15m' | 'backups'>;
  breakerTripped: boolean;
  /** ms since the epoch. */
  now: number;
}

/** A rule that fires, with what it measured (bytes, a count or hours; null when it has no number). */
export interface Finding {
  key: string;
  level: AlertLevel;
  value: number | null;
}

/**
 * The rules that fire, sorted by key. A threshold of 0 turns its rule off (for backups: only a failed run, or none ever
 * succeeded, still fires); an unknown measure (null) never fires, and backups not watched (null) give no finding.
 */
export function evaluateAlerts(inputs: AlertInputs, t: Config['alerts']): Finding[] {
  const { status, breakerTripped, now } = inputs;
  const { diskFreeBytes, databaseBytes, errors15m, backups } = status;
  const findings: Finding[] = [];
  if (diskFreeBytes !== null && diskFreeBytes < t.diskFreeMinBytes) {
    findings.push({ key: 'disk-free-low', level: 'critical', value: diskFreeBytes });
  }
  if (t.databaseMaxBytes > 0 && databaseBytes !== null && databaseBytes > t.databaseMaxBytes) {
    findings.push({ key: 'database-size-high', level: 'warning', value: databaseBytes });
  }
  if (t.errorsPer15m > 0 && errors15m >= t.errorsPer15m) {
    findings.push({ key: 'errors-high', level: 'warning', value: errors15m });
  }
  if (breakerTripped) findings.push({ key: 'spend-breaker', level: 'warning', value: null });
  for (const backup of backups ?? []) {
    const lastSuccess = backup.lastSuccessAt === null ? Number.NaN : Date.parse(backup.lastSuccessAt);
    const ageMs = Number.isNaN(lastSuccess) ? null : now - lastSuccess;
    const stale = ageMs !== null && t.backupMaxAgeMs > 0 && ageMs > t.backupMaxAgeMs;
    if (!backup.ok || ageMs === null || stale) {
      findings.push({
        key: `${BACKUP_KEY_PREFIX}${backup.kind}`,
        level: 'critical',
        value: ageMs === null ? null : ageMs / HOUR_MS,
      });
    }
  }
  return findings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface AlertTransitions {
  opened: Finding[];
  /** From the rows deleted in this transaction: CL4-16's `Resolved:` message needs the level and the last value. */
  closed: { key: string; level: AlertLevel; openedAt: Date; lastValue: number | null }[];
  /** Every row open after this run, with `notifiedAt` (CL4-16 decides from it what to send). */
  open: { key: string; level: AlertLevel; openedAt: Date; lastValue: number | null; notifiedAt: Date | null }[];
}

/**
 * Brings `ops_alerts` in line with `findings` in one transaction, under the open rows' locks: a new finding opens a row,
 * one already open updates its level, `last_seen_at` and `last_value`, and an open row without a finding is deleted.
 * Logs `alert.opened` (warn) and `alert.closed` (info) once it has committed. The alert's level is logged as
 * `alert_level`: `level` is the line's own.
 */
export async function applyAlerts(db: Db, findings: readonly Finding[], now: number, log: Logger): Promise<AlertTransitions> {
  const at = new Date(now);
  const transitions = await db.transaction(async (tx): Promise<AlertTransitions> => {
    const rows = await tx.select({ key: opsAlerts.key }).from(opsAlerts).for('update');
    const wasOpen = new Set(rows.map((r) => r.key));
    const found = new Set(findings.map((f) => f.key));

    const opened = findings.filter((f) => !wasOpen.has(f.key));
    if (opened.length > 0) {
      await tx
        .insert(opsAlerts)
        .values(opened.map((f) => ({ key: f.key, level: f.level, openedAt: at, lastSeenAt: at, lastValue: f.value })));
    }
    for (const f of findings) {
      if (!wasOpen.has(f.key)) continue;
      await tx.update(opsAlerts).set({ level: f.level, lastSeenAt: at, lastValue: f.value }).where(eq(opsAlerts.key, f.key));
    }
    const gone = [...wasOpen].filter((key) => !found.has(key));
    const closed =
      gone.length === 0
        ? []
        : await tx.delete(opsAlerts).where(inArray(opsAlerts.key, gone)).returning({
            key: opsAlerts.key,
            level: opsAlerts.level,
            openedAt: opsAlerts.openedAt,
            lastValue: opsAlerts.lastValue,
          });
    const open = await tx
      .select({
        key: opsAlerts.key,
        level: opsAlerts.level,
        openedAt: opsAlerts.openedAt,
        lastValue: opsAlerts.lastValue,
        notifiedAt: opsAlerts.notifiedAt,
      })
      .from(opsAlerts)
      .orderBy(asc(opsAlerts.openedAt), asc(opsAlerts.key));
    return { opened, closed: closed.sort((a, b) => (a.key < b.key ? -1 : 1)), open };
  });

  for (const f of transitions.opened) log.warn('alert.opened', { key: f.key, alert_level: f.level, value: f.value });
  for (const c of transitions.closed) {
    log.info('alert.closed', { key: c.key, minutes_open: Math.round((now - c.openedAt.getTime()) / MINUTE_MS) });
  }
  return transitions;
}

/** The open alerts for the admin page, oldest first, at most 50. */
export async function listOpenAlerts(db: Db): Promise<OpenAlert[]> {
  const rows = await db
    .select({ key: opsAlerts.key, level: opsAlerts.level, openedAt: opsAlerts.openedAt })
    .from(opsAlerts)
    .orderBy(asc(opsAlerts.openedAt), asc(opsAlerts.key))
    .limit(MAX_OPEN_ALERTS);
  return rows.map((r) => ({ key: r.key, level: r.level, openedAt: r.openedAt.toISOString() }));
}

export interface AlertDeps {
  db: Db;
  config: Config;
  log: Logger;
  errors: ErrorWindow;
  /** CL4-16's notifier, given the check's time. Default: none (alerts are logged and shown on the admin page only). */
  notify?: (t: AlertTransitions, now: number) => Promise<void>;
  /** Tests only, passed through to `readOpsStatus` (`OpsDeps.statfs`). Default: `fs.promises.statfs`. */
  statfs?: (path: string) => Promise<StatsFs>;
}

/** One check: measure (`readOpsStatus` and the spend breaker, at once), evaluate, apply, then notify. */
export async function checkAlerts(deps: AlertDeps, now: number = Date.now()): Promise<AlertTransitions> {
  const { db, config, log, errors, statfs } = deps;
  const [status, breakerTripped] = await Promise.all([
    readOpsStatus({ db, config, log, errors, statfs, now }),
    spendBreakerTripped(db, config, new Date(now)),
  ]);
  const transitions = await applyAlerts(db, evaluateAlerts({ status, breakerTripped, now }, config.alerts), now, log);
  await deps.notify?.(transitions, now);
  return transitions;
}

/**
 * Registers `ops.check-alerts` and its five-minute schedule. The registry's wrapper logs a failed run, and
 * graphile-worker retries it. On PGlite the jobs do not start; tests call `checkAlerts` directly.
 */
export function registerAlertJobs(jobs: JobRegistry, deps: AlertDeps): void {
  jobs.task(OPS_ALERTS_TASK, async () => {
    await checkAlerts(deps);
  });
  jobs.cron(OPS_ALERTS_TASK, OPS_ALERTS_SCHEDULE);
}
