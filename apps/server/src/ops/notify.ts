/**
 * Alert notifications (R43, CL4-16): tells someone when an alert opens, is still open a day later, or closes. By default
 * the server emails its active admins through the mailer it already has; `ALERT_EMAIL` names other addresses (or
 * `none`), and `ALERT_WEBHOOK_URL` adds a JSON POST for a chat or paging tool.
 *
 * Content-free: a message carries the alert's key, level and a number, the server's name and its admin page, never post
 * content, an account's address or a client IP. Plain text, no images or tracking: operational messages to the
 * operator, not marketing (CASL). Log lines name the alert's key and an error's name, code or HTTP status, never an
 * address, the webhook's URL, a message or a response body.
 */
import { formatBytes } from '@unalgorithm/core';
import { ADMIN_PAGE_PATH } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { activeAdminEmails } from '../admin/access.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { opsAlerts } from '../db/schema.ts';
import { errorFields, type Logger } from '../log.ts';
import type { Mailer } from '../mail/mailer.ts';
import type { AlertTransitions } from './alerts.ts';

/** An alert still open gets a reminder once its last notification is older than this. */
export const RENOTIFY_MS = 24 * 3_600_000;
/** How long a webhook may take to answer. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

export type AlertState = 'opened' | 'reminder' | 'closed' | 'test';

/** What a message is about: the alert's key and level, and its number (bytes, a count or hours; null when none). */
export interface AlertSummary {
  key: string;
  level: string;
  value: number | null;
}

/** The fixed keys' titles; `backup-<kind>` is "The <kind> backup failed", and any other key is shown as itself. */
export const ALERT_TITLES: Readonly<Record<string, string>> = {
  'disk-free-low': 'Disk space is low',
  'database-size-high': 'The database is large',
  'errors-high': 'The server is logging errors',
  'spend-breaker': "Today's AI spending limit is reached",
};
const BACKUP_KEY_PREFIX = 'backup-';

const SUBJECT_PREFIX: Record<AlertState, string> = {
  opened: '',
  reminder: 'Still open: ',
  closed: 'Resolved: ',
  test: 'Test: ',
};

export function alertTitle(key: string): string {
  const title = ALERT_TITLES[key];
  if (title !== undefined) return title;
  if (key.startsWith(BACKUP_KEY_PREFIX)) return `The ${key.slice(BACKUP_KEY_PREFIX.length)} backup failed`;
  return key;
}

/** The level a test of `key` claims: the level its rule opens with (CL4-15's `evaluateAlerts`). */
export function testLevel(key: string): string {
  return key === 'disk-free-low' || key.startsWith(BACKUP_KEY_PREFIX) ? 'critical' : 'warning';
}

/** `[<instance>] <prefix><title>`: the email's subject, and with the level the webhook's one-line summary. */
function headline(state: AlertState, key: string, config: Config): string {
  return `[${config.instanceName}] ${SUBJECT_PREFIX[state]}${alertTitle(key)}`;
}

/** What the rule measured, in fixed words: a test has no reading, and a resolved spend breaker needs none. */
function readingLines(state: AlertState, a: AlertSummary, t: Config['alerts']): string[] {
  if (state === 'test') return [];
  const { key, value } = a;
  if (key === 'disk-free-low') {
    return [`Free disk space: ${formatBytes(value)}; the alert opens below ${formatBytes(t.diskFreeMinBytes)}.`];
  }
  if (key === 'database-size-high') {
    return [`Database size: ${formatBytes(value)}; the alert opens above ${formatBytes(t.databaseMaxBytes)}.`];
  }
  if (key === 'errors-high') {
    if (value === null) return [];
    return [`${plural(value, 'error')} in the last 15 minutes; the alert opens at ${t.errorsPer15m}.`];
  }
  if (key === 'spend-breaker') return state === 'closed' ? [] : ['AI resumes for everyone at 00:00 UTC.'];
  if (key.startsWith(BACKUP_KEY_PREFIX)) {
    return [value === null ? 'No successful backup yet.' : `Last successful backup: ${plural(value, 'hour')} ago.`];
  }
  return [];
}

/** "1 hour", "27 hours": `n` rounded to a whole number. */
export function plural(n: number, unit: string): string {
  const whole = Math.round(n);
  return `${whole} ${unit}${whole === 1 ? '' : 's'}`;
}

/** The email: plain text whose only link is the server's own admin page. */
export function alertMessage(state: AlertState, a: AlertSummary, config: Config): { subject: string; text: string } {
  const reading = readingLines(state, a, config.alerts);
  const lead =
    state === 'reminder'
      ? ['This alert is still open.']
      : state === 'closed'
        ? [reading.length ? 'This alert is resolved. The last reading before it closed:' : 'This alert is resolved.']
        : state === 'test'
          ? ['This is a test notification sent with the alerts command.']
          : [];
  const lines = [...lead, ...reading, '', `Level: ${a.level}.`, `Admin page: ${config.publicUrl}${ADMIN_PAGE_PATH}`];
  return { subject: headline(state, a.key, config), text: lines.join('\n') };
}

/**
 * The webhook's JSON: one object, `text` and `content` holding the same one-line summary, so Slack, Mattermost and
 * Discord show it without an adapter.
 */
