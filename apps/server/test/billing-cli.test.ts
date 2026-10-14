import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BillingCliDeps, main } from '../src/cli/billing.ts';
import { CONFIG_VARIABLES, type Config } from '../src/config.ts';
import type { DbHandle } from '../src/db/client.ts';
import { createTestDb } from './support/db.ts';
import { TEST_ENV, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** The public test module (never shipped), by absolute path as `BILLING_MODULE` names it. */
const FIXTURE = fileURLToPath(new URL('./fixtures/billing-module/index.ts', import.meta.url));
/** The server's manifest, by absolute path: the test must not depend on the folder Vitest runs in. */
const PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

/** What a module's `runCli` throws in the error test: a message that names a host, as a driver's can. */
const THROWING_CLI = [
  'export async function createBillingProvider() {',
  "  throw new Error('the CLI makes no provider');",
  '}',
  'export async function runCli() {',
  "  throw Object.assign(new Error('db at 10.0.0.5 failed'), { code: 'ECONNREFUSED' });",
  '}',
  '',
].join('\n');

/** Databases, folders and environment changes a test made, undone after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A fresh migrated PGlite database, closed after the test (a second close does nothing). */
async function testDb(): Promise<DbHandle> {
  const db = await createTestDb();
  cleanup.push(() => db.close());
  return db;
}

/** A module file in a fresh temporary folder, by absolute path; the folder is removed after the test. */
async function moduleFile(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ua-billing-cli-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  await writeFile(path, source);
  return path;
}

/** The test server's config with `BILLING=module` and this module; `env` adds the module's own variables. */
function moduleConfig(path: string = FIXTURE, env: Record<string, string> = {}): Config {
  return testConfig({ BILLING: 'module', BILLING_MODULE: path, ...env });
}

/** An `openDb` that fails the test when called: the paths that refuse never open a database. */
function noDatabase() {
  return vi.fn((_databaseUrl: string): DbHandle => {
    throw new Error('no database should be opened');
  });
}

/** Runs the CLI; returns its exit code and every line it printed. */
async function run(argv: readonly string[], deps: BillingCliDeps) {
  const lines: string[] = [];
  const code = await main(argv, { ...deps, out: (line) => lines.push(line) });
  return { code, lines };
}

describe('refusals', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_billing_cli_off', async () => {
    const openDb = noDatabase();
    expect(await run(['balance'], { config: testConfig(), openDb })).toEqual({
      code: 1,
      lines: ['BILLING is off: this server has no billing module'],
    });
    expect(openDb).not.toHaveBeenCalled();
  });

  it('test_billing_cli_config_error', async () => {
    // The environment of a test server without PUBLIC_URL, whatever the shell running the tests has set.
    for (const name of CONFIG_VARIABLES) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(TEST_ENV)) vi.stubEnv(name, value);
    vi.stubEnv('PUBLIC_URL', undefined);
    const openDb = noDatabase();

    expect(await run(['balance', '--user', 'u1'], { openDb })).toEqual({ code: 1, lines: ['missing: PUBLIC_URL'] });
    expect(openDb).not.toHaveBeenCalled();
  });

  it('test_billing_cli_module_without_commands', async () => {
    const openDb = noDatabase();
    const path = await moduleFile(
      'no-commands.mjs',
      "export async function createBillingProvider() {\n  throw new Error('the CLI makes no provider');\n}\n",
    );
    expect(await run(['balance', '--user', 'u1'], { config: moduleConfig(path), openDb })).toEqual({
      code: 1,
      lines: ['the billing module has no commands'],
    });

    // A module that cannot be loaded prints the loader's message, which names the variable, never the path.
    const missing = join(tmpdir(), 'ua-billing-cli-missing', 'index.mjs');
    expect(await run(['balance'], { config: moduleConfig(missing), openDb })).toEqual({
      code: 1,
      lines: ['BILLING_MODULE could not be loaded'],
    });
    expect(openDb).not.toHaveBeenCalled();
  });

  it('test_billing_cli_hides_error_messages', async () => {
    const db = await testDb();
    const config = moduleConfig(await moduleFile('throws.mjs', THROWING_CLI));

    const { code, lines } = await run(['balance', '--user', 'u1'], { db, config });

    expect(code).toBe(1);
    expect(lines).toEqual(['billing command failed: Error (ECONNREFUSED)']);
    expect(lines.join('\n')).not.toContain('10.0.0.5');
  });
});

describe('passthrough', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_billing_cli_runs_module_command', async () => {
    const db = await testDb();

    expect(await run(['balance', '--user', 'u1'], { db, config: moduleConfig() })).toEqual({
      code: 0,
      lines: ['balance 1000000'],
    });
    // The module's own variables reach it as `host.env`.
    const five = moduleConfig(FIXTURE, { BILLING_FIXTURE_START_MICROS: '5' });
    expect(await run(['balance', '--user', 'u1'], { db, config: five })).toEqual({ code: 0, lines: ['balance 5'] });
    // The module reads its own arguments and prints its own usage.
    expect(await run(['nope'], { db, config: moduleConfig() })).toEqual({
      code: 2,
      lines: ['usage: balance --user <id>'],
    });
  });

  it('test_billing_cli_closes_its_database', async () => {
    const throwing = moduleConfig(await moduleFile('throws.mjs', THROWING_CLI));

    // A database the CLI opened is closed before `main` returns: after a command that succeeds, and after one that
    // fails.
    for (const [config, expected] of [
      [moduleConfig(), 0],
      [throwing, 1],
    ] as const) {
      const db = await testDb();
      const close = vi.spyOn(db, 'close');
      const openDb = vi.fn((_databaseUrl: string) => db);

      expect((await run(['balance', '--user', 'u1'], { config, openDb })).code).toBe(expected);
      expect(openDb).toHaveBeenCalledExactlyOnceWith(config.databaseUrl);
      expect(close).toHaveBeenCalledOnce();
    }

    // A given handle stays open, for its owner to use and close.
    for (const [config, expected] of [
      [moduleConfig(), 0],
      [throwing, 1],
    ] as const) {
      const db = await testDb();
      const close = vi.spyOn(db, 'close');
      const openDb = noDatabase();

      expect((await run(['balance', '--user', 'u1'], { db, config, openDb })).code).toBe(expected);
      expect(close).not.toHaveBeenCalled();
      expect(openDb).not.toHaveBeenCalled();
      const { rows } = (await db.db.execute(sql`select 1 as one`)) as unknown as { rows: { one: number }[] };
      expect(rows).toEqual([{ one: 1 }]);
    }
  });

  it('test_billing_cli_script', async () => {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.billing).toBe('node --import ./src/require-node.js src/cli/billing.ts');
  });
});
