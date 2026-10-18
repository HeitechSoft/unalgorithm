/**
 * The sync switch, the sync status and the devices on the server card (CL3-22; R11, R15, R17, R47a). Background
 * messages are answered per test, the permission prompt is stubbed on the WXT fake browser, and the flag is switched
 * through a mocked `CLOUD_ENABLED`, as in server-setup.test.tsx. Dialogs run on the jsdom stand-in
 * (@unalgorithm/ui/test-support/dialog): Escape is a `cancel` event on the dialog.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type AISourceConfig, type Device, defaultDevice, defaultSettings } from '@unalgorithm/core';
import type { AccountDevice } from '@unalgorithm/protocol';
import { ToastProvider } from '@unalgorithm/ui';
import { setupUser, type UserEvent } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { syncedText } from '../src/components/AccountSync.tsx';
import { AiSetup } from '../src/components/AiSetup.tsx';
import { DeviceList } from '../src/components/DeviceList.tsx';
import { ServerSetup } from '../src/components/ServerSetup.tsx';
import { PrivacyPane } from '../src/entrypoints/options/panes.tsx';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import {
  type BgRequest,
  type BgResponses,
  type PublicServerAccount,
  type SyncStatus,
  sendToBackground,
} from '../src/lib/messages.ts';
import { accountPageUrl, PINNED_CLOUD_ORIGIN, serverLabel } from '../src/lib/server-label.ts';
import { DEFAULT_SYNC_STATE, type SyncProblem, syncStateItem } from '../src/lib/storage.ts';

const flag = vi.hoisted(() => ({ cloud: true }));
// Vitest builds for Chrome; the Firefox cases switch `browserKind()`.
const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
}));
vi.mock('../src/components/ServerSetup.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/ServerSetup.tsx')>();
  return {
    ...actual,
    get CLOUD_ENABLED() {
      return flag.cloud;
    },
  };
});
vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(),
}));

const TOM = 'tom@example.com';
const SELF_HOSTED = 'https://ai.example.org';
const NOW = Date.UTC(2026, 9, 13, 9);
const SWITCH = 'Sync settings between your computers';
const OFF: SyncStatus = { available: true, enabled: false, state: 'off', lastSyncAt: null };
const LAPTOP: AccountDevice = {
  id: '0190a1b2-0000-7000-8000-000000000001',
  name: 'Laptop',
  createdAt: '2026-10-01T09:00:00.000Z',
  lastUsedAt: '2026-10-13T09:00:00.000Z',
  current: true,
};
const WORK: AccountDevice = { ...LAPTOP, id: '0190a1b2-0000-7000-8000-000000000002', name: 'Work PC', current: false };
const OLD: AccountDevice = { ...WORK, id: '0190a1b2-0000-7000-8000-000000000003', name: null, lastUsedAt: null };

const device = (aiSource: AISourceConfig | null = null): Device => ({ ...defaultDevice('dev1'), aiSource });
const account = (origin: string): PublicServerAccount => ({
  origin,
  email: TOM,
  signedInAt: NOW,
  needsSignIn: false,
  label: serverLabel(origin),
});

type Replies = { [K in BgRequest['type']]?: (msg: Extract<BgRequest, { type: K }>) => BgResponses[K] };
let replies: Replies;
/** Every background message and permission prompt, in order. */
let events: string[];
let permission: MockInstance;
let showModal: MockInstance;

const sent = () => vi.mocked(sendToBackground).mock.calls.map(([msg]) => msg);
const sentTypes = () => sent().map((msg) => msg.type);

