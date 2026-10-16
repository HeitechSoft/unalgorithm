import type { StatsFs } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import type { BillingModule } from '../src/billing/host.ts';
import { type BillingAlert, BillingLoadError, type BillingProvider, loadBilling, noopBilling } from '../src/billing/provider.ts';
import type { Db } from '../src/db/client.ts';
import { opsAlerts, user } from '../src/db/schema.ts';
import { type MailMessage, memoryMailer } from '../src/mail/mailer.ts';
import { type AlertDeps, type AlertTransitions, checkAlerts, moduleFindings } from '../src/ops/alerts.ts';
import { createErrorWindow } from '../src/ops/error-window.ts';
import { createAlertNotifier } from '../src/ops/notify.ts';
import { createTestHost } from './support/billing-host.ts';
import { captureLog } from './support/log.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-14T03:20:00.000Z');
const MINUTE = 60_000;
const GB = 1_000_000_000;
const ADA = 'ada@example.com';

/** Databases, apps and folders a test opened, closed after it whatever the outcome; fake timers are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A `statfs` answer of `free` bytes free of 1 TB, so no test depends on the disk of the machine it runs on. */
const diskFree =
  (free = 500 * GB) =>
  async (): Promise<StatsFs> => ({ type: 0, bsize: 1, blocks: 1000 * GB, bfree: free, bavail: free, files: 0, ffree: 0 });

type AlertsFn = (now: Date) => Promise<BillingAlert[]>;

/** A complete module provider whose `alerts` is `alerts` (none when undefined). */
function probeProvider(alerts?: AlertsFn): BillingProvider {
  const provider: BillingProvider = {
    id: 'probe',
    advertised: true,
    check: async () => ({ kind: 'allow' }),
    settle: async () => null,
    release: async () => {},
    balance: async () => null,
  };
  return alerts ? { ...provider, alerts } : provider;
}

interface Harness {
  db: Db;
  outbox: MailMessage[];
  events: () => Record<string, unknown>[];
  /** What the notifier was handed, run by run. */
  notified: AlertTransitions[];
  deps: AlertDeps;
  check(now: number, free?: number): Promise<AlertTransitions>;
}

/** A test app with a module whose `alerts` is `alerts`, an admin (Ada) and the real notifier, recorded. */
async function harness(alerts?: AlertsFn, billing?: BillingProvider): Promise<Harness> {
  const module: BillingModule = { createBillingProvider: async () => probeProvider(alerts) };
  const t = await createTestApp(billing ? { billing } : { billingModule: module });
  cleanup.push(() => t.close());
  const db = t.deps.db.db;
  const at = new Date(NOW);
  await db
    .insert(user)
    .values({ id: 'u-ada', name: '', email: ADA, emailVerified: true, createdAt: at, updatedAt: at, role: ADMIN_ROLE });
  const { mailer, outbox } = memoryMailer();
  const notifier = createAlertNotifier({ db, config: t.deps.config, log: t.deps.log, mailer });
  const notified: AlertTransitions[] = [];
  const deps: AlertDeps = {
    db,
    config: t.deps.config,
    log: t.deps.log,
    errors: createErrorWindow(),
    billing: t.provider,
    statfs: diskFree(),
    notify: async (transitions, now) => {
      notified.push(transitions);
      await notifier.notify(transitions, now);
    },
  };
  return {
    db,
    outbox,
    events: t.events,
    notified,
    deps,
    check: (now, free) => checkAlerts({ ...deps, statfs: diskFree(free) }, now),
  };
}

const STRIPE: BillingAlert = { key: 'billing-reconcile-stripe', level: 'critical', value: 3 };

