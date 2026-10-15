import { type AIClient, AIError, type ResearchRequest } from '@unalgorithm/ai';
import { PROMPT_VERSION } from '@unalgorithm/core';
import { ZERO_USAGE } from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION, type SearchProvider } from '@unalgorithm/research';
import { FACTCHECK_EVAL_SET, type FactcheckEvalReport, mockDepsFor } from '@unalgorithm/research/eval';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { type FactcheckRoutes, factcheckDepsFor, resolveFactcheckRoutes } from '../src/ai/factcheck.ts';
import { type AiRoute, recordEval, syncRouteFromConfig } from '../src/ai/routes.ts';
import { factcheckEvalPassed, main, type RouteEvalDeps } from '../src/cli/route-eval.ts';
import type { Db } from '../src/db/client.ts';
import { aiRoutes } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { seedPassingRoute } from './support/routes.ts';
import { testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** The test server's environment with Anthropic as its provider and fact-check on (research by web search). */
const FACTCHECK_ENV: Record<string, string | undefined> = {
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: 'sk-ant-test-only-not-a-real-key',
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
  FACTCHECK: 'on',
};

/** A route literal for the deps tests (no database). */
function route(task: string, model: string): AiRoute {
  return {
    id: `route-${task}`,
    task,
    provider: 'anthropic',
    model,
    baseUrl: null,
    effort: task === 'classify' ? 'low' : 'medium',
    dataPolicy: 'vendor-zdr',
  } as AiRoute;
}

const ROUTES: FactcheckRoutes = {
  claims: route('classify', 'claude-haiku-5-5'),
  research: route('research', 'claude-sonnet-5-5'),
  synthesis: route('synthesis', 'claude-opus-5-5'),
};

/** A fake client per route, recording the research calls it gets. */
function fakeAi() {
  const research: { route: string; model: string }[] = [];
  const clients = new Map<string, AIClient>();
  const clientFor = (r: AiRoute): AIClient => {
    const existing = clients.get(r.id);
    if (existing) return existing;
    const client: AIClient = {
      kind: `fake-${r.task}`,
      async structured() {
        throw new AIError('unsupported', 'not used');
      },
      async listModels() {
        return [];
      },
      async research(req: ResearchRequest) {
        research.push({ route: r.id, model: req.model });
        return { notes: '', sources: [], usage: ZERO_USAGE, model: req.model, searchErrors: [] };
      },
    };
    clients.set(r.id, client);
    return client;
  };
  return { clientFor, research, clients };
}

const RETRIEVE = { claims: [{ id: 'c1', text: 'A claim.' }], maxSearches: 1, blockedDomains: [], nonce: 'n' };

describe('deps', () => {
  it('test_factcheck_deps_anthropic_mode', async () => {
    const ai = fakeAi();
    const deps = factcheckDepsFor(ROUTES, { ai, search: null, maxCostMicros: 200_000 });

    expect(deps.client).toBe(ai.clientFor(ROUTES.synthesis));
    expect(deps.models).toEqual({ claims: 'claude-haiku-5-5', research: 'claude-sonnet-5-5', verdict: 'claude-opus-5-5' });
    expect(deps.maxCostMicros).toBe(200_000);
    expect(deps.linkCheck).toBeUndefined();

    await deps.retriever.retrieve(RETRIEVE);
    expect(ai.research).toEqual([{ route: 'route-research', model: 'claude-sonnet-5-5' }]);
  });

  it('test_factcheck_deps_search_mode_and_missing_research', async () => {
    const ai = fakeAi();
    const queries: string[] = [];
    const search: SearchProvider = {
      id: 'searxng',
      async search(query) {
        queries.push(query);
        return [{ url: 'https://example.org/a', title: 'A', snippet: 'Evidence.', published: null }];
      },
    };
    const linkCheck = async () => new Map();
    const deps = factcheckDepsFor({ ...ROUTES, research: null }, { ai, search, linkCheck });

    expect(deps.models).toEqual({ claims: 'claude-haiku-5-5', research: 'claude-opus-5-5', verdict: 'claude-opus-5-5' });
    expect(deps.linkCheck).toBe(linkCheck);
    const res = await deps.retriever.retrieve(RETRIEVE);
    expect(queries).toEqual(['A claim.']);
    expect(res.sources.map((s) => s.url)).toEqual(['https://example.org/a']);
    expect(ai.research).toEqual([]);

    let err: unknown;
    try {
      factcheckDepsFor({ ...ROUTES, research: null }, { ai, search: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('not-available');
  });

  it('test_resolve_factcheck_routes_eval_gate', { timeout: PGLITE_TIMEOUT }, async () => {
    const handle = await createTestDb();
    cleanup.push(() => handle.close());
    const { db } = handle;
    const config = testConfig(FACTCHECK_ENV);
    const { log } = captureLog();
    const base = { provider: 'anthropic', baseUrl: null, dataPolicy: 'vendor-zdr' };
    const claims = await seedPassingRoute(db, { ...base, task: 'classify', model: 'claude-haiku-5-5', effort: 'low' });
    const research = await seedPassingRoute(db, {
      ...base,
      task: 'research',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      evalPromptVersion: FACTCHECK_PROMPT_VERSION,
    });
    const synthesis = { ...base, task: 'synthesis', model: 'claude-sonnet-5-5', effort: 'medium' };
    // Passed, but on another prompt version.
    await seedPassingRoute(db, { ...synthesis, evalPromptVersion: FACTCHECK_PROMPT_VERSION + 1 });
    await expectNotAvailable(resolveFactcheckRoutes(db, config, log));

    const passed = await seedPassingRoute(db, { ...synthesis, evalPromptVersion: FACTCHECK_PROMPT_VERSION });
    const routes = await resolveFactcheckRoutes(db, config, log);
    expect([routes.claims.id, routes.research?.id, routes.synthesis.id]).toEqual([claims.id, research.id, passed.id]);
  });
});

async function expectNotAvailable(promise: Promise<unknown>): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AIError);
  expect((err as AIError).code).toBe('not-available');
}

async function routeRow(db: Db, id: string): Promise<AiRoute | undefined> {
  const [row] = await db.select().from(aiRoutes).where(eq(aiRoutes.id, id));
  return row;
}

/** A database with the routes the fact-check config describes, stored as the server stores them at startup. */
async function setup(env: Record<string, string | undefined> = {}) {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  const config = testConfig({ ...FACTCHECK_ENV, ...env });
  const { log } = captureLog();
  await syncRouteFromConfig(handle.db, config, log);
  const rows = await handle.db.select().from(aiRoutes).where(eq(aiRoutes.enabled, true));
  const byTask = (task: string) => {
    const row = rows.find((r) => r.task === task);
    if (!row) throw new Error(`no ${task} route`);
    return row;
  };
  const lines: string[] = [];
  /** The fetch every provider would get: a test fails if a live call is made. */
  const calls: string[] = [];
  const noNetwork: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('{}', { status: 500 });
  };
  const run = (deps: Partial<RouteEvalDeps> = {}, cfg: typeof config = config) =>
    main(['factcheck'], { db: handle, config: cfg, out: (line) => lines.push(line), fetch: noNetwork, ...deps });
  return { db: handle.db, config, log, lines, calls, run, byTask };
}

/** No output line quotes an eval post. */
function expectNoPostText(lines: string[]): void {
  const output = lines.join('\n');
  for (const item of FACTCHECK_EVAL_SET) expect(output).not.toContain(item.post.text.slice(0, 24));
}

const perfect = () => mockDepsFor(FACTCHECK_EVAL_SET);
const wrong = () =>
  mockDepsFor(FACTCHECK_EVAL_SET, { verdict: (item) => (item.expect.includes('supported') ? 'disputed' : 'supported') });

describe('route-eval factcheck', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_route_eval_factcheck_refuses_when_off', async () => {
    const lines: string[] = [];
    let opened = false;
    const db = {
      get db(): Db {
        opened = true;
        throw new Error('The database was opened.');
      },
      close: async () => undefined,
    };
    const config = testConfig({ ...FACTCHECK_ENV, FACTCHECK: undefined });
    expect(await main(['factcheck'], { db: db as never, config, out: (line) => lines.push(line) })).toBe(1);
    expect(lines).toEqual(['FACTCHECK is off: set FACTCHECK=on and start the server once first']);
    expect(opened).toBe(false);
  });

  it('test_route_eval_factcheck_passes_and_opens_gates', async () => {
    const { db, config, log, lines, calls, run, byTask } = await setup();
    const synthesis = byTask('synthesis');
    const research = byTask('research');
    await expectNotAvailable(resolveFactcheckRoutes(db, config, log));

    expect(await run({ factcheckDeps: perfect })).toBe(0);
    expect(lines[0]).toBe(`fact-check eval: ${FACTCHECK_EVAL_SET.length} checks on anthropic/claude-sonnet-5-5, about $2.88`);
    expect(lines[1]).toMatch(
      /^route synthesis anthropic\/claude-sonnet-5-5: agreement 1\.00 \(24\/24\), provenance 1\.00, pairs 1\.00, min 0\.80, PASSED, cost about \$\d+\.\d\d$/,
    );
    expect(lines).toHaveLength(2);
    expect(calls).toEqual([]);

    for (const id of [synthesis.id, research.id]) {
      const row = await routeRow(db, id);
      expect(row?.evalAgreement).toBe(1);
      expect(row?.evalPromptVersion).toBe(FACTCHECK_PROMPT_VERSION);
      expect(row?.evalPassedAt).toBeInstanceOf(Date);
    }

    // The classify route has its own eval; once it has passed, every fact-check route serves.
    await recordEval(db, byTask('classify').id, { agreement: 1, promptVersion: PROMPT_VERSION, passed: true });
    const routes = await resolveFactcheckRoutes(db, config, log);
    expect([routes.synthesis.id, routes.research?.id]).toEqual([synthesis.id, research.id]);
  });

  it('test_route_eval_factcheck_fails_below_agreement_or_provenance', async () => {
    const { db, config, log, lines, run, byTask } = await setup();
    expect(await run({ factcheckDeps: wrong })).toBe(1);
    expect(lines[1]).toMatch(
      /^route synthesis anthropic\/claude-sonnet-5-5: agreement 0\.\d\d \(\d+\/24\), provenance 1\.00, pairs \d\.\d\d, min 0\.80, FAILED, cost /,
    );
    const failures = lines.slice(2);
    expect(failures.length).toBeGreaterThan(0);
    for (const line of failures) expect(line).toMatch(/^ {2}fc-\d+: [a-z]/);

    for (const task of ['synthesis', 'research']) {
      const row = await routeRow(db, byTask(task).id);
      expect(row?.evalAgreement).toBeLessThan(config.routeEvalMinAgreement);
      expect(row?.evalPromptVersion).toBe(FACTCHECK_PROMPT_VERSION);
      expect(row?.evalPassedAt).toBeNull();
    }
    await expectNotAvailable(resolveFactcheckRoutes(db, config, log));

    // The provenance half of the rule.
    const report = (agreement: number, provenance: number) =>
      ({ agreement, provenance }) satisfies Pick<FactcheckEvalReport, 'agreement' | 'provenance'>;
    expect(factcheckEvalPassed(report(1, 0.95), 0.8)).toBe(false);
    expect(factcheckEvalPassed(report(1, 1), 0.8)).toBe(true);
    expect(factcheckEvalPassed(report(0.79, 1), 0.8)).toBe(false);
  });

  it('test_route_eval_factcheck_provider_errors_store_nothing', async () => {
    const { db, lines, run, byTask } = await setup();
    const busy = () => mockDepsFor(FACTCHECK_EVAL_SET, { fail: () => new AIError('overloaded', 'busy') });
    expect(await run({ factcheckDeps: busy })).toBe(1);
    expect(lines[1]).toMatch(
      /^route synthesis anthropic\/claude-sonnet-5-5: not evaluated \(provider errors: overloaded\), stored result unchanged, cost /,
    );
    expect(lines).toHaveLength(2);
    for (const task of ['synthesis', 'research']) {
      const row = await routeRow(db, byTask(task).id);
      expect(row?.evalAgreement).toBeNull();
      expect(row?.evalPassedAt).toBeNull();
    }
  });

  it('test_route_eval_factcheck_refuses_unconfigured_route', async () => {
    const { db, config, lines, calls, run, byTask } = await setup();
    // AI_SYNTHESIS_MODEL edited, but the server has not restarted with it.
    const changed = testConfig({ ...FACTCHECK_ENV, AI_SYNTHESIS_MODEL: 'claude-haiku-5-5' });
    let built = false;
    expect(
      await run(
        {
          factcheckDeps: () => {
            built = true;
            return perfect();
          },
        },
        changed,
      ),
    ).toBe(1);
    expect(lines).toEqual([
      'the stored synthesis route (anthropic/claude-sonnet-5-5) is not the one AI_PROVIDER, AI_SYNTHESIS_MODEL, ' +
        'AI_BASE_URL and AI_DATA_POLICY describe (anthropic/claude-haiku-5-5): start the server with this environment first',
    ]);
    expect(built).toBe(false);
    expect(calls).toEqual([]);
    const row = await routeRow(db, byTask('synthesis').id);
    expect(row?.evalAgreement).toBeNull();
    expect(config.factcheck.synthesisModel).toBe('claude-sonnet-5-5');
  });

  it('test_route_eval_factcheck_output_has_no_post_text', async () => {
    const { lines, run } = await setup();
    expect(await run({ factcheckDeps: wrong })).toBe(1);
    expect(await run({ factcheckDeps: perfect })).toBe(0);
    expect(lines.length).toBeGreaterThan(4);
    expectNoPostText(lines);
  });

  it('test_route_eval_unknown_argument_prints_usage', async () => {
    for (const argv of [['foo'], ['factcheck', 'foo']]) {
      const lines: string[] = [];
      expect(await main(argv, { config: testConfig(), out: (line) => lines.push(line) })).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^usage: .*\[factcheck\]/);
    }
  });
});
