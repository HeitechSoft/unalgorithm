import { randomUUID } from 'node:crypto';
import type { StatsFs } from 'node:fs';
import { readFileSync } from 'node:fs';
import {
  ADMIN_OVERVIEW_PATH,
  AdminOverviewSchema,
  AlertKeySchema,
  type BackupStatus,
  OpenAlertSchema,
} from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { adminOverview } from '../src/admin/queries.ts';
import { spendBreakerTripped } from '../src/ai/limits.ts';
import { ConfigError } from '../src/config.ts';
import { type Db, type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { opsAlerts, usageEvents, user } from '../src/db/schema.ts';
import { createJobRegistry, type JobHandler, type JobRegistry, startJobs } from '../src/jobs/worker.ts';
import {
  ALERT_RULE_KEYS,
  type AlertInputs,
  type AlertTransitions,
  applyAlerts,
  checkAlerts,
  evaluateAlerts,
  type Finding,
  listOpenAlerts,
  OPS_ALERTS_SCHEDULE,
  OPS_ALERTS_TASK,
  registerAlertJobs,
} from '../src/ops/alerts.ts';
import { createErrorWindow } from '../src/ops/error-window.ts';
import { createTestDb, queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { signInWeb } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const GB = 1_000_000_000;
const ADA = 'ada@example.com';

/** Databases and apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function pgliteDb(): Promise<DbHandle> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle;
}

/** A `statfs` answer of 500 GB free of 1 TB, so no test depends on the free space of the machine it runs on. */
const plentyOfSpace = async (): Promise<StatsFs> => {
  const bsize = 4096;
  const free = (500 * GB) / bsize;
  return { type: 0, bsize, blocks: (1000 * GB) / bsize, bfree: free, bavail: free, files: 0, ffree: 0 };
};

/** Nothing fires on these: plenty of disk, a small database, no errors, backups not watched, the breaker untripped. */
function quiet(status: Partial<AlertInputs['status']> = {}, breakerTripped = false, now = NOW): AlertInputs {
  return {
    status: { diskFreeBytes: 500 * GB, databaseBytes: GB, errors15m: 0, backups: null, ...status },
    breakerTripped,
    now,
  };
}

/** A `local` backup that finished `ok`, whose last success was `hoursAgo` hours before `NOW` (null: never). */
function backup(ok: boolean, hoursAgo: number | null): BackupStatus {
  const lastSuccessAt = hoursAgo === null ? null : new Date(NOW - hoursAgo * HOUR).toISOString();
  return { kind: 'local', ok, finishedAt: new Date(NOW).toISOString(), lastSuccessAt, bytes: 1, error: ok ? null : 'dump' };
}

async function addUser(db: Db, id: string, email: string) {
  const at = new Date(NOW);
  await db.insert(user).values({ id, name: '', email, emailVerified: true, createdAt: at, updatedAt: at });
}

/** One usage row costing `cost` micro-dollars at `createdAt`. */
async function addUsage(db: Db, userId: string, createdAt: Date, cost: number) {
  await db.insert(usageEvents).values({
    requestId: randomUUID(),
    userId,
    task: 'classify',
    model: 'mock-model',
    outcome: 'ok',
    postsRequested: 1,
    postsOk: 1,
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
    createdAt,
  });
}

describe('rules', () => {
  it('test_evaluate_alerts_thresholds', () => {
    const t = testConfig().alerts;
    const cases: [string, AlertInputs, Finding[]][] = [
      ['4.9 GB free', quiet({ diskFreeBytes: 4.9e9 }), [{ key: 'disk-free-low', level: 'critical', value: 4.9e9 }]],
      ['5 GB free', quiet({ diskFreeBytes: 5 * GB }), []],
      ['10.1 GB database', quiet({ databaseBytes: 10.1e9 }), [{ key: 'database-size-high', level: 'warning', value: 10.1e9 }]],
      ['10 GB database', quiet({ databaseBytes: 10 * GB }), []],
      ['20 errors', quiet({ errors15m: 20 }), [{ key: 'errors-high', level: 'warning', value: 20 }]],
      ['19 errors', quiet({ errors15m: 19 }), []],
      ['breaker tripped', quiet({}, true), [{ key: 'spend-breaker', level: 'warning', value: null }]],
      ['failed backup', quiet({ backups: [backup(false, 1)] }), [{ key: 'backup-local', level: 'critical', value: 1 }]],
      ['27 h old backup', quiet({ backups: [backup(true, 27)] }), [{ key: 'backup-local', level: 'critical', value: 27 }]],
      ['25 h old backup', quiet({ backups: [backup(true, 25)] }), []],
      ['never succeeded', quiet({ backups: [backup(true, null)] }), [{ key: 'backup-local', level: 'critical', value: null }]],
      ['backups not watched', quiet({ backups: null }), []],
      ['no disk or database measure', quiet({ diskFreeBytes: null, databaseBytes: null }), []],
    ];
    for (const [name, inputs, expected] of cases) expect(evaluateAlerts(inputs, t), name).toEqual(expected);

    // Everything at once: sorted by key, and every key fits the protocol's.
    const all = evaluateAlerts(
      quiet(
        {
          diskFreeBytes: GB,
          databaseBytes: 20 * GB,
          errors15m: 50,
          backups: [{ ...backup(false, 2), kind: 'offsite' }, backup(true, 30)],
        },
        true,
      ),
      t,
    );
    expect(all.map((f) => f.key)).toEqual([
      'backup-local',
      'backup-offsite',
      'database-size-high',
      'disk-free-low',
      'errors-high',
      'spend-breaker',
    ]);
    for (const { key } of all) expect(AlertKeySchema.safeParse(key).success, key).toBe(true);
    expect([...ALERT_RULE_KEYS].sort()).toEqual(['database-size-high', 'disk-free-low', 'errors-high', 'spend-breaker']);
  });

  it('test_evaluate_alerts_zero_turns_rules_off', () => {
    const t = testConfig({
      ALERT_DISK_FREE_MIN_GB: '0',
      ALERT_DATABASE_MAX_GB: '0',
      ALERT_ERRORS_PER_15M: '0',
      ALERT_BACKUP_MAX_AGE_HOURS: '0',
    }).alerts;
    expect(evaluateAlerts(quiet({ diskFreeBytes: 0, databaseBytes: 1e15, errors15m: 10_000 }), t)).toEqual([]);
    expect(evaluateAlerts(quiet({ backups: [backup(true, 10_000)] }), t)).toEqual([]);
    // Only failed runs still alert.
    expect(evaluateAlerts(quiet({ backups: [backup(false, 3)] }), t)).toEqual([
      { key: 'backup-local', level: 'critical', value: 3 },
    ]);
  });
});

describe('state', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_apply_alerts_opens_keeps_and_closes', async () => {
    const { db } = await pgliteDb();
    const { log, events } = captureLog();
    const disk: Finding = { key: 'disk-free-low', level: 'critical', value: 4.9e9 };
    const breaker: Finding = { key: 'spend-breaker', level: 'warning', value: null };

    const first = await applyAlerts(db, [disk, breaker], NOW, log);
    expect(first.opened).toEqual([disk, breaker]);
    expect(first.closed).toEqual([]);
    expect(first.open.map((r) => r.key)).toEqual(['disk-free-low', 'spend-breaker']);
    expect(first.open[0]).toEqual({
      key: 'disk-free-low',
      level: 'critical',
      openedAt: new Date(NOW),
      lastValue: 4.9e9,
      notifiedAt: null,
    });
    expect(events().filter((e) => e.event === 'alert.opened')).toEqual([
      expect.objectContaining({ level: 'warn', key: 'disk-free-low', alert_level: 'critical', value: 4.9e9 }),
      expect.objectContaining({ level: 'warn', key: 'spend-breaker', alert_level: 'warning', value: null }),
    ]);

    // The same findings five minutes later: nothing opens, the rows are seen again.
    const lower = { ...disk, value: 4.5e9 };
    const second = await applyAlerts(db, [lower, breaker], NOW + 5 * MINUTE, log);
    expect(second.opened).toEqual([]);
    expect(second.closed).toEqual([]);
    const rows = await db.select().from(opsAlerts).orderBy(opsAlerts.key);
    expect(rows.map((r) => [r.key, r.openedAt.getTime(), r.lastSeenAt.getTime(), r.lastValue])).toEqual([
      ['disk-free-low', NOW, NOW + 5 * MINUTE, 4.5e9],
      ['spend-breaker', NOW, NOW + 5 * MINUTE, null],
    ]);
    expect(events().filter((e) => e.event === 'alert.opened')).toHaveLength(2);

    // The disk clears: its row goes, and the closed entry carries the deleted row's values.
    const third = await applyAlerts(db, [breaker], NOW + 30 * MINUTE, log);
    expect(third.opened).toEqual([]);
    expect(third.closed).toEqual([{ key: 'disk-free-low', level: 'critical', openedAt: new Date(NOW), lastValue: 4.5e9 }]);
    expect(third.open).toEqual([
      { key: 'spend-breaker', level: 'warning', openedAt: new Date(NOW), lastValue: null, notifiedAt: null },
    ]);
    expect((await db.select().from(opsAlerts)).map((r) => r.key)).toEqual(['spend-breaker']);
    expect(events().filter((e) => e.event === 'alert.closed')).toEqual([
      expect.objectContaining({ level: 'info', key: 'disk-free-low', minutes_open: 30 }),
    ]);

    // Nothing found: everything closes.
    const last = await applyAlerts(db, [], NOW + 60 * MINUTE, log);
    expect(last.closed.map((c) => c.key)).toEqual(['spend-breaker']);
    expect(last.open).toEqual([]);
  });

  it('test_list_open_alerts_and_overview', async () => {
    const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: ADA }) });
    cleanup.push(() => t.close());
    const db = t.deps.db.db;
    const opened = (minutes: number) => new Date(NOW - minutes * MINUTE);
    await db.insert(opsAlerts).values([
      { key: 'spend-breaker', level: 'warning', openedAt: opened(5), lastSeenAt: opened(0), lastValue: null },
      { key: 'disk-free-low', level: 'critical', openedAt: opened(60), lastSeenAt: opened(0), lastValue: 4e9 },
      { key: 'backup-local', level: 'critical', openedAt: opened(30), lastSeenAt: opened(0), lastValue: 27 },
    ]);

    const list = await listOpenAlerts(db);
    expect(list).toEqual([
      { key: 'disk-free-low', level: 'critical', openedAt: opened(60).toISOString() },
      { key: 'backup-local', level: 'critical', openedAt: opened(30).toISOString() },
      { key: 'spend-breaker', level: 'warning', openedAt: opened(5).toISOString() },
    ]);
    for (const alert of list) expect(OpenAlertSchema.parse(alert)).toEqual(alert);

    const admin = await signInWeb(t.app, t.outbox, ADA);
    await db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
    const res = await t.app.request(ADMIN_OVERVIEW_PATH, { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    expect(AdminOverviewSchema.parse(await res.json()).ops?.openAlerts).toEqual(list);
  });

  it('test_check_alerts_spend_breaker_and_notify', async () => {
    const { db } = await pgliteDb();
    const config = testConfig({ DAILY_SPEND_LIMIT_USD: '5' });
    const { log } = captureLog();
    await addUser(db, 'u-ada', ADA);
    await addUsage(db, 'u-ada', new Date(NOW - HOUR), 5_000_000);

    const notified: AlertTransitions[] = [];
    const notify = vi.fn(async (t: AlertTransitions) => void notified.push(t));
    const deps = { db, config, log, errors: createErrorWindow(), notify, statfs: plentyOfSpace };
    const transitions = await checkAlerts(deps, NOW);
    expect(transitions.opened).toEqual([{ key: 'spend-breaker', level: 'warning', value: null }]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notified).toEqual([transitions]);
    expect(transitions.open.map((r) => r.key)).toEqual(['spend-breaker']);

    // The admin page's breaker and the alert's agree on either side of the limit.
    const fresh = (await pgliteDb()).db;
    await addUser(fresh, 'u-ada', ADA);
    await addUsage(fresh, 'u-ada', new Date(NOW - HOUR), 4_999_999);
    const at = new Date(NOW);
    expect(await spendBreakerTripped(fresh, config, at)).toBe(false);
    expect((await adminOverview(fresh, config, at)).breakerTripped).toBe(false);
    await addUsage(fresh, 'u-ada', new Date(NOW - MINUTE), 1);
    expect(await spendBreakerTripped(fresh, config, at)).toBe(true);
    expect((await adminOverview(fresh, config, at)).breakerTripped).toBe(true);
  });
});