describe('provider shape', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_alerts_member_optional_and_checked', async () => {
    const t = await createTestHost();
    cleanup.push(() => t.close());
    const dir = await mkdtemp(join(tmpdir(), 'ua-billing-alerts-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const write = async (name: string, change: string) => {
      const path = join(dir, name);
      const source = [
        'export async function createBillingProvider() {',
        '  const fn = async () => null;',
        "  const provider = { id: 'probe', advertised: true, check: fn, settle: fn, release: fn, balance: fn };",
        `  ${change}`,
        '  return provider;',
        '}',
        '',
      ].join('\n');
      await writeFile(path, source);
      return testConfig({ BILLING: 'module', BILLING_MODULE: path });
    };
    const { log } = captureLog();

    const plain = await loadBilling(await write('plain.mjs', ''), t.host, log);
    expect(plain.id).toBe('probe');
    expect(plain.alerts).toBeUndefined();
    const withAlerts = await loadBilling(await write('alerts.mjs', 'provider.alerts = async () => [];'), t.host, log);
    expect(typeof withAlerts.alerts).toBe('function');

    const err = await loadBilling(await write('bad.mjs', "provider.alerts = 'x';"), t.host, log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BillingLoadError);
    expect((err as Error).message).toBe('the billing module returned an invalid provider');
    expect(noopBilling.alerts).toBeUndefined();
  });
});

