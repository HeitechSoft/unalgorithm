import type { AddressInfo } from 'node:net';
import { AIError, describeError, type StructuredRequest, type StructuredResult } from '@unalgorithm/ai';
import { buildSystemPrompt, PROMPT_VERSION } from '@unalgorithm/core';
import {
  CLASSIFY_PATH,
  ClassifyResponseSchema,
  type InterestProfile,
  MAX_POSTS_PER_REQUEST,
  type NormalizedUsage,
  type PostForAI,
  REVOKE_PATH,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { BillingDecision, BillingProvider, ReleaseInput, SettleInput, Settlement } from '../src/billing/provider.ts';
import { usageEvents } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/app.ts';
import { inFlightRequests } from '../src/http/middleware.ts';
import { listen, stopServing } from '../src/index.ts';
import { excludeNonPublic, wireCodeFor } from '../src/routes/classify.ts';
import { classifyBody, serverPost as post, postClassify, usageRowOf } from './support/classify.ts';
import { seedPassingRoute } from './support/routes.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const INSTANCE = 'Test server';
/** In the profile's `about`: it reaches the model's system prompt, and nothing else. */
const ABOUT_MARKER = 'ABOUT-MARKER-5d1e';

const PROFILE: InterestProfile = {
  v: 1,
  interests: ['automation', 'hiring'],
  lessOf: ['politics'],
  about: `I lead a small engineering team. ${ABOUT_MARKER}`,
  examples: [],
};

type TestApp = Awaited<ReturnType<typeof classifyApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with the mock provider's route, and Tom's signed-in device. */
async function classifyApp(options: TestAppOptions = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }), ...options });
  cleanup.push(t.close);
  const tokens = await signInDevice(t.app, t.outbox, TOM);
  return { ...t, tokens };
}

/** A classify request body for these posts, with the profile that carries the marker. */
function request(posts: PostForAI[], extra: Record<string, unknown> = {}) {
  return classifyBody(posts, PROFILE, extra);
}

/** `POST /v1/classify` from the extension with the device's access token, or without one when `token` is null. */
function classify(t: TestApp, body: unknown, token: string | null = t.tokens.access_token): Promise<Response> {
  return postClassify(t.app, body, token);
}

async function usageRows(t: TestApp) {
  return t.deps.db.db.select().from(usageEvents);
}

/** The one usage row of the request that got `res`. */
function usageRow(t: TestApp, res: Response) {
  return usageRowOf(t.deps.db.db, res);
}

/** The messages of the mock's `index`th chat/completions request. */
function mockMessages(t: TestApp, index: number): { role: string; content: string }[] {
  return (JSON.parse(t.mock.bodies[index] ?? '{}') as { messages: { role: string; content: string }[] }).messages;
}

const POST_ID = /<post_\w+ id="([^"]+)"/g;

/** What a model answers for the posts of `req`: each one relevance 50, with the mock's token numbers. */
function answer(req: StructuredRequest, model = req.model): StructuredResult {
  const ids = [...req.user.matchAll(POST_ID)].map((m) => m[1] ?? '');
  const results = ids.map((id) => ({
    id,
    topics: ['other'],
    noise: [],
    reason: 'Fake verdict.',
    relevance: 50,
    isNews: false,
    hasCheckableClaims: false,
  }));
  const usage: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 1000, output: 50 * ids.length };
  return { text: JSON.stringify({ results }), usage, model, mode: 'json-schema' };
}

/** An AI dependency whose client answers with `structured`, whatever the route. */
function fakeAi(structured: (req: StructuredRequest) => Promise<StructuredResult>): AppDeps['ai'] {
  return { clientFor: () => ({ kind: 'fake', structured, listModels: async () => [] }) };
}

