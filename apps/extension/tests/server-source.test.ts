/**
 * The `server` AI source over HTTP (R25, R26, R23). The network is a stubbed fetch and the device token a stubbed
 * `getAccessToken`; extension storage is the WXT fake browser and the classification cache fake-indexeddb, so
 * `classifyItems`, `aiStatus` and `testSource` run as they do in the background.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AIError } from '@unalgorithm/ai';
import { type AISourceConfig, buildInterestProfile, defaultDevice, defaultSettings, SOURCE_LIMITS } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  CLASSIFY_PATH,
  type Classification,
  type ClassifyRequest,
  ClassifyRequestSchema,
  type ClassifyResponse,
  type PostClassificationResult,
  type PostForAI,
  PostForAISchema,
  type PostKey,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { aiStatus, classifyItems, testSource } from '../src/background/ai.ts';
import { recordVote } from '../src/background/feedback.ts';
import { clearCache } from '../src/background/idb.ts';
import { type getAccessToken, type ServerAccount, serverAccountItem } from '../src/background/server-auth.ts';
import { classifyViaServer, MAX_CLASSIFY_BODY_BYTES } from '../src/background/server-source.ts';
import type { ClassifyItem } from '../src/lib/messages.ts';
import { PINNED_CLOUD_ORIGIN } from '../src/lib/server-label.ts';
import { deviceItem, learnedItem, usageItem } from '../src/lib/storage.ts';

// `classifyItems` and `testSource` take no dependencies: the device token comes from this stub.
const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));

const ORIGIN = 'https://ai.example.org';
const CFG = { kind: 'server', baseUrl: `${ORIGIN}/` } as const;
const NOW = Date.UTC(2026, 9, 12, 9);

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

const account = (over: Partial<ServerAccount> = {}): ServerAccount => ({
  origin: ORIGIN,
  email: 'ada@example.org',
  deviceId: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
  signedInAt: NOW,
  info: INFO,
  needsSignIn: false,
  ...over,
});

const CLASSIFICATION: Classification = {
  relevance: 72,
  noise: [],
  topics: ['automation'],
  reason: 'About moving paperwork online.',
  isNews: false,
  hasCheckableClaims: false,
};

const input = (text: string, over: Partial<PostForAI> = {}): Omit<PostForAI, 'ref'> => ({
  platform: 'linkedin',
  text,
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
  ...over,
});
const item = (key: PostKey, text: string, over: Partial<PostForAI> = {}): ClassifyItem => ({ key, input: input(text, over) });
const withRef = (ref: string, text: string, over: Partial<PostForAI> = {}): PostForAI => ({ ...input(text, over), ref });

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The server's answer to `req`: every post `ok` unless `statusOf` says otherwise. */
function answer(
  req: ClassifyRequest,
  statusOf: (i: number) => PostClassificationResult['status'] = () => 'ok',
): ClassifyResponse {
  return {
    v: 1,
    results: req.posts.map((p, i): PostClassificationResult => {
      const status = statusOf(i);
      if (status === 'ok') return { ref: p.ref, status, classification: CLASSIFICATION };
      if (status === 'declined') return { ref: p.ref, status };
      return { ref: p.ref, status, message: 'Something went wrong with the AI request.' };
    }),
    source: { kind: 'server', model: 'mock-model', promptVersion: 1 },
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A server: discovery answers INFO, and `classify` answers the n-th classify request. */
function fakeServer(classify: (req: ClassifyRequest, n: number) => Response | Promise<Response> = (req) => json(answer(req))) {
  const calls: Call[] = [];
  let n = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { pathname } = new URL(String(url));
    if (pathname === SERVER_INFO_PATH) return json(INFO);
    if (pathname === CLASSIFY_PATH) return classify(JSON.parse(String(init.body)) as ClassifyRequest, ++n);
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const requests = () => calls.filter((c) => new URL(c.url).pathname === CLASSIFY_PATH);
  const bodies = () => requests().map((c) => String(c.init.body));
  return { fetch, calls, requests, bodies };
}

/** Hands out `access-1`, then `access-2` once a refresh is forced. */
function tokens() {
  let issued = 1;
  return vi.fn(async (_origin: string, opts: { forceRefresh?: boolean } = {}) => {
    if (opts.forceRefresh) issued++;
    return `access-${issued}`;
  });
}

const OPTS = (() => {
  const profile = buildInterestProfile(defaultSettings());
  return { profile, profileHash: 'abc123', locale: 'en-CA' };
})();

const bearer = (c: Call | undefined) => new Headers(c?.init.headers).get('authorization');
const codes = (outcome: Awaited<ReturnType<typeof classifyViaServer>>) =>
  [...outcome.byRef.values()].map((r) => (r.ok ? 'ok' : r.error.code));

async function setSource(cfg: AISourceConfig) {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: cfg });
}