describe('module findings', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_module_alert_opens_and_closes', async () => {
    const alerts = vi.fn<AlertsFn>(async () => [STRIPE]);
    const h = await harness(alerts);

    const first = await h.check(NOW);
    expect(alerts).toHaveBeenCalledWith(new Date(NOW));
    expect(first.opened).toEqual([STRIPE]);
    expect(h.notified[0]?.opened).toEqual([STRIPE]);
    const rows = await h.db.select().from(opsAlerts);
    expect(rows).toEqual([expect.objectContaining({ key: STRIPE.key, level: 'critical', lastValue: 3 })]);
    expect(h.events()).toContainEqual(
      expect.objectContaining({ event: 'alert.opened', key: STRIPE.key, alert_level: 'critical', value: 3 }),
    );
    // Titled by its key (CL4-16's rule for keys it does not know).
    expect(h.outbox.map((m) => m.subject)).toEqual([`[Test server] ${STRIPE.key}`]);

    alerts.mockResolvedValue([]);
    const second = await h.check(NOW + 5 * MINUTE);
    expect(second.closed).toEqual([expect.objectContaining({ key: STRIPE.key, level: 'critical', lastValue: 3 })]);
    expect(await h.db.select().from(opsAlerts)).toEqual([]);
  });

  it('test_invalid_module_alerts_dropped', async () => {
    const valid: BillingAlert[] = [
      { key: 'billing-a', level: 'warning', value: null },
      { key: 'billing-ledger-drift', level: 'critical', value: 1.5 },
    ];
    const invalid = [
      { key: 'billing-', level: 'warning', value: 1 },
      { key: 'Billing-x', level: 'warning', value: 1 },
      { key: 'disk-free-low', level: 'critical', value: 1 },
      { key: 'billing-x y', level: 'warning', value: 1 },
      { key: `billing-${'a'.repeat(52)}`, level: 'warning', value: 1 },
      { key: 'billing-info', level: 'info', value: 1 },
      { key: 'billing-nan', level: 'warning', value: Number.NaN },
    ] as unknown as BillingAlert[];
    const h = await harness(async () => [invalid[0], valid[1], ...invalid.slice(1), valid[0]] as BillingAlert[]);

    const t = await h.check(NOW);
    expect(t.opened).toEqual(valid);
    const lines = h.events().filter((e) => e.event === 'alerts.module_invalid');
    expect(lines).toEqual([expect.objectContaining({ count: invalid.length })]);
    // The count only: no key text from the module.
    expect(JSON.stringify(lines)).not.toMatch(/Billing-x|billing-x y|disk-free-low/);
  });

  it('test_failed_module_keeps_open_alerts', async () => {
    const alerts = vi.fn<AlertsFn>(async () => [STRIPE]);
    const h = await harness(alerts);
    await h.check(NOW);
    expect(h.outbox).toHaveLength(1);

    // The module fails while the disk runs low: the module's alert stays open as it was, the server's rule fires.
    alerts.mockRejectedValue(new Error('the ledger is unreachable'));
    const failed = await h.check(NOW + 5 * MINUTE, 4.9e9);
    expect(failed.closed).toEqual([]);
    expect(failed.opened.map((f) => f.key)).toEqual(['billing-alerts-failed', 'disk-free-low']);
    expect(failed.opened[0]).toEqual({ key: 'billing-alerts-failed', level: 'warning', value: null });
    expect(failed.open.find((r) => r.key === STRIPE.key)).toMatchObject({ level: 'critical', lastValue: 3 });
    expect(h.events()).toContainEqual(
      expect.objectContaining({ event: 'alerts.module_failed', level: 'warn', err_name: 'Error' }),
    );
    expect(JSON.stringify(h.events())).not.toContain('the ledger is unreachable');

    // A second failure: still nothing closes, and billing-alerts-failed is not opened twice.
    const again = await h.check(NOW + 10 * MINUTE, 4.9e9);
    expect(again.opened).toEqual([]);
    expect(again.closed).toEqual([]);
    expect(again.open.map((r) => r.key).sort()).toEqual(['billing-alerts-failed', STRIPE.key, 'disk-free-low']);
    expect(h.outbox.some((m) => m.subject.includes('Resolved:'))).toBe(false);

    // The module answers again: only billing-alerts-failed resolves.
    alerts.mockResolvedValue([STRIPE]);
    const back = await h.check(NOW + 15 * MINUTE, 4.9e9);
    expect(back.closed.map((c) => c.key)).toEqual(['billing-alerts-failed']);
    expect(h.outbox.filter((m) => m.subject.includes('Resolved:')).map((m) => m.subject)).toEqual([
      '[Test server] Resolved: billing-alerts-failed',
    ]);
  });

  it('test_module_alert_timeout_counts_as_failure', async () => {
    const { log, events } = captureLog();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const never = probeProvider(() => new Promise<BillingAlert[]>(() => {}));
    const open = [
      { key: STRIPE.key, level: 'critical' as const, lastValue: 3 },
      { key: 'disk-free-low', level: 'critical' as const, lastValue: 1 },
    ];

    const pending = moduleFindings(never, async () => open, NOW, log);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([
      { key: 'billing-alerts-failed', level: 'warning', value: null },
      { key: STRIPE.key, level: 'critical', value: 3 },
    ]);
    expect(events()).toEqual([expect.objectContaining({ event: 'alerts.module_failed', err_name: 'TimeoutError' })]);
  });

  it('test_module_alerts_capped_at_20', async () => {
    const thirty: BillingAlert[] = Array.from({ length: 30 }, (_, i) => ({
      key: `billing-check-${String(29 - i).padStart(2, '0')}`,
      level: 'warning',
      value: i,
    }));
    const h = await harness(async () => thirty);
    const t = await h.check(NOW);
    const keys = Array.from({ length: 20 }, (_, i) => `billing-check-${String(i).padStart(2, '0')}`);
    expect(t.opened.map((f) => f.key)).toEqual(keys);
  });

  it('test_no_module_alerts_unchanged', async () => {
    for (const billing of [noopBilling, undefined]) {
      const h = await harness(undefined, noopBilling);
      const deps = { ...h.deps, billing };
      const opened = await checkAlerts({ ...deps, statfs: diskFree(4.9e9) }, NOW);
      expect(opened.opened).toEqual([{ key: 'disk-free-low', level: 'critical', value: 4.9e9 }]);
      const closed = await checkAlerts(deps, NOW + 5 * MINUTE);
      expect(closed.opened).toEqual([]);
      expect(closed.closed.map((c) => c.key)).toEqual(['disk-free-low']);
      expect(h.events().some((e) => String(e.event).startsWith('alerts.module'))).toBe(false);
    }
    // A module without `alerts` is the same as none.
    const h = await harness();
    const t = await h.check(NOW);
    expect(t.opened).toEqual([]);
    expect(t.open).toEqual([]);
  });
});
