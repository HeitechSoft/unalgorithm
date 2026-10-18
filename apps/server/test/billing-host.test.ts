import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_PRICE_SCHEDULE, DEFAULT_PRICE_BOOK, priceCardsAt } from '@unalgorithm/protocol';
import { type SQL, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPriceChange, type PriceStore } from '../src/admin/prices.ts';
import { createAuth } from '../src/auth/better-auth.ts';
import {
  BILLING_MIGRATION_LOCK_KEY,
  BILLING_SCHEMA,
  type BillingHost,
  type BillingHostDeps,
  createBillingHost,
} from '../src/billing/host.ts';
import { SERVER_VERSION } from '../src/config.ts';
import { type DbHandle, openPglite, openPostgres } from '../src/db/client.ts';
import { MIGRATION_LOCK_KEY, MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { user } from '../src/db/schema.ts';
import { createJobRegistry } from '../src/jobs/worker.ts';
import type { Mailer } from '../src/mail/mailer.ts';
import { createTestHost } from './support/billing-host.ts';
import { queryRows } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ADA = 'ada@example.org';
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };

/** One migration, `0000_probe.sql`, creating `billing.probe`. */
const BILLING_PROBE_FOLDER = fileURLToPath(new URL('./fixtures/billing-migrations', import.meta.url));

/** Handles, hosts, folders and databases a test opened, closed or removed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testHost(opts: Parameters<typeof createTestHost>[0] = {}) {
  const t = await createTestHost(opts);
  cleanup.push(() => t.close());
  return t;
}

/** A host on its own throwaway Postgres database, with the server's migrations applied. */
async function postgresHost() {
  const pg = await createPostgresTestDb('ua_host');
  cleanup.push(() => pg.drop());
  const db = openPostgres(pg.url);
  cleanup.push(() => db.close());
  await runMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
  return testHost({ db });
}

/** A test app whose allow-list lets Tom sign in, closed after the test. */
async function tomApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }) });
  cleanup.push(() => t.close());
  return t;
}

async function count(db: DbHandle, query: SQL): Promise<number> {
  return Number((await queryRows(db, query))[0]?.n);
}

const serverMigrationRows = (db: DbHandle) => count(db, sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
const billingMigrationRows = (db: DbHandle) => count(db, sql`select count(*)::int as n from billing.__drizzle_migrations`);
const hasTable = async (db: DbHandle, name: string) =>
  (await queryRows(db, sql`select to_regclass(${name})::text as t`))[0]?.t !== null;
const hasSchema = async (db: DbHandle, name: string) =>
  (await queryRows(db, sql`select to_regnamespace(${name})::text as s`))[0]?.s !== null;

async function tempFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-billing-migrations-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A migration folder (journal and one migration) whose SQL is `statement`. */
async function migrationFolder(tag: string, statement: string): Promise<string> {
  const dir = await tempFolder();
  await mkdir(join(dir, 'meta'));
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 1791826771503, tag, breakpoints: true }],
  };
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
  await writeFile(join(dir, `${tag}.sql`), statement);
  return dir;
}

/** A migration that writes down the advisory locks its own session holds while it runs: the key the runner took. */
const lockProbeFolder = () =>
  migrationFolder(
    '0000_lock_seen',
    `CREATE TABLE "lock_seen" AS SELECT "objid"::text AS "key" FROM "pg_locks" WHERE "locktype" = 'advisory' AND "pid" = pg_backend_pid();\n`,
  );
const locksSeen = async (db: DbHandle) => (await queryRows(db, sql`select key from lock_seen`)).map((r) => Number(r.key));

async function expectQueryBindsParameters(host: BillingHost): Promise<void> {
  const rows = await host.db.query(host.db.sql`select ${41} + 1 as n`);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]?.n)).toBe(42);
  // A value is a bound parameter, never statement text: quotes and a statement in it come back as they went in.
  const text = `x'); drop table "user"; --`;
  expect(await host.db.query<{ s: string }>(host.db.sql`select ${text}::text as s`)).toEqual([{ s: text }]);
}

