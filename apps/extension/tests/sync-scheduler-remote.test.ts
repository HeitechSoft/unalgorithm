/**
 * The scheduler with the real `syncOnce` (CL3-20, CL3-19): a change another device pushed arrives through the
 * long-poll, lands in settings and clocks, and starts no run of its own (echo suppression). The server is the in-memory
 * fake behind a stubbed global `fetch` that holds long-polls until the test answers them; the device token is a mocked
 * `getAccessToken`, extension storage the WXT fake browser, timers fake.
 */
import { defaultDevice } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  formatHlc,
  type ServerInfo,
  SYNC_CHANGES_PATH,
  SYNC_PUSH_PATH,
  SYNC_SPACES_PATH,
  type SyncItem,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { serverAccountItem } from '../src/background/server-auth.ts';
import { initSync, resetSync } from '../src/background/sync-scheduler.ts';
import { DEFAULT_SYNC_STATE, deviceItem, readSettings, settingsClocksItem, syncStateItem } from '../src/lib/storage.ts';
import { createFakeSyncServer, type FakeSyncServer } from './support/fake-sync-server.ts';

const mocks = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  getAccessToken: mocks.getAccessToken,
}));

const ORIGIN = 'https://sync.example.org';
const EMAIL = 'ada@example.org';
const NOW = Date.UTC(2026, 9, 14, 9);
const LOCAL = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const OTHER = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';

const INFO: ServerInfo = {
  v: 1,
  name: 'Example sync server',
  version: '0.3.0',
  source: 'https://github.com/HeitechSoft/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

interface Sent {
  method: string;
  path: string;
  wait: string | null;
  aborted: boolean;
}

let server: FakeSyncServer;
let requests: Sent[];
/** Answers the long-poll the fake is holding. */
let release: (() => void) | undefined;

/** The fake server, except that a long-poll waits until the test releases it (or its signal fires). */
async function heldFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const req: Sent = { method: init.method ?? 'GET', path: url.pathname, wait: url.searchParams.get('wait'), aborted: false };
  requests.push(req);
  if (req.path === SYNC_CHANGES_PATH && req.wait !== '0') {
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      init.signal?.addEventListener('abort', () => {
        req.aborted = true;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }
  return server.fetch(input, init);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(async () => {
  fakeBrowser.reset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  server = createFakeSyncServer();
  requests = [];
  release = undefined;
  vi.stubGlobal('fetch', heldFetch);
  mocks.getAccessToken.mockReset().mockResolvedValue('access-token');
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [
    { id: 7, url: 'https://www.linkedin.com/feed/' } as Browser.tabs.Tab,
  ]) as never);
  vi.spyOn(fakeBrowser.runtime, 'getContexts').mockImplementation((async () => []) as never);
  await deviceItem.setValue(defaultDevice(LOCAL));
  await serverAccountItem.setValue({
    origin: ORIGIN,
    email: EMAIL,
    deviceId: 'server-device-1',
    signedInAt: NOW,
    info: INFO,
    needsSignIn: false,
  });
  await syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {}, enabled: true, origin: ORIGIN, email: EMAIL });
});

afterEach(async () => {
  await resetSync();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('remote apply', () => {
  it('test_remote_apply_triggers_no_run', async () => {
    initSync();
    await settle();
    // Worker start: one run without waiting, then the loop's long-poll, held by the server.
    expect(requests.map((r) => [r.path, r.wait])).toStrictEqual([
      [SYNC_SPACES_PATH, null],
      [SYNC_CHANGES_PATH, '0'],
      [SYNC_CHANGES_PATH, '20'],
    ]);

    const value = { label: 'X', keywords: [], addedAt: 1 };
    const item = {
      collection: 'settings',
      key: 'interests.more.x',
      hlc: formatHlc({ ms: NOW - 1_000, counter: 0, device: OTHER }),
      deleted: false,
      value,
    } as SyncItem;
    server.put(item);
    const seen = requests.length;
    release?.();
    await settle();
    // Past the edit debounce: the clocks changed, but only to what the server holds.
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect((await readSettings()).interests.more.x).toStrictEqual(value);
    expect((await settingsClocksItem.getValue())['interests.more.x']).toBe(item.hlc);
    expect(requests.filter((r) => r.path === SYNC_PUSH_PATH)).toStrictEqual([]);
    expect(requests.filter((r) => r.aborted)).toStrictEqual([]);
    // The next request is the loop's next long-poll, still waiting.
    expect(requests.slice(seen).map((r) => [r.path, r.wait])).toStrictEqual([[SYNC_CHANGES_PATH, '20']]);
    expect((await syncStateItem.getValue()).known[item.key]).toBe(item.hlc);
  });
});
