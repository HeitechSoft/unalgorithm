import type { StatsFs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatBytes } from '@unalgorithm/core';
import { AlertKeySchema, type BackupStatus } from '@unalgorithm/protocol';
import { spendBreakerTripped } from '../ai/limits.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';
import { createLogger, type Logger } from '../log.ts';
import { type Mailer, smtpMailer } from '../mail/mailer.ts';
import { evaluateAlerts, type Finding } from '../ops/alerts.ts';
import { createErrorWindow } from '../ops/error-window.ts';
import { createAlertNotifier, plural } from '../ops/notify.ts';
import {
  brokenKey,
  CAP_KEY,
  evaluateReportAlerts,
  readReportCounts,
  reportAlertCounts,
  WAITING_KEY,
} from '../ops/report-alerts.ts';
import { readOpsStatus } from '../ops/status.ts';

/**
 * The alerts command (CL4-16): `node apps/server/src/cli/alerts.ts check | test [--key <key>]` (or `pnpm alerts`), with
 * the server's own environment; in production, inside the container with
 * `docker compose exec server node apps/server/src/cli/alerts.ts …`.
 *
 * `check` measures as the alert job does and prints one line per rule, writing and sending nothing: exit 0 when nothing
 * fires, 3 when something does. Thresholds come from the environment, so
 * `docker compose exec -e ALERT_DISK_FREE_MIN_GB=100000 server node apps/server/src/cli/alerts.ts check` shows a rule
 * firing without editing `.env`.
 *
 * `test` sends one test notification to every configured destination (the alert emails' recipients and the webhook),
 * printing a count of recipients and the webhook's HTTP status, never an address or the URL: exit 0 when every
 * destination took it, 1 otherwise. `--key` names the alert the test is about, a problem report alert
 * (`reports-linkedin-broken`, `reports-waiting`…) included, whose message links to the reports page.
 */

export interface AlertsCliDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
  /** Default: the server's SMTP mailer. */
  mailer?: Mailer;
  /** Default: global fetch. */
  fetch?: typeof fetch;
  /** Tests only, passed through to `readOpsStatus`. Default: `fs.promises.statfs`. */
  statfs?: (path: string) => Promise<StatsFs>;
  /** Default: warnings and errors to standard error. */
  log?: Logger;
}

export const ALERTS_USAGE = 'usage: node apps/server/src/cli/alerts.ts check | test [--key <key>]';
export const NO_DESTINATION = 'No alert destination: make an admin, or set ALERT_EMAIL or ALERT_WEBHOOK_URL.';
/** `check`'s exit code when a rule fires. */
export const EXIT_FIRING = 3;

const HOUR_MS = 3_600_000;

type Command = { name: 'check' } | { name: 'test'; key: string };

function parseArgs(argv: readonly string[]): Command | undefined {
  if (argv.length === 1 && argv[0] === 'check') return { name: 'check' };
  if (argv[0] !== 'test') return undefined;
  if (argv.length === 1) return { name: 'test', key: 'test' };
  const key = argv[2];
  if (argv.length === 3 && argv[1] === '--key' && AlertKeySchema.safeParse(key).success)
    return { name: 'test', key: key as string };
  return undefined;
}