beforeEach(async () => {
  fakeBrowser.reset();
  await clearCache();
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockImplementation(tokens());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('classifyViaServer', () => {
  it('test_server_request_shape', async () => {
    const s = fakeServer();
    const token = tokens();
    const posts = [withRef('p1', 'First post'), withRef('p2', 'Second post')];
    await classifyViaServer(CFG, posts, OPTS, { fetch: s.fetch, getAccessToken: token as typeof getAccessToken });

    expect(token).toHaveBeenCalledOnce();
    expect(token.mock.calls[0]?.[0]).toBe(ORIGIN);
    expect(s.calls).toHaveLength(1);
    const [call] = s.calls;
    expect(call?.url).toBe(`${ORIGIN}${CLASSIFY_PATH}`);
    expect(call?.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(bearer(call)).toBe('Bearer access-1');
    expect(new Headers(call?.init.headers).get('content-type')).toBe('application/json');

    const body = ClassifyRequestSchema.parse(JSON.parse(String(call?.init.body)));
    expect(body).toStrictEqual({ v: 1, posts, profile: OPTS.profile, profileHash: 'abc123', locale: 'en-CA' });
  });

  it('test_server_result_mapping', async () => {
    const s = fakeServer((req) => json(answer(req, (i) => (['ok', 'declined', 'error'] as const)[i] ?? 'ok')));
    const posts = [withRef('p1', 'A'), withRef('p2', 'B'), withRef('p3', 'C')];
    const outcome = await classifyViaServer(CFG, posts, OPTS, { fetch: s.fetch, getAccessToken: tokens() });

    expect(outcome.model).toBe('mock-model');
    expect(outcome.byRef.get(posts[0]?.ref ?? '')).toStrictEqual({ ok: true, classification: CLASSIFICATION });
    expect(outcome.byRef.get(posts[1]?.ref ?? '')).toMatchObject({ ok: false, error: { code: 'refusal' } });
    expect(outcome.byRef.get(posts[2]?.ref ?? '')).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(outcome).toMatchObject({ calls: 1, failedCalls: 0 });

    // A post the server left out of its answer gets an error, not silence.
    const partial = fakeServer((req) => json({ ...answer(req), results: answer(req).results.slice(0, 1) }));
    const out = await classifyViaServer(CFG, posts.slice(0, 2), OPTS, { fetch: partial.fetch, getAccessToken: tokens() });
    expect(codes(out)).toStrictEqual(['ok', 'unknown']);

    // A 200 that isn't a classify answer fails every post.
    const garbled = fakeServer(() => json({ hello: 'world' }));
    const bad = await classifyViaServer(CFG, posts, OPTS, { fetch: garbled.fetch, getAccessToken: tokens() });
    expect(codes(bad)).toStrictEqual(['unknown', 'unknown', 'unknown']);
    expect(bad).toMatchObject({ calls: 1, failedCalls: 1 });
  });

  it('test_401_refreshes_once_then_succeeds', async () => {
    const s = fakeServer((req, n) =>
      n === 1 ? json({ code: 'auth-required', message: 'Sign in to Example AI again.' }, 401) : json(answer(req)),
    );
    const token = tokens();
    const posts = [withRef('p1', 'A'), withRef('p2', 'B')];
    const outcome = await classifyViaServer(CFG, posts, OPTS, { fetch: s.fetch, getAccessToken: token });

    expect(token.mock.calls).toStrictEqual([[ORIGIN], [ORIGIN, { forceRefresh: true }]]);
    expect(s.requests().map(bearer)).toStrictEqual(['Bearer access-1', 'Bearer access-2']);
    expect(s.bodies()[0]).toBe(s.bodies()[1]);
    expect(codes(outcome)).toStrictEqual(['ok', 'ok']);
    expect(outcome.failedCalls).toBe(0);
  });

  it('test_double_401_is_auth_required', async () => {
    await serverAccountItem.setValue(account());
    const s = fakeServer(() => json({ code: 'auth-required', message: 'Sign in to Example AI again.' }, 401));
    const token = tokens();
    const posts = [withRef('p1', 'A'), withRef('p2', 'B')];
    const outcome = await classifyViaServer(CFG, posts, OPTS, { fetch: s.fetch, getAccessToken: token });

    expect(codes(outcome)).toStrictEqual(['auth-required', 'auth-required']);
    expect(outcome).toMatchObject({ calls: 1, failedCalls: 1 });
    expect(s.requests()).toHaveLength(2);
    expect(token).toHaveBeenCalledTimes(2);
    expect(await serverAccountItem.getValue()).toStrictEqual(account({ needsSignIn: true }));

    // A refresh the server refuses: no second request.
    const once = fakeServer(() => json({ code: 'auth-required', message: 'Sign in to Example AI again.' }, 401));
    const refused = vi.fn(async (_origin: string, opts: { forceRefresh?: boolean } = {}) => {
      if (opts.forceRefresh) throw new AIError('auth-required', 'Sign in to ai.example.org again.');
      return 'access-1';
    });
    const out = await classifyViaServer(CFG, posts, OPTS, { fetch: once.fetch, getAccessToken: refused });
    expect(codes(out)).toStrictEqual(['auth-required', 'auth-required']);
    expect(once.requests()).toHaveLength(1);

    // Not signed in at all: nothing is sent.
    const none = fakeServer();
    const signedOut = vi.fn(async () => {
      throw new AIError('auth-required', 'Sign in to ai.example.org again.');
    });
    const nothing = await classifyViaServer(CFG, posts, OPTS, { fetch: none.fetch, getAccessToken: signedOut });
    expect(codes(nothing)).toStrictEqual(['auth-required', 'auth-required']);
    expect(none.calls).toHaveLength(0);
  });

  it('test_error_status_mapping', async () => {
    const posts = [withRef('p1', 'A'), withRef('p2', 'B')];
    const run = (fetch: typeof globalThis.fetch) => classifyViaServer(CFG, posts, OPTS, { fetch, getAccessToken: tokens() });

    const cap = await run(fakeServer(() => json({ code: 'cap-reached', message: 'Daily limit.' }, 429)).fetch);
    expect(codes(cap)).toStrictEqual(['cap-reached', 'cap-reached']);
    expect(cap).toMatchObject({ calls: 1, failedCalls: 1 });

    const rate = await run(
      fakeServer(() => json({ code: 'rate-limit', message: 'Slow down.' }, 429, { 'Retry-After': '20' })).fetch,
    );
    expect(codes(rate)).toStrictEqual(['rate-limit', 'rate-limit']);
    for (const r of rate.byRef.values()) expect(r.ok ? undefined : r.error.retryAfterMs).toBe(20_000);

    const busy = await run(
      fakeServer(() => new Response('<html>502 Bad Gateway</html>', { status: 503, headers: { 'content-type': 'text/html' } }))
        .fetch,
    );
    expect(codes(busy)).toStrictEqual(['overloaded', 'overloaded']);

    const down = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch;
    const offline = await run(down);
    expect(codes(offline)).toStrictEqual(['network', 'network']);
    expect(offline).toMatchObject({ calls: 1, failedCalls: 1 });
  });

  it('test_server_timeout_is_90s', async () => {
    expect(SOURCE_LIMITS.server.timeoutMs).toBe(90_000);
    const timers: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController();
      timers.push(c);
      return c.signal;
    });
    // The server never answers; the extension's own deadline ends the request.
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          for (const c of timers) c.abort(new DOMException('The operation timed out.', 'TimeoutError'));
        }),
    ) as unknown as typeof globalThis.fetch;
    const posts = [withRef('p1', 'A'), withRef('p2', 'B')];
    const outcome = await classifyViaServer(CFG, posts, OPTS, { fetch: hang, getAccessToken: tokens() });

    expect(timeout).toHaveBeenCalledWith(90_000);
    expect(codes(outcome)).toStrictEqual(['timeout', 'timeout']);
    expect(outcome).toMatchObject({ calls: 1, failedCalls: 1 });
    expect(outcome.usage).toStrictEqual(ZERO_USAGE);
    expect(outcome.okUsage).toStrictEqual(ZERO_USAGE);

    // The server meters; the extension never sees tokens, even when every post succeeds.
    timeout.mockRestore();
    const ok = await classifyViaServer(CFG, posts, OPTS, { fetch: fakeServer().fetch, getAccessToken: tokens() });
    expect(ok).toMatchObject({ calls: 1, failedCalls: 0, usage: ZERO_USAGE, okUsage: ZERO_USAGE });
  });

  it('test_oversized_or_unbounded_answer_is_refused', async () => {
    const posts = [withRef('p1', 'A'), withRef('p2', 'B')];
    const send = async (reply: (req: ClassifyRequest) => Response) =>
      classifyViaServer(CFG, posts, OPTS, { fetch: fakeServer(reply).fetch, getAccessToken: tokens() });

    // Valid answers padded past the cap are dropped unread, so a server cannot fill memory or storage with one.
    const padded = await send((req) => json({ ...answer(req), padding: 'x'.repeat(MAX_CLASSIFY_BODY_BYTES) }));
    expect(codes(padded)).toStrictEqual(['unknown', 'unknown']);
    expect(padded).toMatchObject({ model: 'server', failedCalls: 1 });
    // An error answer past the cap is read as its status alone.
    const failed = await send(() => json({ code: 'rate-limit', padding: 'x'.repeat(MAX_CLASSIFY_BODY_BYTES) }, 503));
    expect(codes(failed)).toStrictEqual(['overloaded', 'overloaded']);
    // Under the cap, the schema bounds each field: a 1 MiB model name is no answer.
    const named = await send((req) =>
      json({ ...answer(req), source: { kind: 'server', model: 'm'.repeat(1 << 20), promptVersion: 1 } }),
    );
    expect(codes(named)).toStrictEqual(['unknown', 'unknown']);
    expect(named.model).toBe('server');
  });
});