export function webhookBody(state: AlertState, a: AlertSummary, config: Config, at: Date): string {
  const summary = `${headline(state, a.key, config)} (${a.level})`;
  return JSON.stringify({
    v: 1,
    server: config.instanceName,
    url: config.publicUrl,
    state,
    key: a.key,
    level: a.level,
    value: a.value,
    at: at.toISOString(),
    text: summary,
    content: summary,
  });
}

export interface NotifierDeps {
  db: Db;
  config: Config;
  log: Logger;
  mailer: Mailer;
  /** Default: global fetch. */
  fetch?: typeof fetch;
}

/** What one message reached. */
interface Delivery {
  /** Emails the mail server accepted, and those it did not. */
  emailsSent: number;
  emailsFailed: number;
  /** The webhook's HTTP status; 0 when it gave none (a network error, a redirect or the timeout); null: no webhook. */
  webhookStatus: number | null;
  webhookOk: boolean;
}

export interface AlertNotifier {
  /** Sends what `t` calls for; marks an open alert notified once its message reached at least one destination. */
  notify(t: AlertTransitions, now?: number): Promise<void>;
  /**
   * One test message per configured destination; `ok` false when any destination failed or none is configured. `email`
   * is the number of recipients the mail server accepted (null: no recipient), `webhook` the HTTP status (0: no answer,
   * null: no webhook). Writes nothing.
   */
  sendTest(key: string, now?: number): Promise<{ email: number | null; webhook: number | null; ok: boolean }>;
}

export function createAlertNotifier(deps: NotifierDeps): AlertNotifier {
  const { db, config, log, mailer } = deps;
  const fetcher = deps.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const { email, webhookUrl } = config.alerts;
  let warnedNoDestination = false;

  async function recipients(): Promise<string[]> {
    if (email.kind === 'none') return [];
    if (email.kind === 'list') return email.addresses;
    return activeAdminEmails(db);
  }

  async function postWebhook(url: string, state: AlertState, a: AlertSummary, now: number): Promise<number> {
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: webhookBody(state, a, config, new Date(now)),
        redirect: 'error',
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // The answer's body is never read.
      await res.body?.cancel().catch(() => {});
      if (!res.ok) log.warn('alert.webhook_failed', { key: a.key, status: res.status });
      return res.status;
    } catch (err) {
      log.warn('alert.webhook_failed', { key: a.key, ...errorFields(err) });
      return 0;
    }
  }

  async function deliver(state: AlertState, a: AlertSummary, to: readonly string[], now: number): Promise<Delivery> {
    const message = alertMessage(state, a, config);
    const sends = to.map((address) =>
      // One message per recipient: recipients never see each other.
      mailer.send({ to: address, ...message }).then(
        () => true,
        (err: unknown) => {
          log.warn('alert.email_failed', { key: a.key, ...errorFields(err) });
          return false;
        },
      ),
    );
    const [results, webhookStatus] = await Promise.all([
      Promise.all(sends),
      webhookUrl === undefined ? null : postWebhook(webhookUrl, state, a, now),
    ]);
    const emailsSent = results.filter(Boolean).length;
    return {
      emailsSent,
      emailsFailed: results.length - emailsSent,
      webhookStatus,
      webhookOk: webhookStatus !== null && webhookStatus >= 200 && webhookStatus < 300,
    };
  }

  return {
    async notify(t, now = Date.now()) {
      const due: { state: AlertState; alert: AlertSummary; open: boolean }[] = [];
      for (const row of t.open) {
        const alert = { key: row.key, level: row.level, value: row.lastValue };
        // An open alert not yet notified (or whose sends all failed) is sent again on every run until one reaches someone.
        if (row.notifiedAt === null) due.push({ state: 'opened', alert, open: true });
        else if (now - row.notifiedAt.getTime() > RENOTIFY_MS) due.push({ state: 'reminder', alert, open: true });
      }
      // The row is gone: its closed entry carries the level and the last value. Sent once, not retried.
      for (const c of t.closed) {
        due.push({ state: 'closed', alert: { key: c.key, level: c.level, value: c.lastValue }, open: false });
      }
      if (due.length === 0) return;

      const to = await recipients();
      if (to.length === 0 && webhookUrl === undefined) {
        if (!warnedNoDestination) log.warn('alert.no_destination');
        warnedNoDestination = true;
        return;
      }
      for (const { state, alert, open } of due) {
        const d = await deliver(state, alert, to, now);
        if (open && (d.emailsSent > 0 || d.webhookOk)) {
          await db
            .update(opsAlerts)
            .set({ notifiedAt: new Date(now) })
            .where(eq(opsAlerts.key, alert.key));
        }
      }
    },

    async sendTest(key, now = Date.now()) {
      const to = await recipients();
      if (to.length === 0 && webhookUrl === undefined) return { email: null, webhook: null, ok: false };
      const d = await deliver('test', { key, level: testLevel(key), value: null }, to, now);
      return {
        email: to.length === 0 ? null : d.emailsSent,
        webhook: d.webhookStatus,
        ok: d.emailsFailed === 0 && (d.webhookStatus === null || d.webhookOk),
      };
    },
  };
}
