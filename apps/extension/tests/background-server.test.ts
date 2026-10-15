/**
 * The background messages behind server setup (CL1-18, ADR 0005): checking a server, signing in, signing out and
 * reading the account, each only from extension pages, and "Erase everything" ending the device on the server. Sign-in
 * itself is stubbed (`server-auth.test.ts` covers it); extension storage is the WXT fake browser.
 */
import { type AISourceConfig, defaultDevice, emptyDay } from '@unalgorithm/core';
import { AUTHORIZE_PAGE_PATH, CREDIT_BALANCE_PATH, type ServerInfo, TOKEN_PATH } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { type ServerAccount, serverAccountItem } from '../src/background/server-auth.ts';
import { handlers } from '../src/entrypoints/background.ts';
import { PINNED_CLOUD_ORIGIN, serverLabel } from '../src/lib/server-label.ts';
import { deviceItem, readDevice, usageItem } from '../src/lib/storage.ts';

const mocks = vi.hoisted(() => ({
  discoverServer: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getAccessToken: vi.fn(),
  clearSecrets: vi.fn(),
}));
vi.mock('../src/background/server-auth.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/server-auth.ts')>()),
  discoverServer: mocks.discoverServer,
  signIn: mocks.signIn,
  signOut: mocks.signOut,
  getAccessToken: mocks.getAccessToken,
}));
// The real erase, watched for its order.
vi.mock('../src/background/idb.ts', async (importOriginal) => {
  const idb = await importOriginal<typeof import('../src/background/idb.ts')>();
  mocks.clearSecrets.mockImplementation(idb.clearSecrets);
  return { ...idb, clearSecrets: mocks.clearSecrets };
});

type Sender = Browser.runtime.MessageSender;

const ORIGIN = 'https://ai.example.org';
const NOW = Date.UTC(2026, 9, 13, 9);
const DEVICE_ID = '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d';
const FEED_URLS = ['https://www.linkedin.com/*', 'https://www.facebook.com/*'];
const LEDGER = { '2026-10-13': { ...emptyDay(), posts: 3, calls: 1 } };

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
  deviceId: DEVICE_ID,
  signedInAt: NOW,
  info: INFO,
  needsSignIn: false,
  ...over,
});

const tab = (id: number, url: string) => ({ id, url }) as Browser.tabs.Tab;
const feedTab = (url = 'https://www.linkedin.com/feed/'): Sender => ({ tab: tab(7, url), url });
/** The Settings page, open in a tab of its own. */
const page = (): Sender => ({
  tab: tab(3, fakeBrowser.runtime.getURL('/options.html')),
  url: fakeBrowser.runtime.getURL('/options.html'),
});

