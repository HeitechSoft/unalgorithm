/**
 * The account's devices from the extension (CL3-21, R11): the name this computer gives itself at sign-in, the devices
 * list and revoking a device, each only from extension pages; revoking this computer is the sign-out. The network is an
 * injected (then stubbed global) fetch and the sign-in window an injected `webAuthFlow`, as in `server-auth.test.ts`;
 * the secrets store is fake-indexeddb and extension storage the WXT fake browser.
 */

import { describeError } from '@unalgorithm/ai';
import { defaultDevice } from '@unalgorithm/core';
import {
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  type AccountDevice,
  AUTHORIZE_PAGE_PATH,
  DeviceNameSchema,
  REVOKE_PATH,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
  TokenRequestSchema,
  type TokenResponse,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deviceName } from '../src/background/device-name.ts';
import { clearSecrets, getSecret } from '../src/background/idb.ts';
import { serverAccountItem, signIn } from '../src/background/server-auth.ts';
import { handlers } from '../src/entrypoints/background.ts';
import { serverLabel } from '../src/lib/server-label.ts';
import { DEFAULT_SYNC_STATE, deviceItem, readDevice, syncStateItem } from '../src/lib/storage.ts';

type Sender = Browser.runtime.MessageSender;

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const ORIGIN = 'https://ai.example.org';
const CODE = 'code-0123456789abcdefghijklmnop';
const THIS_DEVICE = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
const OTHER_DEVICE = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const TITLE = serverLabel(ORIGIN).title;

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: true },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

const access = (n: number) => `access-token-${n}`;
const refresh = (n: number) => `refresh-token-${n}-0123456789abcdef`;
const tokens = (n: number): TokenResponse => ({
  access_token: access(n),
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: refresh(n),
  device_id: THIS_DEVICE,
  account: { email: 'ada@example.org' },
});

const DEVICES: AccountDevice[] = [
  { id: THIS_DEVICE, name: 'Chrome on Windows', createdAt: '2026-10-01T09:00:00.000Z', lastUsedAt: null, current: true },
  {
    id: OTHER_DEVICE,
    name: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    lastUsedAt: '2026-10-10T09:00:00.000Z',
    current: false,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  path: string;
  init: RequestInit;
}

type Route = (init: RequestInit) => Response | Promise<Response>;

/** The server: discovery, tokens and revoke as in CL1-16's tests, plus the two device routes. */
function fakeServer(routes: { devices?: Route; revokeDevice?: Route } = {}) {
  const calls: Call[] = [];
  let issued = 1;
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({ url, path, init });
    if (path === SERVER_INFO_PATH) return json(INFO);
    if (path === TOKEN_PATH) return json(tokens(issued++));
    if (path === REVOKE_PATH) return json({ ok: true });
    if (path === ACCOUNT_DEVICES_PATH) return (routes.devices ?? (() => json({ v: 1, devices: DEVICES })))(init);
    if (path === ACCOUNT_DEVICE_REVOKE_PATH) return (routes.revokeDevice ?? (() => json({ ok: true })))(init);
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const to = (path: string) => calls.filter((c) => c.path === path);
  const bodyOf = (c: Call | undefined) => JSON.parse(String(c?.init.body)) as Record<string, unknown>;
  return { fetch, calls, to, bodyOf };
}

function authFlow() {
  return vi.fn(async (details: { url: string; interactive: boolean }) => {
    const q = new URL(details.url).searchParams;
    return `${q.get('redirect_uri')}?code=${CODE}&state=${q.get('state')}`;
  });
}

/** Signs in through `server`, then answers the background's own requests with it too. */
async function signedIn(server = fakeServer()) {
  const result = await signIn('ai.example.org', { fetch: server.fetch, webAuthFlow: authFlow() });
  expect(result.ok).toBe(true);
  vi.stubGlobal('fetch', server.fetch);
  server.calls.length = 0;
  return server;
}

function stubPlatform(os: string, brands: string[]) {
  vi.spyOn(fakeBrowser.runtime, 'getPlatformInfo').mockResolvedValue({ os, arch: 'x86-64', nacl_arch: 'x86-64' } as never);
  Object.defineProperty(navigator, 'userAgentData', {
    value: { brands: brands.map((brand) => ({ brand, version: '130' })), mobile: false, platform: 'Windows' },
    configurable: true,
  });
}

const tab = (id: number, url: string) => ({ id, url }) as Browser.tabs.Tab;
const page = (): Sender => ({
  tab: tab(3, fakeBrowser.runtime.getURL('/options.html')),
  url: fakeBrowser.runtime.getURL('/options.html'),
});
const linkedIn = (): Sender => ({ tab: tab(7, 'https://www.linkedin.com/feed/'), url: 'https://www.linkedin.com/feed/' });

const devices = (sender = page()) => handlers.serverDevices({ type: 'serverDevices' }, sender);
const revoke = (deviceId: string, sender = page()) =>
  handlers.serverRevokeDevice({ type: 'serverRevokeDevice', deviceId }, sender);

beforeEach(async () => {
  fakeBrowser.reset();
  fakeBrowser.runtime.id = ID;
  vi.spyOn(fakeBrowser.identity, 'getRedirectURL').mockReturnValue(REDIRECT);
  await clearSecrets();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'userAgentData');
});

