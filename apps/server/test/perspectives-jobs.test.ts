/**
 * The perspectives job endpoints (P3-35): start, poll and cancel on the job kit, link only. Runs on the mock
 * OpenAI-compatible provider and a mock SearXNG answering dated hits on the fictional fixture registry's domains; the
 * registry reaches the app only as `outlets: FIXTURE_LIST`. Nothing here calls a real model or search service.
 */

import { fileURLToPath } from 'node:url';
import { OpenAPIHono } from '@hono/zod-openapi';
import {
  type AnthropicRequestKind,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import {
  FACTCHECK_JOB_TTL_MS,
  FACTCHECK_JOBS_PATH,
  FactcheckJobSchema,
  type FactcheckResult,
  factcheckJobPath,
  LEAN_BUCKETS,
  PERSPECTIVES_JOBS_PATH,
  type PerspectivesJob,
  PerspectivesJobSchema,
  type PerspectivesResult,
  PerspectivesResultSchema,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  retailMicros,
  SERVER_INFO_PATH,
  ServerInfoSchema,
} from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { startMockSearxng } from '@unalgorithm/research/testing';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { LimitDeps } from '../src/ai/limits.ts';
import { clientForRoute } from '../src/ai/provider.ts';
import { usageEvents } from '../src/db/schema.ts';
import type { AppDeps, AppEnv } from '../src/http/app.ts';
import { inFlightRequests } from '../src/http/middleware.ts';
import { listen, stopServing } from '../src/index.ts';
import { createJobStore } from '../src/jobs/memory-jobs.ts';
import { perspectivesRoutes } from '../src/routes/perspectives.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { serverPost } from './support/classify.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { seedPassingRoute } from './support/routes.ts';
import { DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const ALLOW = { SIGNUP_ALLOWLIST: `${TOM},${ANA}` };
const ON = { ...ALLOW, FACTCHECK: 'on', PERSPECTIVES: 'on' };
const FIXTURE = fileURLToPath(new URL('./fixtures/billing-module/index.ts', import.meta.url));
/**
 * A billing server: Anthropic only (it researches with Anthropic web search, so every job is priced), on
 * `mockAnthropicFetch`, with the fixture module on `TEST_PRICE_SCHEDULE`.
 */
const BILLED_ENV: Record<string, string | undefined> = {
  ...ON,
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: 'sk-ant-test-only-not-a-real-key',
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
  BILLING: 'module',
  BILLING_MODULE: FIXTURE,
};

const LINK = { url: 'https://news.example.com/story/bridge-reopens', title: 'City bridge reopens after repairs' };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** One hit an hour old on each `site:` domain of the query; a fact-check search (no `site:`) gets two plain hits. */
function fixtureHits(query: string) {
  const sites = [...query.matchAll(/site:([a-z0-9.-]+)/g)].map((m) => m[1] ?? '');
  const domains = sites.length ? sites : ['a.example', 'b.example'];
  const published = new Date(Date.now() - 3_600_000).toISOString();
  return domains.map((d, i) => ({
    url: `https://${d}/news/bridge-${i + 1}`,
    title: `Bridge coverage ${i + 1}`,
    snippet: `The city bridge reopened this week after repairs reported by ${d} and others.`,
    published,
  }));
}

interface AppOptions extends TestAppOptions {
  env?: Record<string, string | undefined>;
}

type TestApp = Pick<Awaited<ReturnType<typeof perspectivesApp>>, 'app' | 'deps' | 'token' | 'provider' | 'outbox'>;

/** Perspectives on, the fixture registry, a mock SearXNG, the fact-check routes past their eval. */
async function perspectivesApp(opts: AppOptions = {}) {
  const { env, ...options } = opts;
  const searx = await startMockSearxng({ hits: fixtureHits });
  cleanup.push(() => searx.close());
  const config = testConfig({ ...ON, SEARCH_PROVIDER: 'searxng', SEARCH_URL: searx.url, ...env });
  const t = await createTestApp({ config, outlets: FIXTURE_LIST, ...options });
  cleanup.push(t.close);
  await seedPassingRoute(t.deps.db.db, {
    task: 'synthesis',
    effort: 'medium',
    evalPromptVersion: FACTCHECK_PROMPT_VERSION,
    baseUrl: t.mock.baseUrl,
  });
  const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;
  return { ...t, token, searx };
}

type Reply = { status: number; body: unknown };
type Responder = (body: Record<string, unknown>, kind: AnthropicRequestKind) => Reply;

function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role: string; content: unknown }[]) : [];
  const content = messages.find((m) => m.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : '';
}

