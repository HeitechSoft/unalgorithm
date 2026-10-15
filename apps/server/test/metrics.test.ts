import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminOverview } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { fullOverview } from '../src/admin/queries.ts';
import { CONFIG_VARIABLES, ConfigError, loadConfig, SERVER_VERSION } from '../src/config.ts';
import type { Db } from '../src/db/client.ts';
import { opsAlerts, usageEvents, user } from '../src/db/schema.ts';
import { listOpenAlerts } from '../src/ops/alerts.ts';
import { METRICS_PATH, renderMetrics } from '../src/routes/metrics.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { createTestApp, TEST_ENV, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** The test servers' metrics token: 32 characters or more, recognisable in a log line. */
const TOKEN = 'metrics-token-0123456789abcdef-QZ';
/** The same length as `TOKEN`, one character apart. */
const SAME_LENGTH = `${TOKEN.slice(0, -1)}X`;
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
/** The accounts the content tests seed; neither id nor address may reach the body. */
const ADA = { id: 'metrics-account-ada', email: 'ada@example.com' };
const BEA = { id: 'metrics-account-bea', email: 'bea@example.com' };
/** Every non-comment line of a body (CL4-17 AC 4). */
const LINE = /^unalgorithm_[a-z0-9_]+(\{[a-z]+="[a-z0-9.+-]+"(,[a-z]+="[a-z0-9.+-]+")*\})? -?[0-9]+(\.[0-9]+)?$/;
/** The lines whose values depend on the machine the test runs on. */
const MACHINE = /^unalgorithm_(disk_free_bytes|disk_total_bytes|database_bytes) /;

/** Folders and apps a test opened, removed or closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function metricsApp(env: Record<string, string | undefined> = {}) {
  const t = await createTestApp({ config: testConfig({ METRICS_TOKEN: TOKEN, ...env }) });
  cleanup.push(() => t.close());
  return t;
}

/** `GET /metrics` with `Authorization: <authorization>` (none when undefined). */
function scrape(app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, authorization?: string) {
  return app.request(METRICS_PATH, { headers: authorization === undefined ? {} : { Authorization: authorization } });
}

/**
 * Two accounts with today's usage (5 posts in 2 requests costing $0.011, over the $0.01 limit, so the breaker is
 * tripped), a `local` backup status file and an open `spend-breaker` alert.
 */
async function seed(db: Db, statusDir: string) {
  const now = new Date();
  for (const a of [ADA, BEA]) {
    await db.insert(user).values({ id: a.id, name: '', email: a.email, emailVerified: true, createdAt: now, updatedAt: now });
  }
  const usage = (userId: string, postsOk: number, cost: number) => ({
    requestId: randomUUID(),
    userId,
    task: 'classify',
    model: 'mock-model',
    outcome: 'ok',
    postsRequested: postsOk,
    postsOk,
    calls: 1,
    failedCalls: 0,
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    webSearches: 0,
    estimated: false,
    costMicros: cost,
    chargeableCostMicros: cost,
    createdAt: now,
  });
  await db.insert(usageEvents).values([usage(ADA.id, 3, 4_000), usage(BEA.id, 2, 7_000)]);
  await writeFile(
    join(statusDir, 'local.json'),
    `${JSON.stringify({
      v: 1,
      kind: 'local',
      ok: true,
      finished_at: '2026-10-14T03:17:42Z',
      last_success_at: '2026-10-14T03:17:42Z',
      file: 'unalgorithm-20261014T031700Z.dump.gpg',
      bytes: 123_456,
      error: null,
    })}\n`,
  );
  await db.insert(opsAlerts).values({ key: 'spend-breaker', level: 'warning', openedAt: now, lastSeenAt: now, lastValue: null });
}

async function seededApp() {
  const statusDir = await mkdtemp(join(tmpdir(), 'ua-metrics-'));
  cleanup.push(() => rm(statusDir, { recursive: true, force: true }));
  const t = await metricsApp({ BACKUP_STATUS_DIR: statusDir, DAILY_SPEND_LIMIT_USD: '0.01' });
  await seed(t.deps.db.db, statusDir);
  return t;
}

