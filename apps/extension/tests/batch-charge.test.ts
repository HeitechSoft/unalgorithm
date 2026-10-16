/**
 * What each batch of posts cost (CL6-03, R35): a billing server's `chargedMicros` comes back from `classifyViaServer`,
 * is attached to the posts it classified and is recorded in the device's usage ledger. The network is a stubbed fetch
 * and the device token a stubbed `getAccessToken`; extension storage is the WXT fake browser and the classification
 * cache fake-indexeddb.
 */
import { type AISourceConfig, buildInterestProfile, dayUsage, defaultDevice, defaultSettings, sourceId } from '@unalgorithm/core';
import {
  CLASSIFY_PATH,
  type Classification,
  type ClassifyRequest,
  type ClassifyResponse,
  type PostForAI,
  type PostKey,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { classifyItems } from '../src/background/ai.ts';
import { clearCache, setSecret } from '../src/background/idb.ts';
import { classifyViaServer } from '../src/background/server-source.ts';
import type { ClassifyItem, ClassifyItemResult } from '../src/lib/messages.ts';
import { deviceItem, usageItem } from '../src/lib/storage.ts';

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: auth.getAccessToken,
}));

const ORIGIN = 'https://ai.example.org';
const SERVER = { kind: 'server', baseUrl: `${ORIGIN}/` } as const;
const ANTHROPIC = { kind: 'anthropic', model: null } as const;
/** What the fake server charges per post it classified. */
const PER_POST = 146;

const CLASSIFICATION: Classification = {
  relevance: 72,
  noise: [],
  topics: ['automation'],
  reason: 'About moving paperwork online.',
  isNews: false,
  hasCheckableClaims: false,
};

const input = (text: string): Omit<PostForAI, 'ref'> => ({
  platform: 'linkedin',
  text,
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
});
const item = (n: number): ClassifyItem => ({ key: `li:urn:li:activity:${n}` as PostKey, input: input(`Post number ${n}`) });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Every post `ok`; `billing` from `bill` (none when it returns undefined). */
function answer(req: ClassifyRequest, bill: (posts: number) => ClassifyResponse['billing']): ClassifyResponse {
  const billing = bill(req.posts.length);
  return {
    v: 1,
    results: req.posts.map((p) => ({ ref: p.ref, status: 'ok', classification: CLASSIFICATION })),
    source: { kind: 'server', model: 'mock-model', promptVersion: 1 },
    ...(billing ? { billing } : {}),
  };
}

/** A billing server (classify only) and Anthropic's messages API, answering every post. */
const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
  const u = new URL(String(url instanceof Request ? url.url : url));
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  if (u.origin === ORIGIN && u.pathname === CLASSIFY_PATH)
    return json(answer(body as unknown as ClassifyRequest, (n) => ({ chargedMicros: n * PER_POST, balanceMicros: 1_000_000 })));
  if (u.hostname === 'api.anthropic.com') {
    const user = JSON.stringify(body.messages);
    const refs = [...new Set(user.match(/\bp\d+\b/g) ?? [])];
    const results = refs.map((id) => ({ id, ...CLASSIFICATION }));
    return json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: JSON.stringify({ results }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2400, output_tokens: 360, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }
  return new Response('Not found', { status: 404 });
});

const OPTS = { profile: buildInterestProfile(defaultSettings()), profileHash: 'abc123', locale: 'en-CA' };
const posts = [1, 2, 3].map((n) => ({ ...input(`Post ${n}`), ref: `p${n}` }));
const charges = (results: ClassifyItemResult[]) => results.map((r) => (r.status === 'ok' ? r.charge : r.status));

async function setSource(cfg: AISourceConfig) {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: cfg });
}