describe('classifyItems with a server source', () => {
  it('test_classify_items_sends_batch_local_refs', async () => {
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    const s = fakeServer((req) =>
      json({ ...answer(req), source: { kind: 'server', model: 'named-by-server', promptVersion: 1 } }),
    );
    vi.stubGlobal('fetch', s.fetch);
    // `fb:h:` keys hash the author's name with the text: a ref derived from the key would let a server test names.
    const items = [
      item('li:urn:li:activity:71', 'Moving forms online'),
      item('li:ck:secret-key-72', 'What to automate next'),
      item('fb:h:4a7c1f9e2b', 'Our community garden opens this Saturday', { platform: 'facebook', audience: 'public' }),
    ];
    const res = await classifyItems(items);

    expect(res.pause).toBeUndefined();
    expect(res.results).toStrictEqual(
      items.map((i) => ({ key: i.key, status: 'ok', classification: CLASSIFICATION, model: 'named-by-server', cached: false })),
    );
    expect(s.requests()).toHaveLength(1);
    const [body] = s.bodies();
    for (const i of items) expect(body).not.toContain(i.key);
    expect(body).not.toContain('activity:71');
    expect(body).not.toContain('secret-key-72');
    const sent = ClassifyRequestSchema.parse(JSON.parse(body ?? ''));
    // Refs say where a post sits in its batch and nothing else: the answer is mapped back here, as for any source.
    expect(sent.posts.map((p) => p.ref)).toStrictEqual(['p1', 'p2', 'p3']);
    expect(body).not.toContain('4a7c1f9e2b');
    expect(auth.getAccessToken).toHaveBeenCalledWith(ORIGIN);
    // The server's usage is recorded under one fixed name, whatever model the server names (it costs no tokens here).
    const ledger = await usageItem.getValue();
    expect(Object.values(ledger).flatMap((day) => Object.keys(day.byModel))).toStrictEqual(['server']);

    // The answers are cached like any other source's.
    const again = await classifyItems(items);
    expect(again.results.map((r) => r.status === 'ok' && r.cached)).toStrictEqual([true, true, true]);
    expect(s.requests()).toHaveLength(1);
  });

  it('test_facebook_non_public_stays_local', async () => {
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const res = await classifyItems([
      item('fb:1001', 'Only my friends can read this', { platform: 'facebook', audience: 'friends' }),
      item('fb:1002', 'Nobody said who can read this', { platform: 'facebook' }),
      item('fb:1003', 'Everyone can read this', { platform: 'facebook', audience: 'public' }),
    ]);

    expect(res.results).toContainEqual({ key: 'fb:1001', status: 'skipped', reason: 'not-public' });
    expect(res.results).toContainEqual({ key: 'fb:1002', status: 'skipped', reason: 'not-public' });
    expect(res.results).toContainEqual(expect.objectContaining({ key: 'fb:1003', status: 'ok' }));
    expect(res.results).toHaveLength(3);
    const all = s.bodies().join('\n');
    expect(all).toContain('Everyone can read this');
    expect(all).not.toContain('Only my friends');
    expect(all).not.toContain('Nobody said who');

    // A batch of only non-public posts sends nothing at all.
    const before = s.calls.length;
    const local = await classifyItems([item('fb:1004', 'Custom audience', { platform: 'facebook', audience: 'custom' })]);
    expect(local.results).toStrictEqual([{ key: 'fb:1004', status: 'skipped', reason: 'not-public' }]);
    expect(s.calls).toHaveLength(before);
  });

  it('test_rated_non_public_summary_stays_local', async () => {
    // Rated while a source on this computer classified Facebook posts that aren't public too.
    await recordVote('li:urn:li:activity:81', 'more', ['automation'], 'About automating paperwork.', true);
    await recordVote('fb:2001', 'more', ['family'], 'A friends-only post about a family holiday.', false);
    // A rating recorded before ratings said whether a server may receive their post.
    const learned = await learnedItem.getValue();
    await learnedItem.setValue({
      ...learned,
      events: [...learned.events, { id: 'old', at: 1, verdict: 'less', topics: [], summary: 'An older rating.' }],
    });
    expect((await learnedItem.getValue()).events.map((e) => e.shareable)).toStrictEqual([undefined, true, undefined]);

    await setSource({ kind: 'server', baseUrl: ORIGIN });
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const res = await classifyItems([item('li:urn:li:activity:82', 'A post')]);

    expect(res.results[0]).toMatchObject({ status: 'ok' });
    const [body] = s.bodies();
    expect(body).not.toContain('friends-only');
    expect(body).not.toContain('An older rating');
    expect(ClassifyRequestSchema.parse(JSON.parse(body ?? '')).profile.examples).toStrictEqual([
      { summary: 'About automating paperwork.', verdict: 'more' },
    ]);
  });

  it('test_extra_fields_stripped_before_sending', async () => {
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const leaky = { key: 'li:urn:li:activity:9', input: { ...input('A post'), authorName: 'Ada Lovelace' } } as ClassifyItem;
    const res = await classifyItems([leaky]);

    expect(res.results[0]).toMatchObject({ status: 'ok' });
    const [body] = s.bodies();
    expect(body).not.toContain('authorName');
    expect(body).not.toContain('Ada Lovelace');
    const [sent] = (JSON.parse(body ?? '') as ClassifyRequest).posts;
    expect(Object.keys(sent ?? {}).sort()).toStrictEqual(
      Object.keys(PostForAISchema.parse({ ...input('A post'), ref: 'x' })).sort(),
    );
  });

  it('test_auth_required_pause_message_names_server', async () => {
    for (const [baseUrl, message] of [
      [PINNED_CLOUD_ORIGIN, 'Sign in to UnAlgorithm Cloud again.'],
      ['https://ai.example.org', 'Sign in to ai.example.org again.'],
    ] as const) {
      await setSource({ kind: 'server', baseUrl });
      const s = fakeServer(() => json({ code: 'auth-required', message: 'Sign in to Someone Else again.' }, 401));
      vi.stubGlobal('fetch', s.fetch);
      const res = await classifyItems([item('li:urn:li:activity:5', 'A post'), item('li:urn:li:activity:6', 'Another')]);

      expect(res.pause, baseUrl).toStrictEqual({ code: 'auth-required', message });
      expect(res.results, baseUrl).toStrictEqual(
        ['li:urn:li:activity:5', 'li:urn:li:activity:6'].map((key) => ({
          key,
          status: 'failed',
          code: 'auth-required',
          message,
          retryable: false,
        })),
      );
      expect(s.requests(), baseUrl).toHaveLength(2);
    }
  });
});

