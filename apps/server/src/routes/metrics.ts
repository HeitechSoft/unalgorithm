/**
 * `GET /metrics` (R43, CL4-17): the admin page's server-wide numbers (`fullOverview`, CL4-05 and CL4-14) in the
 * Prometheus text format, for an operator's monitoring tool. Off unless `METRICS_TOKEN` is set (the path then does not
 * exist), and readable only with that bearer token. Every value is server-wide: no account, address or post. Each
 * scrape runs the overview's queries, so one a minute or slower is plenty.
 *
 * A plain route outside `/v1`: no extension CORS and no OpenAPI entry. The token travels only in a header, so neither
 * the server's `http` line (the path only) nor a proxy's log ever holds it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AdminOverview } from '@unalgorithm/protocol';
import { fullOverview } from '../admin/queries.ts';
import type { App, AppDeps } from '../http/app.ts';
import { listOpenAlerts } from '../ops/alerts.ts';
import { NO_ERRORS } from '../ops/error-window.ts';
import { NOT_FOUND } from './openapi.ts';

export const METRICS_PATH = '/metrics';
/** The Prometheus text exposition format. */
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
const BEARER = 'Bearer ';

/**
 * What a label value may hold. Every one comes from the server's own version, `BackupKindSchema`, `AlertKeySchema` or
 * `ALERT_LEVELS`, none of which allows a quote, a backslash or a line break, so none is escaped; one that would need it
 * is refused rather than written.
 */
const LABEL_VALUE = /^[a-z0-9.+-]+$/;

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

interface Family {
  name: string;
  help: string;
  samples: Sample[];
}

/** One sample, or none when the measure is null. */
const one = (value: number | null | undefined): Sample[] => (value === null || value === undefined ? [] : [{ value }]);

/**
 * The overview as Prometheus text: every metric a gauge with one `# HELP` and one `# TYPE` line, in a fixed order. A
 * metric without a value (a null measure, no backups, no open alert, or no `ops` block) is left out, comments and all.
 */
export function renderMetrics(overview: AdminOverview): string {
  const { ops } = overview;
  const backups = ops?.backups ?? [];
  const families: Family[] = [
    {
      name: 'unalgorithm_info',
      help: "The server's version, as a label; always 1.",
      samples: [{ labels: { version: overview.version }, value: 1 }],
    },
    { name: 'unalgorithm_users', help: 'Accounts on this server.', samples: one(overview.users) },
    { name: 'unalgorithm_posts_today', help: 'Posts classified today (UTC).', samples: one(overview.today.posts) },
    { name: 'unalgorithm_requests_today', help: 'AI requests today (UTC).', samples: one(overview.today.requests) },
    {
      name: 'unalgorithm_ai_cost_today_micros',
      help: 'AI cost today (UTC), in micro-dollars.',
      samples: one(overview.today.costMicros),
    },
    {
      name: 'unalgorithm_spend_limit_micros',
      help: 'The daily AI spend limit, in micro-dollars.',
      samples: one(overview.spendLimitMicros),
    },
    {
      name: 'unalgorithm_spend_breaker_tripped',
      help: "1 when today's AI spend has reached the daily limit, else 0.",
      samples: one(overview.breakerTripped ? 1 : 0),
    },
    {
      name: 'unalgorithm_disk_free_bytes',
      help: 'Free bytes on the fullest disk the server watches.',
      samples: one(ops?.diskFreeBytes),
    },
    { name: 'unalgorithm_disk_total_bytes', help: 'Total bytes of that disk.', samples: one(ops?.diskTotalBytes) },
    { name: 'unalgorithm_database_bytes', help: "The database's size on disk, in bytes.", samples: one(ops?.databaseBytes) },
    { name: 'unalgorithm_errors_15m', help: 'Error log lines in the last 15 minutes.', samples: one(ops?.errors15m) },
    {
      name: 'unalgorithm_backup_ok',
      help: "1 when the backup's last run succeeded, else 0.",
      samples: backups.map((b) => ({ labels: { kind: b.kind }, value: b.ok ? 1 : 0 })),
    },
    {
      name: 'unalgorithm_backup_last_success_timestamp_seconds',
      help: 'When the backup last succeeded, in Unix seconds.',
      samples: backups.flatMap((b) =>
        b.lastSuccessAt === null ? [] : [{ labels: { kind: b.kind }, value: Date.parse(b.lastSuccessAt) / 1000 }],
      ),
    },
    {
      name: 'unalgorithm_alert_open',
      help: '1 for each open alert.',
      samples: (ops?.openAlerts ?? []).map((a) => ({ labels: { key: a.key, level: a.level }, value: 1 })),
    },
    { name: 'unalgorithm_alerts_open', help: 'The number of open alerts.', samples: one(ops?.openAlerts.length) },
  ];

  const lines: string[] = [];
  for (const { name, help, samples } of families) {
    if (!samples.length) continue;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const { labels, value } of samples) lines.push(`${name}${labelText(labels)} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function labelText(labels: Record<string, string> | undefined): string {
  if (!labels) return '';
  const pairs = Object.entries(labels).map(([name, value]) => {
    // The message never repeats the value.
    if (!LABEL_VALUE.test(value)) throw new TypeError(`The ${name} label holds a character that needs escaping.`);
    return `${name}="${value}"`;
  });
  return `{${pairs.join(',')}}`;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Mounts `GET /metrics` on the app. */
export function metricsRoutes(app: App, deps: AppDeps): void {
  const { config, db, log } = deps;
  const expected = config.metricsToken === undefined ? undefined : sha256(config.metricsToken);

  app.get(METRICS_PATH, async (c) => {
    // As if the path did not exist.
    if (!expected) return c.json(NOT_FOUND, 404);
    const header = c.req.header('Authorization');
    const given = header?.startsWith(BEARER) ? header.slice(BEARER.length) : undefined;
    // Digests of equal length: the comparison takes the same time whatever was sent.
    if (given === undefined || !timingSafeEqual(sha256(given), expected)) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' });
    }
    const overview = await fullOverview({
      db: db.db,
      config,
      log,
      errors: deps.errors ?? NO_ERRORS,
      alerts: () => listOpenAlerts(db.db),
    });
    return c.body(renderMetrics(overview), 200, { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'no-store' });
  });
}
