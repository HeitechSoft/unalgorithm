import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AIError } from '@unalgorithm/ai';
import { startMockOpenAI } from '@unalgorithm/ai/testing';
import { PROMPT_VERSION } from '@unalgorithm/core';
import { asc, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientForRoute } from '../src/ai/provider.ts';
import {
  type AiRoute,
  ANTHROPIC_ZDR_ELIGIBLE,
  RouteConfigError,
  type RouteSpec,
  recordEval,
  resolveRoute,
  syncRouteFromConfig,
  validateRoute,
} from '../src/ai/routes.ts';
import type { Config } from '../src/config.ts';
import type { Db, DbHandle } from '../src/db/client.ts';
import { openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { aiRoutes } from '../src/db/schema.ts';
import { startServer } from '../src/index.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { seedPassingRoute } from './support/routes.ts';
import { testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

/** The entry point, by absolute path: the test must not depend on the folder Vitest runs in. */
const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

/** A distinctive AI_API_KEY: it must never reach a row, an error message or the console. */
const API_KEY = 'sk-ant-test-KEYQXZ7-never-stored';

/** Servers, mocks and databases a test opened, closed after it whatever the outcome; spies are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle.db;
}

/** The server config with Anthropic as its provider; `model` unset means the default (Haiku 5.5). */
function anthropicConfig(model?: string): Config {
  return testConfig({
    AI_PROVIDER: 'anthropic',
    AI_API_KEY: API_KEY,
    AI_MODEL: model,
    AI_BASE_URL: undefined,
    AI_DATA_POLICY: undefined,
  });
}

function allRoutes(db: Db): Promise<AiRoute[]> {
  return db.select().from(aiRoutes).orderBy(asc(aiRoutes.createdAt));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

/** The rejection of `promise`, which must be `AIError` `not-available`. */
async function notAvailable(promise: Promise<unknown>): Promise<AIError> {
  const err = await rejection(promise);
  expect(err).toBeInstanceOf(AIError);
  expect((err as AIError).code).toBe('not-available');
  return err as AIError;
}

/** A valid Anthropic classify route, to vary one field at a time. */
const ANTHROPIC_SPEC: RouteSpec = {
  task: 'classify',
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  baseUrl: null,
  effort: 'low',
  dataPolicy: 'vendor-zdr',
};

describe('sync', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sync_inserts_default_anthropic_route', async () => {
    const db = await testDb();
    const { log, events } = captureLog();
    const synced = await syncRouteFromConfig(db, anthropicConfig(), log);

    const rows = await allRoutes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(synced);
    expect(rows[0]).toMatchObject({
      task: 'classify',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      baseUrl: null,
      effort: 'low',
      dataPolicy: 'vendor-zdr',
      enabled: true,
      evalPassedAt: null,
      evalAgreement: null,
      evalPromptVersion: null,
    });
    expect(events().filter((e) => e.event === 'ai.route.synced')).toEqual([
      expect.objectContaining({ level: 'info', provider: 'anthropic', model: 'claude-haiku-5-5', eval: 'pending' }),
    ]);
  });

  it('test_sync_is_idempotent', async () => {
    const db = await testDb();
    const { log, events } = captureLog();
    const first = await syncRouteFromConfig(db, anthropicConfig(), log);
    const evaluated = await recordEval(db, first.id, { agreement: 0.9, promptVersion: PROMPT_VERSION, passed: true });

    const second = await syncRouteFromConfig(db, anthropicConfig(), log);
    expect(second.id).toBe(first.id);
    expect(await allRoutes(db)).toEqual([evaluated]);
    expect(evaluated.evalPassedAt).toBeInstanceOf(Date);
    expect(evaluated.evalAgreement).toBe(0.9);
    expect(evaluated.evalPromptVersion).toBe(PROMPT_VERSION);
    expect(
      events()
        .filter((e) => e.event === 'ai.route.synced')
        .map((e) => e.eval),
    ).toEqual(['pending', 'passed']);
  });

  it('test_sync_replaces_changed_route', async () => {
    const db = await testDb();
    const { log } = captureLog();
    const haiku = await syncRouteFromConfig(db, anthropicConfig(), log);
    await recordEval(db, haiku.id, { agreement: 0.9, promptVersion: PROMPT_VERSION, passed: true });

    const sonnet = await syncRouteFromConfig(db, anthropicConfig('claude-sonnet-5-5'), log);
    expect(sonnet.id).not.toBe(haiku.id);
    const rows = await allRoutes(db);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.enabled)).toEqual([sonnet]);
    expect(rows.find((r) => r.id === haiku.id)?.enabled).toBe(false);
    expect(sonnet).toMatchObject({
      model: 'claude-sonnet-5-5',
      evalPassedAt: null,
      evalAgreement: null,
      evalPromptVersion: null,
    });

    // Back to Haiku: a new row again, with no eval; the old row's result does not come back.
    const again = await syncRouteFromConfig(db, anthropicConfig(), log);
    expect(again.id).not.toBe(haiku.id);
    expect(again.evalPassedAt).toBeNull();
    expect((await allRoutes(db)).filter((r) => r.enabled)).toEqual([again]);

    // The database itself refuses a second enabled route for a task.
    await expect(db.insert(aiRoutes).values({ ...ANTHROPIC_SPEC })).rejects.toThrow();
  });
});