beforeEach(() => {
  fakeBrowser.reset();
  env.kind = 'chrome';
  flag.cloud = true;
  events = [];
  replies = {
    serverAccount: () => ({ account: account(PINNED_CLOUD_ORIGIN) }),
    syncStatus: () => OFF,
    syncSetEnabled: (msg) => ({ ...OFF, enabled: msg.enabled, state: msg.enabled ? 'ok' : 'off', lastSyncAt: NOW }),
    syncNow: () => OFF,
    serverDevices: () => ({ ok: true, devices: [LAPTOP, WORK, OLD] }),
    serverRevokeDevice: () => ({ ok: true, signedOut: false }),
    serverSignIn: (msg) => ({ ok: true, account: account(msg.baseUrl) }),
    onDeviceStatus: () => ({ availability: 'no-api' }),
  };
  vi.mocked(sendToBackground).mockReset();
  vi.mocked(sendToBackground).mockImplementation(async (msg) => {
    events.push(msg.type);
    const reply = replies[msg.type] as ((m: BgRequest) => unknown) | undefined;
    if (!reply) throw new Error(`No reply to ${msg.type}`);
    return reply(msg) as never;
  });
  // `as never`: spyOn picks the callback overload, typed as returning void.
  permission = vi.spyOn(fakeBrowser.permissions, 'request').mockImplementation((async () => {
    events.push('permission');
    return true;
  }) as never);
  showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The card for an account at `origin` (the Cloud when omitted), signed in, with AI on that server. */
async function renderCard(origin = PINNED_CLOUD_ORIGIN) {
  replies.serverAccount = () => ({ account: account(origin) });
  const user = setupUser();
  render(
    <ToastProvider>
      <ServerSetup device={device({ kind: 'server', baseUrl: origin })} />
    </ToastProvider>,
  );
  const toggle = await screen.findByRole('switch', { name: SWITCH });
  await screen.findByText(WORK.name as string);
  return { user, toggle };
}

/** By its title: a closed dialog is hidden, and Testing Library names hidden elements "". */
function dialogNamed(title: string): HTMLDialogElement {
  const dialog = Array.from(document.querySelectorAll('dialog')).find((d) => d.getAttribute('aria-label') === title);
  if (!dialog) throw new Error(`No dialog "${title}"`);
  return dialog;
}

/** Presses Tab until `target` has the focus; fails when it never does. */
async function tabTo(user: UserEvent, target: HTMLElement) {
  for (let i = 0; i < 30 && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement).toBe(target);
}

describe('flag', () => {
  it('test_no_account_ui_without_flag', async () => {
    flag.cloud = false;
    render(<AiSetup device={device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN })} />);
    await waitFor(() => expect(sentTypes()).toContain('onDeviceStatus'));
    expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull();
    expect(screen.queryByText(/Devices signed in to/)).toBeNull();
    expect(screen.queryByText('Manage your account')).toBeNull();
    expect(sentTypes()).not.toContain('syncStatus');
    expect(sentTypes()).not.toContain('serverDevices');
  });
});