/** The body's lines without the trailing empty one. */
const linesOf = (body: string) => body.split('\n').slice(0, -1);

describe('access', () => {
  it(
    'test_metrics_absent_without_token',
    async () => {
      const t = await metricsApp({ METRICS_TOKEN: undefined });
      expect(t.deps.config.metricsToken).toBeUndefined();
      for (const authorization of [undefined, `Bearer ${TOKEN}`, 'Bearer ']) {
        const res = await scrape(t.app, authorization);
        expect(res.status, String(authorization)).toBe(404);
        expect(await res.json()).toEqual(NOT_FOUND);
      }
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_metrics_bearer_token_checks',
    async () => {
      const t = await metricsApp();

      const missing = await scrape(t.app);
      expect(missing.status).toBe(401);
      expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer');
      expect(await missing.text()).toBe('Unauthorized');

      for (const wrong of [`Bearer ${SAME_LENGTH}`, `Bearer ${TOKEN}0`, 'Bearer short', 'Bearer ', TOKEN, `Basic ${TOKEN}`]) {
        expect(SAME_LENGTH).toHaveLength(TOKEN.length);
        const res = await scrape(t.app, wrong);
        expect(res.status, wrong).toBe(401);
        expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
        expect(await res.text()).toBe('Unauthorized');
      }

      const ok = await scrape(t.app, `Bearer ${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Content-Type')).toBe(CONTENT_TYPE);
      expect(ok.headers.get('Cache-Control')).toBe('no-store');
      expect(await ok.text()).toContain('unalgorithm_info{version=');
    },
    PGLITE_TIMEOUT,
  );
});

describe('content', () => {
  it(
    'test_metrics_snapshot_matches_overview',
    async () => {
      const t = await seededApp();
      const res = await scrape(t.app, `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      const lines = linesOf(body);

      const machine = lines.filter((line) => MACHINE.test(line));
      expect(machine).toHaveLength(3);
      for (const line of machine) expect(Number(line.split(' ')[1]), line).toBeGreaterThan(0);

      // The same state read by the overview renders the same lines (the machine's numbers can move between reads).
      const { db, config, log, errors } = t.deps;
      const overview = await fullOverview({
        db: db.db,
        config,
        log,
        errors: errors ?? never(),
        alerts: () => listOpenAlerts(db.db),
      });
      const stable = (text: string) => linesOf(text).filter((line) => !MACHINE.test(line));
      expect(stable(body)).toEqual(stable(renderMetrics(overview)));

      const placeholder = `version="${SERVER_VERSION}"`;
      expect(body).toContain(placeholder);
      expect(stable(body).join('\n').replace(placeholder, 'version="SERVER_VERSION"')).toMatchInlineSnapshot(`
        "# HELP unalgorithm_info The server's version, as a label; always 1.
        # TYPE unalgorithm_info gauge
        unalgorithm_info{version="SERVER_VERSION"} 1
        # HELP unalgorithm_users Accounts on this server.
        # TYPE unalgorithm_users gauge
        unalgorithm_users 2
        # HELP unalgorithm_posts_today Posts classified today (UTC).
        # TYPE unalgorithm_posts_today gauge
        unalgorithm_posts_today 5
        # HELP unalgorithm_requests_today AI requests today (UTC).
        # TYPE unalgorithm_requests_today gauge
        unalgorithm_requests_today 2
        # HELP unalgorithm_ai_cost_today_micros AI cost today (UTC), in micro-dollars.
        # TYPE unalgorithm_ai_cost_today_micros gauge
        unalgorithm_ai_cost_today_micros 11000
        # HELP unalgorithm_spend_limit_micros The daily AI spend limit, in micro-dollars.
        # TYPE unalgorithm_spend_limit_micros gauge
        unalgorithm_spend_limit_micros 10000
        # HELP unalgorithm_spend_breaker_tripped 1 when today's AI spend has reached the daily limit, else 0.
        # TYPE unalgorithm_spend_breaker_tripped gauge
        unalgorithm_spend_breaker_tripped 1
        # HELP unalgorithm_disk_free_bytes Free bytes on the fullest disk the server watches.
        # TYPE unalgorithm_disk_free_bytes gauge
        # HELP unalgorithm_disk_total_bytes Total bytes of that disk.
        # TYPE unalgorithm_disk_total_bytes gauge
        # HELP unalgorithm_database_bytes The database's size on disk, in bytes.
        # TYPE unalgorithm_database_bytes gauge
        # HELP unalgorithm_errors_15m Error log lines in the last 15 minutes.
        # TYPE unalgorithm_errors_15m gauge
        unalgorithm_errors_15m 0
        # HELP unalgorithm_backup_ok 1 when the backup's last run succeeded, else 0.
        # TYPE unalgorithm_backup_ok gauge
        unalgorithm_backup_ok{kind="local"} 1
        # HELP unalgorithm_backup_last_success_timestamp_seconds When the backup last succeeded, in Unix seconds.
        # TYPE unalgorithm_backup_last_success_timestamp_seconds gauge
        unalgorithm_backup_last_success_timestamp_seconds{kind="local"} 1791947862
        # HELP unalgorithm_alert_open 1 for each open alert.
        # TYPE unalgorithm_alert_open gauge
        unalgorithm_alert_open{key="spend-breaker",level="warning"} 1
        # HELP unalgorithm_alerts_open The number of open alerts.
        # TYPE unalgorithm_alerts_open gauge
        unalgorithm_alerts_open 1"
      `);
    },
    PGLITE_TIMEOUT,
  );

  it('test_render_metrics_line_format', () => {
    const full: AdminOverview = {
      version: '1.2.3-rc.4+build.5',
      users: 12,
      today: { day: '2026-10-15', posts: 340, requests: 21, costMicros: 45_678 },
      last30Days: [],
      spendLimitMicros: 5_000_000,
      breakerTripped: false,
      defaultDailyPostCap: 1000,
      ops: {
        diskFreeBytes: 40_000_000_000,
        diskTotalBytes: 100_000_000_000,
        databaseBytes: 81_920_000,
        errors15m: 3,
        backups: [
          {
            kind: 'local',
            ok: true,
            finishedAt: '2026-10-15T03:00:00Z',
            lastSuccessAt: '2026-10-15T03:00:00Z',
            bytes: 1,
            error: null,
          },
          {
            kind: 'offsite',
            ok: false,
            finishedAt: '2026-10-15T03:05:00.5Z',
            lastSuccessAt: '2026-10-14T03:05:00.5Z',
            bytes: null,
            error: 'copy',
          },
          { kind: 'cold-2', ok: false, finishedAt: null, lastSuccessAt: null, bytes: null, error: 'unreadable' },
        ],
        openAlerts: [
          { key: 'backup-offsite', level: 'critical', openedAt: '2026-10-15T03:06:00Z' },
          { key: 'errors-high', level: 'warning', openedAt: '2026-10-15T03:07:00Z' },
        ],
      },
    };
    const nullHeavy: AdminOverview = {
      ...full,
      ops: { diskFreeBytes: null, diskTotalBytes: null, databaseBytes: null, errors15m: 0, backups: null, openAlerts: [] },
    };
    const noOps: AdminOverview = { ...full, ops: null };

    const names = (body: string) =>
      new Set(
        linesOf(body)
          .filter((l) => !l.startsWith('#'))
          .map((l) => /^[a-z0-9_]+/.exec(l)?.[0]),
      );
    for (const overview of [full, nullHeavy, noOps]) {
      const body = renderMetrics(overview);
      expect(body.endsWith('\n')).toBe(true);
      const lines = linesOf(body);
      for (const line of lines.filter((l) => !l.startsWith('#'))) expect(line).toMatch(LINE);
      for (const name of names(body)) {
        expect(
          lines.filter((l) => l.startsWith(`# HELP ${name} `)),
          `${name} HELP`,
        ).toHaveLength(1);
        expect(
          lines.filter((l) => l === `# TYPE ${name} gauge`),
          `${name} TYPE`,
        ).toHaveLength(1);
      }
      // No comment for a metric without a line.
      for (const line of lines.filter((l) => l.startsWith('#'))) expect(names(body).has(line.split(' ')[2])).toBe(true);
    }

    const fullBody = renderMetrics(full);
    expect(fullBody).toContain('unalgorithm_info{version="1.2.3-rc.4+build.5"} 1\n');
    expect(fullBody).toContain('unalgorithm_backup_ok{kind="offsite"} 0\n');
    expect(fullBody).toContain('unalgorithm_backup_ok{kind="cold-2"} 0\n');
    expect(fullBody).toContain(
      `unalgorithm_backup_last_success_timestamp_seconds{kind="offsite"} ${Date.parse('2026-10-14T03:05:00.5Z') / 1000}\n`,
    );
    expect(fullBody).not.toContain('unalgorithm_backup_last_success_timestamp_seconds{kind="cold-2"}');
    expect(fullBody).toContain('unalgorithm_alert_open{key="backup-offsite",level="critical"} 1\n');
    expect(fullBody).toContain('unalgorithm_alerts_open 2\n');
    expect(fullBody).toContain('unalgorithm_spend_breaker_tripped 0\n');

    // Null measures give no line; what is known still does.
    const nullBody = renderMetrics(nullHeavy);
    for (const name of [
      'disk_free_bytes',
      'disk_total_bytes',
      'database_bytes',
      'backup_ok',
      'backup_last_success_timestamp_seconds',
      'alert_open',
    ]) {
      expect(nullBody).not.toMatch(new RegExp(`unalgorithm_${name}\\b`));
    }
    expect(nullBody).toContain('unalgorithm_errors_15m 0\n');
    expect(nullBody).toContain('unalgorithm_alerts_open 0\n');
    const noOpsBody = renderMetrics(noOps);
    expect(noOpsBody).not.toContain('errors_15m');
    expect(noOpsBody).not.toContain('alerts_open');
    expect(noOpsBody).toContain('unalgorithm_users 12\n');

    // Label values are never escaped: one that would need it is refused, never written.
    expect(() => renderMetrics({ ...full, version: '1.0.0"\n' })).toThrow(TypeError);
  });
});

describe('config and privacy', () => {
  it('test_metrics_token_config', () => {
    expect(CONFIG_VARIABLES).toContain('METRICS_TOKEN');
    expect(loadConfig({ ...TEST_ENV }).metricsToken).toBeUndefined();
    expect(loadConfig({ ...TEST_ENV, METRICS_TOKEN: '  ' }).metricsToken).toBeUndefined();
    // Kept exactly as given, as every secret.
    const spaced = ` ${'k'.repeat(32)} `;
    expect(loadConfig({ ...TEST_ENV, METRICS_TOKEN: spaced }).metricsToken).toBe(spaced);

    let error: unknown;
    try {
      loadConfig({ ...TEST_ENV, METRICS_TOKEN: 'k'.repeat(31) });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).invalid).toEqual([{ name: 'METRICS_TOKEN', reason: 'must be at least 32 characters' }]);
    expect((error as Error).message).not.toContain('k'.repeat(31));

    // Documented in the example, commented out and empty (env-example.test.ts holds its comment and its secrecy).
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(example).toMatch(/^# METRICS_TOKEN=$/m);
  });

  it(
    'test_metrics_hold_no_secret_or_account',
    async () => {
      const t = await seededApp();
      for (const authorization of [undefined, `Bearer ${SAME_LENGTH}`, `Bearer ${TOKEN}`]) await scrape(t.app, authorization);
      const body = await (await scrape(t.app, `Bearer ${TOKEN}`)).text();

      expect(body).toContain('unalgorithm_users 2\n');
      expect(body).not.toContain('@');
      for (const account of [ADA, BEA]) expect(body).not.toContain(account.id);

      expect(t.lines.length).toBeGreaterThan(0);
      for (const line of t.lines) {
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain(SAME_LENGTH);
        expect(line).not.toContain('@');
      }
    },
    PGLITE_TIMEOUT,
  );
});

/** `AppDeps.errors` is always set by `createTestApp`; this only satisfies the type. */
function never(): never {
  throw new Error('The test app has no error window.');
}
