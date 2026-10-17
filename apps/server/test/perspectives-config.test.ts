import { readFileSync } from 'node:fs';
import { type AIClient, AIError, type ResearchRequest } from '@unalgorithm/ai';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { CREDIT_PRICE_SCHEDULE, ZERO_USAGE } from '@unalgorithm/protocol';
import type { SearchProvider } from '@unalgorithm/research';
import { describe, expect, it } from 'vitest';
import type { FactcheckRoutes } from '../src/ai/factcheck.ts';
import { perspectivesDepsFor, perspectivesOffer } from '../src/ai/perspectives.ts';
import type { AiRoute } from '../src/ai/routes.ts';
import { ConfigError } from '../src/config.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { testConfig } from './support/test-app.ts';

const API_KEY = 'sk-ant-test-P334-never-shown';
const ANTHROPIC: Record<string, string | undefined> = {
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: API_KEY,
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
};
const NOW = new Date('2026-10-15T12:00:00Z');
const FIXTURE = FIXTURE_LIST;
const ON = { perspectives: { enabled: true } };

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    testConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

/** A route literal (no database). */
function route(task: string, model: string): AiRoute {
  return {
    id: `route-${task}`,
    task,
    provider: 'anthropic',
    model,
    baseUrl: null,
    effort: 'low',
    dataPolicy: 'vendor-zdr',
  } as AiRoute;
}

const ROUTES: FactcheckRoutes = {
  claims: route('classify', 'claude-haiku-5-5'),
  research: route('research', 'claude-sonnet-5-5'),
  synthesis: route('synthesis', 'claude-opus-5-5'),
};

/** A fake client per route; `asked` lists the routes `clientFor` was asked for, `research` the searches made. */
function fakeAi() {
  const asked: string[] = [];
  const research: { route: string; model: string; allowed: readonly string[] | undefined }[] = [];
  const clients = new Map<string, AIClient>();
  const clientFor = (r: AiRoute): AIClient => {
    asked.push(r.id);
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
        research.push({ route: r.id, model: req.model, allowed: req.allowedDomains });
        return { notes: '', sources: [], usage: ZERO_USAGE, model: req.model, searchErrors: [] };
      },
    };
    clients.set(r.id, client);
    return client;
  };
  return { clientFor, asked, research };
}

const SEARCH_REQ = {
  query: 'A story',
  domains: ['left-a.example'],
  from: new Date('2026-10-10T00:00:00Z'),
  to: NOW,
  nonce: 'n',
};

describe('setting', () => {
  it('test_perspectives_setting_needs_factcheck', () => {
    expect(testConfig().perspectives).toEqual({ enabled: false });
    expect(testConfig({ ...ANTHROPIC, FACTCHECK: 'on', PERSPECTIVES: 'on' }).perspectives).toEqual({ enabled: true });

    const off = configError({ ...ANTHROPIC, PERSPECTIVES: 'on' });
    expect(off.invalid.map((i) => i.name)).toEqual(['PERSPECTIVES']);
    expect(off.message).toContain('must be off when FACTCHECK is off');
    expect(off.message).not.toContain(API_KEY);
    expect(off.message).not.toMatch(/=on\b|"on"/);

    const maybe = configError({ ...ANTHROPIC, FACTCHECK: 'on', PERSPECTIVES: 'maybe' });
    expect(maybe.invalid.map((i) => i.name)).toEqual(['PERSPECTIVES']);
    expect(maybe.message).not.toContain('maybe');
  });
});

describe('offer', () => {
  it('test_perspectives_offer_needs_registry', () => {
    const config = testConfig({ ...ANTHROPIC, FACTCHECK: 'on', PERSPECTIVES: 'on' });
    // A real server has no source list (the bundled candidates hold no lean): UnEcho Chamber stays hidden.
    expect(perspectivesOffer(config, TEST_PRICE_SCHEDULE, null, NOW)).toEqual({ offered: false });
  });

  it('test_perspectives_offer_free_server', () => {
    const config = testConfig({ ...ANTHROPIC, FACTCHECK: 'on', PERSPECTIVES: 'on' });
    expect(config.billing).toBe('off');
    expect(perspectivesOffer(config, CREDIT_PRICE_SCHEDULE, FIXTURE, NOW)).toEqual({
      offered: true,
      price: null,
      maxCostMicros: 250_000,
    });
    // PERSPECTIVES off: not offered, registry or not.
    expect(perspectivesOffer(testConfig(ANTHROPIC), CREDIT_PRICE_SCHEDULE, FIXTURE, NOW)).toEqual({ offered: false });
  });

  it('test_perspectives_offer_billing_schedule', () => {
    const billing = { ...ON, billing: 'module' as const };
    expect(perspectivesOffer(billing, TEST_PRICE_SCHEDULE, FIXTURE, NOW)).toEqual({
      offered: true,
      price: { typicalMicros: 270_000, maxMicros: 500_000 },
      maxCostMicros: 250_000,
    });
    // Production's card takes effect 2026-11-01: not offered before it.
    expect(perspectivesOffer(billing, CREDIT_PRICE_SCHEDULE, FIXTURE, NOW)).toEqual({ offered: false });
  });
});

