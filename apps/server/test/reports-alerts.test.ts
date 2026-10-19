/**
 * The problem report alerts (ADR 0009 §8): the pure rule on counts, the one counts query on stored reports, the alert
 * check and its messages, and the alerts command. Reports are written straight into the table at chosen times.
 */
import type { StatsFs } from 'node:fs';
import { adapterOrder, latestAdapterOrder } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { main } from '../src/cli/alerts.ts';
import type { Db, DbHandle } from '../src/db/client.ts';
import { opsAlerts, problemReports, reportFloors, user } from '../src/db/schema.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { checkAlerts } from '../src/ops/alerts.ts';
import { createErrorWindow } from '../src/ops/error-window.ts';
import { ALERT_TITLES, type AlertState, alertMessage, createAlertNotifier, webhookBody } from '../src/ops/notify.ts';
import {
  CRITICAL_NETWORKS,
  evaluateReportAlerts,
  type ReportBucket,
  readReportCounts,
  reportAlertCounts,
} from '../src/ops/report-alerts.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { correctionDetails, insertReport, report, reportApp } from './support/reports.ts';
import { testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-19T15:20:00.000Z');
const HOUR = 3_600_000;
const GB = 1_000_000_000;
const ON = { enabled: true, alertNetworks: 2, dailyMax: 1000 };

/** Databases a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function pgliteDb(): Promise<DbHandle> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle;
}

/** Open, recent, listed LinkedIn detection reports of today from one network, without positive evidence. */
function bucket(extra: Partial<ReportBucket> = {}): ReportBucket {
  return {
    platform: 'linkedin',
    adapterOrder: 2026010002,
    floorOrder: null,
    listed: true,
    development: false,
    detection: true,
    positive: false,
    open: true,
    recent: true,
    today: true,
    reports: 1,
    networks: 1,
    ...extra,
  };
}

const plentyOfSpace = async (): Promise<StatsFs> => {
  const bsize = 4096;
  const free = (500 * GB) / bsize;
  return { type: 0, bsize, blocks: (1000 * GB) / bsize, bfree: free, bavail: free, files: 0, ffree: 0 };
};

describe('rule', () => {
  it('test_report_alert_rules', () => {
    const evaluate = (buckets: ReportBucket[], t = ON) => evaluateReportAlerts(buckets, t, NOW);
    const broken = (networks: number, level = 'warning') => [{ key: 'reports-linkedin-broken', level, value: networks }];
    const cases: [string, ReportBucket[], unknown[]][] = [
      ['one network, positive', [bucket({ positive: true })], []],
      ['two networks, one positive', [bucket({ positive: true }), bucket()], broken(2)],
      ['two networks, none positive', [bucket(), bucket()], []],
      ['three networks, none positive', [bucket({ networks: 3, reports: 3 })], []],
      ['four networks, none positive', [bucket({ networks: 4, reports: 6 })], broken(4)],
      ['five networks', [bucket({ networks: 5, reports: 5, positive: true })], broken(5, 'critical')],
      // One person, many reports: one network.
      ['one network, many reports', [bucket({ networks: 1, reports: 40, positive: true })], []],
      // Below the floor, or dated in a future month: never counted.
      ['below the floor', [bucket({ networks: 2, positive: true, floorOrder: 2026010003 })], []],
      ['at the floor', [bucket({ networks: 2, positive: true, floorOrder: 2026010002 })], broken(2)],
      // One network on both sides of midnight UTC has a bit on each day: the day with more networks counts.
      ['one network either side of midnight', [bucket({ positive: true }), bucket({ today: false })], []],
      ['two today, one yesterday', [bucket({ networks: 2, positive: true }), bucket({ today: false })], broken(2)],
      ['one today, two yesterday', [bucket(), bucket({ today: false, networks: 2, positive: true })], broken(2)],
      ['a future month', [bucket({ networks: 2, positive: true, adapterOrder: 2026011000 })], []],
      ['the last of this month', [bucket({ networks: 2, positive: true, adapterOrder: 2026010999 })], broken(2)],
      ['development builds', [bucket({ networks: 9, positive: true, development: true })], []],
      ['unlisted extensions', [bucket({ networks: 9, positive: true, listed: false })], []],
      ['handled', [bucket({ networks: 9, positive: true, open: false })], []],
      ['not detection', [bucket({ networks: 9, positive: false, detection: false })], []],
      [
        'Facebook',
        [bucket({ platform: 'facebook', networks: 2, positive: true })],
        [{ key: 'reports-facebook-broken', level: 'warning', value: 2 }],
      ],
      // Older than a day and still open: waiting, whatever the kind, listed and not development only.
      [
        'waiting',
        [
          bucket({ recent: false, today: false, reports: 3, networks: 3, positive: true }),
          bucket({ recent: false, today: false, platform: null, adapterOrder: null, detection: false, networks: 0 }),
          bucket({ recent: false, today: false, development: true, reports: 5 }),
          bucket({ recent: false, today: false, listed: false, reports: 7 }),
        ],
        [{ key: 'reports-waiting', level: 'warning', value: 4 }],
      ],
      // Today's total counts every report, as the daily limit does.
      [
        'cap',
        [
          bucket({ reports: 400, networks: 0, development: true }),
          bucket({ reports: 600, networks: 0, listed: false, open: false }),
        ],
        [{ key: 'reports-cap', level: 'warning', value: 1000 }],
      ],
    ];
    for (const [name, buckets, expected] of cases) expect(evaluate(buckets), name).toEqual(expected);
    expect(CRITICAL_NETWORKS).toBe(5);

    // Off, or with REPORTS_ALERT_NETWORKS at 0: no report alert at all.
    const busy = [bucket({ networks: 9, positive: true }), bucket({ recent: false }), bucket({ reports: 2000 })];
    expect(evaluate(busy).map((f) => f.key)).toEqual(['reports-linkedin-broken', 'reports-waiting', 'reports-cap']);
    expect(evaluate(busy, { ...ON, enabled: false })).toEqual([]);
    expect(evaluate(busy, { ...ON, alertNetworks: 0 })).toEqual([]);
    // A higher threshold.
    expect(evaluate([bucket({ networks: 3, positive: true })], { ...ON, alertNetworks: 4 })).toEqual([]);
    expect(evaluate([bucket({ networks: 4, positive: true })], { ...ON, alertNetworks: 4 })).toEqual(broken(4));
  });
});

describe('counts', { timeout: PGLITE_TIMEOUT }, () => {
  /** Stored reports that make each report alert fire, and some that must not count. */
  async function seed(db: Db) {
    const at = (hoursAgo: number) => new Date(Math.floor(NOW / HOUR) * HOUR - hoursAgo * HOUR);
    const noIssue = { page: undefined, health: { status: 'ok', issues: ['no-ads-seen'], degraded: [] } };
    // LinkedIn: two networks, one with a positive-evidence issue (the default report's `ad-label-near-miss`).
    await insertReport(db, at(1));
    await insertReport(db, at(2), { details: noIssue, topic: 'no-ads-seen' });
    // The same network again: not a new network.
    await insertReport(db, at(2), { firstFromNetwork: false });
    // Not counted: handled, unlisted, development, a future month, wrong-call.
    await insertReport(db, at(1), { handledAt: new Date(NOW), resolution: 'fixed' });
    await insertReport(db, at(1), { listed: false });
    await insertReport(db, at(1), { channel: 'development' });
    await insertReport(db, at(1), { adapter: 'linkedin@2026.11.0', adapterOrder: 2026011000 });
    await insertReport(db, at(1), { kind: 'wrong-call', topic: 'suggested' });
    // Facebook: one network only.
    await insertReport(db, at(1), { platform: 'facebook', adapter: 'facebook@2026.10.2', adapterOrder: 2026010002 });
    // A correction waiting since yesterday.
    await insertReport(db, at(30), {
      kind: 'correction',
      platform: null,
      adapter: null,
      adapterOrder: null,
      topic: 'factcheck',
      details: correctionDetails(),
      firstFromNetwork: false,
    });
  }

  it('test_report_alert_counts_from_stored_reports', async () => {
    const { db } = await pgliteDb();
    await seed(db);
    const buckets = await reportAlertCounts(db, NOW);
    const reading = readReportCounts(buckets, NOW);
    expect(reading).toEqual({
      platforms: { linkedin: { networks: 2, positive: true }, facebook: { networks: 1, positive: true } },
      waiting: 1,
      // Every report received since 00:00 UTC, the handled, unlisted and development ones too.
      today: 9,
    });
    expect(evaluateReportAlerts(buckets, ON, NOW)).toEqual([
      { key: 'reports-linkedin-broken', level: 'warning', value: 2 },
      { key: 'reports-waiting', level: 'warning', value: 1 },
    ]);
    // A floor above the reports' version: LinkedIn no longer counts them.
    await db.insert(reportFloors).values({
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.3',
      adapterOrder: 2026010003,
      setAt: new Date(NOW),
    });
    expect(readReportCounts(await reportAlertCounts(db, NOW), NOW).platforms.linkedin.networks).toBe(0);
  });

  it('test_check_alerts_opens_report_alerts_and_emails', async () => {
    const { db } = await pgliteDb();
    await seed(db);
    await db.insert(user).values({
      id: 'u-ada',
      name: '',
      email: 'ada@example.com',
      emailVerified: true,
      role: ADMIN_ROLE,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
    const { mailer, outbox } = memoryMailer();
    const { log, events } = captureLog();
    const check = async (env: Record<string, string>) => {
      const config = testConfig(env);
      const notifier = createAlertNotifier({ db, config, log, mailer });
      return checkAlerts({ db, config, log, errors: createErrorWindow(), statfs: plentyOfSpace, notify: notifier.notify }, NOW);
    };
    // Off: nothing about reports, whatever is stored.
    expect((await check({})).opened).toEqual([]);
    const on = await check({ REPORTS: 'on' });
    expect(on.opened.map((f) => f.key)).toEqual(['reports-linkedin-broken', 'reports-waiting']);
    expect(outbox.map((m) => m.subject).sort()).toEqual([
      '[Test server] LinkedIn filtering is reported broken',
      '[Test server] Problem reports are waiting',
    ]);
    const broken = outbox.find((m) => m.subject.includes('LinkedIn'));
    expect(broken?.text.split('\n')).toEqual([
      'Reports from 2 networks in the last 24 hours; the alert opens at 2 with a clear sign of breakage, or 4 without.',
      '',
      'Level: warning.',
      'Admin page: http://127.0.0.1:8787/admin/reports',
    ]);
    // REPORTS_ALERT_NETWORKS=0 turns them off: the open ones close.
    const quiet = await check({ REPORTS: 'on', REPORTS_ALERT_NETWORKS: '0' });
    expect(quiet.closed.map((c) => c.key)).toEqual(['reports-linkedin-broken', 'reports-waiting']);
    expect(await db.select().from(opsAlerts)).toEqual([]);
    expect(
      outbox
        .filter((m) => m.subject.includes('Resolved: '))
        .map((m) => m.subject)
        .sort(),
    ).toEqual([
      '[Test server] Resolved: LinkedIn filtering is reported broken',
      '[Test server] Resolved: Problem reports are waiting',
    ]);
    for (const line of events().filter((e) => String(e.event).startsWith('alert.'))) {
      expect(
        Object.keys(line).every((k) => ['t', 'level', 'event', 'key', 'alert_level', 'value', 'minutes_open'].includes(k)),
      ).toBe(true);
    }
  });

  it('test_report_cap_alert', async () => {
    const { db } = await pgliteDb();
    for (let i = 0; i < 3; i++)
      await insertReport(db, new Date(Math.floor(NOW / HOUR) * HOUR), { handledAt: new Date(NOW), resolution: 'spam' });
    const config = testConfig({ REPORTS: 'on', REPORTS_DAILY_MAX: '3' });
    const t = await checkAlerts({ db, config, log: captureLog().log, errors: createErrorWindow(), statfs: plentyOfSpace }, NOW);
    expect(t.opened).toEqual([{ key: 'reports-cap', level: 'warning', value: 3 }]);
    // The next UTC day it closes.
    const tomorrow = Date.parse('2026-10-20T00:05:00.000Z');
    const next = await checkAlerts(
      { db, config, log: captureLog().log, errors: createErrorWindow(), statfs: plentyOfSpace },
      tomorrow,
    );
    expect(next.closed.map((c) => c.key)).toEqual(['reports-cap']);
  });
});

describe('messages', () => {
  it('test_report_alert_messages_are_content_free', () => {
    const config = testConfig({ REPORTS: 'on', PUBLIC_URL: 'https://alerts.example.org', INSTANCE_NAME: 'Example AI' });
    const alerts = [
      { key: 'reports-linkedin-broken', level: 'warning', value: 3 },
      { key: 'reports-facebook-broken', level: 'critical', value: 6 },
      { key: 'reports-waiting', level: 'warning', value: 1 },
      { key: 'reports-cap', level: 'warning', value: 1000 },
    ];
    const states: AlertState[] = ['opened', 'reminder', 'closed', 'test'];
    const titles = alerts.map((a) => ALERT_TITLES[a.key] ?? '');
    expect(titles).toEqual([
      'LinkedIn filtering is reported broken',
      'Facebook filtering is reported broken',
      'Problem reports are waiting',
      "Problem reports reached today's limit",
    ]);
    const allowed = new Set([
      '[<name>] <title>',
      '[<name>] Still open: <title>',
      '[<name>] Resolved: <title>',
      '[<name>] Test: <title>',
      '',
      'This alert is still open.',
      'This alert is resolved. The last reading before it closed:',
      'This is a test notification sent with the alerts command.',
      'Reports from # networks in the last # hours; the alert opens at # with a clear sign of breakage, or # without.',
      '# report unhandled for more than # hours.',
      '# reports accepted today; the limit is #.',
      'Reports are accepted again at # UTC.',
      'Level: critical.',
      'Level: warning.',
      'Admin page: <url>/admin/reports',
    ]);
    const normalize = (line: string) => {
      let out = line.replaceAll('Example AI', '<name>').replaceAll('https://alerts.example.org', '<url>');
      for (const title of titles) out = out.replaceAll(title, '<title>');
      return out.replace(/\d+(?:[.,:]\d+)*/g, '#');
    };
    const seen = new Set<string>();
    for (const a of alerts) {
      for (const state of states) {
        const { subject, text } = alertMessage(state, a, config);
        const body = webhookBody(state, a, config, new Date(NOW));
        for (const part of [subject, text, body]) expect(part, `${a.key} ${state}`).not.toContain('@');
        for (const line of [subject, ...text.split('\n')]) {
          const shape = normalize(line);
          expect(allowed, `${a.key} ${state}: ${line}`).toContain(shape);
          seen.add(shape);
        }
        expect(JSON.parse(body)).toMatchObject({ key: a.key, level: a.level, value: a.value, state });
      }
    }
    expect(seen).toEqual(allowed);
  });
});

describe('command', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alerts_cli_covers_reports', async () => {
    const handle = await pgliteDb();
    const run = async (argv: string[], env: Record<string, string | undefined>) => {
      const out: string[] = [];
      const { mailer, outbox } = memoryMailer();
      const code = await main(argv, {
        db: handle,
        config: testConfig(env),
        out: (line) => out.push(line),
        statfs: plentyOfSpace,
        mailer,
        log: captureLog().log,
      });
      return { code, out, outbox };
    };
    // Two LinkedIn networks with a sign of breakage, by the real clock: the command measures now.
    const hour = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    await insertReport(handle.db, hour);
    await insertReport(handle.db, hour);
    const firing = await run(['check'], { REPORTS: 'on' });
    expect(firing.code).toBe(3);
    expect(firing.out.filter((line) => line.startsWith('reports-'))).toEqual([
      'reports-linkedin-broken: FIRING warning (2 networks in 24 hours, alert at 2 with a sign of breakage or 4 without)',
      'reports-facebook-broken: ok (0 networks in 24 hours, alert at 2 with a sign of breakage or 4 without)',
      'reports-waiting: ok (0 reports unhandled for more than 24 hours)',
      'reports-cap: ok (2 reports today, limit 1000)',
    ]);
    expect((await run(['check'], { REPORTS: 'on', REPORTS_ALERT_NETWORKS: '0' })).out).toContain(
      'reports: alerts off (REPORTS_ALERT_NETWORKS is 0)',
    );
    expect(await handle.db.select().from(opsAlerts)).toEqual([]);

    // The live alert test covers the report keys: their message links to the reports page.
    const sent = await run(['test', '--key', 'reports-linkedin-broken'], { ALERT_EMAIL: 'ops@example.org' });
    expect(sent.code).toBe(0);
    expect(sent.outbox.map((m) => m.subject)).toEqual(['[Test server] Test: LinkedIn filtering is reported broken']);
    expect(sent.outbox[0]?.text).toContain('Admin page: http://127.0.0.1:8787/admin/reports');
    for (const key of ['reports-facebook-broken', 'reports-waiting', 'reports-cap']) {
      expect((await run(['test', '--key', key], { ALERT_EMAIL: 'ops@example.org' })).code, key).toBe(0);
    }
  });
});