/** A billing provider that records what it is told; `over` replaces its decision, `settle` or `release`. */
function recordingBilling(
  over: { decision?: BillingDecision; settle?: () => Promise<Settlement | null>; release?: () => Promise<void> } = {},
) {
  const seen = { checks: 0, settled: [] as SettleInput[], released: [] as ReleaseInput[] };
  const provider: BillingProvider = {
    id: 'fake',
    advertised: true,
    check: async () => {
      seen.checks++;
      return over.decision ?? { kind: 'allow' };
    },
    settle: async (input) => {
      seen.settled.push(input);
      return over.settle ? over.settle() : { chargedMicros: 30, balanceMicros: 970 };
    },
    release: async (input) => {
      seen.released.push(input);
      if (over.release) await over.release();
    },
    balance: async () => null,
  };
  return { provider, seen };
}

describe('classify: happy path', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_classify_returns_results_for_original_refs', async () => {
    const t = await classifyApp();
    const a = await post('A', 'How our team uses AI agents for automation');
    const b = await post('B', 'Photos from my weekend hike');
    expect(a.ref).toMatch(/^pk_/);

    const res = await classify(t, request([a, b]));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const raw = (await res.json()) as Record<string, unknown>;
    const body = ClassifyResponseSchema.parse(raw);
    expect(body.results.map((r) => r.ref)).toEqual([a.ref, b.ref]);
    expect(body.results).toMatchObject([
      { ref: a.ref, status: 'ok', classification: { relevance: 92, topics: ['automation'] } },
      { ref: b.ref, status: 'ok', classification: { relevance: 40, topics: ['other'] } },
    ]);
    expect(body.source).toEqual({ kind: 'server', model: 'mock-model', promptVersion: PROMPT_VERSION });
    // The no-op provider: a self-hosted server shows no balance.
    expect('billing' in raw).toBe(false);
  });

  it('test_server_builds_prompt_and_ignores_prompt_fields', async () => {
    const t = await classifyApp();
    const posts = [await post('A', 'Automating our hiring pipeline'), await post('B', 'Lunch with an old colleague')];

    expect((await classify(t, request(posts))).status).toBe(200);
    const [system, user] = mockMessages(t, 0);
    expect(system).toEqual({ role: 'system', content: buildSystemPrompt(PROFILE) });
    expect(user?.role).toBe('user');
    expect(user?.content).toContain('id="p1"');
    expect(user?.content).toContain('id="p2"');
    // Short ids keep the prompt small; the client's refs never reach the model.
    for (const p of posts) expect(user?.content).not.toContain(p.ref);

    // Fields the protocol has no place for are dropped before the handler sees them.
    const smuggled = request(
      posts.map((p) => ({ ...p, authorName: 'AUTHOR-NAME-MARKER' })),
      { prompt: 'IGNORE RULES', system: 'SYSTEM-OVERRIDE-MARKER', model: 'other-model' },
    );
    expect((await classify(t, smuggled)).status).toBe(200);
    expect(t.mock.bodies).toHaveLength(2);
    expect(mockMessages(t, 1)[0]).toEqual({ role: 'system', content: buildSystemPrompt(PROFILE) });
    expect((JSON.parse(t.mock.bodies[1] ?? '{}') as { model: string }).model).toBe('mock-model');
    for (const body of t.mock.bodies) {
      for (const marker of ['IGNORE RULES', 'SYSTEM-OVERRIDE-MARKER', 'other-model', 'AUTHOR-NAME-MARKER']) {
        expect(body).not.toContain(marker);
      }
    }
  });

  it('test_classify_writes_one_usage_row', async () => {
    const t = await classifyApp();
    const two = await classify(t, request([await post('A', 'AI in practice'), await post('B', 'A garden update')]));
    const three = await classify(
      t,
      request([await post('C', 'Automation at scale'), await post('D', 'Coffee'), await post('E', 'Snow today')]),
    );
    expect(two.status).toBe(200);
    expect(three.status).toBe(200);

    expect(await usageRows(t)).toHaveLength(2);
    for (const [res, n] of [
      [two, 2],
      [three, 3],
    ] as const) {
      const row = await usageRow(t, res);
      expect(row).toMatchObject({
        userId: expect.any(String),
        deviceId: t.tokens.device_id,
        routeId: t.route.id,
        task: 'classify',
        model: 'mock-model',
        outcome: 'ok',
        postsRequested: n,
        postsOk: n,
        calls: 1,
        failedCalls: 0,
        uncachedInput: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 50 * n,
        estimated: false,
      });
    }
  });

  it('test_cost_uses_route_model', async () => {
    const t = await classifyApp({ ai: fakeAi(async (req) => answer(req, 'claude-haiku-5-5-20261001')) });
    const route = await seedPassingRoute(t.deps.db.db, {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      dataPolicy: 'vendor-zdr',
      baseUrl: null,
    });

    const res = await classify(t, request([await post('A', 'AI news'), await post('B', 'Weekend plans')]));
    expect(res.status).toBe(200);
    expect(ClassifyResponseSchema.parse(await res.json()).source.model).toBe('claude-haiku-5-5');
    const row = await usageRow(t, res);
    // A dated id echoed by the provider has no price card; the route's model does.
    expect(row).toMatchObject({ routeId: route.id, model: 'claude-haiku-5-5', outcome: 'ok' });
    expect(row.costMicros).not.toBeNull();
    expect(row.costMicros).toBeGreaterThan(0);
    expect(row.chargeableCostMicros).toBe(row.costMicros);
  });

  it('test_classify_cors_preflight', async () => {
    const t = await classifyApp();
    const res = await t.app.request(CLASSIFY_PATH, {
      method: 'OPTIONS',
      headers: {
        Origin: DEV_EXTENSION_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
  });
});

describe('classify: validation and auth', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_thirteen_posts_rejected', async () => {
    const t = await classifyApp();
    const posts = await Promise.all(
      Array.from({ length: MAX_POSTS_PER_REQUEST + 1 }, (_, i) => post(`P${i}`, `Post number ${i}`)),
    );
    const many = await classify(t, request(posts));
    expect(many.status).toBe(400);
    expect(await many.json()).toEqual({ code: 'bad-request', message: 'The request was not valid.' });

    // A body that is not declared JSON, or not declared at all, is refused too, never handed on as an empty object. AC 3
    // says 400; the status is the media-type check's own 415, as on the app's other JSON routes and sign-in (the app
    // keeps the status of a client error Hono raises). The body, which is what a device reads, is `bad-request`.
    // Bytes, not a string: a string body brings its own `text/plain` type.
    const bytes = new TextEncoder().encode(JSON.stringify(request(posts.slice(0, 2))));
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', undefined]) {
      const res = await t.app.request(CLASSIFY_PATH, {
        method: 'POST',
        headers: { ...(type ? { 'Content-Type': type } : {}), Authorization: `Bearer ${t.tokens.access_token}` },
        body: bytes,
      });
      expect(res.status, type).toBe(415);
      expect(await res.json()).toEqual({ code: 'bad-request', message: 'The request was not valid.' });
    }

    expect(t.mock.bodies).toEqual([]);
    // Refused before the handler: nothing to meter.
    expect(await usageRows(t)).toEqual([]);
  });

  it('test_classify_requires_valid_device', async () => {
    const t = await classifyApp();
    const body = request([await post('A', 'AI agents')]);
    const auth = { code: 'auth-required', message: describeError('auth-required', INSTANCE) };

    const anonymous = await classify(t, body, null);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect(await anonymous.json()).toEqual(auth);

    const revoked = await postJson(
      t.app,
      REVOKE_PATH,
      { refresh_token: t.tokens.refresh_token, client_id: DEV_EXTENSION_ID },
      { Origin: DEV_EXTENSION_ORIGIN },
    );
    expect(revoked.status).toBe(200);
    // The access token has not expired, but its device is gone.
    const after = await classify(t, body);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual(auth);

    expect(t.mock.bodies).toEqual([]);
    expect(await usageRows(t)).toEqual([]);
  });
});