describe('sync switch', () => {
  it('test_signed_in_card_shows_sync_and_devices', async () => {
    const { toggle } = await renderCard();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Your settings stay on this computer.')).toBeTruthy();
    expect(screen.getByText('Devices signed in to unAlgorithm Cloud')).toBeTruthy();
    const current = screen.getByText('Laptop').closest('.ua-row') as HTMLElement;
    expect(within(current).getByText('This computer')).toBeTruthy();
    expect(within(current).queryByRole('button')).toBeNull();
    const work = screen.getByText('Work PC').closest('.ua-row') as HTMLElement;
    expect(within(work).getByText(/^Last used /).textContent).not.toContain('not yet');
    expect(within(work).getByRole('button', { name: 'Revoke Work PC' })).toBeTruthy();
    const old = screen.getByText('Unnamed device').closest('.ua-row') as HTMLElement;
    expect(within(old).getByText('Last used not yet')).toBeTruthy();

    const link = screen.getByRole('link', { name: 'Manage your account' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://cloud.unalgorithm.app/account');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');

    expect(accountPageUrl(PINNED_CLOUD_ORIGIN)).toBe('https://cloud.unalgorithm.app/account');
    expect(accountPageUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/account');
    expect(accountPageUrl('http://ai.example.org')).toBeNull();
    cleanup();

    // A plain-http remote server gets no link.
    render(<DeviceList account={account('http://ai.example.org')} onSignInAgain={vi.fn()} onSignedOut={vi.fn()} />);
    expect(await screen.findByText('Work PC')).toBeTruthy();
    expect(screen.queryByText('Manage your account')).toBeNull();
  });

  it('test_sync_on_needs_disclosure', async () => {
    const { user, toggle } = await renderCard();
    await user.click(toggle);
    const dialog = dialogNamed('Turn on sync?');
    expect(dialog.open).toBe(true);
    expect(showModal).toHaveBeenCalled();
    for (const words of [
      'the names of people you always show or hide',
      'API keys and sign-in tokens never leave this computer',
      'saved on unAlgorithm Cloud',
      'What unAlgorithm learned from your feedback stays on this computer too.',
    ]) {
      expect(dialog.textContent).toContain(words);
    }
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.open).toBe(false);
    expect(sentTypes()).not.toContain('syncSetEnabled');
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: 'Turn on sync' }));
    expect(dialog.open).toBe(false);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(sent()).toContainEqual({ type: 'syncSetEnabled', enabled: true });
  });

  it('test_sync_off_without_dialog', async () => {
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'ok', lastSyncAt: Date.now() });
    const { user, toggle } = await renderCard();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(dialogNamed('Turn on sync?').open).toBe(false);
    expect(sent()).toContainEqual({ type: 'syncSetEnabled', enabled: false });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByText('Your settings stay on this computer.')).toBeTruthy();
  });

  it('test_sync_status_lines_and_retry', async () => {
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'syncing', lastSyncAt: null });
    await renderCard();
    expect(screen.getByText('Syncing…')).toBeTruthy();
    cleanup();

    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'ok', lastSyncAt: Date.now() - 5_000 });
    await renderCard();
    expect(screen.getByText('Synced just now')).toBeTruthy();
    cleanup();

    expect(syncedText(NOW - 30_000, NOW)).toBe('Synced just now');
    expect(syncedText(NOW - 60_000, NOW)).toBe('Synced 1 minute ago');
    expect(syncedText(NOW - 5 * 60_000, NOW)).toBe('Synced 5 minutes ago');
    expect(syncedText(NOW - 2 * 3_600_000, NOW)).toMatch(/^Synced at /);

    for (const problem of ['network', 'quota', 'clock', 'server', 'unavailable'] as const satisfies SyncProblem[]) {
      const message = `The ${problem} message.`;
      replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'problem', lastSyncAt: null, problem, message });
      vi.mocked(sendToBackground).mockClear();
      const { user } = await renderCard();
      const banner = screen.getByText(message).closest('.ua-banner') as HTMLElement;
      expect(within(banner).queryByRole('button', { name: 'Sign in again' })).toBeNull();
      await user.click(within(banner).getByRole('button', { name: 'Try again' }));
      expect(sent()).toContainEqual({ type: 'syncNow' });
      cleanup();
    }
  });

  it('test_status_follows_storage', async () => {
    const { toggle } = await renderCard();
    expect(screen.getByText('Your settings stay on this computer.')).toBeTruthy();
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'ok', lastSyncAt: Date.now() });
    await act(() => syncStateItem.setValue({ ...DEFAULT_SYNC_STATE, enabled: true, lastSyncAt: Date.now() }));
    expect(await screen.findByText('Synced just now')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('naming', () => {
  it('test_self_hosted_server_named_by_host', async () => {
    const { user, toggle } = await renderCard(SELF_HOSTED);
    expect(dialogNamed('Turn on sync?').textContent).toContain('saved on ai.example.org and kept the same');
    expect(screen.getByText('Devices signed in to ai.example.org')).toBeTruthy();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Revoke Work PC' }));
    expect(dialogNamed('Revoke Work PC?').textContent).toContain(
      "It's signed out at once and has to sign in again to use ai.example.org.",
    );
    expect(document.body.textContent).not.toContain('unAlgorithm Cloud');
  });
});

describe('devices', () => {
  it('test_revoke_other_device_confirmed', async () => {
    const { user } = await renderCard();
    expect(screen.queryByRole('button', { name: 'Revoke Laptop' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Revoke Work PC' }));
    const dialog = dialogNamed('Revoke Work PC?');
    expect(dialog.open).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.open).toBe(false);
    expect(sentTypes()).not.toContain('serverRevokeDevice');

    await user.click(screen.getByRole('button', { name: 'Revoke Work PC' }));
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Revoked.')).toBeTruthy();
    expect(sent()).toContainEqual({ type: 'serverRevokeDevice', deviceId: WORK.id });
    expect(screen.queryByText('Work PC')).toBeNull();
    expect(screen.getByText('Laptop')).toBeTruthy();
    expect(screen.getByText(`Signed in as ${TOM}`)).toBeTruthy();
  });

  it('test_self_revoke_returns_to_address', async () => {
    replies.serverRevokeDevice = () => ({ ok: true, signedOut: true });
    const { user } = await renderCard();
    await user.click(screen.getByRole('button', { name: 'Revoke Work PC' }));
    await user.click(within(dialogNamed('Revoke Work PC?')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByLabelText('Server address')).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });
});

describe('sign in again', () => {
  it('test_auth_problem_offers_sign_in_again', async () => {
    const message = 'Sign in to unAlgorithm Cloud again to keep syncing.';
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'problem', lastSyncAt: null, problem: 'auth', message });
    replies.serverDevices = () => ({ ok: false, error: { code: 'auth-required', message: 'Sign in again to see devices.' } });
    replies.serverAccount = () => ({ account: account(PINNED_CLOUD_ORIGIN) });
    render(<ServerSetup device={device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN })} />);

    const syncBanner = (await screen.findByText(message)).closest('.ua-banner') as HTMLElement;
    expect(within(syncBanner).queryByRole('button', { name: 'Try again' })).toBeNull();
    // A plain click event: the prompt must open before anything else is awaited (Chrome needs the user gesture).
    fireEvent.click(within(syncBanner).getByRole('button', { name: 'Sign in again' }));
    expect(permission).toHaveBeenCalledWith({ permissions: ['identity'] });
    await waitFor(() => expect(sentTypes()).toContain('serverSignIn'));
    expect(events.slice(events.indexOf('permission'), events.indexOf('serverSignIn') + 1)).toEqual([
      'permission',
      'serverSignIn',
    ]);
    cleanup();

    events = [];
    permission.mockClear();
    render(<ServerSetup device={device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN })} />);
    const devicesBanner = (await screen.findByText('Sign in again to see devices.')).closest('.ua-banner') as HTMLElement;
    fireEvent.click(within(devicesBanner).getByRole('button', { name: 'Sign in again' }));
    expect(permission).toHaveBeenCalledWith({ permissions: ['identity'] });
    await waitFor(() => expect(sentTypes()).toContain('serverSignIn'));
    expect(events.indexOf('permission')).toBeLessThan(events.indexOf('serverSignIn'));
  });
});