describe('ZDR guard', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_non_zdr_anthropic_model_refused', async () => {
    expect(ANTHROPIC_ZDR_ELIGIBLE).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    const check = validateRoute({ ...ANTHROPIC_SPEC, model: 'claude-opus-5-5' });
    expect(check.ok).toBe(false);

    const db = await testDb();
    const err = await rejection(syncRouteFromConfig(db, anthropicConfig('claude-opus-5-5'), captureLog().log));
    expect(err).toBeInstanceOf(RouteConfigError);
    expect((err as Error).message).toContain('AI_MODEL claude-opus-5-5');
    expect((err as Error).message).toContain('zero data retention');
    expect((err as Error).message).not.toContain(API_KEY);
    expect(await allRoutes(db)).toEqual([]);

    // A vendor-zdr Anthropic route never carries a base URL of its own.
    expect(validateRoute({ ...ANTHROPIC_SPEC, baseUrl: 'https://proxy.example.org' }).ok).toBe(false);
    expect(validateRoute({ ...ANTHROPIC_SPEC, dataPolicy: 'self-hosted' }).ok).toBe(false);
    expect(validateRoute({ ...ANTHROPIC_SPEC, provider: 'openai' }).ok).toBe(false);
    expect(validateRoute(ANTHROPIC_SPEC)).toEqual({ ok: true });
  });

  it('test_compat_requires_self_hosted_policy', async () => {
    const db = await testDb();
    const { log } = captureLog();
    const vendor = testConfig({ AI_DATA_POLICY: 'vendor-zdr', AI_API_KEY: API_KEY });
    const err = await rejection(syncRouteFromConfig(db, vendor, log));
    expect(err).toBeInstanceOf(RouteConfigError);
    expect((err as Error).message).toContain('AI_DATA_POLICY');
    // Neither the key nor the base URL (which can hold credentials) is ever in the message.
    expect((err as Error).message).not.toContain(API_KEY);
    expect((err as Error).message).not.toContain('127.0.0.1');
    expect(await allRoutes(db)).toEqual([]);

    const route = await syncRouteFromConfig(db, testConfig(), log);
    expect(route).toMatchObject({
      task: 'classify',
      provider: 'openai-compatible',
      model: 'mock-model',
      baseUrl: 'http://127.0.0.1:8788/v1',
      dataPolicy: 'self-hosted',
      effort: 'low',
      enabled: true,
      evalPassedAt: null,
    });
    expect(await allRoutes(db)).toEqual([route]);

    const compat: RouteSpec = { ...ANTHROPIC_SPEC, provider: 'openai-compatible', model: 'llama', dataPolicy: 'self-hosted' };
    expect(validateRoute({ ...compat, baseUrl: 'http://ollama:11434/v1' })).toEqual({ ok: true });
    expect(validateRoute(compat).ok).toBe(false);
  });

  it('test_validate_route_rejects_non_low_effort', () => {
    const check = validateRoute({ ...ANTHROPIC_SPEC, effort: 'medium' });
    expect(check).toEqual({ ok: false, reason: expect.stringContaining('low') });
    expect(validateRoute({ ...ANTHROPIC_SPEC, task: 'research' }).ok).toBe(false);
  });
});