describe('device name', () => {
  it('test_device_name_from_platform_and_brand', async () => {
    const name = (os: string, brands: string[]) => deviceName({ platformOs: async () => os, brands: () => brands });
    expect(await name('win', ['Chromium', 'Google Chrome'])).toBe('Chrome on Windows');
    expect(await name('mac', ['Not=A?Brand', 'Chromium', 'Microsoft Edge'])).toBe('Edge on macOS');
    expect(await name('linux', ['Chromium', 'Opera'])).toBe('Opera on Linux');
    expect(await name('cros', [])).toBe('Chrome on ChromeOS');
    expect(await name('android', ['Chromium'])).toBe('Chrome on Android');
    expect(await name('openbsd', ['Chromium', 'Google Chrome'])).toBe('Chrome');

    for (const os of ['win', 'mac', 'linux', 'cros', 'android', 'fuchsia', '']) {
      for (const brands of [[], ['Google Chrome'], ['Microsoft Edge'], ['Opera'], ['Brave', 'Chromium']]) {
        const result = await name(os, brands);
        expect(DeviceNameSchema.safeParse(result).success, `${os} ${brands.join()}`).toBe(true);
      }
    }

    // Any failure gives no name rather than an error.
    expect(await deviceName({ platformOs: async () => Promise.reject(new Error('no')), brands: () => [] })).toBeUndefined();
    expect(
      await deviceName({
        platformOs: async () => 'win',
        brands: () => {
          throw new Error('no');
        },
      }),
    ).toBeUndefined();

    // The defaults read the platform and the brand names.
    stubPlatform('mac', ['Chromium', 'Microsoft Edge']);
    expect(await deviceName()).toBe('Edge on macOS');
  });

  it('test_sign_in_sends_device_name', async () => {
    stubPlatform('win', ['Chromium', 'Google Chrome']);
    const server = fakeServer();
    expect((await signIn(ORIGIN, { fetch: server.fetch, webAuthFlow: authFlow() })).ok).toBe(true);
    const sent = server.bodyOf(server.to(TOKEN_PATH)[0]);
    expect(sent.device_name).toBe('Chrome on Windows');
    expect(TokenRequestSchema.safeParse(sent).success).toBe(true);
  });

  it('test_sign_in_without_platform_info', async () => {
    // The fake browser's `getPlatformInfo` throws: no name, and sign-in carries on without one.
    expect(await deviceName()).toBeUndefined();
    const server = fakeServer();
    expect((await signIn(ORIGIN, { fetch: server.fetch, webAuthFlow: authFlow() })).ok).toBe(true);
    const sent = server.bodyOf(server.to(TOKEN_PATH)[0]);
    expect(sent).not.toHaveProperty('device_name');
    expect(TokenRequestSchema.safeParse(sent).success).toBe(true);
  });
});