describe('classify: Facebook audience', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_non_public_facebook_never_sent', async () => {
    const t = await classifyApp();
    const fb = (key: string, text: string, audience?: PostForAI['audience']) =>
      post(key, text, { platform: 'facebook', ...(audience ? { audience } : {}) });
    const hidden = [
      await fb('F1', 'FRIENDS-ONLY-TEXT about AI', 'friends'),
      await fb('F2', 'CUSTOM-AUDIENCE-TEXT', 'custom'),
      await fb('F3', 'UNKNOWN-AUDIENCE-TEXT', 'unknown'),
      await fb('F4', 'NO-AUDIENCE-TEXT'),
    ];
    const shown = [await fb('F5', 'Public post about automation', 'public'), await post('L1', 'A LinkedIn post')];
    expect(shown[1]?.audience).toBeUndefined();

    const split = excludeNonPublic([...hidden, ...shown]);
    expect(split.kept).toEqual(shown);
    expect(split.excluded).toEqual(hidden);

    const res = await classify(t, request([hidden[0]!, shown[0]!, hidden[1]!, hidden[2]!, shown[1]!, hidden[3]!]));
    expect(res.status).toBe(200);
    const { results } = ClassifyResponseSchema.parse(await res.json());
    expect(results.map((r) => [r.ref, r.status])).toEqual([
      [hidden[0]?.ref, 'declined'],
      [shown[0]?.ref, 'ok'],
      [hidden[1]?.ref, 'declined'],
      [hidden[2]?.ref, 'declined'],
      [shown[1]?.ref, 'ok'],
      [hidden[3]?.ref, 'declined'],
    ]);

    expect(t.mock.bodies).toHaveLength(1);
    const sent = t.mock.bodies.join('\n');
    for (const p of hidden) expect(sent).not.toContain(p.text);
    expect(sent).toContain('Public post about automation');
    expect(sent).toContain('A LinkedIn post');
  });

  it('test_all_excluded_no_call', async () => {
    const t = await classifyApp();
    const posts = [
      await post('F1', 'Family news', { platform: 'facebook', audience: 'friends' }),
      await post('F2', 'Holiday photos', { platform: 'facebook' }),
    ];
    const res = await classify(t, request(posts));
    expect(res.status).toBe(200);
    const body = ClassifyResponseSchema.parse(await res.json());
    expect(body.results).toEqual(posts.map((p) => ({ ref: p.ref, status: 'declined' })));
    expect(t.mock.bodies).toEqual([]);

    const row = await usageRow(t, res);
    expect(row).toMatchObject({
      outcome: 'refused-before-call',
      postsRequested: 2,
      postsOk: 0,
      calls: 0,
      failedCalls: 0,
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      costMicros: null,
    });
  });
});

