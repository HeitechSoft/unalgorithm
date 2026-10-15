/**
 * The fact-check job endpoints (P3-19): start, poll and cancel, the gates in front of a model, billing holds, the usage
 * row and a graceful stop. Search mode runs on the mock OpenAI-compatible provider and a mock SearXNG; Anthropic mode on
 * `mockAnthropicFetch`. Nothing here calls a real model or search service.
 */
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describeError } from '@unalgorithm/ai';
import {
  type AnthropicRequestKind,
  classifyMessage,
  mockAnthropicFetch,
  researchMessage,
  structuredMessage,
} from '@unalgorithm/ai/testing/anthropic';
import {
  CLASSIFY_PATH,
  CREDIT_PRICE_SCHEDULE,
  costMicros,
  FACTCHECK_JOB_TTL_MS,
  FACTCHECK_JOBS_PATH,
  type FactcheckJob,
  FactcheckJobSchema,
  type FactcheckResult,
  factcheckJobCancelPath,
  factcheckJobPath,
  type PostForAI,
  retailMicros,
  SERVER_INFO_PATH,
  ServerInfoSchema,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { startMockSearxng } from '@unalgorithm/research/testing';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { clientForRoute } from '../src/ai/provider.ts';
import { claimCache, usageEvents, user } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/app.ts';
import { inFlightRequests } from '../src/http/middleware.ts';
import { listen, stopServing } from '../src/index.ts';
import { createJobStore } from '../src/jobs/memory-jobs.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { classifyBody, postClassify, serverPost } from './support/classify.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { seedPassingRoute } from './support/routes.ts';
import { DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const ALLOW = { SIGNUP_ALLOWLIST: `${TOM},${ANA}` };
const FIXTURE = fileURLToPath(new URL('./fixtures/billing-module/index.ts', import.meta.url));

/** Anthropic as the provider, fact-check on, research by Anthropic web search. */
const ANTHROPIC_ENV: Record<string, string | undefined> = {
  ...ALLOW,
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: 'sk-ant-test-only-not-a-real-key',
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
  FACTCHECK: 'on',
};
const BILLING_ENV = { BILLING: 'module', BILLING_MODULE: FIXTURE };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Reply = { status: number; body: unknown };
type Responder = (body: Record<string, unknown>, kind: AnthropicRequestKind) => Reply;
const ok = (body: unknown): Reply => ({ status: 200, body });

const URL_A = 'https://news.example.org/bridge';
const URL_B = 'https://archive.example.com/bridge';
const QUOTE_A = 'The bridge opened in 1932 after four years of work.';
const QUOTE_B = 'Records show the bridge opened to traffic in 1932.';
const STRUCTURED_USAGE = { ...ZERO_USAGE, uncachedInput: 1000, output: 100 };
const RESEARCH_USAGE = { ...ZERO_USAGE, uncachedInput: 20_000, output: 1500, webSearches: 3 };

const EXPLANATION = 'Two histories of the bridge give the same year.';

function verdictMessage(explanation = EXPLANATION) {
  return structuredMessage(
    {
      verdicts: [
        {
          claimId: 'c1',
          verdict: 'supported',
          explanation,
          citations: [
            { sourceId: 's1', quote: 'The bridge opened in 1932' },
            { sourceId: 's2', quote: 'the bridge opened to traffic in 1932' },
          ],
        },
      ],
    },
    { model: 'claude-sonnet-5-5' },
  );
}

/** A working Anthropic: one claim, two cited sources on two domains, a supported verdict; classify answers too. */
const happy: Responder = (body, kind) => {
  if (kind === 'classify') return ok(classifyMessage(body, () => ({ relevance: 80, isNews: false, hasCheckableClaims: true })));
  if (kind === 'claims') return ok(structuredMessage({ claims: [{ claim: 'The bridge opened in 1932.' }] }));
  if (kind === 'research') {
    return ok(
      researchMessage({
        results: [
          { url: URL_A, title: 'Bridge history' },
          { url: URL_B, title: 'City archive' },
        ],
        notes: [
          { text: 'It opened in 1932.', cites: [{ url: URL_A, citedText: QUOTE_A }] },
          { text: 'The archive agrees.', cites: [{ url: URL_B, citedText: QUOTE_B }] },
        ],
      }),
    );
  }
  if (kind === 'verdict') return ok(verdictMessage());
  return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } } };
};