/** Every key anywhere in a JSON value. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...keysDeep(v)]);
  return [];
}

async function setSource(cfg: AISourceConfig | null) {
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: cfg });
}

beforeEach(() => {
  fakeBrowser.reset();
  mocks.discoverServer.mockReset();
  mocks.signIn.mockReset();
  mocks.signOut.mockReset();
  mocks.getAccessToken.mockReset();
  mocks.clearSecrets.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sender validation', () => {
  it('test_server_messages_only_from_extension_pages', async () => {
    const getAccount = vi.spyOn(serverAccountItem, 'getValue');
    for (const sender of [
      feedTab(),
      feedTab('https://www.facebook.com/'),
      { tab: tab(5, 'https://example.com/'), url: 'https://example.com/' },
    ]) {
      await expect(handlers.serverDiscover({ type: 'serverDiscover', baseUrl: ORIGIN }, sender)).rejects.toThrow(
        'serverDiscover is not accepted from this sender',
      );
      await expect(handlers.serverSignIn({ type: 'serverSignIn', baseUrl: ORIGIN }, sender)).rejects.toThrow(
        'serverSignIn is not accepted from this sender',
      );
      await expect(handlers.serverSignOut({ type: 'serverSignOut' }, sender)).rejects.toThrow(
        'serverSignOut is not accepted from this sender',
      );
      await expect(handlers.serverAccount({ type: 'serverAccount' }, sender)).rejects.toThrow(
        'serverAccount is not accepted from this sender',
      );
    }
    expect(mocks.discoverServer).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('test_ai_status_only_from_extension_pages', async () => {
    // A server that bills, so an `aiStatus` that ran would ask for the balance.
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    await serverAccountItem.setValue(account({ info: { ...INFO, billing: true } }));
    mocks.getAccessToken.mockResolvedValue('access-1');
    const balance = {
      v: 1,
      balanceMicros: 970_000,
      promoMicros: 970_000,
      purchasedMicros: 0,
      promoExpiresAt: null,
      starter: 'active',
    };
    const fetch = vi.fn(async () => new Response(JSON.stringify(balance), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    for (const sender of [
      feedTab(),
      feedTab('https://www.facebook.com/'),
      { tab: tab(5, 'https://example.com/'), url: 'https://example.com/' },
    ]) {
      await expect(handlers.aiStatus({ type: 'aiStatus' }, sender)).rejects.toThrow('aiStatus is not accepted from this sender');
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.getAccessToken).not.toHaveBeenCalled();

    // The popup (no tab) and Settings get the answer.
    const popup = await handlers.aiStatus({ type: 'aiStatus' }, { url: fakeBrowser.runtime.getURL('/popup.html') });
    expect(popup).toMatchObject({ kind: 'server', state: 'ready', balance: { balanceMicros: 970_000 } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}${CREDIT_BALANCE_PATH}`, expect.anything());
    expect(await handlers.aiStatus({ type: 'aiStatus' }, page())).toStrictEqual(popup);
  });
});

describe('discover and sign-in', () => {
  it('test_server_discover_adds_label', async () => {
    mocks.discoverServer.mockResolvedValue({ ok: true, origin: ORIGIN, info: INFO });
    const found = await handlers.serverDiscover({ type: 'serverDiscover', baseUrl: 'ai.example.org' }, page());
    expect(mocks.discoverServer).toHaveBeenCalledWith('ai.example.org');
    expect(found).toStrictEqual({ ok: true, origin: ORIGIN, info: INFO, label: serverLabel(ORIGIN, INFO) });
    expect(found.ok && found.label).toMatchObject({ title: 'ai.example.org', serverName: 'Example AI', isCloud: false });

    // The Cloud is named by its origin, whatever the server calls itself.
    mocks.discoverServer.mockResolvedValue({ ok: true, origin: PINNED_CLOUD_ORIGIN, info: INFO });
    const cloud = await handlers.serverDiscover({ type: 'serverDiscover', baseUrl: PINNED_CLOUD_ORIGIN }, page());
    expect(cloud.ok && cloud.label).toStrictEqual({ title: 'UnAlgorithm Cloud', host: 'cloud.unalgorithm.app', isCloud: true });

    const error = { code: 'unsupported', message: "That address isn't an UnAlgorithm server." };
    mocks.discoverServer.mockResolvedValue({ ok: false, error });
    expect(await handlers.serverDiscover({ type: 'serverDiscover', baseUrl: 'example.com' }, page())).toStrictEqual({
      ok: false,
      error,
    });
  });

  it('test_server_sign_in_saves_source_and_hides_credentials', async () => {
    await setSource({ kind: 'anthropic', model: null });
    mocks.signIn.mockResolvedValue({ ok: true, account: account() });
    const res = await handlers.serverSignIn({ type: 'serverSignIn', baseUrl: 'ai.example.org' }, page());

    expect(mocks.signIn).toHaveBeenCalledWith('ai.example.org');
    expect((await readDevice()).aiSource).toStrictEqual({ kind: 'server', baseUrl: ORIGIN });
    expect(res).toStrictEqual({
      ok: true,
      account: {
        origin: ORIGIN,
        email: 'ada@example.org',
        signedInAt: NOW,
        needsSignIn: false,
        label: serverLabel(ORIGIN, INFO),
      },
    });
    // Pages never receive credentials, nor the device id that names this browser on the server.
    const keys = keysDeep(res);
    for (const key of ['deviceId', 'refresh_token', 'access_token', 'device_id']) expect(keys).not.toContain(key);
    expect(JSON.stringify(res)).not.toContain(DEVICE_ID);
  });

  it('test_server_sign_in_failure_keeps_source', async () => {
    await setSource({ kind: 'anthropic', model: null });
    const query = vi.spyOn(fakeBrowser.tabs, 'query');
    const error = { code: 'auth-required', message: 'Sign-in was cancelled.' };
    mocks.signIn.mockResolvedValue({ ok: false, error });

    expect(await handlers.serverSignIn({ type: 'serverSignIn', baseUrl: ORIGIN }, page())).toStrictEqual({ ok: false, error });
    expect((await readDevice()).aiSource).toStrictEqual({ kind: 'anthropic', model: null });
    // Nothing changed, so feed tabs are left alone.
    expect(query).not.toHaveBeenCalled();
  });

  it('test_sign_in_again_resumes_feed_tabs', async () => {
    // Feed tabs are paused on "Sign in to ai.example.org again"; the source stays the same server.
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    const stored = await deviceItem.getValue();
    const feedTabs = [tab(7, 'https://www.linkedin.com/feed/'), tab(9, 'https://www.facebook.com/')];
    const query = vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => feedTabs) as never);
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (tabId: number) => {
      // A tab whose content script is gone (or older than this message).
      if (tabId === 9) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true };
    }) as never);
    mocks.signIn.mockResolvedValue({ ok: true, account: account() });

    const res = await handlers.serverSignIn({ type: 'serverSignIn', baseUrl: ORIGIN }, page());
    expect(res.ok).toBe(true);
    expect(query).toHaveBeenCalledWith({ url: FEED_URLS });
    expect(send.mock.calls).toStrictEqual([
      [7, { type: 'aiResume' }],
      [9, { type: 'aiResume' }],
    ]);
    // An identical device: the content scripts' storage watch has nothing to report, hence the message.
    expect(await deviceItem.getValue()).toStrictEqual(stored);
  });
});

describe('sign-out and account', () => {
  it('test_server_sign_out_turns_ai_off_for_that_server', async () => {
    mocks.signOut.mockResolvedValue(undefined);
    await serverAccountItem.setValue(account());
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    expect(await handlers.serverSignOut({ type: 'serverSignOut' }, page())).toStrictEqual({ ok: true });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect((await readDevice()).aiSource).toBeNull();

    // Another source stays as it is.
    for (const other of [
      { kind: 'anthropic', model: null },
      { kind: 'server', baseUrl: 'https://ai.example.net' },
    ] as const) {
      mocks.signOut.mockClear();
      await setSource(other);
      expect(await handlers.serverSignOut({ type: 'serverSignOut' }, page())).toStrictEqual({ ok: true });
      expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(ORIGIN);
      expect((await readDevice()).aiSource).toStrictEqual(other);
    }

    // Nobody signed in: nothing to end, and the source stays.
    mocks.signOut.mockClear();
    await serverAccountItem.removeValue();
    await setSource({ kind: 'server', baseUrl: ORIGIN });
    expect(await handlers.serverSignOut({ type: 'serverSignOut' }, page())).toStrictEqual({ ok: true });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect((await readDevice()).aiSource).toStrictEqual({ kind: 'server', baseUrl: ORIGIN });
  });

  it('test_server_account_before_and_after', async () => {
    expect(await handlers.serverAccount({ type: 'serverAccount' }, page())).toStrictEqual({ account: null });

    await serverAccountItem.setValue(account());
    const res = await handlers.serverAccount({ type: 'serverAccount' }, page());
    expect(res).toStrictEqual({
      account: {
        origin: ORIGIN,
        email: 'ada@example.org',
        signedInAt: NOW,
        needsSignIn: false,
        label: serverLabel(ORIGIN, INFO),
      },
    });
    expect(JSON.stringify(res)).not.toContain(DEVICE_ID);

    await serverAccountItem.setValue(account({ origin: PINNED_CLOUD_ORIGIN, needsSignIn: true }));
    const cloud = await handlers.serverAccount({ type: 'serverAccount' }, page());
    expect(cloud.account).toMatchObject({ needsSignIn: true, label: { title: 'UnAlgorithm Cloud', isCloud: true } });
    expect(cloud.account).not.toHaveProperty('billing');

    // A server that bills says so: Settings asks for the balance again after signing in (CL2-12).
    await serverAccountItem.setValue(account({ info: { ...INFO, billing: true } }));
    expect((await handlers.serverAccount({ type: 'serverAccount' }, page())).account?.billing).toBe(true);

    // The account sits where content scripts can write: a broken discovery document still gives a label.
    await serverAccountItem.setValue({ ...account(), info: { name: 42 } } as unknown as ServerAccount);
    const odd = await handlers.serverAccount({ type: 'serverAccount' }, page());
    expect(odd.account?.label).toStrictEqual({ title: 'ai.example.org', host: 'ai.example.org', isCloud: false });
  });
});

describe('erase everything', () => {
  it('test_erase_all_signs_out_first', async () => {
    await serverAccountItem.setValue(account());
    await usageItem.setValue(LEDGER);
    const removeAccount = vi.spyOn(serverAccountItem, 'removeValue');
    let finishSignOut!: () => void;
    mocks.signOut.mockImplementation(() => new Promise<void>((resolve) => (finishSignOut = resolve)));

    const erasing = handlers.clearData({ type: 'clearData', what: 'all' }, page());
    await vi.waitFor(() => expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(ORIGIN));
    // Ending the device needs its refresh token, which lives in the secrets store: nothing is erased yet.
    expect(mocks.clearSecrets).not.toHaveBeenCalled();
    expect(removeAccount).not.toHaveBeenCalled();
    finishSignOut();
    expect(await erasing).toStrictEqual({ ok: true });
    expect(mocks.clearSecrets).toHaveBeenCalledOnce();
    expect(mocks.signOut.mock.invocationCallOrder[0]).toBeLessThan(mocks.clearSecrets.mock.invocationCallOrder[0] ?? 0);
    expect(removeAccount).toHaveBeenCalled();
    expect(await serverAccountItem.getValue()).toBeNull();

    // A sign-out that fails stops nothing: the account and everything else are erased all the same.
    mocks.signOut.mockReset();
    mocks.clearSecrets.mockClear();
    removeAccount.mockClear();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    mocks.signOut.mockRejectedValue(new Error('The secrets store is closed.'));
    await serverAccountItem.setValue(account());
    await usageItem.setValue(LEDGER);

    expect(await handlers.clearData({ type: 'clearData', what: 'all' }, page())).toStrictEqual({ ok: true });
    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith(ORIGIN);
    expect(debug).toHaveBeenCalled();
    expect(mocks.clearSecrets).toHaveBeenCalledOnce();
    expect(removeAccount).toHaveBeenCalled();
    expect(await serverAccountItem.getValue()).toBeNull();
    expect(await usageItem.getValue()).toStrictEqual({});

    // Smaller erases leave the account alone.
    mocks.signOut.mockReset();
    await serverAccountItem.setValue(account());
    expect(await handlers.clearData({ type: 'clearData', what: 'cache' }, page())).toStrictEqual({ ok: true });
    expect(mocks.signOut).not.toHaveBeenCalled();
    expect(await serverAccountItem.getValue()).toStrictEqual(account());
  });
});