describe('networks through the intake', { timeout: PGLITE_TIMEOUT }, () => {
  /** A report app that reads the client's address from `X-Forwarded-For`, closed after the test. */
  async function app() {
    const r = await reportApp({ TRUST_PROXY: 'one-hop' });
    cleanup.push(() => r.t.close());
    return r;
  }
  /** A LinkedIn detection report naming `adapter`, with a positive-evidence issue unless `issues` says otherwise. */
  const detection = (adapter: string, issues: string[] = ['ad-label-near-miss']) =>
    report('detection', {
      page: { platform: 'linkedin', adapter, route: 'feed', lang: 'en', preset: 'balanced', ai: 'off', paused: false },
      health: { status: issues.length ? 'broken' : 'ok', issues, degraded: [] },
    });
  /** The report alerts on what was stored, now. */
  const alerts = async (r: Awaited<ReturnType<typeof app>>) =>
    evaluateReportAlerts(await reportAlertCounts(r.db, Date.now()), r.t.deps.config.reports, Date.now());

  it('test_one_sender_naming_many_versions_is_one_network', async () => {
    const r = await app();
    // This month's versions, so none is dated in a future month whenever the test runs.
    const today = new Date();
    const version = (patch: number) => `linkedin@${today.getUTCFullYear()}.${today.getUTCMonth() + 1}.${patch}`;
    for (const patch of [1, 2, 3, 4, 5]) {
      expect(adapterOrder(version(patch)) as number).toBeLessThanOrEqual(latestAdapterOrder(today));
      const sent = await r.send(detection(version(patch), patch === 1 ? ['ad-label-near-miss'] : []), { ip: '192.0.2.7' });
      expect(sent.status).toBe(201);
    }
    const stored = await r.db.select({ first: problemReports.firstFromNetwork }).from(problemReports);
    expect(stored.filter((row) => row.first)).toHaveLength(1);
    expect(await alerts(r)).toEqual([]);
    // A second network makes two: the alert opens on positive evidence.
    expect((await r.send(detection(version(2)), { ip: '198.51.100.9' })).status).toBe(201);
    expect(await alerts(r)).toEqual([{ key: 'reports-linkedin-broken', level: 'warning', value: 2 }]);
  });

  it('test_a_wrong_call_first_leaves_the_networks_detection_bit', async () => {
    const r = await app();
    expect((await r.send(report('wrong-call'), { ip: '192.0.2.7' })).status).toBe(201);
    expect((await r.send(report('detection'), { ip: '192.0.2.7' })).status).toBe(201);
    expect((await r.send(report('detection'), { ip: '198.51.100.9' })).status).toBe(201);
    const stored = await r.db.select({ kind: problemReports.kind, first: problemReports.firstFromNetwork }).from(problemReports);
    expect(stored.filter((row) => row.kind === 'detection' && row.first)).toHaveLength(2);
    expect((await alerts(r)).map((f) => f.key)).toEqual(['reports-linkedin-broken']);
  });
});
