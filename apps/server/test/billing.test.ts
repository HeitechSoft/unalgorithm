import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AIError, describeError } from '@unalgorithm/ai';
import {
  ClassifyResponseSchema,
  CREDIT_ACCOUNT_PATH,
  CREDIT_BALANCE_PATH,
  CreditAccountSchema,
  CreditBalanceSchema,
  SERVER_INFO_PATH,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingHost } from '../src/billing/host.ts';
import {
  type BillingContext,
  type BillingDecision,
  BillingLoadError,
  type BillingProvider,
  type CheckRequest,
  loadBilling,
  noopBilling,
  type ReleaseInput,
  runWithBilling,
  type SettleInput,
  type SettleRequest,
} from '../src/billing/provider.ts';
import { type Config, loadConfig } from '../src/config.ts';
import { startFailureMessage, startServer } from '../src/index.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { createTestHost } from './support/billing-host.ts';
import { classifyBody, serverPost as post, postClassify } from './support/classify.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT, PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

/** The public test module (never shipped), by absolute path as `BILLING_MODULE` names it. */
const FIXTURE = fileURLToPath(new URL('./fixtures/billing-module/index.ts', import.meta.url));
/** The entry point, by absolute path: the test must not depend on the folder Vitest runs in. */
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const TOM = 'tom@example.com';

/** Hosts, apps, folders and databases a test opened, closed or removed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Fakes `Date` (only) at `instant`; `afterEach` restores the real clock. */
function clockAt(instant: string): Date {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
  return new Date(instant);
}

/** The fake clock's instant for the runWithBilling cases. */
const CHECKED = '2026-10-14T12:00:00.000Z';

const CTX: CheckRequest = { userId: 'user-1', deviceId: 'device-1', task: 'classify', requestId: 'req-1' };

function settleInput(): SettleRequest {
  return {
    userId: CTX.userId,
    requestId: CTX.requestId,
    task: 'classify',
    model: 'claude-haiku-5-5',
    chargeableUsage: { ...ZERO_USAGE, uncachedInput: 1_200, output: 300 },
    costMicros: 270,
    posts: 3,
  };
}

/** What the fake's `settle` answers. */
const SETTLED = { chargedMicros: 270, balanceMicros: 4_730 };

/** A provider that answers `decision` to every check and records every call it receives. */
function recordingFake(decision: BillingDecision = { kind: 'allow' }) {
  const calls = {
    check: [] as BillingContext[],
    settle: [] as SettleInput[],
    release: [] as ReleaseInput[],
  };
  const provider: BillingProvider = {
    id: 'fake',
    advertised: true,
    async check(ctx) {
      calls.check.push(ctx);
      return decision;
    },
    async settle(input) {
      calls.settle.push(input);
      return SETTLED;
    },
    async release(input) {
      calls.release.push(input);
    },
    async balance() {
      return { balanceMicros: SETTLED.balanceMicros };
    },
  };
  return { provider, calls };
}

/** An AI call that counts how often it runs and answers `result`. */
function countingCall<T>(result: T) {
  const counter = { calls: 0 };
  const call = async () => {
    counter.calls += 1;
    return result;
  };
  return { call, counter };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

/** A fresh temporary folder, removed after the test. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-billing-module-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A module file in a fresh temporary folder, by absolute path. */
async function moduleFile(name: string, source: string): Promise<string> {
  const path = join(await tempDir(), name);
  await writeFile(path, source);
  return path;
}

/** A module whose provider is complete until `change` (a statement on `provider`) runs. */
function providerModule(change: string): string {
  return [
    'export async function createBillingProvider() {',
    '  const fn = async () => null;',
    "  const provider = { id: 'probe', advertised: true, check: fn, settle: fn, release: fn, balance: fn };",
    `  ${change}`,
    '  return provider;',
    '}',
    '',
  ].join('\n');
}

/** The test server's config with `BILLING=module` and this module; `env` adds the module's own variables. */
function moduleConfig(path: string, env: Record<string, string> = {}): Config {
  return testConfig({ BILLING: 'module', BILLING_MODULE: path, ...env });
}

/** A host on a fresh PGlite database, closed after the test; its `env` is the config's `billingEnv`, as at boot. */
async function hostFor(config: Config): Promise<BillingHost> {
  const t = await createTestHost({ env: { ...config.billingEnv } });
  cleanup.push(() => t.close());
  return t.host;
}

/** A port nothing listens on: the system picks it and it is let go at once. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Listens on `port` and lets it go again; rejects (EADDRINUSE) while something else holds it. */
async function listenOnce(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

/** A test app running the fixture module, whose allow-list lets Tom sign in; closed after the test. */
async function fixtureApp(options: TestAppOptions = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }), billingModule: fixtureModule, ...options });
  cleanup.push(t.close);
  return t;
}