describe('job', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_register_alert_jobs', async () => {
    const { db } = await pgliteDb();
    const deps = { db, config: testConfig(), log: captureLog().log, errors: createErrorWindow() };
    const tasks = new Map<string, JobHandler>();
    const schedules: [string, string][] = [];
    const recording: JobRegistry = {
      task: (name, handler) => tasks.set(name, handler),
      cron: (task, match) => schedules.push([task, match]),
    };
    registerAlertJobs(recording, deps);
    expect([...tasks.keys()]).toEqual(['ops.check-alerts']);
    expect(schedules).toEqual([['ops.check-alerts', '*/5 * * * *']]);
    expect([OPS_ALERTS_TASK, OPS_ALERTS_SCHEDULE]).toEqual(['ops.check-alerts', '*/5 * * * *']);

    const jobs = createJobRegistry();
    registerAlertJobs(jobs, deps);
    expect(() => registerAlertJobs(jobs, deps)).toThrow(TypeError);
  });

  describe.skipIf(!TEST_DATABASE_URL)('postgres', () => {
    it('test_alert_job_runs_on_postgres', async () => {
      const pg = await createPostgresTestDb('ua_alerts');
      cleanup.push(() => pg.drop());
      const handle = openPostgres(pg.url);
      cleanup.push(() => handle.close());
      const { log } = captureLog();
      await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log });
      // The job reads today's spend by the real clock.
      await addUser(handle.db, 'u-ada', ADA);
      await addUsage(handle.db, 'u-ada', new Date(), 5_000_000);

      const jobs = createJobRegistry();
      const config = testConfig({ DAILY_SPEND_LIMIT_USD: '5' });
      registerAlertJobs(jobs, { db: handle.db, config, log, errors: createErrorWindow(), statfs: plentyOfSpace });
      const running = await startJobs(handle, jobs, log);
      cleanup.push(() => running.stop());
      await running.addJob(OPS_ALERTS_TASK, {});
      await vi.waitFor(
        async () => expect((await handle.db.select().from(opsAlerts)).map((r) => r.key)).toContain('spend-breaker'),
        { timeout: 5_000, interval: 50 },
      );
    });
  });
});