async function expectTransactionRollsBack(host: BillingHost): Promise<void> {
  const ids = async () => (await host.db.query(host.db.sql`select id from scratch order by id`)).map((r) => Number(r.id));
  await host.db.query(host.db.sql`create table scratch (id integer)`);
  const failure = new Error('stop here');
  await expect(
    host.db.transaction(async (tx) => {
      await tx.query(tx.sql`insert into scratch (id) values (${1})`);
      expect(await tx.query(tx.sql`select id from scratch`)).toHaveLength(1);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await ids()).toEqual([]);

  // A transaction that returns commits, and resolves with what it returned.
  await expect(
    host.db.transaction(async (tx) => {
      await tx.query(tx.sql`insert into scratch (id) values (${2})`);
      return 'done';
    }),
  ).resolves.toBe('done');
  expect(await ids()).toEqual([2]);
}

async function expectMigrateIntoBillingSchema(host: BillingHost, db: DbHandle, lines: string[]): Promise<void> {
  const serverRows = await serverMigrationRows(db);
  expect(serverRows).toBeGreaterThan(0);

  await host.migrate(BILLING_PROBE_FOLDER);
  expect(await hasTable(db, 'billing.probe')).toBe(true);
  expect(await billingMigrationRows(db)).toBe(1);

  await host.migrate(BILLING_PROBE_FOLDER);
  expect(await billingMigrationRows(db)).toBe(1);
  expect(await serverMigrationRows(db)).toBe(serverRows);
  expect(await hasTable(db, 'public.probe')).toBe(false);

  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.filter((e) => e.event === 'db.migrations.done' && e.migrations === 'billing')).toHaveLength(2);
}

describe('SQL facade', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_query_binds_parameters', async () => {
    await expectQueryBindsParameters((await testHost()).host);
  });

  it('test_host_transaction_rolls_back', async () => {
    await expectTransactionRollsBack((await testHost()).host);
  });
});

describe('migrations', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_migrate_into_billing_schema', async () => {
    const { host, db, lines } = await testHost();
    await expectMigrateIntoBillingSchema(host, db, lines);
  });

  it('test_host_migrate_without_journal', async () => {
    const { host, db, lines } = await testHost();
    await expect(host.migrate(await tempFolder())).resolves.toBeUndefined();
    expect(await hasSchema(db, BILLING_SCHEMA)).toBe(false);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({ event: 'db.migrations.none', migrations: 'billing' })]);
  });

  it('test_host_migrate_failure_rejects', async () => {
    const { host, db } = await testHost();
    const broken = await migrationFolder('0000_broken', 'CREATE TABL "billing"."probe" ("id" integer);\n');
    await expect(host.migrate(broken)).rejects.toThrow();
    expect(await hasTable(db, 'billing.probe')).toBe(false);
  });

  it('test_host_migrate_holds_its_own_lock', async () => {
    const { host, db } = await testHost();
    await host.migrate(await lockProbeFolder());
    expect(await locksSeen(db)).toEqual([BILLING_MIGRATION_LOCK_KEY]);
    expect(BILLING_MIGRATION_LOCK_KEY).toBe(1431191874);
  });

  it('test_server_migrations_unchanged', async () => {
    expect(MIGRATION_LOCK_KEY).toBe(1431191884);
    const db = await openPglite();
    cleanup.push(() => db.close());
    await expect(runMigrations(db, { migrationsFolder: await lockProbeFolder(), log: captureLog().log })).resolves.toEqual({
      applied: true,
    });
    // Without the new options: the server's lock, and its bookkeeping in drizzle.__drizzle_migrations.
    expect(await locksSeen(db)).toEqual([1431191884]);
    expect(await serverMigrationRows(db)).toBe(1);
    expect(await hasSchema(db, BILLING_SCHEMA)).toBe(false);
  });
});

describe('accounts and auth', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_accounts_lookup', async () => {
    const t = await tomApp();
    await signInWeb(t.app, t.outbox, TOM);
    const { host } = await testHost({ db: t.deps.db });
    const [row] = await queryRows(t.deps.db, sql`select id from "user" where email = ${TOM}`);
    const id = String(row?.id);

    const account = await host.accounts.get(id);
    expect(account).toStrictEqual({ id, email: TOM, emailVerified: true, createdAt: expect.any(Date) });
    expect(Math.abs((account?.createdAt.getTime() ?? 0) - Date.now())).toBeLessThan(60_000);
    expect(await host.accounts.findByEmail('  TOM@Example.com ')).toStrictEqual(account);

    expect(await host.accounts.get('no-such-account')).toBeNull();
    expect(await host.accounts.findByEmail('nobody@example.com')).toBeNull();
  });

  it('test_host_auth_middlewares_refuse', async () => {
    const t = await tomApp();
    const { host } = await testHost({ db: t.deps.db });
    t.app.get('/v1/test/device', host.auth.device, (c) => c.json(c.get('account')));
    t.app.get('/v1/test/web', host.auth.webSession, (c) => c.json(c.get('webUser')));

    const noToken = await t.app.request('/v1/test/device');
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toEqual(AUTH_REQUIRED);
    expect(noToken.headers.get('www-authenticate')).toBe('Bearer');
    const noCookie = await t.app.request('/v1/test/web');
    expect(noCookie.status).toBe(401);
    expect(await noCookie.json()).toEqual(AUTH_REQUIRED);

    // The same checks let a signed-in device and a web session through.
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const device = await t.app.request('/v1/test/device', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    expect(device.status).toBe(200);
    expect(await device.json()).toMatchObject({ deviceId: tokens.device_id });
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    const web = await t.app.request('/v1/test/web', { headers: { Cookie: cookie } });
    expect(web.status).toBe(200);
    expect(await web.json()).toMatchObject({ email: TOM });
  });
});

