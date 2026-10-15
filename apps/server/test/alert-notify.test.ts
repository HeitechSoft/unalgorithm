import type { StatsFs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { ALERTS_USAGE, main, NO_DESTINATION } from '../src/cli/alerts.ts';
import { type Config, ConfigError } from '../src/config.ts';
import type { Db, DbHandle } from '../src/db/client.ts';
import { opsAlerts, user } from '../src/db/schema.ts';
import type { Logger } from '../src/log.ts';
import { type Mailer, type MailMessage, memoryMailer } from '../src/mail/mailer.ts';
import { type AlertTransitions, checkAlerts } from '../src/ops/alerts.ts';
import { createErrorWindow } from '../src/ops/error-window.ts';
import {
  ALERT_TITLES,
  type AlertState,
  type AlertSummary,
  alertMessage,
  createAlertNotifier,
  RENOTIFY_MS,
  webhookBody,
} from '../src/ops/notify.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-14T03:20:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const GB = 1_000_000_000;
const ADA = 'ada@example.com';
const BOB = 'bob@example.com';
const CY = 'cy@example.com';
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;

/** Databases, servers and folders a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function pgliteDb(): Promise<DbHandle> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle;
}

/** A `statfs` answer of `free` bytes free of 1 TB, so no test depends on the disk of the machine it runs on. */
const diskFree = (free: number) => async (): Promise<StatsFs> => ({
  type: 0,
  bsize: 1,
  blocks: 1000 * GB,
  bfree: free,
  bavail: free,
  files: 0,
  ffree: 0,
});

async function addUser(db: Db, id: string, email: string, extra: { role?: string; banned?: boolean } = {}) {
  const at = new Date(NOW);
  await db.insert(user).values({ id, name: '', email, emailVerified: true, createdAt: at, updatedAt: at, ...extra });
}

/** Ada is an admin, Bob an admin whose access is removed, Cy a user. */
async function seedPeople(db: Db) {
  await addUser(db, 'u-ada', ADA, { role: ADMIN_ROLE });
  await addUser(db, 'u-bob', BOB, { role: ADMIN_ROLE, banned: true });
  await addUser(db, 'u-cy', CY);
}

async function notifiedAt(db: Db, key: string): Promise<Date | null | undefined> {
  const [row] = await db.select({ at: opsAlerts.notifiedAt }).from(opsAlerts).where(eq(opsAlerts.key, key));
  return row?.at;
}

interface Harness {
  db: Db;
  config: Config;
  log: Logger;
  lines: string[];
  events: () => Record<string, unknown>[];
  outbox: MailMessage[];
  notifier: ReturnType<typeof createAlertNotifier>;
  /** One alert check at `now` with `free` bytes of disk free, notifying through the notifier. */
  check(now: number, free?: number): Promise<AlertTransitions>;
}

async function harness(env: Record<string, string | undefined> = {}, mailer?: Mailer, fetcher?: typeof fetch): Promise<Harness> {
  const { db } = await pgliteDb();
  const config = testConfig(env);
  const { log, lines, events } = captureLog();
  const memory = memoryMailer();
  const notifier = createAlertNotifier({ db, config, log, mailer: mailer ?? memory.mailer, fetch: fetcher });
  return {
    db,
    config,
    log,
    lines,
    events,
    outbox: memory.outbox,
    notifier,
    check: (now, free = 4.9e9) =>
      checkAlerts({ db, config, log, errors: createErrorWindow(), statfs: diskFree(free), notify: notifier.notify }, now),
  };
}

interface Hook {
  url: string;
  /** Each request's path, content type and parsed body. */
  requests: { path: string; contentType: string | undefined; body: Record<string, unknown> }[];
  /** How the next requests are answered: a status, or `hang` (no answer until the server closes). */
  answer: number | 'hang';
}

/** A webhook receiver on 127.0.0.1. A 3xx answer redirects to `/elsewhere` on the same server. */
async function startHook(): Promise<Hook> {
  const hook: Hook = { url: '', requests: [], answer: 204 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      hook.requests.push({
        path: req.url ?? '',
        contentType: req.headers['content-type'],
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      });
      if (hook.answer === 'hang') return;
      const headers = hook.answer >= 300 && hook.answer < 400 ? { location: '/elsewhere' } : {};
      res.writeHead(hook.answer, headers).end(hook.answer === 500 ? 'Internal error at the hook' : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  hook.url = `http://127.0.0.1:${port}/hook?token=hook-secret-token-0123`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return hook;
}

describe('email', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alert_email_goes_to_active_admins', async () => {
    const h = await harness();
    await seedPeople(h.db);
    await h.check(NOW);

    expect(h.outbox).toHaveLength(1);
    const [mail] = h.outbox;
    expect(mail?.to).toBe(ADA);
    expect(mail?.subject).toBe('[Test server] Disk space is low');
    expect(mail?.text).toContain('Free disk space: 4.9 GB; the alert opens below 5.0 GB.');
    expect(mail?.text).toContain('Level: critical.');
    expect(mail?.text).toContain(`Admin page: ${TEST_PUBLIC_URL}/admin`);
    expect(await notifiedAt(h.db, 'disk-free-low')).toEqual(new Date(NOW));
  });

  it('test_alert_reminder_and_resolved', async () => {
    const h = await harness();
    await seedPeople(h.db);
    await h.check(NOW);
    expect(h.outbox).toHaveLength(1);

    // Still open five minutes later, at a lower reading: nothing new.
    await h.check(NOW + 5 * MINUTE, 4.5e9);
    expect(h.outbox).toHaveLength(1);

    // The last notification 25 hours ago: a reminder, and notified_at moves.
    const later = NOW + 10 * MINUTE;
    await h.db
      .update(opsAlerts)
      .set({ notifiedAt: new Date(later - 25 * HOUR) })
      .where(eq(opsAlerts.key, 'disk-free-low'));
    await h.check(later, 4.5e9);
    expect(h.outbox).toHaveLength(2);
    expect(h.outbox[1]?.subject).toBe('[Test server] Still open: Disk space is low');
    expect(h.outbox[1]?.text).toContain('This alert is still open.');
    expect(await notifiedAt(h.db, 'disk-free-low')).toEqual(new Date(later));
    expect(RENOTIFY_MS).toBe(24 * HOUR);

    // The disk clears: one Resolved message with the closed entry's level and last value, then nothing.
    const cleared = await h.check(later + 5 * MINUTE, 500 * GB);
    expect(cleared.closed).toEqual([expect.objectContaining({ key: 'disk-free-low', level: 'critical', lastValue: 4.5e9 })]);
    expect(h.outbox).toHaveLength(3);
    const resolved = h.outbox[2];
    expect(resolved?.to).toBe(ADA);
    expect(resolved?.subject).toBe('[Test server] Resolved: Disk space is low');
    expect(resolved?.text).toContain('This alert is resolved.');
    expect(resolved?.text).toContain('Free disk space: 4.5 GB; the alert opens below 5.0 GB.');
    expect(resolved?.text).toContain('Level: critical.');
    await h.check(later + 10 * MINUTE, 500 * GB);
    expect(h.outbox).toHaveLength(3);

    // A closed warning-level alert says so.
    const warning: AlertTransitions = {
      opened: [],
      closed: [{ key: 'errors-high', level: 'warning', openedAt: new Date(NOW), lastValue: 31 }],
      open: [],
    };
    await h.notifier.notify(warning, later + 15 * MINUTE);
    expect(h.outbox[3]?.subject).toBe('[Test server] Resolved: The server is logging errors');
    expect(h.outbox[3]?.text).toContain('31 errors in the last 15 minutes; the alert opens at 20.');
    expect(h.outbox[3]?.text).toContain('Level: warning.');
  });

  it('test_alert_email_failure_retries_next_run', async () => {
    let refusing = true;
    const { mailer, outbox } = memoryMailer();
    const flaky: Mailer = {
      async send(msg) {
        if (refusing) throw Object.assign(new Error(`550 mailbox ${msg.to} refused`), { code: 'EENVELOPE' });
        await mailer.send(msg);
      },
    };
    const h = await harness({}, flaky);
    await seedPeople(h.db);

    await h.check(NOW);
    expect(outbox).toEqual([]);
    expect(await notifiedAt(h.db, 'disk-free-low')).toBeNull();
    expect(h.events().filter((e) => e.event === 'alert.email_failed')).toEqual([
      expect.objectContaining({ level: 'warn', key: 'disk-free-low', err_name: 'Error', err_code: 'EENVELOPE' }),
    ]);
    expect(h.lines.filter((line) => line.includes('@'))).toEqual([]);

    refusing = false;
    await h.check(NOW + 5 * MINUTE);
    expect(outbox.map((m) => [m.to, m.subject])).toEqual([[ADA, '[Test server] Disk space is low']]);
    expect(await notifiedAt(h.db, 'disk-free-low')).toEqual(new Date(NOW + 5 * MINUTE));
  });

  it('test_alert_email_config_list_and_none', async () => {
    expect(testConfig().alerts.email).toEqual({ kind: 'admins' });
    expect(testConfig({ ALERT_EMAIL: ' none ' }).alerts.email).toEqual({ kind: 'none' });
    expect(testConfig({ ALERT_EMAIL: 'Ops@Example.org, oncall@example.org' }).alerts.email).toEqual({
      kind: 'list',
      addresses: ['ops@example.org', 'oncall@example.org'],
    });

    const listed = await harness({ ALERT_EMAIL: 'ops@example.org,oncall@example.org' });
    await seedPeople(listed.db);
    await listed.check(NOW);
    expect(listed.outbox.map((m) => m.to)).toEqual(['ops@example.org', 'oncall@example.org']);
    expect(new Set(listed.outbox.map((m) => m.subject))).toEqual(new Set(['[Test server] Disk space is low']));

    const none = await harness({ ALERT_EMAIL: 'none' });
    await seedPeople(none.db);
    await none.check(NOW);
    expect(none.outbox).toEqual([]);
    expect(await notifiedAt(none.db, 'disk-free-low')).toBeNull();

    const many = Array.from({ length: 21 }, (_, i) => `ops${i}@example.org`).join(',');
    for (const value of ['not-an-address', many, 'ops@example.org,,nope']) {
      let error: unknown;
      try {
        testConfig({ ALERT_EMAIL: value });
      } catch (err) {
        error = err;
      }
      expect(error, value).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).invalid).toEqual([
        { name: 'ALERT_EMAIL', reason: 'must be email addresses, comma-separated, or none' },
      ]);
      expect((error as ConfigError).message).not.toContain('example.org');
    }
    expect(testConfig({ ALERT_EMAIL: many.split(',').slice(0, 20).join(',') }).alerts.email).toMatchObject({ kind: 'list' });
  });
});