/** A working Anthropic: a story query, one dated result per bucket search, every source matched in the comparison. */
const happy: Responder = (body, kind) => {
  if (kind === 'story') return { status: 200, body: structuredMessage({ query: 'city bridge reopens' }) };
  if (kind === 'research') {
    const tools = (body.tools ?? []) as { allowed_domains?: string[] }[];
    const domain = tools[0]?.allowed_domains?.[0] ?? 'none.example';
    const url = `https://${domain}/news/bridge`;
    const text = `The city bridge reopened this week after repairs, ${domain} reported.`;
    const pageAge = new Date(Date.now() - 3_600_000).toISOString();
    return {
      status: 200,
      body: researchMessage({
        results: [{ url, title: 'Bridge reopens', pageAge }],
        notes: [{ text: 'Coverage found.', cites: [{ url, citedText: text }] }],
        searches: 1,
      }),
    };
  }
  if (kind === 'comparison') {
    const tags = [...userText(body).matchAll(/<source_\w+ id="(s\d+)"[^>]*>\n([^\n]*)/g)];
    const comparison = {
      matched: tags.map(([, id]) => id),
      agreed: [
        {
          text: 'Several outlets report the bridge reopened.',
          citations: tags.slice(0, 2).map(([, sourceId = '', text = '']) => ({
            sourceId,
            quote: text.split(/\s+/).slice(0, 8).join(' '),
          })),
        },
      ],
      differences: [],
      unique: [],
    };
    return { status: 200, body: structuredMessage(comparison, { model: 'claude-sonnet-5-5' }) };
  }
  return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } } };
};

const authError: Reply = {
  status: 401,
  body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
};

/** A billing server on `mockAnthropicFetch`, with the fact-check routes past their eval and the fixture registry. */
async function billedApp(reply: Responder = happy, opts: AppOptions = {}) {
  const { env, ...options } = opts;
  const config = testConfig({ ...BILLED_ENV, ...env });
  const fetch = mockAnthropicFetch(reply);
  const ai: AppDeps['ai'] = { clientFor: (r) => clientForRoute(r, config, { fetch }) };
  const t = await createTestApp({
    config,
    ai,
    outlets: FIXTURE_LIST,
    billingModule: fixtureModule,
    priceSchedule: TEST_PRICE_SCHEDULE,
    ...options,
  });
  cleanup.push(t.close);
  const base = { provider: 'anthropic', baseUrl: null, dataPolicy: 'vendor-zdr' };
  const db = t.deps.db.db;
  await seedPassingRoute(db, { ...base, task: 'classify', model: 'claude-haiku-5-5', effort: 'low' });
  const factcheck = { ...base, effort: 'medium', model: 'claude-sonnet-5-5', evalPromptVersion: FACTCHECK_PROMPT_VERSION };
  await seedPassingRoute(db, { ...factcheck, task: 'research' });
  await seedPassingRoute(db, { ...factcheck, task: 'synthesis' });
  const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;
  return { ...t, token, bodies: fetch.bodies };
}

/** Records the billing module's decisions. */
function watchChecks(t: TestApp): Promise<unknown>[] {
  const checks: Promise<unknown>[] = [];
  const check = t.provider.check.bind(t.provider);
  t.provider.check = (ctx) => {
    const decision = check(ctx);
    checks.push(decision);
    return decision;
  };
  return checks;
}