describe('schema, config and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_ops_alerts_table_exists', async () => {
    const handle = await pgliteDb();
    const rows = await queryRows(
      handle,
      sql`select column_name from information_schema.columns where table_name = 'ops_alerts' order by ordinal_position`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['key', 'level', 'opened_at', 'last_seen_at', 'last_value', 'notified_at']);
  });

  it('test_alert_thresholds_config', () => {
    expect(testConfig().alerts).toEqual({
      diskFreeMinBytes: 5 * GB,
      databaseMaxBytes: 10 * GB,
      errorsPer15m: 20,
      backupMaxAgeMs: 26 * HOUR,
      email: { kind: 'admins' },
    });
    expect(
      testConfig({
        ALERT_DISK_FREE_MIN_GB: '2.5',
        ALERT_DATABASE_MAX_GB: '0',
        ALERT_ERRORS_PER_15M: '7',
        ALERT_BACKUP_MAX_AGE_HOURS: '48',
      }).alerts,
    ).toEqual({
      diskFreeMinBytes: 2.5 * GB,
      databaseMaxBytes: 0,
      errorsPer15m: 7,
      backupMaxAgeMs: 48 * HOUR,
      email: { kind: 'admins' },
    });

    for (const [name, value] of [
      ['ALERT_DISK_FREE_MIN_GB', '-1'],
      ['ALERT_DATABASE_MAX_GB', '1e3'],
      ['ALERT_ERRORS_PER_15M', '1.5'],
      ['ALERT_BACKUP_MAX_AGE_HOURS', 'x'],
    ] as const) {
      let error: unknown;
      try {
        testConfig({ [name]: value });
      } catch (err) {
        error = err;
      }
      expect(error, name).toBeInstanceOf(ConfigError);
      const { invalid, message } = error as ConfigError;
      expect(
        invalid.map((i) => i.name),
        name,
      ).toEqual([name]);
      expect(message, name).toMatch(new RegExp(`${name} \\(must be a (number of GB|whole number)`));
      expect(message, 'never the value').not.toContain(`(${value})`);
    }

    // The example documents each with its default.
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    for (const line of [
      '# ALERT_DISK_FREE_MIN_GB=5',
      '# ALERT_DATABASE_MAX_GB=10',
      '# ALERT_ERRORS_PER_15M=20',
      '# ALERT_BACKUP_MAX_AGE_HOURS=26',
    ]) {
      expect(example).toContain(line);
    }
  });

  it('test_alert_logs_hold_no_content', async () => {
    const { db } = await pgliteDb();
    const { log, events, lines } = captureLog();
    await addUser(db, 'u-ada', ADA);
    await addUsage(db, 'u-ada', new Date(NOW - HOUR), 5_000_000);
    const errors = createErrorWindow();
    for (let i = 0; i < 20; i++) errors.record(NOW);
    const deps = { db, config: testConfig({ ALERT_DISK_FREE_MIN_GB: '600' }), log, errors, statfs: plentyOfSpace };
    await checkAlerts(deps, NOW);
    await checkAlerts({ ...deps, errors: createErrorWindow() }, NOW + 45 * MINUTE);

    const alertLines = events().filter((e) => String(e.event).startsWith('alert.'));
    expect(alertLines.map((e) => [e.event, e.key])).toEqual([
      ['alert.opened', 'disk-free-low'],
      ['alert.opened', 'errors-high'],
      ['alert.opened', 'spend-breaker'],
      ['alert.closed', 'errors-high'],
    ]);
    const allowed = new Set(['t', 'level', 'event', 'key', 'alert_level', 'value', 'minutes_open']);
    for (const line of alertLines) for (const field of Object.keys(line)) expect(allowed, field).toContain(field);
    // Warnings and information only, so an alert never counts toward errors-high.
    expect(alertLines.map((e) => e.level)).toEqual(['warn', 'warn', 'warn', 'info']);
    expect(lines.filter((line) => line.includes('@'))).toEqual([]);
  });
});