describe('no-op provider', () => {
  it('test_noop_billing_allows_and_charges_nothing', async () => {
    expect(noopBilling.id).toBe('off');
    expect(noopBilling.advertised).toBe(false);
    expect(noopBilling.mount).toBeUndefined();
    const checkedAt = new Date('2026-10-14T12:00:00Z');
    await expect(noopBilling.check({ ...CTX, checkedAt })).resolves.toEqual({ kind: 'allow' });
    await expect(noopBilling.settle({ ...settleInput(), checkedAt })).resolves.toBeNull();
    await expect(noopBilling.release({ userId: CTX.userId, requestId: CTX.requestId })).resolves.toBeUndefined();
    await expect(noopBilling.balance(CTX.userId)).resolves.toBeNull();
  });

  it('test_load_billing_off_returns_noop', async () => {
    const config = loadConfig({
      PUBLIC_URL: 'https://cloud.example.org',
      DATABASE_URL: 'postgres://unalgorithm@db:5432/unalgorithm',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      SMTP_HOST: 'smtp.example.org',
      MAIL_FROM: 'noreply@example.org',
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'test-key',
    });
    expect(config.billing).toBe('off');
    // A module that throws when it is imported, and a host that throws when it is touched: off uses neither.
    const throwing = await moduleFile('throws.mjs', "throw new Error('imported');\n");
    const untouchable = new Proxy({} as BillingHost, {
      get() {
        throw new Error('the host was touched');
      },
    });
    const { log, lines } = captureLog();

    await expect(loadBilling({ ...config, billingModule: throwing }, untouchable, log)).resolves.toBe(noopBilling);
    expect(lines).toEqual([]);
  });

  it('test_run_with_noop_returns_null_billing', async () => {
    const out = await runWithBilling(noopBilling, CTX, async () => 'answer', settleInput);
    expect(out).toEqual({ result: 'answer', billing: null });
  });
});