describe('firefox consent', () => {
  // Never technical and interaction data: Firefox offers it at install, and the extension never asks for it.
  const CLOUD_DATA = ['websiteContent', 'personalCommunications', 'personallyIdentifyingInfo', 'authenticationInfo'];

  /**
   * Firefox, with the consent `getAll()` reports (standing unless told otherwise; the server card's own banner stays
   * out of these tests). Returns the change: Firefox's add-ons page, as the permission events report it.
   */
  function firefox(granted = CLOUD_DATA) {
    env.kind = 'firefox';
    const consent = { granted };
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
      origins: [],
      permissions: [],
      data_collection: consent.granted,
    })) as never);
    const listeners = new Set<() => void>();
    for (const event of [fakeBrowser.permissions.onAdded, fakeBrowser.permissions.onRemoved]) {
      vi.spyOn(event, 'addListener').mockImplementation(((l: () => void) => void listeners.add(l)) as never);
      vi.spyOn(event, 'removeListener').mockImplementation(((l: () => void) => void listeners.delete(l)) as never);
    }
    return (next: string[]) => {
      consent.granted = next;
      for (const l of listeners) l();
    };
  }

  it('test_firefox_sync_on_asks_consent_from_the_click', async () => {
    firefox();
    const { user, toggle } = await renderCard();
    await user.click(toggle);
    fireEvent.click(within(dialogNamed('Turn on sync?')).getByRole('button', { name: 'Turn on sync' }));
    expect(permission).toHaveBeenCalledExactlyOnceWith({ data_collection: CLOUD_DATA });
    await waitFor(() => expect(sent()).toContainEqual({ type: 'syncSetEnabled', enabled: true }));
    expect(events.indexOf('permission')).toBeLessThan(events.indexOf('syncSetEnabled'));
    cleanup();

    // Declined: sync stays off and says why.
    permission.mockImplementation((async () => false) as never);
    vi.mocked(sendToBackground).mockClear();
    const again = await renderCard();
    await again.user.click(again.toggle);
    await again.user.click(within(dialogNamed('Turn on sync?')).getByRole('button', { name: 'Turn on sync' }));
    expect(await screen.findByText('unAlgorithm needs your permission to send your settings to the server.')).toBeTruthy();
    expect(sentTypes()).not.toContain('syncSetEnabled');
    expect(again.toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('test_consent_problem_offers_allow', async () => {
    firefox();
    const message = 'unAlgorithm needs your permission to send your settings to unAlgorithm Cloud.';
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'problem', lastSyncAt: null, problem: 'consent', message });
    await renderCard();
    const banner = screen.getByText(message).closest('.ua-banner') as HTMLElement;
    expect(within(banner).queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Allow' }));
    expect(permission).toHaveBeenCalledExactlyOnceWith({ data_collection: CLOUD_DATA });
    await waitFor(() => expect(sent()).toContainEqual({ type: 'syncNow' }));
    expect(events.indexOf('permission')).toBeLessThan(events.indexOf('syncNow'));
  });

  it('test_chrome_sync_on_asks_nothing', async () => {
    const { user, toggle } = await renderCard();
    await user.click(toggle);
    await user.click(within(dialogNamed('Turn on sync?')).getByRole('button', { name: 'Turn on sync' }));
    await waitFor(() => expect(sent()).toContainEqual({ type: 'syncSetEnabled', enabled: true }));
    expect(permission).not.toHaveBeenCalled();
  });

  it('test_firefox_device_list_offers_allow', async () => {
    // Withdrawn in Firefox's add-ons page: the background asks the server nothing and says so.
    const change = firefox(['websiteContent', 'personalCommunications']);
    const title = 'unAlgorithm needs your permission to send your account details to unAlgorithm Cloud.';
    let granted = false;
    replies.serverDevices = () =>
      granted ? { ok: true, devices: [LAPTOP, WORK] } : { ok: false, error: { code: 'host-permission', message: title } };
    replies.serverAccount = () => ({ account: account(PINNED_CLOUD_ORIGIN) });
    render(
      <ToastProvider>
        <ServerSetup device={device({ kind: 'anthropic', model: null })} />
      </ToastProvider>,
    );
    const banner = (await screen.findByText(title)).closest('.ua-banner') as HTMLElement;
    expect(screen.queryByText('Work PC')).toBeNull();

    // Declined: said, and the list isn't asked for again.
    permission.mockImplementation((async () => {
      events.push('permission');
      return false;
    }) as never);
    const asked = sentTypes().filter((t) => t === 'serverDevices').length;
    fireEvent.click(within(banner).getByRole('button', { name: 'Allow' }));
    expect(permission).toHaveBeenCalledExactlyOnceWith({ data_collection: CLOUD_DATA });
    expect(await screen.findByText('unAlgorithm needs your permission to send your account details to the server.')).toBeTruthy();
    expect(sentTypes().filter((t) => t === 'serverDevices')).toHaveLength(asked);

    // Given from the click (Firefox reports it as a permission change too): asked first, then the list.
    permission.mockImplementation((async () => {
      events.push('permission');
      granted = true;
      change(CLOUD_DATA);
      return true;
    }) as never);
    events = [];
    fireEvent.click(within(banner).getByRole('button', { name: 'Allow' }));
    expect(await screen.findByText('Work PC')).toBeTruthy();
    expect(screen.queryByText(title)).toBeNull();
    expect(events.indexOf('permission')).toBeLessThan(events.indexOf('serverDevices'));

    // Withdrawn while the page is open, then given back in Firefox's add-ons page: asked again each time.
    granted = false;
    change(['websiteContent']);
    expect(await screen.findByText(title)).toBeTruthy();
    granted = true;
    change(CLOUD_DATA);
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect(screen.getByText('Work PC')).toBeTruthy();
  });

  it('test_chrome_device_list_asked_once', async () => {
    vi.spyOn(fakeBrowser.permissions, 'getAll');
    await renderCard();
    // Chrome and Edge have no such consent: the list is asked for once, and nothing reads it.
    expect(sentTypes().filter((t) => t === 'serverDevices')).toHaveLength(1);
    expect(fakeBrowser.permissions.getAll).not.toHaveBeenCalled();
  });
});