describe('webhook', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alert_webhook_body_and_failures', async () => {
    const hook = await startHook();
    const inits: RequestInit[] = [];
    let shortTimeout = false;
    // Records each request's options; for the timeout case, also gives up after 200 ms instead of 5 s.
    const recording: typeof fetch = (input, init) => {
      if (init) inits.push(init);
      const signal = shortTimeout && init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(200)]) : init?.signal;
      return fetch(input, { ...init, signal });
    };
    const h = await harness({ ALERT_EMAIL: 'none', ALERT_WEBHOOK_URL: hook.url }, undefined, recording);
    expect(h.config.alerts.webhookUrl).toBe(hook.url);

    // A 500: the alert stays unnotified, and is sent again on the next run.
    hook.answer = 500;
    await h.check(NOW);
    expect(hook.requests).toHaveLength(1);
    expect(await notifiedAt(h.db, 'disk-free-low')).toBeNull();
    expect(h.events().filter((e) => e.event === 'alert.webhook_failed')).toEqual([
      expect.objectContaining({ level: 'warn', key: 'disk-free-low', status: 500 }),
    ]);

    hook.answer = 204;
    await h.check(NOW + 5 * MINUTE);
    expect(hook.requests).toHaveLength(2);
    const sent = hook.requests[1];
    expect(sent?.path).toBe('/hook?token=hook-secret-token-0123');
    expect(sent?.contentType).toBe('application/json');
    expect(Object.keys(sent?.body ?? {})).toEqual([
      'v',
      'server',
      'url',
      'state',
      'key',
      'level',
      'value',
      'at',
      'text',
      'content',
    ]);
    expect(sent?.body).toEqual({
      v: 1,
      server: 'Test server',
      url: TEST_PUBLIC_URL,
      state: 'opened',
      key: 'disk-free-low',
      level: 'critical',
      value: 4.9e9,
      at: new Date(NOW + 5 * MINUTE).toISOString(),
      text: '[Test server] Disk space is low (critical)',
      content: '[Test server] Disk space is low (critical)',
    });
    expect(await notifiedAt(h.db, 'disk-free-low')).toEqual(new Date(NOW + 5 * MINUTE));
    for (const init of inits) {
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }

    // A redirect is a failure, and is not followed.
    hook.answer = 302;
    const redirected = await h.notifier.sendTest('disk-free-low', NOW);
    expect(redirected).toEqual({ email: null, webhook: 0, ok: false });
    expect(hook.requests.map((r) => r.path)).not.toContain('/elsewhere');
    expect(hook.requests.at(-1)?.body.state).toBe('test');

    // No answer in time.
    hook.answer = 'hang';
    shortTimeout = true;
    const timedOut = await h.notifier.sendTest('disk-free-low', NOW);
    expect(timedOut).toEqual({ email: null, webhook: 0, ok: false });

    const failed = h.events().filter((e) => e.event === 'alert.webhook_failed');
    expect(failed).toHaveLength(3);
    expect(failed.slice(1)).toEqual([
      expect.objectContaining({ key: 'disk-free-low', err_name: expect.any(String) }),
      expect.objectContaining({ key: 'disk-free-low', err_name: expect.any(String) }),
    ]);
    for (const line of h.lines) {
      expect(line).not.toContain('hook-secret-token');
      expect(line).not.toContain('/hook');
      expect(line).not.toContain('Internal error at the hook');
    }
  });
});