describe('eval gate', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_resolve_route_gate_failures', async () => {
    const db = await testDb();
    const { log, events } = captureLog();

    const none = await notAvailable(resolveRoute(db, 'classify', 0.8, log));
    expect(none.message).toBe('No AI route is configured.');

    const notPassed = /has not passed its evaluation/;
    await seedPassingRoute(db, { evalPassedAt: null });
    expect((await notAvailable(resolveRoute(db, 'classify', 0.8, log))).message).toMatch(notPassed);
    await seedPassingRoute(db, { evalPromptVersion: PROMPT_VERSION + 1 });
    expect((await notAvailable(resolveRoute(db, 'classify', 0.8, log))).message).toMatch(notPassed);
    await seedPassingRoute(db, { evalAgreement: 0.79 });
    expect((await notAvailable(resolveRoute(db, 'classify', 0.8, log))).message).toMatch(notPassed);

    // The route itself is checked again: one written past the guard is not served, whatever its eval says.
    await seedPassingRoute(db, { provider: 'anthropic', model: 'claude-opus-5-5', dataPolicy: 'vendor-zdr', baseUrl: null });
    await notAvailable(resolveRoute(db, 'classify', 0.8, log));

    // Three refusals within a minute, one log line; it names the route, never more.
    const pending = events().filter((e) => e.event === 'ai.route.eval_pending');
    expect(pending).toEqual([expect.objectContaining({ level: 'warn', task: 'classify', model: 'mock-model' })]);

    // The seeded route itself passes.
    const seeded = await seedPassingRoute(db);
    expect((await resolveRoute(db, 'classify', 0.8, log)).id).toBe(seeded.id);
  });

  it('test_record_eval_opens_gate', async () => {
    const db = await testDb();
    const { log } = captureLog();
    const route = await syncRouteFromConfig(db, testConfig(), log);
    await notAvailable(resolveRoute(db, 'classify', 0.8, log));

    const evaluated = await recordEval(db, route.id, { agreement: 0.9, promptVersion: PROMPT_VERSION, passed: true });
    expect(evaluated.evalPassedAt).toBeInstanceOf(Date);
    expect((await resolveRoute(db, 'classify', 0.8, log)).id).toBe(route.id);
    // The agreement is stored exactly, so a minimum equal to the measured value still passes.
    expect((await resolveRoute(db, 'classify', 0.9, log)).id).toBe(route.id);
    await notAvailable(resolveRoute(db, 'classify', 0.91, log));

    // A failed eval closes the gate again.
    const failed = await recordEval(db, route.id, { agreement: 0.5, promptVersion: PROMPT_VERSION, passed: false });
    expect(failed).toMatchObject({ evalPassedAt: null, evalAgreement: 0.5, evalPromptVersion: PROMPT_VERSION });
    await notAvailable(resolveRoute(db, 'classify', 0, log));
  });
});