const authError: Reply = {
  status: 401,
  body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
};

/** A promise and its resolver: a request kind held until the test lets it go. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const POST_TEXT = 'The bridge opened in 1932 and cost $10 million to build. Nothing like it had been built before.';

function publicPost(over: Partial<PostForAI> = {}): Promise<PostForAI> {
  return serverPost('check', POST_TEXT, over);
}

type TestApp = Awaited<ReturnType<typeof createTestApp>> & { token: string };

async function signedIn(t: Awaited<ReturnType<typeof createTestApp>>): Promise<TestApp> {
  cleanup.push(t.close);
  const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;
  return { ...t, token };
}

/** Search mode: the mock OpenAI-compatible model, a mock SearXNG, `BILLING=off`. */
async function searchApp(env: Record<string, string> = {}, options: TestAppOptions = {}) {
  const searx = await startMockSearxng();
  cleanup.push(() => searx.close());
  const config = testConfig({ ...ALLOW, FACTCHECK: 'on', SEARCH_PROVIDER: 'searxng', SEARCH_URL: searx.url, ...env });
  const t = await signedIn(await createTestApp({ config, ...options }));
  await seedPassingRoute(t.deps.db.db, {
    task: 'synthesis',
    effort: 'medium',
    evalPromptVersion: FACTCHECK_PROMPT_VERSION,
    baseUrl: t.mock.baseUrl,
  });
  return { ...t, searx };
}

interface AnthropicOptions extends TestAppOptions {
  /** `BILLING=module` with the fixture module on `TEST_PRICE_SCHEDULE` (unless `priceSchedule` says otherwise). */
  billed?: boolean;
  env?: Record<string, string | undefined>;
  /** Request kinds held at the fetch until their gate opens (or the request is aborted). */
  gates?: Partial<Record<AnthropicRequestKind, Promise<void>>>;
  synthesisPromptVersion?: number;
}

/** Anthropic mode: the server's own client on `mockAnthropicFetch`, with the three fact-check routes past their eval. */
async function anthropicApp(reply: Responder = happy, opts: AnthropicOptions = {}) {
  const { billed, env, gates, synthesisPromptVersion, ...options } = opts;
  const config = testConfig({ ...ANTHROPIC_ENV, ...(billed ? BILLING_ENV : {}), ...env });
  const kinds: AnthropicRequestKind[] = [];
  const inner = mockAnthropicFetch((body, kind) => {
    kinds.push(kind);
    return reply(body, kind);
  });
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const held = gates?.[requestKindOf(init)];
    if (held) await untilAbort(held, init?.signal);
    return inner(url, init);
  }) as typeof globalThis.fetch;
  const ai: AppDeps['ai'] = { clientFor: (r) => clientForRoute(r, config, { fetch }) };
  const t = await signedIn(
    await createTestApp({
      config,
      ai,
      ...(billed ? { billingModule: fixtureModule, priceSchedule: TEST_PRICE_SCHEDULE } : {}),
      ...options,
    }),
  );
  const base = { provider: 'anthropic', baseUrl: null, dataPolicy: 'vendor-zdr' };
  const db = t.deps.db.db;
  await seedPassingRoute(db, { ...base, task: 'classify', model: 'claude-haiku-5-5', effort: 'low' });
  const factcheck = { ...base, effort: 'medium', model: 'claude-sonnet-5-5', evalPromptVersion: FACTCHECK_PROMPT_VERSION };
  await seedPassingRoute(db, { ...factcheck, task: 'research' });
  await seedPassingRoute(db, {
    ...factcheck,
    task: 'synthesis',
    evalPromptVersion: synthesisPromptVersion ?? FACTCHECK_PROMPT_VERSION,
  });
  return { ...t, kinds, bodies: inner.bodies };
}

