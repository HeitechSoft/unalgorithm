/**
 * unAlgorithm Cloud's source list in the extension (P3-75, decision D98): fetched only while UnEcho Chamber is on (its
 * switch, and an AI source that can compare, as Settings → AI shows it), at most once a day counted from the last request, anonymous (no cookie, no referrer, no header but Accept), and kept only
 * when it passes the schema and the list rules, so any failure keeps the last good copy. The network is a fake fetch,
 * the clock fixed, extension storage the WXT fake browser; every list is the fictional `.example` fixture or a copy of
 * it. Nothing real is called.
 */
import { type AISourceConfig, type Device, defaultDevice, type ServerOffer } from '@unalgorithm/core';
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import type { OfficialList } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  MAX_OFFICIAL_LIST_BYTES,
  OFFICIAL_LIST_EVERY_MS,
  OFFICIAL_LIST_URL,
  refreshOfficialList,
  startOfficialListUpdates,
} from '../src/background/official-list.ts';
import { storedOfficialList } from '../src/lib/outlets.ts';
import { deviceItem, officialListItem, serverOfferItem } from '../src/lib/storage.ts';

const NOW = Date.UTC(2026, 9, 17, 9);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The fixture as the Cloud publishes it after a change: every lean removed (the Cloud's list today). */
const NO_LEAN: OfficialList = {
  ...FIXTURE_OFFICIAL_LIST,
  version: '2',
  outlets: FIXTURE_OFFICIAL_LIST.outlets.map((o) => ({ ...o, lean: null })),
};

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const OLLAMA: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: 'none',
  model: null,
};
const SERVER: AISourceConfig = { kind: 'server', baseUrl: 'https://ai.example.org' };
const SERVER_OFFER: ServerOffer = {
  origin: 'https://ai.example.org',
  billing: false,
  factcheck: false,
  factcheckPrice: null,
  perspectives: true,
  perspectivesPrice: null,
};