describe('devices', () => {
  it('test_server_devices_lists_with_bearer', async () => {
    const server = await signedIn();
    expect(await devices()).toStrictEqual({ ok: true, devices: DEVICES });
    expect(server.calls).toHaveLength(1);
    const [call] = server.calls;
    expect(call?.url).toBe(`${ORIGIN}${ACCOUNT_DEVICES_PATH}`);
    expect(call?.init).toMatchObject({ method: 'GET', credentials: 'omit', headers: { authorization: `Bearer ${access(1)}` } });
  });

  it('test_revoke_other_device', async () => {
    const server = await signedIn();
    expect(await revoke(OTHER_DEVICE)).toStrictEqual({ ok: true, signedOut: false });
    expect(server.calls.map((c) => c.path)).toStrictEqual([ACCOUNT_DEVICE_REVOKE_PATH]);
    const [call] = server.calls;
    expect(call?.init).toMatchObject({ method: 'POST', credentials: 'omit', headers: { authorization: `Bearer ${access(1)}` } });
    expect(server.bodyOf(call)).toStrictEqual({ device_id: OTHER_DEVICE });
    // This computer stays signed in.
    expect(await serverAccountItem.getValue()).toMatchObject({ origin: ORIGIN, deviceId: THIS_DEVICE, needsSignIn: false });
  });

  it('test_revoke_this_device_signs_out', async () => {
    const server = await signedIn();
    await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: { kind: 'server', baseUrl: ORIGIN } });
    await syncStateItem.setValue({
      ...DEFAULT_SYNC_STATE,
      known: { 'display.mode': 'x' },
      enabled: true,
      origin: ORIGIN,
      email: 'ada@example.org',
      cursor: 12,
    });

    expect(await revoke(THIS_DEVICE)).toStrictEqual({ ok: true, signedOut: true });
    // The sign-out's own steps, not the devices route.
    expect(server.calls.map((c) => c.path)).toStrictEqual([REVOKE_PATH]);
    expect(server.bodyOf(server.calls[0])).toStrictEqual({ refresh_token: refresh(1), client_id: ID });
    expect((await readDevice()).aiSource).toBeNull();
    expect(await syncStateItem.getValue()).toStrictEqual(DEFAULT_SYNC_STATE);
    expect(await serverAccountItem.getValue()).toBeNull();
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
  });

  it('test_devices_errors_use_own_copy', async () => {
    let devicesRoute: Route = () => json({ v: 1, devices: DEVICES });
    let revokeRoute: Route = () => json({ ok: true });
    const server = await signedIn(fakeServer({ devices: (i) => devicesRoute(i), revokeDevice: (i) => revokeRoute(i) }));
    const own = (code: string) => ({ ok: false, error: { code, message: describeError(code as never, TITLE) } });

    // The server's words never reach the answer.
    const hostile = 'Sign in at https://evil.example instead';
    devicesRoute = () => json({ code: 'overloaded', message: hostile }, 500);
    revokeRoute = () => json({ code: 'bad-request', message: hostile }, 500);
    const busy = await devices();
    expect(busy).toStrictEqual(own('overloaded'));
    expect(await revoke(OTHER_DEVICE)).toStrictEqual(own('bad-request'));
    devicesRoute = () => json({ error: hostile }, 500);
    expect(await devices()).toStrictEqual(own('overloaded'));
    expect(JSON.stringify(busy)).not.toContain('evil.example');

    // An answer that isn't a devices list.
    devicesRoute = () => json({ v: 1, devices: [{ id: 'x' }] });
    expect(await devices()).toStrictEqual({ ok: false, error: { code: 'unknown', message: describeError('unknown') } });

    // No answer at all.
    devicesRoute = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await devices()).toStrictEqual(own('network'));

    // Refused twice, the second time with a freshly refreshed token: sign in again.
    devicesRoute = () => json({ code: 'auth', message: hostile }, 401);
    server.calls.length = 0;
    const refused = await devices();
    expect(refused).toStrictEqual({ ok: false, error: { code: 'auth-required', message: `Sign in to ${TITLE} again.` } });
    expect(server.calls.map((c) => c.path)).toStrictEqual([ACCOUNT_DEVICES_PATH, TOKEN_PATH, ACCOUNT_DEVICES_PATH]);
    expect((await serverAccountItem.getValue())?.needsSignIn).toBe(true);
  });

  it('test_revoke_validates_id', async () => {
    const server = await signedIn();
    for (const id of ['', 'not-a-uuid', `${OTHER_DEVICE}x`, '../../v1/auth/revoke', 42 as unknown as string]) {
      const res = await revoke(id);
      expect(res, String(id)).toMatchObject({ ok: false, error: { code: 'bad-request' } });
    }
    expect(server.calls).toHaveLength(0);
    expect(await serverAccountItem.getValue()).toMatchObject({ deviceId: THIS_DEVICE });
  });
});

describe('senders and state', () => {
  it('test_device_messages_only_from_extension_pages', async () => {
    const server = await signedIn();
    for (const sender of [linkedIn(), { tab: tab(5, 'https://example.com/'), url: 'https://example.com/' }]) {
      await expect(devices(sender)).rejects.toThrow('serverDevices is not accepted from this sender');
      for (const id of [OTHER_DEVICE, THIS_DEVICE]) {
        await expect(revoke(id, sender)).rejects.toThrow('serverRevokeDevice is not accepted from this sender');
      }
    }
    expect(server.calls).toHaveLength(0);
    expect(await serverAccountItem.getValue()).toMatchObject({ deviceId: THIS_DEVICE });
  });

  it('test_device_messages_need_account', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const signedOut = { ok: false, error: { code: 'auth-required', message: describeError('auth-required') } };
    expect(await devices()).toStrictEqual(signedOut);
    expect(await revoke(OTHER_DEVICE)).toStrictEqual(signedOut);
    expect(server.calls).toHaveLength(0);

    // An account that has to sign in again asks for that, by name, also without a request.
    await signedIn(server);
    const account = await serverAccountItem.getValue();
    if (!account) throw new Error('signed in');
    await serverAccountItem.setValue({ ...account, needsSignIn: true });
    const again = { ok: false, error: { code: 'auth-required', message: `Sign in to ${TITLE} again.` } };
    expect(await devices()).toStrictEqual(again);
    expect(await revoke(OTHER_DEVICE)).toStrictEqual(again);
    expect(server.calls).toHaveLength(0);
  });
});