describe('status and setup', () => {
  it('test_ai_status_server_label_and_attention', async () => {
    await setSource({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN });
    const attention = { state: 'needs-attention', message: 'Sign in to UnAlgorithm Cloud again.' };
    expect(await aiStatus()).toMatchObject({ configured: true, kind: 'server', label: 'UnAlgorithm Cloud', ...attention });

    await serverAccountItem.setValue(account({ origin: ORIGIN }));
    expect(await aiStatus(), 'another server').toMatchObject(attention);

    await serverAccountItem.setValue(account({ origin: PINNED_CLOUD_ORIGIN, needsSignIn: true }));
    expect(await aiStatus(), 'refused refresh').toMatchObject(attention);

    await serverAccountItem.setValue(account({ origin: PINNED_CLOUD_ORIGIN }));
    const ready = await aiStatus();
    expect(ready).toMatchObject({ label: 'UnAlgorithm Cloud', state: 'ready', capApplies: true });
    expect(ready).not.toHaveProperty('message');
    expect(ready).not.toHaveProperty('model');

    await setSource({ kind: 'server', baseUrl: `${ORIGIN}/` });
    await serverAccountItem.setValue(account());
    expect(await aiStatus()).toMatchObject({ label: 'ai.example.org', state: 'ready' });
    await serverAccountItem.setValue(null);
    expect(await aiStatus()).toMatchObject({
      label: 'ai.example.org',
      state: 'needs-attention',
      message: 'Sign in to ai.example.org again.',
    });
  });

  it('test_test_source_server_probe', async () => {
    const s = fakeServer();
    vi.stubGlobal('fetch', s.fetch);
    const res = await testSource({ kind: 'server', baseUrl: ORIGIN });

    expect(res).toMatchObject({ ok: true, mode: 'server', model: 'mock-model', models: [] });
    expect(s.calls.map((c) => new URL(c.url).pathname)).toStrictEqual([SERVER_INFO_PATH, CLASSIFY_PATH]);
    const [probe] = ClassifyRequestSchema.parse(JSON.parse(s.bodies()[0] ?? '')).posts;
    expect(probe?.ref).toBe('p1');

    // Not a server: discovery says so, and nothing is classified.
    const notServer = vi.fn(async () => new Response('Not found', { status: 404 })) as unknown as typeof globalThis.fetch;
    vi.stubGlobal('fetch', notServer);
    expect(await testSource({ kind: 'server', baseUrl: ORIGIN })).toStrictEqual({
      ok: false,
      error: { code: 'unsupported', message: "That address isn't an UnAlgorithm server." },
    });

    // Signed out: the extension's own words, naming the server.
    vi.stubGlobal('fetch', s.fetch);
    auth.getAccessToken.mockRejectedValue(new AIError('auth-required', 'Sign in to Someone Else again.'));
    expect(await testSource({ kind: 'server', baseUrl: ORIGIN })).toStrictEqual({
      ok: false,
      error: { code: 'auth-required', message: 'Sign in to ai.example.org again.' },
    });
  });

  it('test_stub_removed', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/background/ai.ts'), 'utf8');
    expect(source).not.toMatch(/coming soon/i);
  });
});