describe('deps', () => {
  it('test_perspectives_deps_routes_and_models', async () => {
    const resolveLink = async () => null;

    // Anthropic: searches on the research route's client, at the classify model; the rest on synthesis.
    const ai = fakeAi();
    const deps = perspectivesDepsFor(ROUTES, { ai, search: null, registry: FIXTURE, resolveLink, maxCostMicros: 250_000 });
    expect(ai.asked.sort()).toEqual(['route-research', 'route-synthesis']);
    expect(deps.client).toBe(ai.clientFor(ROUTES.synthesis));
    expect(deps.models).toEqual({ query: 'claude-haiku-5-5', search: 'claude-haiku-5-5', compare: 'claude-opus-5-5' });
    expect(deps.registry).toBe(FIXTURE);
    expect(deps.resolveLink).toBe(resolveLink);
    expect(deps.maxCostMicros).toBe(250_000);
    expect(deps.searcher.model).toBe('claude-haiku-5-5');
    await deps.searcher.search(SEARCH_REQ);
    expect(ai.research).toEqual([{ route: 'route-research', model: 'claude-haiku-5-5', allowed: ['left-a.example'] }]);

    // A search provider: its searcher, and no research client asked, even with a research route at hand.
    const withSearch = fakeAi();
    const queries: string[] = [];
    const search: SearchProvider = {
      id: 'searxng',
      async search(query) {
        queries.push(query);
        return [];
      },
    };
    const searched = perspectivesDepsFor(ROUTES, { ai: withSearch, search, registry: FIXTURE });
    expect(withSearch.asked).toEqual(['route-synthesis']);
    expect(searched.searcher.model).toBe('search:searxng');
    expect(searched.resolveLink).toBeUndefined();
    expect(searched.maxCostMicros).toBeUndefined();
    await searched.searcher.search(SEARCH_REQ);
    expect(queries).toHaveLength(1);
    expect(withSearch.research).toEqual([]);

    // Neither: not available.
    let err: unknown;
    try {
      perspectivesDepsFor({ ...ROUTES, research: null }, { ai: fakeAi(), search: null, registry: FIXTURE });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('not-available');
  });
});

describe('image', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('test_dockerfile_copies_outlets_and_runs_no_gate', () => {
    const dockerfile = read('../Dockerfile');
    const stages = dockerfile.split(/^FROM /m).slice(1);
    const stage = (name: string) => stages.find((s) => s.split('\n')[0]?.includes(` AS ${name}`)) ?? '';
    const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim());
    const build = lines(stage('build'));
    const prod = lines(stage('prod'));

    for (const s of [build, prod]) expect(s).toContain('COPY packages/outlets/package.json packages/outlets/');
    expect(build).toContain('COPY packages/ packages/');
    // The server imports the candidate list (the admins' import, P3-73): the image keeps the source and the data.
    expect(prod).toContain('COPY packages/outlets/src packages/outlets/src');
    expect(prod).toContain('COPY packages/outlets/data packages/outlets/data');
    // No outlets check in any stage: nothing bundled can carry a lean (decision D99).
    expect(stages.length).toBeGreaterThanOrEqual(3);
    for (const s of stages) {
      expect(s).not.toContain('cli.ts');
      expect(s).not.toContain('outlets:check');
    }

    // Key files stay out of the build context; the outlets package never had one, so no rule names it.
    const ignore = lines(read('../../../.dockerignore'));
    expect(ignore).toContain('**/*.pem');
    expect(ignore.filter((l) => /panel|outlets/.test(l))).toStrictEqual([]);
  });
});