describe('classify: failures', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_no_eval_passed_route_503', async () => {
    const t = await classifyApp();
    // The enabled route has not passed its eval.
    await seedPassingRoute(t.deps.db.db, { evalPassedAt: null });

    const res = await classify(t, request([await post('A', 'AI agents')]));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'not-available', message: describeError('not-available', INSTANCE) });
    expect(t.mock.bodies).toEqual([]);

    const row = await usageRow(t, res);
    expect(row).toMatchObject({
      routeId: null,
      model: 'mock-model',
      outcome: 'refused-before-call',
      postsRequested: 1,
      postsOk: 0,
      calls: 0,
      uncachedInput: 0,
      output: 0,
    });
  });

  it('test_provider_500_is_overloaded_and_metered', async () => {
    const t = await classifyApp();
    t.mock.failNext(500, '{"error":{"message":"upstream failed"}}');

    const res = await classify(t, request([await post('A', 'AI agents'), await post('B', 'Coffee')]));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'overloaded', message: describeError('overloaded', INSTANCE) });
    expect(t.mock.bodies).toHaveLength(1);

    const row = await usageRow(t, res);
    expect(row).toMatchObject({ outcome: 'failed', calls: 1, failedCalls: 1, postsRequested: 2, postsOk: 0 });
    expect([0, null]).toContain(row.chargeableCostMicros);
  });

  it('test_provider_auth_is_not_available', async () => {
    const t = await classifyApp();
    t.mock.failNext(401, '{"error":{"message":"Incorrect API key provided"}}');

    const res = await classify(t, request([await post('A', 'AI agents')]));
    expect(res.status).toBe(503);
    // The server's key is the operator's to fix: never "your key".
    expect(await res.json()).toEqual({ code: 'not-available', message: describeError('not-available', INSTANCE) });
    const logged = t.events().filter((e) => e.event === 'classify.provider_error');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ provider_code: 'auth' });

    // Advice meant for a person's own key or local server is never passed on.
    for (const code of ['auth', 'origin-blocked', 'no-key', 'quota', 'host-permission'] as const) {
      expect(wireCodeFor(code)).toBe('not-available');
    }
    expect(wireCodeFor('rate-limit')).toBe('overloaded');
    expect(wireCodeFor('timeout')).toBe('timeout');
    expect(wireCodeFor('refusal')).toBe('refusal');
  });

  it('test_refusal_declines_only_that_post', async () => {
    const t = await classifyApp({
      ai: fakeAi(async (req) => {
        if (req.user.includes('REFUSE')) throw new AIError('refusal', 'The model declined.');
        return answer(req);
      }),
    });
    const posts = [await post('A', 'AI agents'), await post('B', 'Please REFUSE this one'), await post('C', 'Coffee')];

    const res = await classify(t, request(posts));
    expect(res.status).toBe(200);
    const { results } = ClassifyResponseSchema.parse(await res.json());
    expect(results.map((r) => [r.ref, r.status])).toEqual([
      [posts[0]?.ref, 'ok'],
      [posts[1]?.ref, 'declined'],
      [posts[2]?.ref, 'ok'],
    ]);
    expect(await usageRow(t, res)).toMatchObject({ outcome: 'partial', postsRequested: 3, postsOk: 2 });
  });

  it('test_provider_echo_never_leaks', async () => {
    const t = await classifyApp();
    const text = 'ECHO-MARKER-91c4 our roadmap for AI';
    const body = request([await post('A', text)]);

    t.mock.failNext(500, `echo: ${text}`);
    const single = await classify(t, body);
    t.mock.failNext(502, `<html>\nupstream error\n${text}\n</html>`);
    const multi = await classify(t, body);

    for (const res of [single, multi]) {
      expect(res.status).toBe(503);
      const answer = await res.text();
      expect(answer).not.toContain('ECHO-MARKER');
      expect(answer).not.toContain('upstream error');
    }
    // The provider did see the text, so the marker had every chance to leak.
    expect(t.mock.bodies.every((b) => b.includes('ECHO-MARKER'))).toBe(true);
    expect(t.lines.join('')).not.toContain('ECHO-MARKER');
    expect(t.lines.join('')).not.toContain('upstream error');
  });

  it('test_server_deadline_under_client_timeout', async () => {
    const { provider, seen } = recordingBilling();
    const waiting = fakeAi(
      (req) =>
        new Promise<StructuredResult>((_, reject) => {
          req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true });
        }),
    );
    const t = await classifyApp({ classifyDeadlineMs: 200, ai: waiting, billing: provider });

    const started = performance.now();
    const res = await classify(t, request([await post('A', 'AI agents'), await post('B', 'Coffee')]));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ code: 'timeout', message: describeError('timeout', INSTANCE) });
    expect(await usageRow(t, res)).toMatchObject({ outcome: 'failed', postsOk: 0, calls: 1, failedCalls: 1 });
    expect(seen.released).toHaveLength(1);
    expect(seen.settled).toEqual([]);
  });
});

