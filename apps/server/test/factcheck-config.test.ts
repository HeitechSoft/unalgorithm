import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AIError } from '@unalgorithm/ai';
import { PROMPT_VERSION } from '@unalgorithm/core';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { asc } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configuredRoutes,
  type RouteSpec,
  resolveRoute,
  routePromptVersion,
  syncRouteFromConfig,
  validateRoute,
} from '../src/ai/routes.ts';
import { CONFIG_VARIABLES, type Config, ConfigError, loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/client.ts';
import { aiRoutes } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { seedPassingRoute } from './support/routes.ts';
import { TEST_ENV, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT, PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

/** Distinctive values: none of them may reach an error message. */
const API_KEY = 'sk-ant-test-FCQ7-never-shown';
const SEARCH_KEY = 'search-key-FCQ7-never-shown';
const SEARXNG_URL = 'http://searxng:8080';

/** The test server's environment with Anthropic as its provider. */
const ANTHROPIC: Record<string, string | undefined> = {
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: API_KEY,
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
};

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function testDb(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle.db;
}

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    testConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('config', () => {
  it('test_factcheck_config_defaults_off', () => {
    for (const config of [testConfig(), testConfig(ANTHROPIC)]) {
      expect(config.factcheck).toMatchObject({ enabled: false, userDailyCheckCap: 10, search: null });
      expect(config.egressDeny).toEqual([]);
    }
    // The limits apply whether fact-check is on or off.
    expect(testConfig({ USER_DAILY_CHECK_CAP: '0', EGRESS_DENY: '192.0.2.7, 2001:db8::/32' })).toMatchObject({
      factcheck: { userDailyCheckCap: 0 },
      egressDeny: ['192.0.2.7', '2001:db8::/32'],
    });
  });

  it('test_factcheck_config_model_defaults', () => {
    expect(testConfig({ ...ANTHROPIC, FACTCHECK: 'on' }).factcheck).toEqual({
      enabled: true,
      researchModel: 'claude-sonnet-5-5',
      synthesisModel: 'claude-sonnet-5-5',
      search: null,
      userDailyCheckCap: 10,
    });
    expect(testConfig({ FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: SEARXNG_URL }).factcheck).toMatchObject({
      researchModel: 'mock-model',
      synthesisModel: 'mock-model',
      search: { provider: 'searxng', url: SEARXNG_URL },
    });
    expect(
      testConfig({
        ...ANTHROPIC,
        FACTCHECK: 'on',
        SEARCH_PROVIDER: 'tavily',
        SEARCH_API_KEY: SEARCH_KEY,
        AI_SYNTHESIS_MODEL: 'claude-haiku-5-5',
      }).factcheck,
    ).toMatchObject({ synthesisModel: 'claude-haiku-5-5', search: { provider: 'tavily', apiKey: SEARCH_KEY } });
  });

  it('test_factcheck_config_rules', () => {
    const on = { ...ANTHROPIC, FACTCHECK: 'on' };
    const billing = { BILLING: 'module', BILLING_MODULE: '/srv/billing/index.ts' };
    const cases: [string, Record<string, string | undefined>, string[]][] = [
      [
        'search settings with FACTCHECK off',
        { ...ANTHROPIC, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY },
        ['SEARCH_PROVIDER', 'SEARCH_API_KEY'],
      ],
      ['searxng without SEARCH_URL', { ...on, SEARCH_PROVIDER: 'searxng' }, ['SEARCH_URL']],
      ['brave without SEARCH_API_KEY', { ...on, SEARCH_PROVIDER: 'brave' }, ['SEARCH_API_KEY']],
      [
        'brave with SEARCH_URL',
        { ...on, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY, SEARCH_URL: SEARXNG_URL },
        ['SEARCH_URL'],
      ],
      ['openai-compatible without SEARCH_PROVIDER', { FACTCHECK: 'on' }, ['SEARCH_PROVIDER']],
      [
        'AI_RESEARCH_MODEL with a search provider',
        { ...on, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY, AI_RESEARCH_MODEL: 'claude-haiku-5-5' },
        ['AI_RESEARCH_MODEL'],
      ],
      [
        'BILLING=module with a search provider',
        { ...on, ...billing, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY },
        ['SEARCH_PROVIDER'],
      ],
      ['USER_DAILY_CHECK_CAP=-1', { USER_DAILY_CHECK_CAP: '-1' }, ['USER_DAILY_CHECK_CAP']],
      ['EGRESS_DENY=10.0.0.0/40', { EGRESS_DENY: '10.0.0.0/40' }, ['EGRESS_DENY']],
    ];
    for (const [label, env, names] of cases) {
      const err = configError(env);
      expect([...err.missing, ...err.invalid.map((i) => i.name)].sort(), label).toEqual([...names].sort());
      for (const name of names) expect(err.message, label).toContain(name);
      for (const value of [SEARCH_KEY, SEARXNG_URL, API_KEY, 'claude-haiku-5-5', '10.0.0.0/40', '-1']) {
        expect(err.message, label).not.toContain(value);
      }
    }

    // The reasons say why, as the plan words them.
    expect(configError({ FACTCHECK: 'on' }).message).toContain(
      'an OpenAI-compatible model cannot search the web: set SEARCH_PROVIDER',
    );
    expect(
      configError({ ...on, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY, AI_RESEARCH_MODEL: 'x' }).message,
    ).toContain('unused when SEARCH_PROVIDER is set');
    expect(configError({ ...ANTHROPIC, AI_SYNTHESIS_MODEL: 'x' }).message).toContain('must be unset when FACTCHECK is off');
    expect(configError({ ...on, ...billing, SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY }).message).toContain(
      'a billing server researches with Anthropic web search only, so every check is priced',
    );
    // A billing server on an OpenAI-compatible model cannot fact-check either; with fact-check off it is unaffected.
    expect(
      configError({ ...billing, FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: SEARXNG_URL }).invalid.map(
        (i) => i.name,
      ),
    ).toEqual(['AI_PROVIDER', 'SEARCH_PROVIDER']);
    expect(testConfig(billing).billing).toBe('module');
    expect(testConfig({ ...on, ...billing }).factcheck.enabled).toBe(true);
    // Other values and shapes.
    expect(configError({ ...on, SEARCH_PROVIDER: 'google' }).invalid.map((i) => i.name)).toEqual(['SEARCH_PROVIDER']);
    expect(configError({ ...on, SEARCH_PROVIDER: 'searxng', SEARCH_URL: 'ftp://searxng' }).invalid.map((i) => i.name)).toEqual([
      'SEARCH_URL',
    ]);
    expect(
      configError({ ...on, SEARCH_PROVIDER: 'searxng', SEARCH_URL: SEARXNG_URL, SEARCH_API_KEY: SEARCH_KEY }).invalid.map(
        (i) => i.name,
      ),
    ).toEqual(['SEARCH_API_KEY']);
    expect(configError({ FACTCHECK: 'yes' }).invalid.map((i) => i.name)).toEqual(['FACTCHECK']);
    for (const deny of ['fd00::/129', 'not-an-ip', '192.0.2.1/', '192.0.2.1/8/8']) {
      expect(
        configError({ EGRESS_DENY: deny }).invalid.map((i) => i.name),
        deny,
      ).toEqual(['EGRESS_DENY']);
    }
  });

  it('test_factcheck_config_never_echoes_search_key', () => {
    const envs = [
      { ...ANTHROPIC, SEARCH_API_KEY: SEARCH_KEY },
      { ...ANTHROPIC, FACTCHECK: 'on', SEARCH_API_KEY: SEARCH_KEY },
      { ...ANTHROPIC, FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: SEARXNG_URL, SEARCH_API_KEY: SEARCH_KEY },
      { ...ANTHROPIC, FACTCHECK: 'on', SEARCH_PROVIDER: 'brave', SEARCH_URL: 'x', SEARCH_API_KEY: SEARCH_KEY },
    ];
    for (const env of envs) {
      const err = configError(env);
      expect(err.message).toContain('SEARCH_');
      expect(err.message).not.toContain(SEARCH_KEY);
    }
    // Kept exactly as given, like every secret.
    const padded = ` ${SEARCH_KEY} `;
    expect(
      testConfig({ ...ANTHROPIC, FACTCHECK: 'on', SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: padded }).factcheck.search?.apiKey,
    ).toBe(padded);
  });

  it('test_config_variables_include_factcheck_names', () => {
    const names = ['FACTCHECK', 'AI_RESEARCH_MODEL', 'AI_SYNTHESIS_MODEL', 'SEARCH_PROVIDER', 'SEARCH_URL', 'SEARCH_API_KEY'];
    const at = (name: string) => CONFIG_VARIABLES.indexOf(name);
    expect(CONFIG_VARIABLES.slice(at('AI_DATA_POLICY') + 1, at('AI_DATA_POLICY') + 7)).toEqual(names);
    expect(CONFIG_VARIABLES.slice(at('DAILY_SPEND_LIMIT_USD') + 1, at('DAILY_SPEND_LIMIT_USD') + 3)).toEqual([
      'USER_DAILY_CHECK_CAP',
      'EGRESS_DENY',
    ]);
    // loadConfig reads each of them with fact-check off as well (the env-example parity test checks every name).
    const read = new Set<string>();
    const watched = new Proxy(
      { ...TEST_ENV },
      {
        get(target, name) {
          if (typeof name === 'string') read.add(name);
          return Reflect.get(target, name);
        },
      },
    );
    loadConfig(watched);
    for (const name of [...names, 'USER_DAILY_CHECK_CAP', 'EGRESS_DENY']) expect(read.has(name), name).toBe(true);
  });
});

/** A valid Anthropic route, to vary one field at a time. */
const SONNET: RouteSpec = {
  task: 'synthesis',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  baseUrl: null,
  effort: 'medium',
  dataPolicy: 'vendor-zdr',
};

function anthropic(env: Record<string, string | undefined> = {}): Config {
  return testConfig({ ...ANTHROPIC, ...env });
}

describe('routes', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_validate_route_research_and_synthesis_guards', () => {
    expect(validateRoute(SONNET)).toEqual({ ok: true });
    expect(validateRoute({ ...SONNET, task: 'research' })).toEqual({ ok: true });

    expect(validateRoute({ ...SONNET, effort: 'low' })).toEqual({ ok: false, reason: 'effort must be medium for synthesis' });
    expect(
      validateRoute({
        ...SONNET,
        task: 'research',
        provider: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        dataPolicy: 'self-hosted',
      }),
    ).toEqual({ ok: false, reason: 'the research route needs Anthropic web search' });
    const opus = validateRoute({ ...SONNET, model: 'claude-opus-5-5' });
    expect(opus.ok).toBe(false);
    expect(!opus.ok && opus.reason).toMatch(/^AI_SYNTHESIS_MODEL claude-opus-5-5 is not eligible for zero data retention/);
    const research = validateRoute({ ...SONNET, task: 'research', model: 'claude-opus-5-5' });
    expect(!research.ok && research.reason).toMatch(/^AI_RESEARCH_MODEL claude-opus-5-5/);
    // A synthesis route on hardware the operator controls passes, as classify does.
    expect(
      validateRoute({
        ...SONNET,
        provider: 'openai-compatible',
        model: 'local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        dataPolicy: 'self-hosted',
      }),
    ).toEqual({ ok: true });
  });

  it('test_configured_routes_by_mode', () => {
    const tasks = (config: Config) => configuredRoutes(config).map((r) => r.task);
    expect(tasks(anthropic())).toEqual(['classify']);
    expect(configuredRoutes(anthropic({ FACTCHECK: 'on' }))).toEqual([
      {
        task: 'classify',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        baseUrl: null,
        effort: 'low',
        dataPolicy: 'vendor-zdr',
      },
      { ...SONNET, task: 'synthesis' },
      { ...SONNET, task: 'research' },
    ]);
    expect(tasks(anthropic({ FACTCHECK: 'on', SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY }))).toEqual([
      'classify',
      'synthesis',
    ]);
    const compat = configuredRoutes(testConfig({ FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: SEARXNG_URL }));
    expect(compat.map((r) => [r.task, r.provider, r.model, r.effort])).toEqual([
      ['classify', 'openai-compatible', 'mock-model', 'low'],
      ['synthesis', 'openai-compatible', 'mock-model', 'medium'],
    ]);
  });

  it('test_sync_routes_adds_and_disables_factcheck_routes', async () => {
    const db = await testDb();
    const { log, events } = captureLog();
    const all = () => db.select().from(aiRoutes).orderBy(asc(aiRoutes.createdAt));

    const classify = await syncRouteFromConfig(db, anthropic({ FACTCHECK: 'on' }), log);
    expect(classify).toMatchObject({ task: 'classify', model: 'claude-haiku-5-5', enabled: true });
    const on = await all();
    expect(on.map((r) => [r.task, r.model, r.effort, r.enabled]).sort()).toEqual([
      ['classify', 'claude-haiku-5-5', 'low', true],
      ['research', 'claude-sonnet-5-5', 'medium', true],
      ['synthesis', 'claude-sonnet-5-5', 'medium', true],
    ]);
    expect(
      events()
        .filter((e) => e.event === 'ai.route.synced')
        .map((e) => e.task),
    ).toEqual(['classify', 'synthesis', 'research']);

    // Again with fact-check on: every route is kept.
    expect((await syncRouteFromConfig(db, anthropic({ FACTCHECK: 'on' }), log)).id).toBe(classify.id);
    expect(await all()).toEqual(on);

    // A search provider: research is no longer configured, so it is disabled; synthesis stays.
    await syncRouteFromConfig(db, anthropic({ FACTCHECK: 'on', SEARCH_PROVIDER: 'brave', SEARCH_API_KEY: SEARCH_KEY }), log);
    expect(
      (await all())
        .filter((r) => r.enabled)
        .map((r) => r.task)
        .sort(),
    ).toEqual(['classify', 'synthesis']);

    // The next start with fact-check off disables synthesis too; classify is returned, unchanged.
    const off = await syncRouteFromConfig(db, anthropic(), log);
    expect(off.id).toBe(classify.id);
    const rows = await all();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.enabled).map((r) => r.id)).toEqual([classify.id]);
  });

  it('test_resolve_route_uses_factcheck_prompt_version', async () => {
    expect(routePromptVersion('classify')).toBe(PROMPT_VERSION);
    expect(routePromptVersion('research')).toBe(FACTCHECK_PROMPT_VERSION);
    expect(routePromptVersion('synthesis')).toBe(FACTCHECK_PROMPT_VERSION);

    const db = await testDb();
    const { log } = captureLog();
    const synthesis = { task: 'synthesis', effort: 'medium' } as const;
    await seedPassingRoute(db, { ...synthesis, evalPromptVersion: FACTCHECK_PROMPT_VERSION + 1 });
    const err = await resolveRoute(db, 'synthesis', 0.8, log).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('not-available');

    const passed = await seedPassingRoute(db, { ...synthesis, evalPromptVersion: FACTCHECK_PROMPT_VERSION });
    expect((await resolveRoute(db, 'synthesis', 0.8, log)).id).toBe(passed.id);
  });
});

const CHECK_CONFIG = fileURLToPath(new URL('../src/cli/check-config.ts', import.meta.url));

describe('cli', { timeout: SPAWN_TIMEOUT }, () => {
  it('test_check_config_runs_factcheck_route_guard', () => {
    const run = (env: Record<string, string | undefined>) =>
      spawnSync(process.execPath, [CHECK_CONFIG], {
        env: Object.fromEntries(
          Object.entries({ ...TEST_ENV, ...ANTHROPIC, FACTCHECK: 'on', ...env }).filter(([, v]) => v !== undefined),
        ),
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT,
      });

    const opus = run({ AI_RESEARCH_MODEL: 'claude-opus-5-5' });
    expect(opus.status).toBe(1);
    expect(opus.stderr).toMatch(/^AI_RESEARCH_MODEL claude-opus-5-5 is not eligible for zero data retention/m);
    expect(opus.stderr).not.toMatch(/\bAI_MODEL\b/);

    const ok = run({});
    expect(ok.status).toBe(0);
    for (const out of [opus, ok]) expect(out.stdout + out.stderr).not.toContain(API_KEY);
  });
});