/** A device with UnEcho Chamber's switch at `perspectives`, on an own Anthropic key unless `patch` says otherwise. */
function device(perspectives: boolean, patch: Partial<Device> = {}): Device {
  const d = defaultDevice('0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d');
  return { ...d, aiSource: ANTHROPIC, ...patch, labs: { ...d.labs, perspectives } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

/** The Cloud's endpoint: every request is recorded, and `answer` decides the reply. */
function fakeCloud(answer: () => Response | Promise<Response> = () => json(FIXTURE_OFFICIAL_LIST)) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** One refresh with UnEcho Chamber on (unless `on` is false) at `at`. */
const refresh = (cloud: ReturnType<typeof fakeCloud>, at = NOW, on = true) =>
  refreshOfficialList({ fetch: cloud.fetch, now: () => at, device: async () => device(on) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  fakeBrowser.reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fetch', () => {
  it('test_official_list_skipped_when_off', async () => {
    const cloud = fakeCloud();
    expect(await refresh(cloud, NOW, false)).toBe('skipped');
    // The device as stored: a new device has UnEcho Chamber off.
    expect(await refreshOfficialList({ fetch: cloud.fetch, now: () => NOW })).toBe('skipped');
    expect(cloud.calls).toHaveLength(0);
    expect(await officialListItem.getValue()).toStrictEqual({ list: null, checkedAt: 0 });
  });

  it('test_official_list_skipped_when_source_cant_compare', async () => {
    // The switch stays stored as on, but Settings → AI shows it off (and disabled) on a source that can't compare: no AI,
    // on-device, Ollama with no web search key, a server that doesn't offer it or isn't signed in.
    const cloud = fakeCloud();
    const cases: Array<[string, Partial<Device>, ServerOffer | null]> = [
      ['AI off', { aiSource: null }, null],
      ['on-device', { aiSource: { kind: 'on-device' } }, null],
      ['Ollama, no web search key', { aiSource: OLLAMA, webSearch: null }, null],
      ['server, no offer', { aiSource: SERVER }, null],
      ['server, offer without it', { aiSource: SERVER }, { ...SERVER_OFFER, perspectives: false }],
    ];
    for (const [name, patch, offer] of cases) {
      const deps = { fetch: cloud.fetch, now: () => NOW, device: async () => device(true, patch), offer: async () => offer };
      expect(await refreshOfficialList(deps), name).toBe('skipped');
    }
    // As stored: the flag on, AI off, no offer.
    await deviceItem.setValue(device(true, { aiSource: null }));
    expect(await refreshOfficialList({ fetch: cloud.fetch, now: () => NOW })).toBe('skipped');
    expect(cloud.calls).toHaveLength(0);
    expect(await officialListItem.getValue()).toStrictEqual({ list: null, checkedAt: 0 });

    // A source that can compare: one request. A server reads the stored offer.
    await deviceItem.setValue(device(true, { aiSource: SERVER }));
    await serverOfferItem.setValue(SERVER_OFFER);
    expect(await refreshOfficialList({ fetch: cloud.fetch, now: () => NOW })).toBe('updated');
    expect(cloud.calls).toHaveLength(1);
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 0 });
    const ollama = device(true, { aiSource: OLLAMA, webSearch: { provider: 'brave' } });
    expect(await refreshOfficialList({ fetch: cloud.fetch, now: () => NOW, device: async () => ollama })).toBe('updated');
    expect(cloud.calls).toHaveLength(2);
  });

  it('test_official_list_request_is_anonymous', async () => {
    expect(OFFICIAL_LIST_URL).toBe('https://cloud.unalgorithm.app/outlets.json');
    const cloud = fakeCloud();
    expect(await refresh(cloud)).toBe('updated');

    expect(cloud.calls).toHaveLength(1);
    const [call] = cloud.calls;
    expect(call?.url).toBe('https://cloud.unalgorithm.app/outlets.json');
    const init = call?.init ?? {};
    expect(Object.keys(init).sort()).toStrictEqual([
      'cache',
      'credentials',
      'headers',
      'method',
      'redirect',
      'referrerPolicy',
      'signal',
    ]);
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-cache',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
    });
    expect(init.body).toBeUndefined();
    expect([...new Headers(init.headers).entries()]).toStrictEqual([['accept', 'application/json']]);
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(await officialListItem.getValue()).toStrictEqual({ list: FIXTURE_OFFICIAL_LIST, checkedAt: NOW });
  });

  it('test_official_list_at_most_daily', async () => {
    expect(OFFICIAL_LIST_EVERY_MS).toBe(DAY);
    const cloud = fakeCloud();
    expect(await refresh(cloud, NOW)).toBe('updated');
    expect(await refresh(cloud, NOW + 23 * HOUR + 59 * MINUTE)).toBe('skipped');
    expect(cloud.calls).toHaveLength(1);
    expect(await refresh(cloud, NOW + DAY)).toBe('updated');
    expect(cloud.calls).toHaveLength(2);
    expect((await officialListItem.getValue()).checkedAt).toBe(NOW + DAY);
  });

  it('test_official_list_keeps_last_good_copy', async () => {
    // Each answer would replace the stored copy if it were read past its fault: the 500 and the 2 MB body carry an
    // otherwise valid list.
    const big = JSON.stringify({ ...NO_LEAN, padding: 'x'.repeat(2 * 1024 * 1024) });
    expect(big.length).toBeGreaterThan(MAX_OFFICIAL_LIST_BYTES);
    const [first, second] = NO_LEAN.outlets;
    const answers: Array<[string, () => Response | Promise<Response>]> = [
      ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['timeout', () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'))],
      ['500', () => json(NO_LEAN, 500)],
      ['2 MB body', () => new Response(big, { status: 200 })],
      ['invalid JSON', () => new Response('{"v":1,"outlets":[', { status: 200 })],
      ['schema failure', () => json({ ...NO_LEAN, v: 2 })],
      [
        'a domain in two outlets',
        () =>
          json({
            ...NO_LEAN,
            outlets: [first, { ...second, domains: [...(second?.domains ?? []), ...(first?.domains ?? [])] }],
          }),
      ],
    ];
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );

    for (const [name, answer] of answers) {
      await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: NOW - 2 * DAY });
      const cloud = fakeCloud(answer);
      expect(await refresh(cloud), name).toBe('kept');
      expect(cloud.calls, name).toHaveLength(1);
      expect(await officialListItem.getValue(), name).toStrictEqual({ list: FIXTURE_OFFICIAL_LIST, checkedAt: NOW });
    }
    // Nothing about the list or the answer is logged.
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('test_official_list_valid_empty_list_replaces', async () => {
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: NOW - 2 * DAY });
    expect(await refresh(fakeCloud(() => json(NO_LEAN)))).toBe('updated');
    expect(await officialListItem.getValue()).toStrictEqual({ list: NO_LEAN, checkedAt: NOW });
  });

  it('test_official_list_one_request_at_a_time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cloud = fakeCloud(async () => {
      await gate;
      return json(FIXTURE_OFFICIAL_LIST);
    });
    const both = Promise.all([refresh(cloud), refresh(cloud)]);
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(1));
    release();
    expect(await both).toStrictEqual(['updated', 'skipped']);
    expect(cloud.calls).toHaveLength(1);
  });
});