describe('classify: billing seam', { timeout: PGLITE_TIMEOUT }, () => {
  /** An AI whose call i answers the first `answer` posts it is sent (all when undefined), or throws `fail`. */
  function scriptedAi(script: Array<{ answer?: number } | AIError>) {
    let i = 0;
    return fakeAi(async (req) => {
      const step = script[i++];
      if (!step) throw new Error('no more answers');
      if (step instanceof AIError) throw step;
      const full = answer(req);
      const { results } = JSON.parse(full.text) as { results: unknown[] };
      const kept = results.slice(0, step.answer ?? results.length);
      return { ...full, text: JSON.stringify({ results: kept }), usage: { ...ZERO_USAGE, uncachedInput: 100 * (i + 1) } };
    });
  }

  it('test_failed_retry_keeps_settled_posts', async () => {
    // Call 1 skips C; the retry of C is overloaded. A and B are kept, settled and charged for call 1 only.
    const one = recordingBilling();
    const t = await classifyApp({ ai: scriptedAi([{ answer: 2 }, new AIError('overloaded', 'Busy.')]), billing: one.provider });
    const posts = [await post('A', 'AI agents'), await post('B', 'Coffee'), await post('C', 'Hiring')];
    const res = await classify(t, request(posts));
    expect(res.status).toBe(200);
    const { results } = ClassifyResponseSchema.parse(await res.json());
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'error']);
    expect(one.seen.settled).toMatchObject([{ posts: 2, chargeableUsage: { ...ZERO_USAGE, uncachedInput: 200 } }]);
    expect(await usageRow(t, res)).toMatchObject({ postsOk: 2, calls: 2, failedCalls: 1 });

    // Inside a refusal split: the call that answered C but skipped D is still kept when D's retry is rate-limited.
    const two = recordingBilling();
    const t2 = await classifyApp({
      ai: scriptedAi([new AIError('refusal', 'Declined.'), {}, { answer: 1 }, new AIError('rate-limit', 'Slow down.')]),
      billing: two.provider,
    });
    const four = [...posts, await post('D', 'Travel')];
    const res2 = await classify(t2, request(four));
    expect(res2.status).toBe(200);
    const body2 = ClassifyResponseSchema.parse(await res2.json());
    expect(body2.results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'error']);
    expect(two.seen.settled).toMatchObject([{ posts: 3, chargeableUsage: { ...ZERO_USAGE, uncachedInput: 300 + 400 } }]);
    expect(await usageRow(t2, res2)).toMatchObject({ postsOk: 3, calls: 4, failedCalls: 2 });
  });

  it('test_billing_refusal_402', async () => {
    const { provider, seen } = recordingBilling({
      decision: { kind: 'refuse', code: 'insufficient-credits', message: 'No credits left.' },
    });
    const t = await classifyApp({ billing: provider });

    const res = await classify(t, request([await post('A', 'AI agents')]));
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      code: 'insufficient-credits',
      message: describeError('insufficient-credits', INSTANCE),
    });
    expect(seen.checks).toBe(1);
    expect(t.mock.bodies).toEqual([]);
    expect(await usageRow(t, res)).toMatchObject({ outcome: 'refused-before-call', calls: 0, uncachedInput: 0 });
  });

  it('test_billing_settle_and_release', async () => {
    // Settled: the response carries what the provider charged, for the usage of the calls that answered.
    const settling = recordingBilling();
    const t = await classifyApp({ billing: settling.provider });
    const posts = [await post('A', 'AI agents'), await post('B', 'Coffee')];
    const ok = await classify(t, request(posts));
    expect(ok.status).toBe(200);
    const body = ClassifyResponseSchema.parse(await ok.json());
    expect(body.billing).toEqual({ chargedMicros: 30, balanceMicros: 970 });
    const okUsage: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 1000, output: 100 };
    expect(settling.seen.settled).toEqual([
      {
        userId: expect.any(String),
        requestId: ok.headers.get('x-request-id'),
        task: 'classify',
        model: 'mock-model',
        chargeableUsage: okUsage,
        costMicros: null,
        posts: 2,
      },
    ]);
    expect(settling.seen.released).toEqual([]);

    // The call failed: released, never settled.
    t.mock.failNext(500, 'busy');
    expect((await classify(t, request(posts))).status).toBe(503);
    expect(settling.seen.settled).toHaveLength(1);
    expect(settling.seen.released).toHaveLength(1);

    // `settle` throws: the request fails, and the usage row still holds the tokens the call spent.
    const throwing = recordingBilling({
      settle: async () => {
        throw new Error('ledger down');
      },
    });
    const t2 = await classifyApp({ billing: throwing.provider });
    const failed = await classify(t2, request(posts));
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ code: 'unknown', message: 'Something went wrong on the server.' });
    expect(await usageRow(t2, failed)).toMatchObject({ outcome: 'ok', uncachedInput: 1000, output: 100 });

    // `release` rejects after a failed call: the answer keeps the call's error, and the failure is logged once.
    const rejecting = recordingBilling({
      release: async () => {
        throw new Error('hold store down');
      },
    });
    const t3 = await classifyApp({ billing: rejecting.provider });
    t3.mock.failNext(500, 'busy');
    const busy = await classify(t3, request(posts));
    expect(busy.status).toBe(503);
    expect(((await busy.json()) as { code: string }).code).toBe('overloaded');
    const releaseFailed = t3.events().filter((e) => e.event === 'billing.release.failed');
    expect(releaseFailed).toHaveLength(1);
    expect(releaseFailed[0]?.rid).toBe(busy.headers.get('x-request-id'));
  });
});