describe('destinations and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alert_no_destination_logged_once', async () => {
    const h = await harness();
    await addUser(h.db, 'u-cy', CY);
    await h.check(NOW);
    await h.check(NOW + 5 * MINUTE);
    await h.check(NOW + 10 * MINUTE, 500 * GB);
    expect(h.events().filter((e) => e.event === 'alert.no_destination')).toEqual([expect.objectContaining({ level: 'warn' })]);
    expect(h.outbox).toEqual([]);

    // An admin appears: the alert still open and never sent is sent then.
    await addUser(h.db, 'u-ada', ADA, { role: ADMIN_ROLE });
    await h.check(NOW + 15 * MINUTE);
    expect(h.outbox.map((m) => [m.to, m.subject])).toEqual([[ADA, '[Test server] Disk space is low']]);
  });

  it('test_alert_messages_are_content_free', () => {
    const config = testConfig({ PUBLIC_URL: 'https://alerts.example.org', INSTANCE_NAME: 'Example AI' });
    const alerts: AlertSummary[] = [
      { key: 'disk-free-low', level: 'critical', value: 4_900_000_000 },
      { key: 'database-size-high', level: 'warning', value: 12_300_000_000 },
      { key: 'errors-high', level: 'warning', value: 25 },
      { key: 'spend-breaker', level: 'warning', value: null },
      { key: 'backup-local', level: 'critical', value: 27.4 },
      { key: 'backup-offsite', level: 'critical', value: null },
    ];
    const states: AlertState[] = ['opened', 'reminder', 'closed', 'test'];
    const titles = [...Object.values(ALERT_TITLES), 'The local backup failed', 'The offsite backup failed'];
    /** Every line a message may hold, with the name, the URL and the title as placeholders and numbers as `#`. */
    const allowed = new Set([
      '[<name>] <title>',
      '[<name>] Still open: <title>',
      '[<name>] Resolved: <title>',
      '[<name>] Test: <title>',
      '',
      'This alert is still open.',
      'This alert is resolved.',
      'This alert is resolved. The last reading before it closed:',
      'This is a test notification sent with the alerts command.',
      'Free disk space: # GB; the alert opens below # GB.',
      'Database size: # GB; the alert opens above # GB.',
      '# errors in the last # minutes; the alert opens at #.',
      'AI resumes for everyone at # UTC.',
      'Last successful backup: # hours ago.',
      'No successful backup yet.',
      'Level: critical.',
      'Level: warning.',
      'Admin page: <url>/admin',
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
        for (const part of [subject, text, body]) {
          expect(part, `${a.key} ${state}`).not.toContain('@');
          expect(part, `${a.key} ${state}`).not.toMatch(IPV4);
        }
        for (const line of [subject, ...text.split('\n')]) {
          const shape = normalize(line);
          expect(allowed, `${a.key} ${state}: ${line}`).toContain(shape);
          seen.add(shape);
        }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(parsed, `${a.key} ${state}`).toEqual({
          v: 1,
          server: 'Example AI',
          url: 'https://alerts.example.org',
          state,
          key: a.key,
          level: a.level,
          value: a.value,
          at: new Date(NOW).toISOString(),
          text: `${subject} (${a.level})`,
          content: `${subject} (${a.level})`,
        });
      }
    }
    // Every allowed line is used, so the list is not looser than the messages.
    expect(seen).toEqual(allowed);
    expect(alertMessage('opened', alerts[4] as AlertSummary, config).text).toContain('Last successful backup: 27 hours ago.');
  });

  it('test_alert_logs_hold_no_address_or_url', async () => {
    const hook = await startHook();
    hook.answer = 500;
    const failing: Mailer = {
      async send(msg) {
        throw Object.assign(new Error(`could not deliver to ${msg.to}: ${msg.subject}`), { code: 'EENVELOPE' });
      },
    };
    const h = await harness({ ALERT_WEBHOOK_URL: hook.url }, failing);
    await seedPeople(h.db);
    await h.check(NOW);
    await h.notifier.sendTest('spend-breaker', NOW);
    hook.answer = 204;
    await h.check(NOW + 5 * MINUTE, 500 * GB);

    const alertLines = h.events().filter((e) => String(e.event).startsWith('alert.'));
    expect(alertLines.map((e) => e.event)).toContain('alert.email_failed');
    expect(alertLines.map((e) => e.event)).toContain('alert.webhook_failed');
    const allowed = new Set([
      't',
      'level',
      'event',
      'key',
      'alert_level',
      'value',
      'minutes_open',
      'status',
      'err_name',
      'err_code',
      'err_stack',
    ]);
    for (const line of alertLines) for (const field of Object.keys(line)) expect(allowed, field).toContain(field);
    const { port } = new URL(hook.url);
    for (const line of h.lines) {
      expect(line).not.toContain('@');
      expect(line).not.toContain('hook-secret-token');
      expect(line).not.toContain(`:${port}`);
      expect(line).not.toContain('Disk space is low');
      expect(line).not.toContain('Admin page');
      expect(line).not.toContain('Level:');
    }
  });
});