describe('privacy pane', () => {
  const footerOf = () => screen.getByText('Where your data goes').closest('section')?.querySelector('.ua-group-footer');
  const boxes = () => Array.from(document.querySelectorAll('.flow-box'), (el) => el.textContent);

  it('test_privacy_pane_names_sync_server', async () => {
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'ok', lastSyncAt: NOW });
    render(<PrivacyPane settings={defaultSettings()} device={device()} />);
    await waitFor(() =>
      expect(footerOf()?.textContent).toBe(
        'Rules run in your browser. Your settings, interests and exceptions are synced with unAlgorithm Cloud.',
      ),
    );
    expect(boxes()).toEqual(['This browser', 'unAlgorithm Cloud']);
    expect(document.body.textContent).not.toContain('Nothing leaves your computer.');
    cleanup();

    // Beside another AI recipient.
    render(<PrivacyPane settings={defaultSettings()} device={device({ kind: 'anthropic', model: null })} />);
    await waitFor(() => expect(boxes()).toEqual(['This browser', 'Anthropic', 'unAlgorithm Cloud']));
    expect(footerOf()?.textContent).toMatch(/Your settings, interests and exceptions are synced with unAlgorithm Cloud\.$/);
    cleanup();

    // Sync off: as before.
    replies.syncStatus = () => OFF;
    render(<PrivacyPane settings={defaultSettings()} device={device()} />);
    await waitFor(() => expect(sentTypes()).toContain('syncStatus'));
    expect(footerOf()?.textContent).toBe('Rules run in your browser. Nothing leaves your computer.');
    cleanup();

    // Without the flag nothing new is sent and the pane is unchanged.
    flag.cloud = false;
    vi.mocked(sendToBackground).mockClear();
    replies.syncStatus = () => ({ ...OFF, enabled: true, state: 'ok', lastSyncAt: NOW });
    render(<PrivacyPane settings={defaultSettings()} device={device()} />);
    expect(footerOf()?.textContent).toBe('Rules run in your browser. Nothing leaves your computer.');
    expect(boxes()).toEqual(['This browser']);
    await act(() => Promise.resolve());
    expect(sentTypes()).not.toContain('syncStatus');
    expect(sentTypes()).not.toContain('serverAccount');
  });
});

