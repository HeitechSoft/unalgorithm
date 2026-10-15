/**
 * Cache-only lookups while AI is paused (R27): the background answers what its classification cache knows and sends
 * nothing anywhere, also when a feed tab asks through the `classify` message. Extension storage is the WXT fake browser,
 * the cache fake-indexeddb and the network a spied fetch.
 */
import { defaultDevice, defaultSettings } from '@unalgorithm/core';
import type { Classification, ClassifyRequest, ClassifyResponse, PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { classifyItems } from '../src/background/ai.ts';
import { clearCache } from '../src/background/idb.ts';
import { handlers } from '../src/entrypoints/background.ts';
import type { BgRequest, ClassifyItem } from '../src/lib/messages.ts';
import { deviceItem, settingsItem, usageItem } from '../src/lib/storage.ts';

// The device token, and the server source itself as a spy: for a server source it is the AI client.
const spies = vi.hoisted(() => ({ getAccessToken: vi.fn(), classifyViaServer: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: spies.getAccessToken,
}));
vi.mock('../src/background/server-source.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/background/server-source.ts')>();
  spies.classifyViaServer.mockImplementation(real.classifyViaServer);
  return { ...real, classifyViaServer: spies.classifyViaServer };
});

const ORIGIN = 'https://ai.example.org';

const CLASSIFICATION: Classification = {
  relevance: 12,
  noise: ['engagement-bait'],
  topics: ['automation'],
  reason: 'Asks for comments to spread the post.',
  isNews: false,
  hasCheckableClaims: false,
};

const item = (key: PostKey, text: string): ClassifyItem => ({
  key,
  input: { platform: 'linkedin', text, textComplete: true, authorKind: 'person', isReshare: false, media: 'none' },
});

/** A server with credit: every post `ok`. */
const server = vi.fn(async (_url: string | URL | Request, init: RequestInit = {}) => {
  const req = JSON.parse(String(init.body)) as ClassifyRequest;
  const res: ClassifyResponse = {
    v: 1,
    results: req.posts.map((p) => ({ ref: p.ref, status: 'ok', classification: CLASSIFICATION })),
    source: { kind: 'server', model: 'mock-model', promptVersion: 1 },
  };
  return new Response(JSON.stringify(res), { status: 200, headers: { 'content-type': 'application/json' } });
});

beforeEach(async () => {
  fakeBrowser.reset();
  await clearCache();
  spies.getAccessToken.mockReset();
  spies.getAccessToken.mockResolvedValue('access-1');
  server.mockClear();
  vi.stubGlobal('fetch', server);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('test_cache_only_returns_hits_and_skips_misses', async () => {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: { kind: 'server', baseUrl: ORIGIN } });
  const settings = defaultSettings();
  // Today's limit is two posts, and the two below use it up.
  await settingsItem.setValue({ ...settings, ai: { ...settings.ai, dailyCap: 2 } });
  const seen = [item('li:urn:li:activity:1', 'Comment YES to get the guide'), item('li:urn:li:activity:2', 'Tag three friends')];
  const fresh = await classifyItems(seen);
  expect(fresh.results.map((r) => r.status === 'ok' && r.cached)).toStrictEqual([false, false]);
  expect(server).toHaveBeenCalledOnce();

  server.mockClear();
  spies.classifyViaServer.mockClear();
  spies.getAccessToken.mockClear();
  const ledger = await usageItem.getValue();
  expect(ledger).not.toStrictEqual({});
  const unseen = item('li:urn:li:activity:3', 'A post first seen after the balance ran out');

  const res = await classifyItems([...seen, unseen], { cacheOnly: true });

  expect(res).toStrictEqual({
    results: [
      ...seen.map((i) => ({ key: i.key, status: 'ok', classification: CLASSIFICATION, model: 'mock-model', cached: true })),
      { key: unseen.key, status: 'skipped', reason: 'paused' },
    ],
  });
  expect(res).not.toHaveProperty('pause');
  // No AI client, no token, no request, and nothing metered: the daily limit is not even consulted.
  expect(spies.classifyViaServer).not.toHaveBeenCalled();
  expect(spies.getAccessToken).not.toHaveBeenCalled();
  expect(server).not.toHaveBeenCalled();
  expect(await usageItem.getValue()).toStrictEqual(ledger);

  // The same miss asked normally does reach the limit, so the answer above was the cache's, not the limit's.
  const normal = await classifyItems([unseen]);
  expect(normal.results).toStrictEqual([{ key: unseen.key, status: 'skipped', reason: 'cap-reached' }]);
  expect(normal.pause?.code).toBe('cap-reached');
  expect(server).not.toHaveBeenCalled();
});

it('test_classify_message_passes_cache_only', async () => {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: { kind: 'server', baseUrl: ORIGIN } });
  const url = 'https://www.linkedin.com/feed/';
  const feedTab = { tab: { id: 7, url }, url } as Browser.runtime.MessageSender;
  const unseen = item('li:urn:li:activity:4', 'A post first seen after the balance ran out');
  const msg: Extract<BgRequest, { type: 'classify' }> = { type: 'classify', platform: 'linkedin', items: [unseen] };

  // A paused feed tab's lookup: the cache does not know the post, and nothing is sent.
  expect(await handlers.classify({ ...msg, cacheOnly: true }, feedTab)).toStrictEqual({
    results: [{ key: unseen.key, status: 'skipped', reason: 'paused' }],
  });
  expect(spies.getAccessToken).not.toHaveBeenCalled();
  expect(server).not.toHaveBeenCalled();

  // The same message without `cacheOnly` goes to the server.
  const res = await handlers.classify(msg, feedTab);
  expect(res.results).toStrictEqual([
    { key: unseen.key, status: 'ok', classification: CLASSIFICATION, model: 'mock-model', cached: false },
  ]);
  expect(server).toHaveBeenCalledOnce();
});