const headers = (token: string) => ({ Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` });

function startCompare(t: TestApp, body: unknown, token = t.token): Promise<Response> {
  return postJson(t.app, PERSPECTIVES_JOBS_PATH, body, headers(token));
}

const request = (over: Record<string, unknown> = {}) => ({ v: 1, link: LINK, platform: 'linkedin', ...over });

function poll(t: TestApp, id: string, token = t.token): Promise<Response> {
  return Promise.resolve(t.app.request(`${perspectivesJobPath(id)}?wait=1`, { headers: headers(token) }));
}

async function started(t: TestApp, body: unknown = request()): Promise<string> {
  const res = await startCompare(t, body);
  expect(res.status, await res.clone().text()).toBe(202);
  const job = PerspectivesJobSchema.parse(await res.json());
  expect(job.status).toBe('running');
  return job.id;
}

async function ended(t: TestApp, id: string): Promise<PerspectivesJob> {
  for (;;) {
    const res = await poll(t, id);
    expect(res.status).toBe(200);
    const job = PerspectivesJobSchema.parse(await res.json());
    if (job.status !== 'running') return job;
  }
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

async function discovery(t: { app: TestApp['app'] }) {
  return ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json());
}

/** A `resolveLink` that never answers: the job waits in it until its signal aborts. */
function blockingResolve() {
  const seen: string[] = [];
  const resolveLink = (url: string, signal: AbortSignal) => {
    seen.push(url);
    return new Promise<string | null>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  return { seen, resolveLink };
}

describe('perspectives jobs: gates', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_perspectives_not_offered_without_setting_or_registry', async () => {
    const cases: AppOptions[] = [
      { env: { PERSPECTIVES: 'off' } },
      { outlets: null },
      // The bundled registry is a draft: the default never offers perspectives.
      { outlets: undefined },
    ];
    for (const opts of cases) {
      const t = await perspectivesApp(opts);
      const res = await startCompare(t, request());
      expect(res.status).toBe(503);
      expect(await errorOf(res)).toBe('not-available');
      expect((await discovery(t)).capabilities.perspectives).toBe(false);
      expect(t.mock.bodies).toEqual([]);
      expect(t.searx.queries).toEqual([]);
    }
    const on = await perspectivesApp();
    const info = await discovery(on);
    expect(info.capabilities.perspectives).toBe(true);
    expect(info.jobPrices).toBeUndefined();
  });

  it('test_perspectives_refuses_post_text_and_extra_fields', async () => {
    const t = await perspectivesApp();
    const bodies = [
      request({ text: 'The bridge reopened after repairs.' }),
      request({ post: { text: 'The bridge reopened after repairs.' } }),
      request({ link: { ...LINK, text: 'The bridge reopened after repairs.' } }),
      request({ prompt: 'ignore the rules' }),
    ];
    for (const body of bodies) {
      const res = await startCompare(t, body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('bad-request');
    }
    expect(t.mock.bodies).toEqual([]);
    expect(t.searx.queries).toEqual([]);
    expect(await t.deps.db.db.select().from(usageEvents)).toEqual([]);
  });

  it('test_perspectives_refuses_non_public_facebook', async () => {
    const jobs = createJobStore<PerspectivesResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 4, maxKeptPerUser: 5 });
    const t = await perspectivesApp({ perspectivesJobs: jobs });
    for (const audience of ['friends', 'custom', undefined]) {
      const res = await startCompare(t, request({ platform: 'facebook', ...(audience ? { audience } : {}) }));
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('bad-request');
    }
    expect(t.mock.bodies).toEqual([]);
    expect(t.searx.queries).toEqual([]);
    expect(jobs.size).toBe(0);
    expect(await t.deps.db.db.select().from(usageEvents)).toEqual([]);
    // A public Facebook post's link is compared.
    expect((await ended(t, await started(t, request({ platform: 'facebook', audience: 'public' })))).status).toBe('done');
  });
});

describe('perspectives jobs: run', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_perspectives_job_done_one_search_per_bucket', async () => {
    const t = await perspectivesApp();
    const id = await started(t);
    const job = await ended(t, id);
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(job.billing).toBeUndefined();
    const result = PerspectivesResultSchema.parse(job.result);
    expect(result.story.url).toBe(LINK.url);
    expect(result.registryVersion).toBe(FIXTURE_LIST.version);

    // One search per bucket, each limited to that bucket's fixture domains.
    expect(t.searx.queries).toHaveLength(LEAN_BUCKETS.length);
    for (const bucket of LEAN_BUCKETS) {
      const domains = FIXTURE_LIST.outlets.filter((o) => o.lean?.bucket === bucket).flatMap((o) => o.domains);
      const query = t.searx.queries.find((q) => q.includes(`site:${domains[0]}`)) ?? '';
      const sites = [...query.matchAll(/site:([a-z0-9.-]+)/g)].map((m) => m[1]);
      expect(sites.sort(), bucket).toEqual([...domains].sort());
    }

    const rows = await t.deps.db.db.select().from(usageEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: id, task: 'perspectives', outcome: 'ok', postsOk: 0 });
    expect(rows[0]?.calls).toBeGreaterThan(0);
    const done = t.events().filter((e) => e.event === 'perspectives.done');
    expect(done).toMatchObject([{ rid: id, outcome: 'done', sources: result.sources.length }]);
    expect(t.lines.join('\n')).not.toContain('news.example.com');
  });

  it('test_perspectives_resolves_canonical_url', async () => {
    const seen: string[] = [];
    const t = await perspectivesApp({
      resolveLink: async (url) => {
        seen.push(url);
        return 'https://news.example.com/final?utm_source=x';
      },
    });
    const id = await started(t, request({ link: { ...LINK, url: `${LINK.url}?utm_medium=feed#comments` } }));
    const job = await ended(t, id);
    expect(job.status).toBe('done');
    expect(seen).toEqual([LINK.url]);
    expect(job.result?.story.url).toBe('https://news.example.com/final');
  });

  it('test_perspectives_hold_settle_release', async () => {
    const t = await billedApp();
    const info = await discovery(t);
    expect(info.capabilities.perspectives).toBe(true);
    expect(info.jobPrices?.perspectives).toEqual({ typicalMicros: 270_000, maxMicros: 500_000 });
    expect(info.jobPrices?.factcheck).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });

    const checks = watchChecks(t);
    const id = await started(t);
    const job = await ended(t, id);
    expect(job.status, JSON.stringify(job.error)).toBe('done');
    expect(await Promise.all(checks)).toMatchObject([{ kind: 'hold', amountMicros: 500_000 }]);
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ task: 'perspectives', outcome: 'ok', calls: 7 });
    expect(row?.costMicros).toBeGreaterThan(0);
    expect(job.billing?.chargedMicros).toBe(retailMicros(row?.costMicros ?? -1, 2));
    expect(job.billing?.chargedMicros).toBeLessThanOrEqual(500_000);

    // A balance under the cap: the hold is the balance.
    const low = await billedApp(happy, { billingEnv: { BILLING_FIXTURE_START_MICROS: '300000' } });
    const lowChecks = watchChecks(low);
    expect((await ended(low, await started(low))).status).toBe('done');
    expect(await Promise.all(lowChecks)).toMatchObject([{ kind: 'hold', amountMicros: 300_000 }]);

    // A provider failure: the job fails, nothing is charged and its hold is released.
    const holds = fixtureModule.openHolds();
    const failing = await billedApp((body, kind) => (kind === 'comparison' ? authError : happy(body, kind)));
    const failedId = await started(failing);
    const failed = await ended(failing, failedId);
    expect(failed.status).toBe('failed');
    expect(failed.billing).toBeUndefined();
    expect(fixtureModule.openHolds()).toBe(holds);
    const [failedRow] = await failing.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, failedId));
    expect(failedRow).toMatchObject({ outcome: 'failed', chargeableCostMicros: 0 });
  });

  it('test_perspectives_shares_daily_cap', async () => {
    const t = await perspectivesApp({ env: { USER_DAILY_CHECK_CAP: '1' } });
    const post = await serverPost('check', 'The city bridge reopened this week after two years of repairs.');
    const start = await postJson(t.app, FACTCHECK_JOBS_PATH, { v: 1, post }, headers(t.token));
    expect(start.status).toBe(202);
    const { id } = FactcheckJobSchema.parse(await start.json());
    for (;;) {
      const res = await t.app.request(`${factcheckJobPath(id)}?wait=1`, { headers: headers(t.token) });
      if (FactcheckJobSchema.parse(await res.json()).status !== 'running') break;
    }
    const sent = t.mock.bodies.length;
    const searched = t.searx.queries.length;
    const res = await startCompare(t, request());
    expect(res.status).toBe(429);
    expect(await errorOf(res)).toBe('cap-reached');
    expect(t.mock.bodies.length).toBe(sent);
    expect(t.searx.queries.length).toBe(searched);
  });
});