export async function main(argv: readonly string[], deps: AlertsCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const command = parseArgs(argv);
  if (!command) {
    out(ALERTS_USAGE);
    return 1;
  }

  let config: Config;
  try {
    config = deps.config ?? loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }

  const log = deps.log ?? createLogger({ level: 'warn', sink: (line) => process.stderr.write(line) });
  const handle = deps.db ?? openPostgres(config.databaseUrl);
  try {
    if (command.name === 'check') return await check(handle, config, log, out, deps.statfs);
    const notifier = createAlertNotifier({
      db: handle.db,
      config,
      log,
      mailer: deps.mailer ?? smtpMailer(config.smtp, log),
      fetch: deps.fetch,
    });
    const result = await notifier.sendTest(command.key);
    if (result.email === null && result.webhook === null) {
      out(NO_DESTINATION);
      return 1;
    }
    out(result.email === null ? 'email: none configured' : `email: sent to ${plural(result.email, 'recipient')}`);
    out(
      result.webhook === null
        ? 'webhook: none configured'
        : result.webhook === 0
          ? 'webhook: no answer (a network error, a redirect or no answer within 5 seconds)'
          : `webhook: HTTP ${result.webhook}`,
    );
    return result.ok ? 0 : 1;
  } catch (err) {
    // A database error by name and code only: its message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`alerts failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

/** Measures as the job does (with a fresh, empty error window), evaluates, and prints one line per rule. */
async function check(
  handle: DbHandle,
  config: Config,
  log: Logger,
  out: (line: string) => void,
  statfs: AlertsCliDeps['statfs'],
): Promise<number> {
  const now = Date.now();
  const reportsWatched = config.reports.enabled && config.reports.alertNetworks > 0;
  const [status, breakerTripped, reportCounts] = await Promise.all([
    readOpsStatus({ db: handle.db, config, log, errors: createErrorWindow(), statfs, now }),
    spendBreakerTripped(handle.db, config, new Date(now)),
    reportsWatched ? reportAlertCounts(handle.db, now) : [],
  ]);
  const findings = [
    ...evaluateAlerts({ status, breakerTripped, now }, config.alerts),
    ...evaluateReportAlerts(reportCounts, config.reports, now),
  ];
  const byKey = new Map(findings.map((f) => [f.key, f]));
  const t = config.alerts;
  const line = (key: string, detail?: string) => {
    const f: Finding | undefined = byKey.get(key);
    out(`${key}: ${f ? `FIRING ${f.level}` : 'ok'}${detail === undefined ? '' : ` (${detail})`}`);
  };

  line(
    'disk-free-low',
    `free ${formatBytes(status.diskFreeBytes)}, ${t.diskFreeMinBytes > 0 ? `alert below ${formatBytes(t.diskFreeMinBytes)}` : 'alert off'}`,
  );
  line(
    'database-size-high',
    `${formatBytes(status.databaseBytes)}, ${t.databaseMaxBytes > 0 ? `alert above ${formatBytes(t.databaseMaxBytes)}` : 'alert off'}`,
  );
  line('spend-breaker');
  if (status.backups === null) out('backups: not watched (BACKUP_STATUS_DIR is unset)');
  else if (status.backups.length === 0) out('backups: no backup has reported yet');
  for (const backup of status.backups ?? []) line(`backup-${backup.kind}`, backupDetail(backup, now));
  if (!config.reports.enabled) out('reports: off (REPORTS is off)');
  else if (!reportsWatched) out('reports: alerts off (REPORTS_ALERT_NETWORKS is 0)');
  else {
    const reading = readReportCounts(reportCounts, now);
    const opens = config.reports.alertNetworks;
    for (const [platform, { networks }] of Object.entries(reading.platforms)) {
      line(
        brokenKey(platform as keyof typeof reading.platforms),
        `${plural(networks, 'network')} in 24 hours, alert at ${opens} with a sign of breakage or ${2 * opens} without`,
      );
    }
    line(WAITING_KEY, `${plural(reading.waiting, 'report')} unhandled for more than 24 hours`);
    line(CAP_KEY, `${plural(reading.today, 'report')} today, limit ${config.reports.dailyMax}`);
  }
  out('errors-high: not checked here (the server process counts its own errors)');
  return findings.length > 0 ? EXIT_FIRING : 0;
}

function backupDetail(backup: BackupStatus, now: number): string {
  const run = backup.ok ? 'last run ok' : 'last run failed';
  const lastSuccess = backup.lastSuccessAt === null ? Number.NaN : Date.parse(backup.lastSuccessAt);
  if (Number.isNaN(lastSuccess)) return `${run}, no successful backup yet`;
  return `${run}, last success ${plural((now - lastSuccess) / HOUR_MS, 'hour')} ago`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