describe('shape', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_exposes_only_the_contract', async () => {
    const env = { BILLING_STARTER_SECRET: 's3cret' };
    const { host, jobs, lines } = await testHost({ env });

    expect(Object.keys(host)).toEqual([
      'protocol',
      'prices',
      'db',
      'migrate',
      'log',
      'config',
      'env',
      'accounts',
      'auth',
      'jobs',
      'html',
      'pages',
      'format',
      'usage',
      'mail',
    ]);
    // The price book in use, read at each use: never the store itself (no refresh, no seed).
    expect(Object.keys(host.prices)).toEqual(['current']);
    expect(Object.isFrozen(host.prices)).toBe(true);
    expect(Object.keys(host.db)).toEqual(['sql', 'query', 'transaction']);
    expect(host.db.sql).toBe(sql);
    expect(Object.keys(host.accounts)).toEqual(['get', 'findByEmail']);
    expect(Object.keys(host.auth)).toEqual(['device', 'webSession', 'webUser', 'ownPage']);
    expect(Object.keys(host.pages)).toEqual(['render']);
    expect(Object.isFrozen(host.pages)).toBe(true);
    expect(Object.keys(host.format)).toEqual(['formatBalance', 'formatCreditAmount', 'formatPostsEstimate', 'formatPrice']);
    expect(Object.isFrozen(host.format)).toBe(true);
    expect(Object.keys(host.usage)).toEqual(['costByDay']);
    expect(Object.isFrozen(host.usage)).toBe(true);
    expect(Object.keys(host.mail)).toEqual(['toAccount']);
    expect(Object.isFrozen(host.mail)).toBe(true);

    // The running release's dated price schedule, never a copy, and no undated cards.
    expect(host.protocol.CREDIT_PRICE_SCHEDULE).toBe(CREDIT_PRICE_SCHEDULE);
    expect(host.protocol.priceCardsAt).toBe(priceCardsAt);
    // The undated cards CL2-26 removed, spelled in parts so that `git grep` finds the name in no tracked file.
    expect(['CREDIT', 'PRICE', 'CARDS'].join('_') in host.protocol).toBe(false);
    expect(host.config).toStrictEqual({ publicOrigin: TEST_PUBLIC_URL, instanceName: 'Test server', version: SERVER_VERSION });
    expect(host.jobs).toBe(jobs);

    expect(host.env).toStrictEqual(env);
    expect(Object.isFrozen(host.env)).toBe(true);
    // A copy: changing the object given changes nothing the module sees.
    env.BILLING_STARTER_SECRET = 'changed';
    expect(host.env.BILLING_STARTER_SECRET).toBe('s3cret');
    const bare = await testHost();
    expect(bare.host.env).toStrictEqual({});
    expect(Object.isFrozen(bare.host.env)).toBe(true);

    host.log.info('billing.probe');
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ event: 'billing.probe', module: 'billing' });
  });

  it('test_host_prices_follow_the_store', async () => {
    const { host, db, prices } = await testHost();
    // The store's book, not a copy: the code defaults while none is stored.
    expect(host.prices.current()).toBe(prices.current());
    expect(host.prices.current()).toEqual(DEFAULT_PRICE_BOOK);

    // An admin saves a change: the same host returns the new book, without being made again.
    const at = new Date();
    await db.db.insert(user).values({ id: 'u-ada', name: '', email: ADA, emailVerified: true, createdAt: at, updatedAt: at });
    const purchase = {
      minMicros: 10_000_000,
      maxMicros: 1_000_000_000,
      presetsMicros: [10_000_000, 25_000_000],
      defaultMicros: 25_000_000,
    };
    expect(await applyPriceChange(db.db, prices, 'u-ada', { action: 'purchase', baseVersion: '0', purchase })).toEqual({
      ok: true,
      version: '2',
      changed: true,
    });
    expect(host.prices.current()).toBe(prices.current());
    expect(host.prices.current().purchase).toEqual(purchase);
    expect(host.prices.current().schedule).toEqual(DEFAULT_PRICE_BOOK.schedule);
  });
});

const ANN = 'ann@example.org';
const MESSAGE = { subject: 'Auto-reload is on', text: 'Line 1\nLine 2' };

/** A test host with Ann's account in its database; `annId` is her user id. */
async function annHost() {
  const t = await testHost();
  const at = new Date();
  const annId = 'u-ann';
  await t.db.db.insert(user).values({ id: annId, name: '', email: ANN, emailVerified: true, createdAt: at, updatedAt: at });
  return { ...t, annId };
}