describe('wiring', () => {
  it('test_official_list_refreshes_when_turned_on', async () => {
    const cloud = fakeCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    await deviceItem.setValue(device(false));
    const stop = startOfficialListUpdates();
    await settle();
    // Started with UnEcho Chamber off: nothing asked.
    expect(cloud.calls).toHaveLength(0);

    // Off → on: one refresh.
    await deviceItem.setValue(device(true));
    await vi.waitFor(async () => expect((await officialListItem.getValue()).list).toStrictEqual(FIXTURE_OFFICIAL_LIST));
    expect(cloud.calls).toHaveLength(1);

    // With the daily limit cleared, other device changes still ask nothing: neither another change while it is on,
    // nor turning it off.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 0 });
    await deviceItem.setValue(device(true, { pausedUntil: { linkedin: NOW, facebook: null } }));
    await settle();
    await deviceItem.setValue(device(false));
    await settle();
    expect(cloud.calls).toHaveLength(1);

    // On again: one more.
    await deviceItem.setValue(device(true));
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(2));
    stop();

    // A service-worker start with UnEcho Chamber on and the last request over a day old asks once.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 0 });
    const restart = startOfficialListUpdates();
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(3));
    await settle();
    expect(cloud.calls).toHaveLength(3);
    restart();
  });

  it('test_official_list_refreshes_when_source_can_compare', async () => {
    // The switch was left on while the source couldn't compare: nothing asked at start, nor while it stays that way.
    const cloud = fakeCloud();
    vi.stubGlobal('fetch', cloud.fetch);
    await deviceItem.setValue(device(true, { aiSource: null }));
    const stop = startOfficialListUpdates();
    await settle();
    await deviceItem.setValue(device(true, { aiSource: OLLAMA }));
    await settle();
    await deviceItem.setValue(device(true, { aiSource: SERVER }));
    await settle();
    expect(cloud.calls).toHaveLength(0);

    // The server's offer arrives (signed in): UnEcho Chamber shows on, so one refresh.
    await serverOfferItem.setValue(SERVER_OFFER);
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(1));

    // Turning AI off, then back to a source that can compare (switch still on): one more.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 0 });
    await deviceItem.setValue(device(true, { aiSource: null }));
    await settle();
    expect(cloud.calls).toHaveLength(1);
    await deviceItem.setValue(device(true, { aiSource: ANTHROPIC }));
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(2));

    // A web search key makes Ollama able to compare: one more.
    await officialListItem.setValue({ list: FIXTURE_OFFICIAL_LIST, checkedAt: 0 });
    await deviceItem.setValue(device(true, { aiSource: OLLAMA }));
    await settle();
    expect(cloud.calls).toHaveLength(2);
    await deviceItem.setValue(device(true, { aiSource: OLLAMA, webSearch: { provider: 'tavily' } }));
    await vi.waitFor(() => expect(cloud.calls).toHaveLength(3));
    await settle();
    expect(cloud.calls).toHaveLength(3);
    stop();
  });

  it('test_official_list_e2e_uses_fixture', async () => {
    expect(import.meta.env.MODE).not.toBe('e2e');
    expect(storedOfficialList({ list: null, checkedAt: 0 })).toBeNull();
    expect(storedOfficialList({ list: NO_LEAN, checkedAt: NOW })).toStrictEqual(NO_LEAN);

    vi.stubEnv('MODE', 'e2e');
    const cloud = fakeCloud();
    expect(await refresh(cloud)).toBe('skipped');
    expect(cloud.calls).toHaveLength(0);
    expect(await officialListItem.getValue()).toStrictEqual({ list: null, checkedAt: 0 });
    expect(storedOfficialList({ list: null, checkedAt: 0 })).toStrictEqual(FIXTURE_OFFICIAL_LIST);
    expect(storedOfficialList({ list: NO_LEAN, checkedAt: NOW })).toStrictEqual(FIXTURE_OFFICIAL_LIST);
  });
});