describe('runWithBilling with a recording fake', () => {
  it('test_refusal_never_calls_ai', async () => {
    const checkedAt = clockAt(CHECKED);
    const { provider, calls } = recordingFake({ kind: 'refuse', code: 'insufficient-credits', message: 'Balance is empty.' });
    const { call, counter } = countingCall('answer');

    const err = await rejection(runWithBilling(provider, CTX, call, settleInput));

    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('insufficient-credits');
    expect((err as AIError).message).toBe('Balance is empty.');
    expect(counter.calls).toBe(0);
    expect(calls.check).toEqual([{ ...CTX, checkedAt }]);
    expect(calls.settle).toHaveLength(0);
    expect(calls.release).toHaveLength(0);
  });

  it('test_failed_call_is_released_not_settled', async () => {
    const { provider, calls } = recordingFake();
    const failure = new AIError('overloaded', 'The provider is busy.');
    let toSettleCalls = 0;

    const err = await rejection(
      runWithBilling(
        provider,
        CTX,
        async () => {
          throw failure;
        },
        () => {
          toSettleCalls += 1;
          return settleInput();
        },
      ),
    );

    expect(err).toBe(failure);
    expect(calls.release).toEqual([{ userId: CTX.userId, requestId: CTX.requestId }]);
    expect(calls.settle).toHaveLength(0);
    expect(toSettleCalls).toBe(0);
  });

  it('test_nothing_chargeable_is_released', async () => {
    const { provider, calls } = recordingFake();

    const out = await runWithBilling(
      provider,
      CTX,
      async () => 'every post failed',
      () => null,
    );

    expect(out).toEqual({ result: 'every post failed', billing: null });
    expect(calls.release).toEqual([{ userId: CTX.userId, requestId: CTX.requestId }]);
    expect(calls.settle).toHaveLength(0);
  });

  it('test_success_is_settled_once', async () => {
    const checkedAt = clockAt(CHECKED);
    const { provider, calls } = recordingFake();
    const input = settleInput();

    const out = await runWithBilling(
      provider,
      CTX,
      async () => 'answer',
      () => input,
    );

    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]).toEqual({ ...input, checkedAt });
    // A new object: the caller's input is never changed.
    expect(calls.settle[0]).not.toBe(input);
    expect(input).not.toHaveProperty('checkedAt');
    expect(calls.release).toHaveLength(0);
    expect(out.result).toBe('answer');
    expect(out.billing).toEqual(SETTLED);
  });

  it('test_hold_id_flows_to_settle_and_release', async () => {
    const hold: BillingDecision = { kind: 'hold', holdId: 'hold-7', amountMicros: 5_000 };
    const released = { userId: CTX.userId, requestId: CTX.requestId, holdId: 'hold-7' };

    const checkedAt = clockAt(CHECKED);
    const settled = recordingFake(hold);
    await runWithBilling(settled.provider, CTX, async () => 'answer', settleInput);
    expect(settled.calls.settle).toEqual([{ ...settleInput(), checkedAt, holdId: 'hold-7' }]);
    expect(settled.calls.release).toHaveLength(0);

    const nothingChargeable = recordingFake(hold);
    await runWithBilling(
      nothingChargeable.provider,
      CTX,
      async () => 'every post failed',
      () => null,
    );
    expect(nothingChargeable.calls.release).toEqual([released]);
    expect(nothingChargeable.calls.settle).toHaveLength(0);

    const failed = recordingFake(hold);
    const failure = new AIError('timeout', 'The provider took too long.');
    const err = await rejection(
      runWithBilling(
        failed.provider,
        CTX,
        async () => {
          throw failure;
        },
        settleInput,
      ),
    );
    expect(err).toBe(failure);
    expect(failed.calls.release).toEqual([released]);
    expect(failed.calls.settle).toHaveLength(0);
  });

  it('test_check_and_settle_share_the_check_instant', async () => {
    // A request checked just before 00:00 UTC whose AI call ends after it is priced at the check's instant.
    const checkedAt = clockAt('2026-11-14T23:59:59.900Z');
    const { provider, calls } = recordingFake();
    await runWithBilling(
      provider,
      CTX,
      async () => {
        vi.setSystemTime(new Date('2026-11-15T00:00:00.100Z'));
        return 'answer';
      },
      settleInput,
    );
    expect(calls.check[0]?.checkedAt.getTime()).toBe(checkedAt.getTime());
    expect(calls.settle[0]?.checkedAt.getTime()).toBe(checkedAt.getTime());

    // A released request is told no instant: `ReleaseInput` is unchanged.
    const released = recordingFake();
    await runWithBilling(
      released.provider,
      CTX,
      async () => 'every post failed',
      () => null,
    );
    expect(released.calls.release).toEqual([{ userId: CTX.userId, requestId: CTX.requestId }]);
    expect(released.calls.release[0]).not.toHaveProperty('checkedAt');
  });

  it('test_release_failure_keeps_the_outcome', async () => {
    const hold: BillingDecision = { kind: 'hold', holdId: 'hold-7', amountMicros: 5_000 };
    const { provider, calls } = recordingFake(hold);
    const ledgerDown: BillingProvider = {
      ...provider,
      async release(input) {
        calls.release.push(input);
        throw new Error('ledger unavailable for user-1');
      },
    };
    const { log, lines, events } = captureLog();

    // A failed call: the AI error itself comes back, retry hint and usage included.
    const failure = new AIError('overloaded', 'The provider is busy.', {
      retryAfterMs: 2_000,
      usage: { ...ZERO_USAGE, uncachedInput: 800 },
    });
    const err = await rejection(
      runWithBilling(
        ledgerDown,
        CTX,
        async () => {
          throw failure;
        },
        settleInput,
        log,
      ),
    );
    expect(err).toBe(failure);

    // Nothing chargeable: the result still comes back, uncharged.
    const out = await runWithBilling(
      ledgerDown,
      CTX,
      async () => 'every post failed',
      () => null,
      log,
    );
    expect(out).toEqual({ result: 'every post failed', billing: null });

    expect(calls.release).toHaveLength(2);
    expect(calls.settle).toHaveLength(0);
    expect(events()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'billing.release.failed', rid: CTX.requestId, billing: 'fake' }),
      expect.objectContaining({ level: 'warn', event: 'billing.release.failed', rid: CTX.requestId, billing: 'fake' }),
    ]);
    // Only `errorFields`: the provider's message never reaches the log.
    for (const line of lines) expect(line).not.toContain('ledger unavailable');

    // Without a log the outcome is the same.
    await expect(
      runWithBilling(
        ledgerDown,
        CTX,
        async () => 'answer',
        () => null,
      ),
    ).resolves.toEqual({
      result: 'answer',
      billing: null,
    });
  });
});