describe('perspectives jobs: lifecycle', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_perspectives_poll_cancel_owner_only', async () => {
    const holds = fixtureModule.openHolds();
    const blocked = blockingResolve();
    const t = await billedApp(happy, { resolveLink: blocked.resolveLink });
    const id = await started(t);
    await expect.poll(() => blocked.seen.length).toBe(1);
    expect(fixtureModule.openHolds()).toBe(holds + 1);

    const ana = (await signInDevice(t.app, t.outbox, ANA)).access_token;
    expect((await t.app.request(perspectivesJobPath(id), { headers: headers(ana) })).status).toBe(404);
    const foreign = await t.app.request(perspectivesJobCancelPath(id), { method: 'POST', headers: headers(ana) });
    expect(foreign.status).toBe(404);
    expect(fixtureModule.openHolds()).toBe(holds + 1);

    const cancel = await t.app.request(perspectivesJobCancelPath(id), { method: 'POST', headers: headers(t.token) });
    expect(cancel.status).toBe(202);
    expect((await ended(t, id)).status).toBe('cancelled');
    expect(fixtureModule.openHolds()).toBe(holds);
    expect(t.bodies).toEqual([]);
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ task: 'perspectives', outcome: 'failed', chargeableCostMicros: 0 });
  });

  it('test_perspectives_stop_releases_hold', async () => {
    const holds = fixtureModule.openHolds();
    const blocked = blockingResolve();
    const stopping = new AbortController();
    const inFlight = inFlightRequests();
    const factcheckJobs = createJobStore<FactcheckResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const perspectivesJobs = createJobStore<PerspectivesResult>({
      ttlMs: FACTCHECK_JOB_TTL_MS,
      maxRunning: 4,
      maxKeptPerUser: 5,
    });
    const t = await billedApp(happy, {
      resolveLink: blocked.resolveLink,
      stopping: stopping.signal,
      inFlight,
      factcheckJobs,
      perspectivesJobs,
    });
    const server = await listen(t.app, '127.0.0.1', 0);
    cleanup.push(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });
    const id = await started(t);
    await expect.poll(() => blocked.seen.length).toBe(1);
    expect(fixtureModule.openHolds()).toBe(holds + 1);

    await stopServing(server, {
      stopping,
      inFlight,
      log: t.deps.log,
      graceMs: 1_000,
      jobs: [factcheckJobs, perspectivesJobs],
    });
    // Once the stop has returned (the database would close next), the row is written and the hold released.
    expect(perspectivesJobs.running).toBe(0);
    expect(fixtureModule.openHolds()).toBe(holds);
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ task: 'perspectives', outcome: 'failed' });
  });

  it('test_openapi_lists_perspectives_paths', async () => {
    const t = await perspectivesApp();
    // Only the perspectives routes, as the fact-check paths are compared (job-routes.test.ts).
    const app = new OpenAPIHono<AppEnv>();
    const jobs = createJobStore<never>({ ttlMs: 1, maxRunning: 1, maxKeptPerUser: 1 });
    perspectivesRoutes(
      app,
      { ...t.deps, priceSchedule: TEST_PRICE_SCHEDULE, perspectivesJobs: jobs, outlets: FIXTURE_LIST },
      {} as LimitDeps,
    );
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '1' } });
    const paths = doc.paths ?? {};
    const codes = (op: { responses?: object } | undefined) => Object.keys(op?.responses ?? {}).sort();
    expect(codes(paths[PERSPECTIVES_JOBS_PATH]?.post)).toEqual(['202', '400', '401', '402', '429', '500', '503']);
    const unavailable = paths[PERSPECTIVES_JOBS_PATH]?.post?.responses?.['503'] as { description?: string } | undefined;
    expect(unavailable?.description?.startsWith('UnEcho Chamber is not offered')).toBe(true);
    expect(codes(paths[perspectivesJobPath('{id}')]?.get)).toEqual(['200', '401', '404']);
    expect(codes(paths[perspectivesJobCancelPath('{id}')]?.post)).toEqual(['202', '401', '404']);
  });
});