describe('provider and secrets', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_client_for_compat_route_lists_mock_model', async () => {
    const mock = await startMockOpenAI();
    cleanup.push(() => mock.close());
    const config = testConfig({ AI_BASE_URL: mock.baseUrl });
    const route = await syncRouteFromConfig(await testDb(), config, captureLog().log);

    const client = clientForRoute(route, config);
    expect(client.kind).toBe('openai-compatible');
    expect((await client.listModels()).map((m) => m.id)).toEqual(['mock-model']);
  });

  it('test_client_for_anthropic_route_kind', async () => {
    const config = anthropicConfig();
    const route = await syncRouteFromConfig(await testDb(), config, captureLog().log);
    expect(clientForRoute(route, config).kind).toBe('anthropic');

    // A route that breaks the guard gets no client.
    expect(() => clientForRoute({ ...route, model: 'claude-opus-5-5' }, config)).toThrow(AIError);
  });

  it('test_anthropic_route_ignores_sdk_env', async () => {
    const config = anthropicConfig();
    const route = await syncRouteFromConfig(await testDb(), config, captureLog().log);

    const sdkEnv: Record<string, string> = {
      ANTHROPIC_LOG: 'debug',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: 'probe-bearer-token',
    };
    const saved = Object.keys(sdkEnv).map((name) => [name, process.env[name]] as const);
    cleanup.push(async () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    Object.assign(process.env, sdkEnv);
    const consoleSpies = (['debug', 'info', 'log', 'warn'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const urls: string[] = [];
    const sent: Headers[] = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      sent.push(new Headers(init?.headers));
      return Response.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: '{"results":[]}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    };
    const client = clientForRoute(route, config, { fetch: fakeFetch as unknown as typeof fetch });
    const out = await client.structured({
      model: route.model,
      system: 'System prompt CANARY-SYSTEM',
      user: 'Post text CANARY-POST',
      jsonSchema: { type: 'object' },
      schemaName: 'results',
      effort: 'low',
      maxOutputTokens: 100,
    });

    expect(out.text).toBe('{"results":[]}');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').origin).toBe('https://api.anthropic.com');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
    // AI_API_KEY is the one credential: no bearer token from the environment rides along.
    expect(sent[0]?.get('x-api-key')).toBe(API_KEY);
    expect(sent[0]?.has('authorization')).toBe(false);

    // No client option stops the SDK adding ANTHROPIC_CUSTOM_HEADERS to every request, so the server refuses to start
    // while it is set.
    expect(() => testConfig({ ANTHROPIC_CUSTOM_HEADERS: 'x-probe: injected' })).toThrow(/ANTHROPIC_CUSTOM_HEADERS/);
  });

  it('test_api_key_never_stored', async () => {
    const db = await testDb();
    const { log } = captureLog();
    const anthropic = await syncRouteFromConfig(db, anthropicConfig(), log);
    await recordEval(db, anthropic.id, { agreement: 0.9, promptVersion: PROMPT_VERSION, passed: true });
    await syncRouteFromConfig(db, testConfig({ AI_API_KEY: API_KEY }), log);

    const result = await db.execute(sql`select ai_routes::text as row from ai_routes`);
    const rows = (result as unknown as { rows: { row: string }[] }).rows.map((r) => r.row);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).not.toContain(API_KEY);
  });

  it('test_boot_refuses_ineligible_model', async () => {
    const { log, lines } = captureLog();
    const db = await createTestDb();
    cleanup.push(() => db.close());
    const err = await rejection(startServer(anthropicConfig('claude-opus-5-5'), { db, port: 0, log }));

    expect(err).toBeInstanceOf(RouteConfigError);
    expect((err as Error).message).toContain('claude-opus-5-5');
    expect((err as Error).message).not.toContain(API_KEY);
    expect(lines.join('')).not.toContain(API_KEY);
    // startServer closed the database it was given.
    await expect(db.db.execute(sql`select 1`)).rejects.toThrow();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_entry_prints_route_config_error', async () => {
    const pg = await createPostgresTestDb('ua_routes');
    cleanup.push(() => pg.drop());

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
        AI_MODEL: 'claude-opus-5-5',
        AI_API_KEY: API_KEY,
      },
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^AI_MODEL claude-opus-5-5 is not eligible for zero data retention/m);
    expect(run.stdout).not.toContain('server.start_failed');
    expect(run.stdout).not.toContain('server.started');
    expect(run.stderr + run.stdout).not.toContain(API_KEY);

    // The refusal came after the migrations, and wrote no route.
    const handle: DbHandle = openPostgres(pg.url);
    cleanup.push(() => handle.close());
    await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
    expect(await allRoutes(handle.db)).toEqual([]);
  });

  it('test_concurrent_sync_on_postgres', async () => {
    const pg = await createPostgresTestDb('ua_routes');
    cleanup.push(() => pg.drop());
    const a = openPostgres(pg.url);
    const b = openPostgres(pg.url);
    cleanup.push(
      () => a.close(),
      () => b.close(),
    );
    const { log } = captureLog();
    await runMigrations(a, { migrationsFolder: MIGRATIONS_FOLDER, log });
    await syncRouteFromConfig(a.db, anthropicConfig(), log);

    // Servers start together after AI_MODEL changed: one replaces the route, the others keep the replacement. Each pool
    // opens its connections first, so the syncs overlap.
    await Promise.all([a, b].flatMap((h) => [1, 2, 3].map(() => h.db.execute(sql`select pg_sleep(0.05)`))));
    const sonnet = anthropicConfig('claude-sonnet-5-5');
    const synced = await Promise.all([a, b, a, b, a, b].map((h) => syncRouteFromConfig(h.db, sonnet, log)));
    expect(new Set(synced.map((r) => r.id)).size).toBe(1);
    const rows = await allRoutes(a.db);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.enabled)).toEqual([synced[0]]);
  });
});