describe('loader', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_load_billing_fixture', async () => {
    const config = moduleConfig(FIXTURE);
    const { log, events } = captureLog();

    const provider = await loadBilling(config, await hostFor(config), log);

    expect(provider).toMatchObject({ id: 'fixture', advertised: true });
    expect(events()).toEqual([
      expect.objectContaining({ level: 'info', event: 'billing.loaded', billing: 'fixture', advertised: true }),
    ]);
    await expect(provider.balance('user-1')).resolves.toEqual({ balanceMicros: 1_000_000 });

    // The module's own errors come back unchanged. Its configuration error names the variable, never the value, and
    // the entry prints it as it prints a ConfigError.
    const badStart = moduleConfig(FIXTURE, { BILLING_FIXTURE_START_MICROS: 'QXZ7' });
    const err = await rejection(loadBilling(badStart, await hostFor(badStart), log));
    expect(err).not.toBeInstanceOf(BillingLoadError);
    expect(err).toMatchObject({ name: 'BillingConfigError' });
    expect(startFailureMessage(err)).toBe('BILLING_FIXTURE_START_MICROS must be a whole number of micro-dollars');
    expect(events()).toHaveLength(1);
  });

  it('test_fixture_settle_needs_its_check_instant', async () => {
    const t = await createTestHost();
    cleanup.push(() => t.close());
    const provider = await fixtureModule.createBillingProvider(t.host);
    const checkedAt = new Date('2026-10-14T12:00:00Z');
    const request = (requestId: string): BillingContext => ({ ...CTX, userId: `user-${requestId}`, requestId, checkedAt });
    const settle = (ctx: BillingContext, at: Date): SettleInput => ({
      ...settleInput(),
      userId: ctx.userId,
      requestId: ctx.requestId,
      checkedAt: at,
    });

    // The instant its check received: charged 100 micro-dollars a post.
    const ok = request('req-ok');
    await expect(provider.check(ok)).resolves.toEqual({ kind: 'allow' });
    await expect(provider.settle(settle(ok, new Date(checkedAt.getTime())))).resolves.toEqual({
      chargedMicros: 300,
      balanceMicros: 999_700,
    });

    // One millisecond off, or no check at all: refused.
    const off = request('req-off');
    await provider.check(off);
    await expect(provider.settle(settle(off, new Date(checkedAt.getTime() + 1)))).rejects.toThrow(
      'settle without the instant its check received',
    );
    await expect(provider.settle(settle(request('req-unchecked'), checkedAt))).rejects.toThrow(
      'settle without the instant its check received',
    );
  });

  it('test_load_billing_refuses_bad_modules', async () => {
    const t = await createTestHost();
    cleanup.push(() => t.close());
    const { log, lines } = captureLog();
    const dir = await tempDir();
    const write = async (name: string, source: string) => {
      const path = join(dir, name);
      await writeFile(path, source);
      return path;
    };
    const invalid = 'the billing module returned an invalid provider';

    const cases: [path: string, message: string][] = [
      [join(dir, 'missing.mjs'), 'BILLING_MODULE could not be loaded'],
      [await write('broken.mjs', "throw new Error('broken when imported');\n"), 'BILLING_MODULE could not be loaded'],
      [
        await write('no-export.mjs', 'export async function createProvider() {}\n'),
        'BILLING_MODULE does not export createBillingProvider',
      ],
      [await write('no-settle.mjs', providerModule('delete provider.settle;')), invalid],
      [await write('null.mjs', providerModule('return null;')), invalid],
      [await write('no-id.mjs', providerModule("provider.id = '';")), invalid],
      [await write('off-id.mjs', providerModule("provider.id = 'off';")), invalid],
      [await write('advertised.mjs', providerModule("provider.advertised = 'yes';")), invalid],
      [await write('mount.mjs', providerModule("provider.mount = '/routes';")), invalid],
      [await write('export.mjs', providerModule('provider.exportAccount = {};')), invalid],
      [await write('delete.mjs', providerModule('provider.deleteAccount = true;')), invalid],
    ];
    for (const [path, message] of cases) {
      const err = await rejection(loadBilling(moduleConfig(path), t.host, log));
      expect(err, path).toBeInstanceOf(BillingLoadError);
      expect((err as Error).name).toBe('BillingLoadError');
      expect((err as Error).message, path).toBe(message);
      expect(startFailureMessage(err)).toBe(message);
    }
    // A failed import keeps what went wrong as the cause, for a debugger; the message names the variable only.
    expect(await rejection(loadBilling(moduleConfig(join(dir, 'missing.mjs')), t.host, log))).toMatchObject({
      cause: expect.any(Error),
    });
    expect(lines).toEqual([]);

    // The same shape with every member in place, `mount` left out, loads.
    const complete = await loadBilling(moduleConfig(await write('complete.mjs', providerModule(''))), t.host, log);
    expect(complete.id).toBe('probe');
    expect(lines).toHaveLength(1);
    // And with the account export and deletion members (CL3-15).
    const account = providerModule('provider.exportAccount = fn; provider.deleteAccount = fn;');
    const withAccount = await loadBilling(moduleConfig(await write('account.mjs', account)), t.host, log);
    expect([typeof withAccount.exportAccount, typeof withAccount.deleteAccount]).toEqual(['function', 'function']);
    expect(lines).toHaveLength(2);
  });

  it('test_start_server_runs_billing_module', async () => {
    const { log, events } = captureLog();
    const server = await startServer(moduleConfig(FIXTURE), { db: await createTestDb(), port: 0, log });
    cleanup.push(() => server.close());

    // The loaded provider is the one the app serves: discovery advertises it, and its routes are mounted (a missing
    // route would answer 404, not the device check's 401).
    const info = await fetch(`${server.url}${SERVER_INFO_PATH}`);
    expect(await info.json()).toMatchObject({ billing: true });
    const balance = await fetch(`${server.url}${CREDIT_BALANCE_PATH}`);
    expect(balance.status).toBe(401);
    expect(await balance.json()).toMatchObject({ code: 'auth-required' });
    const order = events().map((e) => e.event);
    expect(order).toContain('billing.loaded');
    expect(order.indexOf('billing.loaded')).toBeLessThan(order.indexOf('server.started'));
    await expect(server.close()).resolves.toBeUndefined();

    // The module gets the config's BILLING_* variables: one it refuses stops the start, and the database is closed.
    const db = await createTestDb();
    cleanup.push(() => db.close());
    const badStart = moduleConfig(FIXTURE, { BILLING_FIXTURE_START_MICROS: 'QXZ7' });
    const err = await rejection(startServer(badStart, { db, port: 0, log }));
    expect(err).toMatchObject({ name: 'BillingConfigError' });
    await expect(db.db.execute(sql`select 1`)).rejects.toThrow();
    expect(events().filter((e) => e.event === 'server.started')).toHaveLength(1);
  });

  it('test_start_fails_closed_on_bad_module', async () => {
    const { log, events } = captureLog();
    const db = await createTestDb();
    cleanup.push(() => db.close());
    const port = await freePort();

    const err = await rejection(startServer(moduleConfig(join(await tempDir(), 'index.mjs')), { db, port, log }));

    expect(err).toBeInstanceOf(BillingLoadError);
    expect((err as Error).message).toBe('BILLING_MODULE could not be loaded');
    // startServer closed the database it was given, and never listened.
    await expect(db.db.execute(sql`select 1`)).rejects.toThrow();
    await expect(listenOnce(port)).resolves.toBeUndefined();
    expect(events().map((e) => e.event)).not.toContain('server.started');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('spawned entry', { timeout: SPAWN_TIMEOUT }, () => {
  it('test_entry_prints_billing_load_error', async () => {
    const pg = await createPostgresTestDb('ua_billing');
    cleanup.push(() => pg.drop());
    const missing = join(await tempDir(), 'index.mjs');

    const run = spawnSync(process.execPath, [ENTRY], {
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        PUBLIC_URL: 'http://127.0.0.1:8787',
        DATABASE_URL: pg.url,
        BETTER_AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
        SMTP_HOST: 'localhost',
        SMTP_SECURE: 'none',
        MAIL_FROM: 'noreply@example.org',
        AI_PROVIDER: 'anthropic',
        AI_API_KEY: 'sk-ant-test-not-a-key',
        BILLING: 'module',
        BILLING_MODULE: missing,
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^BILLING_MODULE could not be loaded$/m);
    expect(run.stdout).not.toContain('server.start_failed');
    expect(run.stdout).not.toContain('server.started');
    expect(run.stderr + run.stdout).not.toContain(missing);
  });
});

describe('fixture through the app', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_discovery_advertises_module_billing', async () => {
    const t = await fixtureApp();
    expect(t.provider.id).toBe('fixture');
    expect(await (await t.app.request(SERVER_INFO_PATH)).json()).toMatchObject({ billing: true });

    const plain = await createTestApp();
    cleanup.push(plain.close);
    expect(plain.provider).toBe(noopBilling);
    expect(await (await plain.app.request(SERVER_INFO_PATH)).json()).toMatchObject({ billing: false });
  });

  it('test_classify_charges_and_refuses_through_module', async () => {
    const t = await fixtureApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const posts = [await post('A', 'AI agents'), await post('B', 'Coffee')];

    const ok = await postClassify(t.app, classifyBody(posts), tokens.access_token);
    expect(ok.status).toBe(200);
    expect(ClassifyResponseSchema.parse(await ok.json()).billing).toEqual({ chargedMicros: 200, balanceMicros: 999_800 });
    expect(t.mock.bodies).toHaveLength(1);
    const tom = await t.host.accounts.findByEmail(TOM);
    await expect(t.provider.balance(tom?.id ?? '')).resolves.toEqual({ balanceMicros: 999_800 });

    // An empty balance: refused before the AI call.
    const empty = await fixtureApp({ billingEnv: { BILLING_FIXTURE_START_MICROS: '0' } });
    const emptyTokens = await signInDevice(empty.app, empty.outbox, TOM);
    const refused = await postClassify(empty.app, classifyBody(posts), emptyTokens.access_token);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({
      code: 'insufficient-credits',
      message: describeError('insufficient-credits', 'Test server'),
    });
    expect(empty.mock.bodies).toEqual([]);
  });

  it('test_fixture_routes_auth', async () => {
    const t = await fixtureApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    const bearer = { Authorization: `Bearer ${tokens.access_token}` };

    const balance = await t.app.request(CREDIT_BALANCE_PATH, { headers: bearer });
    expect(balance.status).toBe(200);
    expect(balance.headers.get('cache-control')).toBe('no-store');
    expect(CreditBalanceSchema.parse(await balance.json())).toEqual({
      v: 1,
      balanceMicros: 1_000_000,
      promoMicros: 1_000_000,
      purchasedMicros: 0,
      promoExpiresAt: null,
      starter: 'active',
    });

    const account = await t.app.request(CREDIT_ACCOUNT_PATH, { headers: { Cookie: cookie } });
    expect(account.status).toBe(200);
    expect(account.headers.get('cache-control')).toBe('no-store');
    expect(CreditAccountSchema.parse(await account.json())).toMatchObject({
      v: 1,
      balance: { balanceMicros: 1_000_000 },
      history: [],
    });

    // Without its credential, or with the other route's, each answers 401 auth-required.
    const refusals: [path: string, headers: Record<string, string>][] = [
      [CREDIT_BALANCE_PATH, {}],
      [CREDIT_BALANCE_PATH, { Cookie: cookie }],
      [CREDIT_ACCOUNT_PATH, {}],
      [CREDIT_ACCOUNT_PATH, bearer],
    ];
    for (const [path, headers] of refusals) {
      const res = await t.app.request(path, { headers });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'auth-required' });
    }
  });
});
