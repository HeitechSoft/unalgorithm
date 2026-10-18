/**
 * What Firefox needs beyond the manifest for unAlgorithm Cloud and the other sources that send data (ADR 0008): its
 * data-collection consent, asked for in the clicks that first send data to a service (one on this computer included)
 * and checked before every send; the sidebar the popup opens and the in-feed words when it isn't open; and a panel that
 * follows its own window. Vitest builds for Chrome, so `browserKind()` is switched here and Firefox's `sidebarAction`
 * added to the fake browser.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { describeError } from '@unalgorithm/ai';
import { type AISourceConfig, type Device, defaultDevice } from '@unalgorithm/core';
import {
  AUTHORIZE_PAGE_PATH,
  FIREFOX_DEV_ADDON_ID,
  REVOKE_PATH,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { classifyItems, listSourceModels, missingAccess, testSource } from '../src/background/ai.ts';
import { clearSecrets, setSecret } from '../src/background/idb.ts';
import { KEEP_AWAKE_MS, keepAwake } from '../src/background/keep-awake.ts';
import { saveSearchKey } from '../src/background/search-key.ts';
import { serverAccountItem } from '../src/background/server-auth.ts';
import { serverBalanceItem } from '../src/background/server-balance.ts';
import { AiSetup } from '../src/components/AiSetup.tsx';
import { WebSearchKey } from '../src/components/WebSearchKey.tsx';
import { panelHint } from '../src/content/feed-controller.ts';
import background, { handlers } from '../src/entrypoints/background.ts';
import { App as Popup } from '../src/entrypoints/popup/App.tsx';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import {
  CLOUD_DATA,
  DEVICE_NAME_DATA,
  hasConsent,
  POST_DATA,
  requestConsent,
  sourceConsent,
  withConsent,
} from '../src/lib/data-consent.ts';
import { useActiveTab } from '../src/lib/hooks.ts';
import { type BgRequest, type ClassifyItem, sendToBackground } from '../src/lib/messages.ts';
import { PINNED_CLOUD_ORIGIN } from '../src/lib/server-label.ts';
import { DEFAULT_SYNC_STATE, deviceItem, syncStateItem } from '../src/lib/storage.ts';

const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
}));
vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(),
}));

const CLOUD: AISourceConfig = { kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN };
const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const OLLAMA: AISourceConfig = {
  kind: 'openai-compatible',
  preset: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  auth: 'none',
  model: 'llama3.2',
};
const LAN: AISourceConfig = { ...OLLAMA, preset: 'custom', baseUrl: 'http://192.168.1.20:11434/v1' };
const OTHER_DEVICE = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const device = (aiSource: AISourceConfig | null = null): Device => ({ ...defaultDevice('dev1'), aiSource });
const item = (key: string): ClassifyItem => ({
  key: key as ClassifyItem['key'],
  input: { platform: 'linkedin', text: 'A post.', textComplete: true, authorKind: 'person', isReshare: false, media: 'none' },
});

let granted: string[] | undefined;
let getAll: MockInstance;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fakeBrowser.reset();
  await clearSecrets();
  env.kind = 'chrome';
  granted = [];
  // `as never`: spyOn picks the callback overload, typed as returning void.
  getAll = vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
    origins: [],
    permissions: [],
    ...(granted ? { data_collection: granted } : {}),
  })) as never);
  vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
  fetchSpy = vi.fn(async () => Promise.reject(new TypeError('offline')));
  vi.stubGlobal('fetch', fetchSpy);
  vi.mocked(sendToBackground).mockReset();
});

afterEach(() => {
  cleanup();
  delete (fakeBrowser as { sidebarAction?: unknown }).sidebarAction;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('data-collection consent', () => {
  it('test_what_each_source_needs', () => {
    // Post text: the page's content, and other people's social media posts.
    expect(POST_DATA).toEqual(['websiteContent', 'personalCommunications']);
    // A server also gets the people sync carries and the account, with this device's sign-in to it.
    expect(CLOUD_DATA).toEqual(['websiteContent', 'personalCommunications', 'personallyIdentifyingInfo', 'authenticationInfo']);
    // The device name only: Firefox offers it at install, and it is never part of what a source needs.
    expect(DEVICE_NAME_DATA).toEqual(['technicalAndInteraction']);
    expect(sourceConsent(CLOUD)).toEqual(CLOUD_DATA);
    expect(sourceConsent(ANTHROPIC)).toEqual(POST_DATA);
    expect(sourceConsent({ kind: 'openai', model: null })).toEqual(POST_DATA);
    expect(sourceConsent({ ...OLLAMA, preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1' })).toEqual(POST_DATA);
    expect(sourceConsent(LAN)).toEqual(POST_DATA);
    // Only on-device AI keeps posts in the browser. A server on this computer is outside it, and an unAlgorithm server
    // there passes posts on to the AI its owner chose: both are asked for like any other.
    expect(sourceConsent({ kind: 'on-device' })).toEqual([]);
    expect(sourceConsent(OLLAMA)).toEqual(POST_DATA);
    for (const host of ['127.0.0.1:1234', '[::1]:8787', 'localhost']) {
      expect(sourceConsent({ kind: 'server', baseUrl: `http://${host}` }), host).toEqual(CLOUD_DATA);
    }
  });

  it('test_technical_data_is_never_asked_for', async () => {
    // Mozilla's add-on policies: nothing may depend on technical and interaction data. No set the extension
    // asks for or checks before a send holds it, for any source.
    const sources: AISourceConfig[] = [{ kind: 'on-device' }, ANTHROPIC, { kind: 'openai', model: null }, OLLAMA, LAN, CLOUD];
    for (const types of [POST_DATA, CLOUD_DATA, ...sources.map(sourceConsent)]) {
      expect(types).not.toContain('technicalAndInteraction');
    }
    // Only the sign-in's device name reads it, and nothing in the extension names the type anywhere else.
    const src = join(import.meta.dirname, '../src');
    const files = (await readdir(src, { recursive: true })).filter((f) => /\.tsx?$/.test(f));
    const naming: string[] = [];
    const reading: string[] = [];
    for (const file of files) {
      const text = await readFile(join(src, file), 'utf8');
      if (text.includes("'technicalAndInteraction'")) naming.push(file.replaceAll('\\', '/'));
      for (const [line] of text.matchAll(/^.*\bDEVICE_NAME_DATA\b.*$/gm))
        reading.push(`${file.replaceAll('\\', '/')}: ${line.trim()}`);
    }
    expect(naming.sort()).toEqual(['lib/data-consent.ts', 'types/firefox.d.ts']);
    expect(reading.filter((r) => !r.startsWith('lib/data-consent.ts: '))).toEqual([
      "background/server-auth.ts: import { CLOUD_DATA, DEVICE_NAME_DATA, hasConsent } from '../lib/data-consent.ts';",
      'background/server-auth.ts: const name = (await hasConsent(DEVICE_NAME_DATA)) ? await deviceName() : undefined;',
    ]);
  });

  it('test_requests_carry_consent_in_firefox_only', async () => {
    const origins = { origins: ['https://api.anthropic.com/*'] };
    for (const kind of ['chrome', 'edge'] as const) {
      env.kind = kind;
      // Chrome and Edge refuse a request with a key they don't know.
      expect(withConsent(origins, POST_DATA), kind).toEqual(origins);
      expect(await hasConsent(CLOUD_DATA), kind).toBe(true);
      const request = vi.spyOn(fakeBrowser.permissions, 'request');
      expect(await requestConsent(CLOUD_DATA), kind).toBe(true);
      expect(request).not.toHaveBeenCalled();
    }
    expect(getAll).not.toHaveBeenCalled();

    env.kind = 'firefox';
    expect(withConsent(origins, POST_DATA)).toEqual({
      ...origins,
      data_collection: ['websiteContent', 'personalCommunications'],
    });
    expect(withConsent(origins, [])).toEqual(origins);
    // Every type asked for, not some of them.
    granted = ['websiteContent'];
    expect(await hasConsent(POST_DATA)).toBe(false);
    granted = POST_DATA.slice();
    expect(await hasConsent(POST_DATA)).toBe(true);
    expect(await hasConsent(CLOUD_DATA)).toBe(false);
    expect(await hasConsent([])).toBe(true);
    // A Firefox without data-collection consent has nothing to withhold; one that doesn't answer withholds.
    granted = undefined;
    expect(await hasConsent(CLOUD_DATA)).toBe(true);
    getAll.mockRejectedValueOnce(new Error('gone'));
    expect(await hasConsent(CLOUD_DATA)).toBe(false);

    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValueOnce(true as never);
    expect(await requestConsent(CLOUD_DATA)).toBe(true);
    expect(request).toHaveBeenCalledWith({ data_collection: CLOUD_DATA });
    request.mockRejectedValueOnce(new Error('declined'));
    expect(await requestConsent(CLOUD_DATA)).toBe(false);
    request.mockClear();
    expect(await requestConsent([])).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('test_withdrawn_consent_stops_classify_like_a_host_permission', async () => {
    env.kind = 'firefox';
    granted = ['websiteContent'];
    await deviceItem.setValue(device(CLOUD));
    const cloud = 'unAlgorithm needs your permission to send posts to unAlgorithm Cloud. Open Settings → AI and allow it.';
    expect(await classifyItems([item('li:1'), item('li:2')])).toStrictEqual({
      results: ['li:1', 'li:2'].map((key) => ({
        key,
        status: 'failed',
        code: 'host-permission',
        message: cloud,
        retryable: false,
      })),
      pause: { code: 'host-permission', message: cloud },
    });

    granted = [];
    await deviceItem.setValue(device(ANTHROPIC));
    const anthropic = describeError('host-permission', 'Anthropic');
    expect(await classifyItems([item('li:1')])).toMatchObject({
      results: [{ status: 'failed', code: 'host-permission', message: anthropic }],
      pause: { code: 'host-permission', message: anthropic },
    });
    expect(await testSource(ANTHROPIC, 'sk-ant-test')).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: anthropic },
    });
    expect(await listSourceModels(ANTHROPIC)).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: anthropic },
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // On this computer too: a model server and an unAlgorithm server need their consent like any other.
    const loopback: AISourceConfig = { kind: 'server', baseUrl: 'http://127.0.0.1:8787' };
    for (const cfg of [OLLAMA, LAN, loopback]) expect(await missingAccess(cfg)).toMatchObject({ code: 'host-permission' });
    // Post text alone: enough for a model, not for a server, which also gets the account and the device.
    granted = POST_DATA.slice();
    for (const cfg of [ANTHROPIC, OLLAMA, LAN]) expect(await missingAccess(cfg)).toBeNull();
    for (const cfg of [CLOUD, loopback]) expect(await missingAccess(cfg)).toMatchObject({ code: 'host-permission' });
    granted = CLOUD_DATA.slice();
    for (const cfg of [CLOUD, loopback, ANTHROPIC, OLLAMA, LAN]) expect(await missingAccess(cfg)).toBeNull();
    // A host permission still counts first, with its own words.
    vi.mocked(fakeBrowser.permissions.contains).mockResolvedValue(false as never);
    expect(await missingAccess(ANTHROPIC)).toMatchObject({ code: 'host-permission', message: anthropic });
  });

  it('test_withdrawn_server_consent_leaves_only_sign_out', async () => {
    env.kind = 'firefox';
    fakeBrowser.runtime.id = FIREFOX_DEV_ADDON_ID;
    // Signed in to a billing server that AI uses and sync runs on, with an empty balance old enough to ask about again.
    const info: ServerInfo = {
      v: 1,
      name: 'unAlgorithm',
      version: '0.3.0',
      source: 'https://github.com/HeitechSoft/unalgorithm',
      billing: true,
      capabilities: { classify: true, sync: true },
      auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
      limits: { maxPostsPerRequest: 12 },
    };
    const origin = PINNED_CLOUD_ORIGIN;
    const email = 'ada@example.org';
    const deviceId = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
    await serverAccountItem.setValue({ origin, email, deviceId, signedInAt: 0, info, needsSignIn: false });
    await setSecret(`server-refresh:${origin}`, 'refresh-token-0123456789abcdef');
    await deviceItem.setValue(device(CLOUD));
    await syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, known: {}, enabled: true, origin, email });
    await serverBalanceItem.setValue({ origin, deviceId, balanceMicros: 0, source: 'refused', updatedAt: 0 });
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([] as never);
    // Withdrawn in Firefox's add-ons page: post text stays, the account doesn't. Technical data plays no part.
    granted = ['websiteContent', 'personalCommunications', 'technicalAndInteraction'];
    const page = {} as Browser.runtime.MessageSender;
    const feed = { tab: { id: 7, url: 'https://www.linkedin.com/feed/' }, url: 'https://www.linkedin.com/feed/' };
    const tab = feed as Browser.runtime.MessageSender;
    const account = 'unAlgorithm needs your permission to send your account details to unAlgorithm Cloud.';
    const posts = 'unAlgorithm needs your permission to send posts to unAlgorithm Cloud. Open Settings → AI and allow it.';

    expect(await handlers.aiStatus({ type: 'aiStatus' }, page)).not.toHaveProperty('balance');
    expect(await handlers.balanceCheck({ type: 'balanceCheck' }, tab)).toEqual({ ok: true });
    expect(await handlers.serverDevices({ type: 'serverDevices' }, page)).toEqual({
      ok: false,
      error: { code: 'host-permission', message: account },
    });
    expect(await handlers.serverRevokeDevice({ type: 'serverRevokeDevice', deviceId: OTHER_DEVICE }, page)).toEqual({
      ok: false,
      error: { code: 'host-permission', message: account },
    });
    expect(await handlers.syncNow({ type: 'syncNow' }, page)).toMatchObject({ state: 'problem', problem: 'consent' });
    expect(await handlers.classify({ type: 'classify', platform: 'linkedin', items: [item('li:1')] }, tab)).toMatchObject({
      pause: { code: 'host-permission', message: posts },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // Signing in again reads the server's public discovery document, which carries nothing, and stops there.
    const discovery = { ...info, auth: { ...info.auth, clients: ['chromium', 'gecko'] } };
    fetchSpy.mockImplementation(async (url: string) =>
      new URL(url).pathname === SERVER_INFO_PATH ? Response.json(discovery) : Promise.reject(new TypeError('offline')),
    );
    expect(await handlers.serverSignIn({ type: 'serverSignIn', baseUrl: origin }, page)).toEqual({
      ok: false,
      error: {
        code: 'host-permission',
        message: 'unAlgorithm needs your permission to send post text and account details to unAlgorithm Cloud.',
      },
    });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${origin}${SERVER_INFO_PATH}`]);

    // Signing out still ends the device on the server.
    fetchSpy.mockClear();
    expect(await handlers.serverSignOut({ type: 'serverSignOut' }, page)).toEqual({ ok: true });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([`${origin}${REVOKE_PATH}`]);
    expect(await serverAccountItem.getValue()).toBeNull();
  });

  it('test_chrome_classify_never_reads_consent', async () => {
    await deviceItem.setValue(device(ANTHROPIC));
    expect(await missingAccess(ANTHROPIC)).toBeNull();
    expect(await missingAccess(CLOUD)).toBeNull();
    expect(getAll).not.toHaveBeenCalled();
  });

  it('test_web_search_key_needs_consent', async () => {
    env.kind = 'firefox';
    expect(await saveSearchKey('brave', 'brave-key-0123')).toStrictEqual({
      ok: false,
      error: { code: 'host-permission', message: 'unAlgorithm needs permission to reach api.search.brave.com.' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('test_setup_clicks_ask_for_consent_with_the_host', async () => {
    env.kind = 'firefox';
    const requested: unknown[] = [];
    vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async (p: unknown) => {
      requested.push(p);
      return false;
    }) as never);
    vi.mocked(sendToBackground).mockImplementation((async (msg: BgRequest) =>
      msg.type === 'onDeviceStatus' ? { availability: 'no-api' } : { ok: true }) as never);
    const user = setupUser();
    render(<AiSetup device={device()} />);

    // Your own key: the provider's host and consent to send it post text, in one prompt.
    await user.click(await screen.findByRole('radio', { name: /^Your own API key/ }));
    await user.type(screen.getByLabelText('API key'), 'sk-ant-api03-0123456789');
    await user.click(screen.getByRole('button', { name: 'Test and save' }));
    const postText = ['websiteContent', 'personalCommunications'];
    expect(requested).toEqual([{ origins: ['https://api.anthropic.com/*'], data_collection: postText }]);

    // A model server, on this computer or elsewhere: the same consent with its host.
    await user.click(screen.getByRole('radio', { name: /^Local or self-hosted/ }));
    await user.click(screen.getAllByRole('button', { name: 'Test and save' }).at(-1) as HTMLElement);
    expect(requested.at(-1)).toEqual({ origins: ['http://localhost/*'], data_collection: postText });
    const address = screen.getByLabelText('Address');
    await user.clear(address);
    await user.type(address, 'http://192.168.1.20:11434/v1');
    await user.click(screen.getAllByRole('button', { name: 'Test and save' }).at(-1) as HTMLElement);
    expect(requested.at(-1)).toEqual({ origins: ['http://192.168.1.20/*'], data_collection: postText });
    // Declined: nothing was tested or saved.
    expect(vi.mocked(sendToBackground).mock.calls.map(([m]) => m.type)).toEqual(['onDeviceStatus']);
    cleanup();

    // The web search key's Save.
    requested.length = 0;
    render(<WebSearchKey device={device(LAN)} />);
    await user.type(screen.getByLabelText('Brave API key'), 'brave-key-0123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(requested).toEqual([{ origins: ['https://api.search.brave.com/*'], data_collection: postText }]);
  });

  it('test_consent_given_again_resumes_feed_tabs', async () => {
    vi.spyOn(fakeBrowser.sidePanel, 'setPanelBehavior').mockResolvedValue(undefined as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7, url: 'https://www.linkedin.com/feed/' }] as never);
    const told = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const listeners: Array<(p: Browser.permissions.Permissions) => void> = [];
    const onAdded = vi
      .spyOn(fakeBrowser.permissions.onAdded, 'addListener')
      .mockImplementation(((l: (p: Browser.permissions.Permissions) => void) => void listeners.push(l)) as never);

    background.main();
    expect(onAdded).not.toHaveBeenCalled();

    env.kind = 'firefox';
    background.main();
    expect(listeners).toHaveLength(1);
    listeners[0]?.({ origins: ['https://api.anthropic.com/*'] });
    await Promise.resolve();
    expect(told).not.toHaveBeenCalled();
    listeners[0]?.({ data_collection: ['websiteContent'] });
    await waitFor(() => expect(told).toHaveBeenCalledWith(7, { type: 'aiResume' }));
  });
});

describe('event page lifetime', () => {
  it('test_firefox_event_page_kept_awake_while_answering', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const ping = vi.spyOn(fakeBrowser.runtime, 'getPlatformInfo').mockResolvedValue({} as never);
      let answer: (v: string) => void = () => undefined;
      const slow = new Promise<string>((r) => (answer = r));

      // Chrome and Edge wait for the answer themselves: the same promise, no calls.
      expect(keepAwake(slow)).toBe(slow);
      vi.advanceTimersByTime(3 * KEEP_AWAKE_MS);
      expect(ping).not.toHaveBeenCalled();

      // Firefox ends an idle event page after 30 s, a pending fetch or not: an API call every 20 s while it runs.
      env.kind = 'firefox';
      expect(KEEP_AWAKE_MS).toBeLessThan(30_000);
      const kept = keepAwake(slow);
      vi.advanceTimersByTime(KEEP_AWAKE_MS - 1);
      expect(ping).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ping).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2 * KEEP_AWAKE_MS);
      expect(ping).toHaveBeenCalledTimes(3);
      answer('done');
      expect(await kept).toBe('done');
      vi.advanceTimersByTime(3 * KEEP_AWAKE_MS);
      expect(ping).toHaveBeenCalledTimes(3);

      // A failed answer stops it too, and still fails.
      const failing = keepAwake(Promise.reject(new Error('refused')));
      await expect(failing).rejects.toThrow('refused');
      vi.advanceTimersByTime(3 * KEEP_AWAKE_MS);
      expect(ping).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sidebar', () => {
  const FEED_TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 3, active: true };

  async function openPopup() {
    vi.mocked(sendToBackground).mockImplementation((async () => ({
      configured: false,
      kind: null,
      label: 'Off',
      state: 'off',
      postsToday: 0,
      dailyCap: 300,
      capApplies: false,
    })) as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([FEED_TAB] as never);
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
    await deviceItem.setValue(device());
    const user = setupUser();
    render(<Popup />);
    return { user, close, button: await screen.findByRole('button', { name: 'Open Highlights' }) };
  }

  it('test_popup_opens_firefox_sidebar_from_the_click', async () => {
    env.kind = 'firefox';
    const sidebar = { open: vi.fn(async () => undefined) };
    (fakeBrowser as { sidebarAction?: unknown }).sidebarAction = sidebar;
    const sidePanel = vi.spyOn(fakeBrowser.sidePanel, 'open');
    const { close, button } = await openPopup();
    // A plain click event: the call happens in it, before the popup closes (Firefox needs the user action).
    act(() => button.click());
    expect(sidebar.open).toHaveBeenCalledExactlyOnceWith();
    expect(close).toHaveBeenCalledOnce();
    expect(sidebar.open.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0] ?? 0);
    expect(sidePanel).not.toHaveBeenCalled();
  });

  it('test_popup_opens_chrome_side_panel_for_its_window', async () => {
    const sidePanel = vi.spyOn(fakeBrowser.sidePanel, 'open').mockResolvedValue(undefined as never);
    const { close, button } = await openPopup();
    act(() => button.click());
    await waitFor(() => expect(sidePanel).toHaveBeenCalledWith({ windowId: 3 }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('test_in_feed_words_name_the_way_in', () => {
    expect(panelHint(false)).toBe('Open unAlgorithm from the toolbar to see it.');
    expect(panelHint(false, 'Alt+Shift+U')).toBe('Open unAlgorithm from the toolbar to see it.');
    expect(panelHint(true, 'Alt+Shift+U')).toBe(
      'Press Alt+Shift+U to see it, or open unAlgorithm from the toolbar and choose Open Highlights.',
    );
    expect(panelHint(true)).toBe('To see it, open unAlgorithm from the toolbar and choose Open Highlights.');
  });
});

describe('the panel follows its own window', () => {
  function ShowsTab() {
    const tab = useActiveTab();
    return <p data-testid="tab">{tab ? `${tab.id} ${tab.url}` : 'none'}</p>;
  }
  const shown = () => screen.getByTestId('tab').textContent;

  /** Window 1 is focused; the panel is in window 2. `active` is each window's active tab. */
  function twoWindows() {
    const active: Record<number, { id: number; url: string; windowId: number }> = {
      1: { id: 11, url: 'https://www.linkedin.com/feed/', windowId: 1 },
      2: { id: 21, url: 'https://www.facebook.com/', windowId: 2 },
    };
    const query = vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async (q: {
      windowId?: number;
      lastFocusedWindow?: boolean;
      currentWindow?: boolean;
    }) => {
      const tab = q.windowId !== undefined ? active[q.windowId] : active[1];
      return tab ? [{ ...tab, active: true }] : [];
    }) as never);
    return { active, query };
  }

  it('test_panel_shows_and_follows_only_its_window', async () => {
    const { active, query } = twoWindows();
    vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue({ id: 2 } as never);
    render(<ShowsTab />);
    await waitFor(() => expect(shown()).toBe('21 https://www.facebook.com/'));
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 2 });
    expect(query).not.toHaveBeenCalledWith(expect.objectContaining({ lastFocusedWindow: true }));

    // The focused window changes tab: its own panel follows, this one doesn't ask.
    query.mockClear();
    active[1] = { id: 12, url: 'https://www.linkedin.com/feed/', windowId: 1 };
    await act(() => fakeBrowser.tabs.onActivated.trigger({ tabId: 12, windowId: 1 }));
    await act(() => fakeBrowser.tabs.onUpdated.trigger(12, { status: 'complete' }, { windowId: 1 } as never));
    expect(query).not.toHaveBeenCalled();
    expect(shown()).toBe('21 https://www.facebook.com/');

    // Its own window: a tab switch, then navigation in that tab.
    active[2] = { id: 22, url: 'https://www.linkedin.com/feed/', windowId: 2 };
    await act(() => fakeBrowser.tabs.onActivated.trigger({ tabId: 22, windowId: 2 }));
    await waitFor(() => expect(shown()).toBe('22 https://www.linkedin.com/feed/'));
    active[2] = { id: 22, url: 'https://www.linkedin.com/feed/?page=2', windowId: 2 };
    await act(() => fakeBrowser.tabs.onUpdated.trigger(22, { url: active[2]?.url }, { windowId: 2 } as never));
    await waitFor(() => expect(shown()).toBe('22 https://www.linkedin.com/feed/?page=2'));
  });

  it('test_without_a_window_the_current_one_is_asked', async () => {
    const { query } = twoWindows();
    vi.spyOn(fakeBrowser.windows, 'getCurrent').mockRejectedValue(new Error('no window'));
    render(<ShowsTab />);
    await waitFor(() => expect(shown()).toBe('11 https://www.linkedin.com/feed/'));
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });
});