/** The kind of an Anthropic request from its body, before the mock sees it. */
function requestKindOf(init?: RequestInit): AnthropicRequestKind {
  const text = typeof init?.body === 'string' ? init.body : '';
  if (text.includes('"tools"')) return 'research';
  if (text.includes('"verdicts"')) return 'verdict';
  if (text.includes('"claims"')) return 'claims';
  if (text.includes('"results"')) return 'classify';
  return 'unknown';
}

/** Waits for `held`, or rejects once `signal` aborts. */
function untilAbort(held: Promise<void>, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal?.reason ?? new Error('aborted'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    held.then(resolve, reject);
  });
}

function headers(token: string) {
  return { Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` };
}

function startCheck(t: TestApp, post: PostForAI | unknown, token = t.token): Promise<Response> {
  return postJson(t.app, FACTCHECK_JOBS_PATH, { v: 1, post }, headers(token));
}

function poll(t: TestApp, id: string, opts: { wait?: boolean; token?: string } = {}): Promise<Response> {
  const path = `${factcheckJobPath(id)}${opts.wait === false ? '' : '?wait=1'}`;
  return Promise.resolve(t.app.request(path, { headers: headers(opts.token ?? t.token) }));
}

/** Starts a check that must be accepted, and answers its id. */
async function started(t: TestApp, post?: PostForAI): Promise<string> {
  const res = await startCheck(t, post ?? (await publicPost()));
  expect(res.status, await res.clone().text()).toBe(202);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const job = FactcheckJobSchema.parse(await res.json());
  expect(job.status).toBe('running');
  return job.id;
}

/** Polls (`?wait=1`) until the job has ended. */
async function ended(t: TestApp, id: string): Promise<FactcheckJob> {
  for (;;) {
    const res = await poll(t, id);
    expect(res.status).toBe(200);
    const job = FactcheckJobSchema.parse(await res.json());
    if (job.status !== 'running') return job;
  }
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code;
}

async function usageRows(t: TestApp) {
  return t.deps.db.db.select().from(usageEvents);
}

async function discovery(t: TestApp) {
  const res = await t.app.request(SERVER_INFO_PATH);
  return ServerInfoSchema.parse(await res.json());
}

function citedIds(result: FactcheckResult | undefined): string[] {
  return (result?.claims ?? []).flatMap((c) => c.citations.map((x) => x.sourceId));
}

describe('fact-check jobs: happy path', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_job_search_mode_done', async () => {
    const t = await searchApp();
    const id = await started(t);
    const job = await ended(t, id);
    expect(job.status).toBe('done');
    expect(job.billing).toBeUndefined();
    const result = job.result as FactcheckResult;
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ claim: 'The bridge opened in 1932 and cost $10 million to build.' });
    expect(result.claims[0]?.verdict).toBe('supported');
    // The verdict cites the mock's sources, and only those.
    const urls = new Set(result.sources.map((s) => s.url));
    expect([...urls].every((u) => /^https:\/\/[abc]\.example\//.test(u))).toBe(true);
    expect(citedIds(result).length).toBeGreaterThanOrEqual(2);
    expect(t.searx.queries.length).toBeGreaterThan(0);
  });

  it('test_factcheck_job_anthropic_mode_three_calls', async () => {
    const t = await anthropicApp();
    const job = await ended(t, await started(t));
    expect(job.status).toBe('done');
    expect(t.kinds).toEqual(['claims', 'research', 'verdict']);
    expect(job.result?.claims[0]?.verdict).toBe('supported');
    expect(job.result?.sources.map((s) => s.url).sort()).toEqual([URL_B, URL_A].sort());
  });
});

describe('fact-check jobs: refusals before a model', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_job_refuses_non_public_post', async () => {
    const jobs = createJobStore<FactcheckResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const t = await searchApp({}, { factcheckJobs: jobs });
    for (const audience of ['friends', 'custom', undefined] as const) {
      const res = await startCheck(t, await publicPost({ platform: 'facebook', ...(audience ? { audience } : {}) }));
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('bad-request');
    }
    expect(t.mock.bodies).toEqual([]);
    expect(t.searx.queries).toEqual([]);
    expect(jobs.size).toBe(0);
    expect(await usageRows(t)).toEqual([]);
  });

  it('test_factcheck_job_off_and_discovery_capability', async () => {
    const off = await signedIn(await createTestApp({ config: testConfig(ALLOW) }));
    const res = await startCheck(off, await publicPost());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('not-available');
    expect((await discovery(off)).capabilities.factcheck).toBe(false);
    expect(off.mock.bodies).toEqual([]);

    const on = await searchApp();
    const info = await discovery(on);
    expect(info.capabilities.factcheck).toBe(true);
    expect(info.jobPrices).toBeUndefined();
  });

  it('test_factcheck_job_cap_rate_and_busy', async () => {
    // The daily check cap: 0 refuses every check, and the refusal is metered.
    const capped = await searchApp({ USER_DAILY_CHECK_CAP: '0' });
    const cap = await startCheck(capped, await publicPost());
    expect(cap.status).toBe(429);
    expect(await errorOf(cap)).toBe('cap-reached');
    expect(capped.mock.bodies).toEqual([]);
    expect(await usageRows(capped)).toMatchObject([{ task: 'factcheck', outcome: 'refused-before-call', calls: 0 }]);

    // One rate bucket for classify and fact-check: two classify requests use it up.
    const rated = await searchApp({ USER_REQUESTS_PER_MINUTE: '2' });
    const body = classifyBody([await serverPost('c', 'AI agents at work')]);
    for (let i = 0; i < 2; i++) expect((await postClassify(rated.app, body, rated.token)).status).toBe(200);
    const sent = rated.mock.bodies.length;
    const rate = await startCheck(rated, await publicPost());
    expect(rate.status).toBe(429);
    expect(await errorOf(rate)).toBe('rate-limit');
    expect(rate.headers.get('retry-after')).not.toBeNull();
    expect(rated.mock.bodies.length).toBe(sent);
    expect(rated.searx.queries).toEqual([]);

    // A second check while the first runs.
    const research = gate();
    const busy = await anthropicApp(happy, { gates: { research: research.opened } });
    const first = await started(busy);
    await expect.poll(() => busy.kinds).toEqual(['claims']);
    const second = await startCheck(busy, await publicPost());
    expect(second.status).toBe(429);
    expect(await errorOf(second)).toBe('rate-limit');
    expect(busy.kinds).toEqual(['claims']);
    research.open();
    expect((await ended(busy, first)).status).toBe('done');
  });

  it('test_factcheck_job_route_eval_gate', async () => {
    const t = await anthropicApp(happy, { synthesisPromptVersion: FACTCHECK_PROMPT_VERSION + 1 });
    const res = await startCheck(t, await publicPost());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('not-available');
    expect(t.bodies).toEqual([]);
    expect(await usageRows(t)).toMatchObject([{ outcome: 'refused-before-call' }]);
  });
});

describe('fact-check jobs: billing', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_job_holds_and_settles_under_cap', async () => {
    const t = await anthropicApp(happy, { billed: true });
    const info = await discovery(t);
    expect(info.capabilities.factcheck).toBe(true);
    expect(info.jobPrices?.factcheck).toEqual({ typicalMicros: 240_000, maxMicros: 400_000 });

    const checks: Promise<unknown>[] = [];
    const check = t.provider.check.bind(t.provider);
    t.provider.check = (ctx) => {
      const decision = check(ctx);
      checks.push(decision);
      return decision;
    };
    const id = await started(t);
    const job = await ended(t, id);
    expect(job.status).toBe('done');
    expect(await Promise.all(checks)).toMatchObject([{ kind: 'hold', amountMicros: 400_000 }]);
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row?.costMicros).toBeGreaterThan(0);
    expect(job.billing?.chargedMicros).toBe(retailMicros(row?.costMicros ?? -1, 2));
    expect(job.billing?.chargedMicros).toBeLessThanOrEqual(400_000);

    // Claims and research cheap, the verdict over the ceiling: checked before it, never after, so the job is done and
    // charged the hold cap exactly.
    const pricey = await anthropicApp(
      (body, kind) => {
        if (kind !== 'verdict') return happy(body, kind);
        const message = verdictMessage();
        return ok({ ...message, usage: { input_tokens: 150_000, output_tokens: 1000 } });
      },
      { billed: true },
    );
    const capped = await ended(pricey, await started(pricey));
    expect(capped.status).toBe('done');
    expect(capped.billing?.chargedMicros).toBe(400_000);
  });

  it('test_factcheck_job_not_offered_on_billing_server', async () => {
    // No entry prices checks: the shipped schedule does from its fact-check entry's date, so it is not used here.
    const unpriced = CREDIT_PRICE_SCHEDULE.filter((e) => !e.cards.factcheck);
    const t = await anthropicApp(happy, { billed: true, priceSchedule: unpriced });
    const res = await startCheck(t, await publicPost());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('not-available');
    const info = await discovery(t);
    expect(info.capabilities.factcheck).toBe(false);
    expect(info.jobPrices).toBeUndefined();
    expect(t.bodies).toEqual([]);
  });

  it('test_factcheck_job_empty_balance_402', async () => {
    const jobs = createJobStore<FactcheckResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const t = await anthropicApp(happy, {
      billed: true,
      billingEnv: { BILLING_FIXTURE_START_MICROS: '0' },
      factcheckJobs: jobs,
    });
    const res = await startCheck(t, await publicPost());
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe('insufficient-credits');
    expect(t.bodies).toEqual([]);
    expect(jobs.size).toBe(0);
    expect(jobs.running).toBe(0);
    const rows = await usageRows(t);
    expect(rows).toMatchObject([{ outcome: 'refused-before-call', requestId: res.headers.get('x-request-id') }]);
  });

  it('test_factcheck_job_failure_and_cancel_release_hold', async () => {
    const holds = fixtureModule.openHolds();
    const failing = await anthropicApp((body, kind) => (kind === 'research' ? authError : happy(body, kind)), {
      billed: true,
    });
    const id = await started(failing);
    const job = await ended(failing, id);
    expect(job.status).toBe('failed');
    expect(job.error).toEqual({ code: 'not-available', message: describeError('not-available', 'Test server') });
    expect(JSON.stringify(job)).not.toContain('x-api-key');
    expect(fixtureModule.openHolds()).toBe(holds);
    const [row] = await failing.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ outcome: 'failed', chargeableCostMicros: 0 });
    expect(await failing.provider.balance(row?.userId ?? '')).toEqual({ balanceMicros: 1_000_000 });

    const research = gate();
    const cancelled = await anthropicApp(happy, { billed: true, gates: { research: research.opened } });
    const running = await started(cancelled);
    await expect.poll(() => cancelled.kinds).toEqual(['claims']);
    expect(fixtureModule.openHolds()).toBe(holds + 1);
    const cancel = await cancelled.app.request(factcheckJobCancelPath(running), {
      method: 'POST',
      headers: headers(cancelled.token),
    });
    expect(cancel.status).toBe(202);
    expect((await ended(cancelled, running)).status).toBe('cancelled');
    expect(fixtureModule.openHolds()).toBe(holds);
    research.open();
  });

  it('test_factcheck_abandoned_job_released_not_charged', async () => {
    const holds = fixtureModule.openHolds();
    // Real timers (PGlite does not run under fake ones), so a short abandonment; research holds until the job's signal
    // aborts, so the job is still running when nobody has polled it for 300 ms.
    const jobs = createJobStore<FactcheckResult>({
      ttlMs: FACTCHECK_JOB_TTL_MS,
      maxRunning: 8,
      maxKeptPerUser: 5,
      abandonAfterMs: 300,
    });
    const research = gate();
    const t = await anthropicApp(happy, { billed: true, factcheckJobs: jobs, gates: { research: research.opened } });
    const calls: string[] = [];
    for (const name of ['check', 'settle', 'release'] as const) {
      const real = t.provider[name].bind(t.provider) as (input: never) => Promise<unknown>;
      t.provider[name] = ((input: never) => {
        calls.push(name);
        return real(input);
      }) as never;
    }

    const id = await started(t);
    // Never polled: the log line, not a poll, says when it ended.
    await expect.poll(() => jobs.running, { timeout: 5_000 }).toBe(0);
    expect(t.kinds).toEqual(['claims']);
    expect(calls).toEqual(['check', 'release']);
    expect(fixtureModule.openHolds()).toBe(holds);
    expect((await ended(t, id)).status).toBe('cancelled');

    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ outcome: 'failed', chargeableCostMicros: 0 });
    expect(await t.provider.balance(row?.userId ?? '')).toEqual({ balanceMicros: 1_000_000 });
    const done = t.events().filter((e) => e.event === 'factcheck.done');
    expect(done).toMatchObject([{ rid: id, outcome: 'cancelled', abandoned: true }]);
    expect(t.lines.join('')).not.toContain('bridge opened');
    research.open();
  });
});

describe('fact-check jobs: pipeline wiring', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_job_drops_dead_link_citations', async () => {
    const dead = 'https://a.example/record-1';
    const checked: string[] = [];
    const t = await searchApp(
      {},
      {
        linkCheck: async (urls) => {
          checked.push(...urls);
          return new Map(urls.map((u) => [u, u === dead ? 'dead' : 'live'] as const));
        },
      },
    );
    const job = await ended(t, await started(t));
    expect(job.status).toBe('done');
    expect(checked).toContain(dead);
    const result = job.result as FactcheckResult;
    expect(result.sources.map((s) => s.url)).not.toContain(dead);
    const deadIds = result.sources.filter((s) => s.url === dead).map((s) => s.id);
    expect(citedIds(result).filter((id) => deadIds.includes(id) || id === 's1')).toEqual([]);
  });

  it('test_factcheck_job_usage_rows', async () => {
    const t = await anthropicApp();
    const id = await started(t);
    expect((await ended(t, id)).status).toBe('done');
    const expected =
      (costMicros('claude-haiku-5-5', STRUCTURED_USAGE) ?? 0) +
      (costMicros('claude-sonnet-5-5', RESEARCH_USAGE) ?? 0) +
      (costMicros('claude-sonnet-5-5', STRUCTURED_USAGE) ?? 0);
    expect(await usageRows(t)).toMatchObject([
      {
        requestId: id,
        task: 'factcheck',
        outcome: 'ok',
        postsRequested: 1,
        postsOk: 0,
        calls: 3,
        failedCalls: 0,
        costMicros: expected,
        chargeableCostMicros: expected,
        model: 'claude-sonnet-5-5',
      },
    ]);
    const done = t.events().filter((e) => e.event === 'factcheck.done');
    expect(done).toMatchObject([{ rid: id, outcome: 'done', claims: 1, sources: 2, cached: 0, cost_micros: expected }]);
    expect(Object.keys(done[0] ?? {}).sort()).toEqual(
      ['cached', 'claims', 'cost_micros', 'event', 'level', 'ms', 'outcome', 'rid', 'sources', 't'].sort(),
    );
  });
});

/** The claims call's cost in Anthropic mode: the classify route's model on the mock's structured usage. */
const CLAIMS_COST = costMicros('claude-haiku-5-5', STRUCTURED_USAGE) ?? -1;

/** The same public post checked by Tom, then by Ana on the same server: the two jobs' results and the second's calls. */
async function checkTwice(t: Awaited<ReturnType<typeof anthropicApp>>) {
  const post = await publicPost();
  const first = await ended(t, await started(t, post));
  const before = t.kinds.length;
  const bodiesBefore = t.bodies.length;
  const ana = { ...t, token: (await signInDevice(t.app, t.outbox, ANA)).access_token };
  const secondId = await started(ana, post);
  const second = await ended(ana, secondId);
  return { first, second, secondId, kinds: t.kinds.slice(before), bodies: t.bodies.slice(bodiesBefore) };
}

function hourFloor(iso: string | undefined): string {
  const hour = 60 * 60_000;
  return new Date(Math.floor(Date.parse(iso ?? '') / hour) * hour).toISOString();
}

describe('fact-check jobs: claim cache', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_repeat_answered_from_cache', async () => {
    const t = await anthropicApp();
    const { first, second, secondId, kinds, bodies } = await checkTwice(t);
    expect(first.status).toBe('done');
    expect(first.result?.claims[0]?.cachedAt).toBeUndefined();
    expect(second.status).toBe('done');
    // One request, the claims prompt: no research, no verdict.
    expect(kinds).toEqual(['claims']);
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies[0])).toContain('"claims"');
    expect(second.result?.claims).toHaveLength(1);
    // The explanation repeats none of the post, so the row keeps it and the hit shows it.
    expect(second.result?.claims[0]).toMatchObject({
      verdict: 'supported',
      explanation: EXPLANATION,
      cachedAt: hourFloor(first.result?.checkedAt),
    });
    expect((await t.deps.db.db.select().from(claimCache)).map((r) => r.explanation)).toEqual([EXPLANATION]);

    const done = t.events().filter((e) => e.event === 'factcheck.done' && e.rid === secondId);
    expect(done).toMatchObject([{ outcome: 'done', claims: 1, cached: 1 }]);
    const line = JSON.stringify(done[0]);
    for (const text of ['bridge', '1932', POST_TEXT]) expect(line).not.toContain(text);
    expect(t.lines.join('')).not.toContain('bridge opened');
  });

  it('test_factcheck_cache_row_drops_explanation_echoing_post', async () => {
    // Six words in a row of POST_TEXT ("the bridge opened in 1932 and").
    const echo = 'Sources agree the bridge opened in 1932 and cost $10 million to build.';
    const t = await anthropicApp((body, kind) => (kind === 'verdict' ? ok(verdictMessage(echo)) : happy(body, kind)));
    const { first, second, kinds } = await checkTwice(t);
    // The person who ran the check sees it; the row keeps the verdict and sources only, so the hit shows none.
    expect(first.result?.claims[0]?.explanation).toBe(echo);
    expect(kinds).toEqual(['claims']);
    expect(second.result?.claims[0]).toMatchObject({
      verdict: 'supported',
      explanation: '',
      cachedAt: hourFloor(first.result?.checkedAt),
    });
    const rows = await t.deps.db.db.select().from(claimCache);
    expect(rows.map((r) => r.explanation)).toEqual([null]);
    expect(JSON.stringify(rows)).not.toContain('1932 and cost');
  });

  it('test_factcheck_cache_hit_charged_cost_times_two', async () => {
    const t = await anthropicApp(happy, { billed: true });
    const settled: { requestId: string; costMicros: number | null; chargedMicros: number }[] = [];
    const settle = t.provider.settle.bind(t.provider);
    t.provider.settle = async (input) => {
      const out = await settle(input);
      settled.push({ requestId: input.requestId, costMicros: input.costMicros, chargedMicros: out?.chargedMicros ?? -1 });
      return out;
    };
    const { second, secondId, kinds } = await checkTwice(t);
    expect(kinds).toEqual(['claims']);
    expect(second.status).toBe('done');
    // Cost x 2 of the one call it made, as every task; no flat price.
    const charge = settled.find((s) => s.requestId === secondId);
    expect(charge).toEqual({ requestId: secondId, costMicros: CLAIMS_COST, chargedMicros: retailMicros(CLAIMS_COST, 2) });
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, secondId));
    expect(row).toMatchObject({ outcome: 'ok', calls: 1, costMicros: CLAIMS_COST, chargeableCostMicros: CLAIMS_COST });
    expect(second.billing?.chargedMicros).toBe(charge?.chargedMicros);
  });

  it('test_factcheck_cache_off_runs_full', async () => {
    const t = await anthropicApp(happy, { env: { CLAIM_CACHE: 'off' } });
    const { first, second, kinds } = await checkTwice(t);
    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect(kinds).toEqual(['claims', 'research', 'verdict']);
    expect(second.result?.claims[0]?.cachedAt).toBeUndefined();
    expect(await t.deps.db.db.select().from(claimCache)).toEqual([]);
  });

  it('test_factcheck_cache_failure_runs_full', async () => {
    const t = await anthropicApp(happy, {
      claimCache: {
        key: async () => 'f'.repeat(64),
        get: async () => {
          throw new Error('cache down');
        },
        put: async () => undefined,
      },
    });
    const { first, second, kinds } = await checkTwice(t);
    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect(kinds).toEqual(['claims', 'research', 'verdict']);
    expect(second.result?.claims[0]?.cachedAt).toBeUndefined();
  });
});

describe('fact-check jobs: polling and lifecycle', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_factcheck_job_poll_owner_only_and_ttl', async () => {
    let now = Date.now();
    const jobs = createJobStore<FactcheckResult>({
      ttlMs: FACTCHECK_JOB_TTL_MS,
      maxRunning: 8,
      maxKeptPerUser: 5,
      now: () => now,
    });
    const t = await searchApp({}, { factcheckJobs: jobs });
    const id = await started(t);
    expect((await ended(t, id)).status).toBe('done');
    expect((await poll(t, id, { wait: false })).status).toBe(200);

    const ana = (await signInDevice(t.app, t.outbox, ANA)).access_token;
    expect((await poll(t, id, { token: ana })).status).toBe(404);
    expect((await poll(t, id, { token: ana, wait: false })).status).toBe(404);
    const cancel = await t.app.request(factcheckJobCancelPath(id), { method: 'POST', headers: headers(ana) });
    expect(cancel.status).toBe(404);
    expect((await poll(t, crypto.randomUUID())).status).toBe(404);

    now += FACTCHECK_JOB_TTL_MS;
    const expired = await poll(t, id, { wait: false });
    expect(expired.status).toBe(404);
    expect(await errorOf(expired)).toBe('bad-request');
  });

  it('test_factcheck_jobs_released_on_stop', async () => {
    const holds = fixtureModule.openHolds();
    const research = gate();
    // The classify request is held until its connection closes: in flight for the whole grace period.
    const classifyHeld = gate();
    const stopping = new AbortController();
    const inFlight = inFlightRequests();
    const jobs = createJobStore<FactcheckResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const t = await anthropicApp(happy, {
      billed: true,
      gates: { research: research.opened, classify: classifyHeld.opened },
      stopping: stopping.signal,
      inFlight,
      factcheckJobs: jobs,
    });
    const server = await listen(t.app, '127.0.0.1', 0);
    cleanup.push(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });

    const id = await started(t);
    await expect.poll(() => t.kinds).toEqual(['claims']);
    expect(fixtureModule.openHolds()).toBe(holds + 1);

    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const answered = fetch(`${url}${CLASSIFY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers(t.token) },
      body: JSON.stringify(classifyBody([await serverPost('c', 'AI agents at work')])),
    }).then(
      (res) => res.status,
      () => 'connection closed',
    );
    await expect.poll(() => inFlight.count).toBe(1);

    const GRACE_MS = 1_500;
    let stopped = false;
    const stop = stopServing(server, { stopping, inFlight, log: t.deps.log, graceMs: GRACE_MS, jobs: [jobs] }).then(() => {
      stopped = true;
    });
    // Aborted at the start of the stop: the job has ended, its row written and its hold released, while the classify
    // request still holds the grace period open.
    const end = await jobs.waitFor(id, await userIdOf(t), GRACE_MS * 4);
    expect(end?.status).toBe('failed');
    expect(stopped).toBe(false);
    const [row] = await t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id));
    expect(row).toMatchObject({ outcome: 'failed', task: 'factcheck' });
    expect(fixtureModule.openHolds()).toBe(holds);

    await stop;
    expect(await answered).toBe('connection closed');
    expect(jobs.running).toBe(0);
    research.open();
    classifyHeld.open();
  });

  it('test_factcheck_job_refused_once_stopping', async () => {
    // A start whose gates were passing when the stop began: `stopServing` has already aborted the jobs, so a job started
    // now would never be aborted, outlive the drain and leave its hold open under a closed database.
    const holds = fixtureModule.openHolds();
    const stopping = new AbortController();
    const jobs = createJobStore<FactcheckResult>({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 });
    const t = await anthropicApp(happy, { billed: true, stopping: stopping.signal, factcheckJobs: jobs });
    stopping.abort();
    const res = await startCheck(t, await publicPost());
    expect(res.status).toBe(503);
    expect(await errorOf(res)).toBe('overloaded');
    expect(t.bodies).toEqual([]);
    expect(jobs.size).toBe(0);
    expect(fixtureModule.openHolds()).toBe(holds);
    expect(await usageRows(t)).toMatchObject([{ outcome: 'refused-before-call', calls: 0 }]);
  });
});

/** The signed-in user's id: the only user of the app's database. */
async function userIdOf(t: TestApp): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user);
  return row?.id ?? '';
}