describe('command', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alerts_cli_check', async () => {
    const handle = await pgliteDb();
    const run = async (env: Record<string, string | undefined>) => {
      const out: string[] = [];
      const code = await main(['check'], {
        db: handle,
        config: testConfig(env),
        out: (line) => out.push(line),
        statfs: diskFree(500 * GB),
        log: captureLog().log,
      });
      return { code, out };
    };

    const quiet = await run({});
    expect(quiet.code).toBe(0);
    expect(quiet.out).toEqual([
      'disk-free-low: ok (free 500.0 GB, alert below 5.0 GB)',
      expect.stringMatching(/^database-size-high: ok \(\d+ MB, alert above 10\.0 GB\)$/),
      'spend-breaker: ok',
      'backups: not watched (BACKUP_STATUS_DIR is unset)',
      'errors-high: not checked here (the server process counts its own errors)',
    ]);

    // A backup status folder with one stale backup, and a disk threshold above the free space.
    const dir = await mkdtemp(join(tmpdir(), 'ua-alerts-cli-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const lastSuccess = new Date(Date.now() - 30 * HOUR).toISOString();
    await writeFile(
      join(dir, 'local.json'),
      JSON.stringify({
        v: 1,
        kind: 'local',
        ok: true,
        finished_at: lastSuccess,
        last_success_at: lastSuccess,
        file: null,
        bytes: null,
        error: null,
      }),
    );
    const firing = await run({ ALERT_DISK_FREE_MIN_GB: '100000', BACKUP_STATUS_DIR: dir });
    expect(firing.code).toBe(3);
    expect(firing.out).toEqual([
      'disk-free-low: FIRING critical (free 500.0 GB, alert below 100,000.0 GB)',
      expect.stringMatching(/^database-size-high: ok /),
      'spend-breaker: ok',
      'backup-local: FIRING critical (last run ok, last success 30 hours ago)',
      'errors-high: not checked here (the server process counts its own errors)',
    ]);
    expect(await handle.db.select().from(opsAlerts)).toEqual([]);

    for (const argv of [[], ['nope'], ['check', 'now']]) {
      const out: string[] = [];
      expect(await main(argv, { db: handle, config: testConfig(), out: (line) => out.push(line) }), argv.join(' ')).toBe(1);
      expect(out).toEqual([ALERTS_USAGE]);
    }
  });

  it('test_alerts_cli_test', async () => {
    const handle = await pgliteDb();
    const hook = await startHook();
    await addUser(handle.db, 'u-ada', ADA, { role: ADMIN_ROLE });
    await addUser(handle.db, 'u-bea', 'bea@example.com', { role: ADMIN_ROLE });
    await addUser(handle.db, 'u-cy', CY);
    const { mailer, outbox } = memoryMailer();
    const run = async (argv: string[], env: Record<string, string | undefined> = {}, db = handle) => {
      const out: string[] = [];
      const { log } = captureLog();
      const code = await main(argv, { db, config: testConfig(env), out: (line) => out.push(line), mailer, log });
      return { code, out };
    };

    const sent = await run(['test', '--key', 'spend-breaker'], { ALERT_WEBHOOK_URL: hook.url });
    expect(sent).toEqual({ code: 0, out: ['email: sent to 2 recipients', 'webhook: HTTP 204'] });
    expect(outbox.map((m) => m.to).sort()).toEqual([ADA, 'bea@example.com']);
    for (const m of outbox) {
      expect(m.subject).toBe("[Test server] Test: Today's AI spending limit is reached");
      expect(m.text).toContain('This is a test notification sent with the alerts command.');
    }
    expect(hook.requests).toHaveLength(1);
    expect(hook.requests[0]?.body).toMatchObject({ state: 'test', key: 'spend-breaker', level: 'warning', value: null });
    expect(await handle.db.select().from(opsAlerts)).toEqual([]);

    // The webhook alone, failing.
    hook.answer = 500;
    expect(await run(['test'], { ALERT_EMAIL: 'none', ALERT_WEBHOOK_URL: hook.url })).toEqual({
      code: 1,
      out: ['email: none configured', 'webhook: HTTP 500'],
    });

    // No admin and no webhook.
    const empty = await pgliteDb();
    expect(await run(['test'], {}, empty)).toEqual({ code: 1, out: [NO_DESTINATION] });
    expect(await run(['test', '--key', 'spend-breaker'], { ALERT_EMAIL: 'none' })).toEqual({ code: 1, out: [NO_DESTINATION] });

    for (const argv of [
      ['test', '--key', 'Bad_Key'],
      ['test', '--key'],
      ['test', 'spend-breaker'],
    ]) {
      expect(await run(argv), argv.join(' ')).toEqual({ code: 1, out: [ALERTS_USAGE] });
    }
  });
});