describe('classify: graceful stop', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_stop_waits_for_a_slow_classify_to_write_its_usage_row', async () => {
    // The model answers after the grace period has closed the connection, and ignores the abort that closing sends.
    const SLOW_MS = 800;
    const ai = fakeAi(async (req) => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      return answer(req);
    });
    const stopping = new AbortController();
    const inFlight = inFlightRequests();
    const t = await classifyApp({ ai, stopping: stopping.signal, inFlight });
    const server = await listen(t.app, '127.0.0.1', 0);
    cleanup.push(async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const answered = fetch(`${url}${CLASSIFY_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: DEV_EXTENSION_ORIGIN,
        Authorization: `Bearer ${t.tokens.access_token}`,
      },
      body: JSON.stringify(request([await post('A', 'AI agents'), await post('B', 'Coffee')])),
    }).then(
      (res) => res.status,
      () => 'connection closed',
    );
    await expect.poll(() => inFlight.count).toBe(1);

    const started = performance.now();
    await stopServing(server, { stopping, inFlight, log: t.deps.log, graceMs: 50 });
    expect(await answered).toBe('connection closed');
    expect(performance.now() - started).toBeGreaterThan(SLOW_MS / 2);
    // Written before the stop returned, so before the database would close.
    expect(await usageRows(t)).toMatchObject([{ outcome: 'ok', postsOk: 2, calls: 1 }]);
    expect(t.events().filter((e) => e.event === 'usage.record_failed')).toEqual([]);
  });
});

describe('classify: logs', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_classify_logs_hold_no_content', async () => {
    const t = await classifyApp();
    const texts = ['TEXT-MARKER-1 about AI agents', 'TEXT-MARKER-2 a quiet weekend', 'TEXT-MARKER-3 friends only'];
    const posts = [
      await post('A', texts[0]!),
      await post('B', texts[1]!, { link: { domain: 'example.org', title: 'TEXT-MARKER-4 link title' } }),
      await post('C', texts[2]!, { platform: 'facebook', audience: 'friends' }),
    ];

    expect((await classify(t, request(posts))).status).toBe(200);
    t.mock.failNext(500, `echo: ${texts[0]}`);
    expect((await classify(t, request(posts))).status).toBe(503);
    t.mock.failNext(400, `{"error":"bad input ${texts[1]}"}`);
    await classify(t, request(posts));
    expect((await classify(t, request(posts), 'not-a-token')).status).toBe(401);

    // The marker travelled to the provider, and the profile with it.
    expect(t.mock.bodies.some((b) => b.includes('TEXT-MARKER-1') && b.includes(ABOUT_MARKER))).toBe(true);
    const done = t.events().filter((e) => e.event === 'classify.done');
    expect(done.length).toBeGreaterThanOrEqual(3);
    expect(done[0]).toMatchObject({ posts_requested: 3, posts_ok: 2, excluded: 1, model: 'mock-model' });
    expect(Object.keys(done[0] ?? {}).sort()).toEqual(
      ['event', 'excluded', 'level', 'model', 'ms', 'outcome', 'posts_ok', 'posts_requested', 'rid', 't'].sort(),
    );

    const logged = t.lines.join('');
    expect(logged).not.toContain('TEXT-MARKER');
    expect(logged).not.toContain(ABOUT_MARKER);
    expect(logged).not.toContain('en-CA');
    for (const p of posts) expect(logged).not.toContain(p.ref);
  });
});