beforeEach(async () => {
  fakeBrowser.reset();
  await clearCache();
  auth.getAccessToken.mockReset();
  auth.getAccessToken.mockResolvedValue('access-1');
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('server source', () => {
  it('test_server_outcome_carries_charge', async () => {
    const run = (reply: (req: ClassifyRequest) => Response) =>
      classifyViaServer(SERVER, posts, OPTS, {
        fetch: (async (_url: string | URL, init: RequestInit = {}) =>
          reply(JSON.parse(String(init.body)) as ClassifyRequest)) as typeof fetch,
        getAccessToken: async () => 'access-1',
        account: null,
      });

    const billed = await run((req) => json(answer(req, () => ({ chargedMicros: 1_752, balanceMicros: 998_248 }))));
    expect(billed.chargedMicros).toBe(1_752);
    expect(billed.failedCalls).toBe(0);

    const free = await run((req) => json(answer(req, () => undefined)));
    expect(free).not.toHaveProperty('chargedMicros');
    expect(free.failedCalls).toBe(0);

    const negative = await run((req) => json(answer(req, () => ({ chargedMicros: -5, balanceMicros: 998_248 }))));
    expect(negative).not.toHaveProperty('chargedMicros');
    expect([...negative.byRef.values()].every((r) => r.ok)).toBe(true);

    const failed = await run(() => json({ code: 'unknown', message: 'Something went wrong.' }, 500));
    expect(failed).not.toHaveProperty('chargedMicros');
    expect(failed.failedCalls).toBe(1);
  });
});

describe('background', () => {
  it('test_classify_items_attaches_batch_charge', async () => {
    await setSource(SERVER);
    const res = await classifyItems([item(1), item(2), item(3)]);

    expect(res.results).toHaveLength(3);
    for (const r of res.results)
      expect(r).toMatchObject({ status: 'ok', cached: false, charge: { batchPosts: 3, chargedMicros: 438 } });
    const day = dayUsage(await usageItem.getValue());
    expect(day.chargedMicros).toBe(438);
    expect(day.batches).toHaveLength(1);
    expect(day.batches?.[0]).toMatchObject({ posts: 3, chargedMicros: 438 });
  });

  it('test_cached_and_own_key_results_have_no_charge', async () => {
    // A cache hit: the post was charged when it was classified, not again.
    await setSource(SERVER);
    await classifyItems([item(1)]);
    const again = await classifyItems([item(1), item(2)]);
    const cached = again.results.find((r) => r.key === item(1).key);
    const fresh = again.results.find((r) => r.key === item(2).key);
    expect(cached).toMatchObject({ status: 'ok', cached: true });
    expect(cached).not.toHaveProperty('charge');
    expect(fresh).toMatchObject({ status: 'ok', cached: false, charge: { batchPosts: 1, chargedMicros: PER_POST } });

    // Two groups (the server source's batch is 8): each group's posts carry their own batch's charge.
    fakeBrowser.reset();
    await clearCache();
    await setSource(SERVER);
    const ten = Array.from({ length: 10 }, (_, i) => item(100 + i));
    const split = await classifyItems(ten);
    const byKey = new Map(split.results.map((r) => [r.key, r]));
    expect(charges(ten.slice(0, 8).map((i) => byKey.get(i.key) as ClassifyItemResult))).toStrictEqual(
      Array(8).fill({ batchPosts: 8, chargedMicros: 8 * PER_POST }),
    );
    expect(charges(ten.slice(8).map((i) => byKey.get(i.key) as ClassifyItemResult))).toStrictEqual(
      Array(2).fill({ batchPosts: 2, chargedMicros: 2 * PER_POST }),
    );
    const day = dayUsage(await usageItem.getValue());
    expect(day.chargedMicros).toBe(10 * PER_POST);
    expect(day.batches?.map((b) => [b.posts, b.chargedMicros]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toStrictEqual([
      [2, 2 * PER_POST],
      [8, 8 * PER_POST],
    ]);

    // An own key: no charge, no batch.
    fakeBrowser.reset();
    await clearCache();
    vi.spyOn(fakeBrowser.permissions, 'contains').mockImplementation((async () => true) as never);
    await setSecret(sourceId(ANTHROPIC), 'sk-ant-test');
    await setSource(ANTHROPIC);
    const own = await classifyItems([item(1), item(2)]);
    expect(own.results.map((r) => r.status)).toStrictEqual(['ok', 'ok']);
    for (const r of own.results) expect(r).not.toHaveProperty('charge');
    const ownDay = dayUsage(await usageItem.getValue());
    expect(ownDay.posts).toBe(2);
    expect(ownDay).not.toHaveProperty('batches');
    expect(ownDay).not.toHaveProperty('chargedMicros');
  });
});