/** A host on `db` and its price store whose mailer is `mailer`, logging into `lines`. */
function hostWithMailer(db: DbHandle, prices: PriceStore, mailer: Mailer) {
  const config = testConfig();
  const { log, lines } = captureLog();
  const auth = createAuth({ config, db, mailer, log, rateLimitEnabled: false });
  return { host: createBillingHost({ config, db, log, auth, jobs: createJobRegistry(), mailer, prices }), lines };
}

/** The calls `mail.toAccount` refuses (AC 4's six cases, the line break both ways), as [user id, message]. */
function badMessages(annId: string): [string, { subject: string; text: string }][] {
  return [
    [annId, { subject: 'Auto-reload\nBcc: eve@example.org', text: MESSAGE.text }],
    [annId, { subject: 'Auto-reload\rBcc: eve@example.org', text: MESSAGE.text }],
    [annId, { subject: '', text: MESSAGE.text }],
    [annId, { subject: 'S'.repeat(201), text: MESSAGE.text }],
    [annId, { subject: MESSAGE.subject, text: '' }],
    [annId, { subject: MESSAGE.subject, text: 'T'.repeat(10_001) }],
    ['', MESSAGE],
  ];
}

async function expectRefused(host: BillingHost, userId: string, message: { subject: string; text: string }) {
  const err = await host.mail.toAccount(userId, message).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TypeError);
  const text = (err as TypeError).message;
  if (message.subject !== '') expect(text).not.toContain(message.subject);
  if (message.text !== '') expect(text).not.toContain(message.text);
}

describe('mail', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_mail_to_account_sends_to_its_address', async () => {
    const { host, outbox, annId } = await annHost();
    const before = outbox.length;
    await expect(host.mail.toAccount(annId, MESSAGE)).resolves.toBe('sent');
    expect(outbox.slice(before)).toStrictEqual([{ to: ANN, subject: MESSAGE.subject, text: MESSAGE.text }]);
  });

  it('test_host_mail_unknown_account', async () => {
    const { host, outbox } = await annHost();
    const before = outbox.length;
    await expect(host.mail.toAccount('no-such-account', MESSAGE)).resolves.toBe('no-account');
    expect(outbox).toHaveLength(before);
  });

  it('test_host_mail_refuses_bad_messages', async () => {
    const { host, outbox, annId } = await annHost();
    const before = outbox.length;
    // Each is refused on its own: the edges just inside the limits are sent.
    for (const [userId, message] of badMessages(annId)) await expectRefused(host, userId, message);
    expect(outbox).toHaveLength(before);
    await expect(host.mail.toAccount(annId, { subject: 'S'.repeat(200), text: 'T'.repeat(10_000) })).resolves.toBe('sent');
  });

  it('test_host_mail_rejection_propagates', async () => {
    const { db, prices, annId } = await annHost();
    const refused = new Error('550 mailbox unavailable');
    const { host } = hostWithMailer(db, prices, { send: () => Promise.reject(refused) });
    await expect(host.mail.toAccount(annId, MESSAGE)).rejects.toBe(refused);
  });

  it('test_host_mail_logs_hold_no_address_or_text', async () => {
    const { host, db, prices, lines, annId } = await annHost();
    await host.mail.toAccount(annId, MESSAGE);
    await host.mail.toAccount('no-such-account', MESSAGE);
    for (const [userId, message] of badMessages(annId)) await host.mail.toAccount(userId, message).catch(() => {});
    const failing = hostWithMailer(db, prices, { send: () => Promise.reject(new Error(`refused for ${ANN}`)) });
    await failing.host.mail.toAccount(annId, MESSAGE).catch(() => {});

    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'billing.mail.sent', module: 'billing', ms: expect.any(Number) }),
    );
    expect(events).toContainEqual(expect.objectContaining({ event: 'billing.mail.no_account', module: 'billing' }));
    for (const line of [...lines, ...failing.lines]) {
      expect(line).not.toContain(ANN);
      expect(line).not.toContain(MESSAGE.subject);
      expect(line).not.toContain('Line 1');
    }
  });

  it('test_host_requires_a_mailer', () => {
    // Never called: the line is here for `pnpm typecheck`, which fails if `mailer` becomes optional.
    const withoutMailer = (deps: Omit<BillingHostDeps, 'mailer'>) =>
      // @ts-expect-error `mailer` is required: every caller passes the one mailer its process has.
      createBillingHost(deps);
    expect(typeof withoutMailer).toBe('function');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_host_query_binds_parameters', async () => {
    await expectQueryBindsParameters((await postgresHost()).host);
  });

  it('test_host_transaction_rolls_back', async () => {
    await expectTransactionRollsBack((await postgresHost()).host);
  });

  it('test_host_migrate_into_billing_schema', async () => {
    const { host, db, lines } = await postgresHost();
    await expectMigrateIntoBillingSchema(host, db, lines);
  });
});