describe('accessibility', () => {
  it('test_account_sync_keyboard', async () => {
    const { user, toggle } = await renderCard();
    expect(toggle.getAttribute('aria-label')).toBe(SWITCH);

    // The switch with Space opens the dialog on Cancel; Escape (a `cancel` event) closes it and sends nothing.
    await tabTo(user, toggle);
    await user.keyboard(' ');
    const sync = dialogNamed('Turn on sync?');
    expect(sync.open).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(within(sync).getByRole('button', { name: 'Cancel' }));
    act(() => {
      sync.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(sync.open).toBe(false);
    expect(document.activeElement).toBe(toggle);
    expect(sentTypes()).not.toContain('syncSetEnabled');

    // Again, then Tab to "Turn on sync" and Enter.
    await user.keyboard(' ');
    await user.tab();
    expect(document.activeElement).toBe(within(sync).getByRole('button', { name: 'Turn on sync' }));
    await user.keyboard('{Enter}');
    await waitFor(() => expect(sent()).toContainEqual({ type: 'syncSetEnabled', enabled: true }));

    // Revoke by keyboard, Escape closes it without sending.
    await tabTo(user, screen.getByRole('button', { name: 'Revoke Work PC' }));
    await user.keyboard('{Enter}');
    const revoke = dialogNamed('Revoke Work PC?');
    expect(revoke.open).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(3);
    act(() => {
      revoke.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(revoke.open).toBe(false);
    expect(sentTypes()).not.toContain('serverRevokeDevice');

    await tabTo(user, screen.getByRole('link', { name: 'Manage your account' }));
  });
});
