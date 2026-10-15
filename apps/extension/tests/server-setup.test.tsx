/**
 * The server card (R25, R26, R47a): only builds made with the `UA_CLOUD` flag offer it, it never calls a self-hosted
 * server "UnAlgorithm Cloud", and no post leaves the browser before the person has seen who receives it and agreed.
 * Background messages are answered per test, the permission prompt is stubbed on the WXT fake browser, and the flag is
 * switched through a mocked `CLOUD_ENABLED` (builds set it with `define`, which Vitest doesn't apply).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type AISourceConfig, type Device, defaultDevice, defaultSettings } from '@unalgorithm/core';
import { AUTHORIZE_PAGE_PATH, type ServerInfo, TOKEN_PATH } from '@unalgorithm/protocol';
import { setupUser, type UserEvent } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AiSetup } from '../src/components/AiSetup.tsx';
import { ServerSetup } from '../src/components/ServerSetup.tsx';
import { PrivacyPane } from '../src/entrypoints/options/panes.tsx';
import { type BgRequest, type BgResponses, type PublicServerAccount, sendToBackground } from '../src/lib/messages.ts';
import { PINNED_CLOUD_ORIGIN, recipientText, serverLabel } from '../src/lib/server-label.ts';
import { manifestFor } from '../wxt.config.ts';

const flag = vi.hoisted(() => ({ cloud: false }));
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

const devKey = JSON.parse(readFileSync(resolve(import.meta.dirname, '../dev-key.json'), 'utf8')) as { key: string; id: string };
const TOM = 'tom@example.com';
const SELF_HOSTED = 'https://ai.example.org';
const NOW = Date.UTC(2026, 9, 13, 9);
const CARD_TEXT =
  'No API key needed. Sign in to UnAlgorithm Cloud (invite only during the beta) or to an UnAlgorithm server you trust.';
const WHAT_IS_SENT =
  "What is sent: the text of posts that pass your filters (up to 2,000 characters, emails and phone numbers masked), the kind of media and a shared link's site and title, whether the author is a person or a page, and your interests.";
const NEVER_SENT = "Never sent: author names, profile links, comments, images, and Facebook posts that aren't public.";
const NO_PERMISSION = 'UnAlgorithm needs permission to open the sign-in window.';

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

const device = (aiSource: AISourceConfig | null = null): Device => ({ ...defaultDevice('dev1'), aiSource });
const account = (origin: string, over: Partial<PublicServerAccount> = {}): PublicServerAccount => ({
  origin,
  email: TOM,
  signedInAt: NOW,
  needsSignIn: false,
  label: serverLabel(origin, INFO),
  ...over,
});

type Replies = { [K in BgRequest['type']]?: (msg: Extract<BgRequest, { type: K }>) => BgResponses[K] };
let replies: Replies;
/** Every background message and permission prompt, in order. */
let events: string[];
let permission: MockInstance;

const sent = () => vi.mocked(sendToBackground).mock.calls.map(([msg]) => msg);
const sentTypes = () => sent().map((msg) => msg.type);

beforeEach(() => {
  fakeBrowser.reset();
  flag.cloud = true;
  events = [];
  replies = {
    onDeviceStatus: () => ({ availability: 'no-api' }),
    serverAccount: () => ({ account: null }),
    serverDiscover: (msg) => ({
      ok: true,
      origin: new URL(msg.baseUrl).origin,
      label: serverLabel(msg.baseUrl, INFO),
      info: INFO,
    }),
    serverSignIn: (msg) => ({ ok: true, account: account(msg.baseUrl) }),
    serverSignOut: () => ({ ok: true }),
    saveSource: () => ({ ok: true }),
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function renderSetup(dev = device()) {
  const onSaved = vi.fn();
  const user = setupUser();
  render(<ServerSetup device={dev} onSaved={onSaved} />);
  return { onSaved, user };
}

/** From the address step to the consent step for `baseUrl` (the prefilled Cloud address when omitted). */
async function continueTo(user: UserEvent, baseUrl?: string) {
  const field = await screen.findByLabelText('Server address');
  if (baseUrl !== undefined) {
    await user.clear(field);
    await user.type(field, baseUrl);
  }
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.findByRole('button', { name: 'Sign in and turn on' });
}

/** Presses Tab until `target` has the focus; fails when it never does. */
async function tabTo(user: UserEvent, target: HTMLElement) {
  for (let i = 0; i < 20 && document.activeElement !== target; i++) await user.tab();
  expect(document.activeElement).toBe(target);
}

describe('flag', () => {
  it('test_card_disabled_without_flag', async () => {
    flag.cloud = false;
    render(<AiSetup device={device()} />);
    const card = screen.getByRole('radio', { name: /^UnAlgorithm Cloud/ }) as HTMLInputElement;
    expect(card.disabled).toBe(true);
    expect(card.closest('.ua-choice')?.textContent).toBe(
      'UnAlgorithm CloudComing soonNothing to set up and works on all your devices. Pay only for what you use.',
    );
    expect(screen.queryByText('UnAlgorithm server')).toBeNull();
    expect(screen.queryByLabelText('Server address')).toBeNull();
    await waitFor(() => expect(sentTypes()).toContain('onDeviceStatus'));
    expect(sentTypes()).not.toContain('serverAccount');
  });

  it('test_card_enabled_with_flag_prefills_cloud', async () => {
    render(<AiSetup device={device()} />);
    const card = screen.getByRole('radio', { name: /^UnAlgorithm server/ }) as HTMLInputElement;
    expect(card.disabled).toBe(false);
    expect(screen.queryByText('Coming soon')).toBeNull();
    fireEvent.click(card);
    expect(card.checked).toBe(true);
    const field = (await screen.findByLabelText('Server address')) as HTMLInputElement;
    expect(field.value).toBe(PINNED_CLOUD_ORIGIN);
  });

  it('test_card_names_server_not_cloud', async () => {
    replies.serverAccount = () => ({ account: account(SELF_HOSTED) });
    render(<AiSetup device={device({ kind: 'server', baseUrl: SELF_HOSTED })} />);
    const card = screen.getByRole('radio', { name: /^UnAlgorithm server/ }) as HTMLInputElement;
    expect(card.checked).toBe(true);
    const choice = card.closest('.ua-choice');
    expect(choice?.querySelector('.ua-choice-title')?.textContent).toBe('UnAlgorithm server');
    expect(screen.getByText(CARD_TEXT)).toBeTruthy();
    expect(screen.getByText('In use · ai.example.org')).toBeTruthy();
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(screen.queryByText('UnAlgorithm Cloud')).toBeNull();
    for (const claim of ['Pay only', 'all your devices']) expect(document.body.textContent).not.toContain(claim);
  });

  it('test_erase_dialog_names_server_sign_out', async () => {
    // `as never`: spyOn picks the callback overload, typed as returning void.
    vi.spyOn(fakeBrowser.permissions, 'getAll').mockResolvedValue({ origins: [], permissions: [] } as never);
    const keys = 'stats, AI usage history and saved API keys from this browser';
    for (const [cloud, description] of [
      [true, `${keys}, and signs it out of any UnAlgorithm server. This can't be undone.`],
      // Store builds have no server card, so nobody can be signed in to a server.
      [false, `${keys}. This can't be undone.`],
    ] as const) {
      flag.cloud = cloud;
      render(<PrivacyPane settings={defaultSettings()} device={device()} />);
      // The dialog stays in the page while closed (jsdom has no `showModal`).
      const dialog = screen.getByRole('alertdialog', { hidden: true });
      expect(dialog.textContent).toContain(description);
      cleanup();
    }
  });
});

describe('flow', () => {
  it('test_continue_discovers_and_shows_errors', async () => {
    const { user } = renderSetup();
    replies.serverDiscover = () => ({
      ok: false,
      error: { code: 'unsupported', message: "That address isn't an UnAlgorithm server." },
    });
    const field = (await screen.findByLabelText('Server address')) as HTMLInputElement;
    expect(field.value).toBe(PINNED_CLOUD_ORIGIN);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText("That address isn't an UnAlgorithm server.")).toBeTruthy();
    expect(sent()).toContainEqual({ type: 'serverDiscover', baseUrl: PINNED_CLOUD_ORIGIN });

    await user.clear(field);
    await user.type(field, SELF_HOSTED);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(sent()).toContainEqual({ type: 'serverDiscover', baseUrl: SELF_HOSTED }));
    // Still on the address step, with the address as typed.
    expect((screen.getByLabelText('Server address') as HTMLInputElement).value).toBe(SELF_HOSTED);
    expect(screen.queryByRole('button', { name: 'Sign in and turn on' })).toBeNull();

    // A background that never answers is an error too, never a silent stop.
    vi.mocked(sendToBackground).mockRejectedValueOnce(new Error('No reply to serverDiscover'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Reload this page and try again\./)).toBeTruthy();
    expect(screen.getByLabelText('Server address')).toBeTruthy();
  });

  it('test_consent_cloud_vs_self_hosted', async () => {
    const { user } = renderSetup();
    await continueTo(user);
    expect(screen.getByRole('heading', { name: 'UnAlgorithm Cloud' })).toBeTruthy();
    expect(screen.getByText(recipientText(serverLabel(PINNED_CLOUD_ORIGIN)).text)).toBeTruthy();
    expect(screen.getByText('Invite only')).toBeTruthy();
    expect(screen.getByText('UnAlgorithm Cloud is invite-only during the beta.')).toBeTruthy();
    expect(screen.getByText(WHAT_IS_SENT)).toBeTruthy();
    expect(screen.getByText(NEVER_SENT)).toBeTruthy();
    // The discovery name is never shown for the Cloud, and nothing is signed in yet.
    expect(screen.queryByText(INFO.name)).toBeNull();
    expect(sentTypes()).not.toContain('serverSignIn');
    expect(permission).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await continueTo(user, SELF_HOSTED);
    expect(screen.getByRole('heading', { name: 'ai.example.org' })).toBeTruthy();
    expect(screen.getByText(INFO.name)).toBeTruthy();
    const text = recipientText(serverLabel(SELF_HOSTED)).text;
    expect(text).toContain('not HeitechSoft');
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(WHAT_IS_SENT)).toBeTruthy();
    expect(screen.getByText(NEVER_SENT)).toBeTruthy();
    expect(screen.queryByText('Invite only')).toBeNull();
    expect(document.body.textContent).not.toContain('UnAlgorithm Cloud');
  });

  it('test_permission_requested_before_sign_in', async () => {
    let { user } = renderSetup();
    fireEvent.click(await continueTo(user));
    // The prompt opens from the click itself, before anything else is awaited: Chrome needs the user gesture.
    expect(permission).toHaveBeenCalledWith({ permissions: ['identity'] });
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(events.slice(events.indexOf('serverDiscover') + 1)).toEqual(['permission', 'serverSignIn']);
    cleanup();

    // Denied: the reason is shown on the consent step and nothing is sent.
    permission.mockImplementation((async () => false) as never);
    vi.mocked(sendToBackground).mockClear();
    ({ user } = renderSetup());
    await user.click(await continueTo(user));
    expect(await screen.findByText(NO_PERMISSION)).toBeTruthy();
    expect(sentTypes()).not.toContain('serverSignIn');
    expect(screen.getByRole('button', { name: 'Sign in and turn on' })).toBeTruthy();
  });

  it('test_sign_in_success_and_failure', async () => {
    let { user, onSaved } = renderSetup();
    await user.click(await continueTo(user));
    expect(await screen.findByText('Signed in as tom@example.com')).toBeTruthy();
    expect(screen.getByText('UnAlgorithm Cloud')).toBeTruthy();
    expect(sent()).toContainEqual({ type: 'serverSignIn', baseUrl: PINNED_CLOUD_ORIGIN });
    expect(onSaved).toHaveBeenCalledWith({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN });
    cleanup();

    replies.serverSignIn = () => ({ ok: false, error: { code: 'auth-required', message: 'Sign-in was cancelled.' } });
    ({ user, onSaved } = renderSetup());
    await user.click(await continueTo(user));
    expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in and turn on' })).toBeTruthy();
    expect(screen.getByText(WHAT_IS_SENT)).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('test_sign_in_again_banner', async () => {
    replies.serverAccount = () => ({ account: account(PINNED_CLOUD_ORIGIN, { needsSignIn: true }) });
    const { user, onSaved } = renderSetup(device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN }));
    expect(await screen.findByText('Sign in to UnAlgorithm Cloud again.')).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(permission).toHaveBeenCalledWith({ permissions: ['identity'] });
    expect(events.slice(events.indexOf('serverAccount') + 1)).toEqual(['permission', 'serverSignIn']);
    expect(sent()).toContainEqual({ type: 'serverSignIn', baseUrl: PINNED_CLOUD_ORIGIN });
    // Consent was given for this origin before: no discovery, no consent step.
    expect(sentTypes()).not.toContain('serverDiscover');
    expect(screen.queryByText(WHAT_IS_SENT)).toBeNull();
    expect(screen.queryByText('Sign in to UnAlgorithm Cloud again.')).toBeNull();
    expect(onSaved).toHaveBeenCalledWith({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN });
  });

  it('test_sign_out_returns_to_address', async () => {
    replies.serverAccount = () => ({ account: account(PINNED_CLOUD_ORIGIN) });
    const { user } = renderSetup(device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN }));
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const field = (await screen.findByLabelText('Server address')) as HTMLInputElement;
    expect(field.value).toBe(PINNED_CLOUD_ORIGIN);
    expect(sent()).toContainEqual({ type: 'serverSignOut' });
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    cleanup();

    // Also from "Sign in again".
    replies.serverAccount = () => ({ account: account(SELF_HOSTED, { needsSignIn: true }) });
    renderSetup(device({ kind: 'server', baseUrl: SELF_HOSTED }));
    expect(await screen.findByText('Sign in to ai.example.org again.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Server address')).toBeTruthy();
  });

  it('test_signed_in_but_off_turns_on', async () => {
    replies.serverAccount = () => ({ account: account(PINNED_CLOUD_ORIGIN) });
    const onSaved = vi.fn();
    const user = setupUser();
    render(<AiSetup device={device({ kind: 'anthropic', model: null })} onSaved={onSaved} />);
    await user.click(screen.getByRole('radio', { name: /^UnAlgorithm server/ }));
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    const server = { kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN };
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(server));
    expect(sent()).toContainEqual({ type: 'saveSource', config: server });
    expect(sentTypes()).not.toContain('serverSignIn');
    expect(permission).not.toHaveBeenCalled();
    cleanup();

    // Already the source: nothing to turn on.
    renderSetup(device({ kind: 'server', baseUrl: PINNED_CLOUD_ORIGIN }));
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });

  it('test_keyboard_and_labels', async () => {
    const onSaved = vi.fn();
    const user = setupUser();
    render(<AiSetup device={device()} onSaved={onSaved} />);

    // Into the card group (on "Off, rules only"), then the arrow keys pick the server card.
    await tabTo(user, screen.getByRole('radio', { name: /^Off, rules only/ }));
    await user.keyboard('{ArrowDown}');
    const card = screen.getByRole('radio', { name: /^UnAlgorithm server/ }) as HTMLInputElement;
    expect(card.checked).toBe(true);

    // Address: a visible label, and Enter in the field continues.
    const field = await screen.findByLabelText('Server address');
    expect(screen.getByText('Server address', { selector: 'label' }).className).not.toContain('ua-vh');
    await tabTo(user, field);
    await tabTo(user, screen.getByRole('button', { name: 'Continue' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(field);
    await user.keyboard('{Enter}');

    // Consent: both buttons by Tab; Cancel goes back, then "Sign in and turn on" with Enter.
    await tabTo(user, await screen.findByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Enter}');
    await tabTo(user, await screen.findByRole('button', { name: 'Continue' }));
    await user.keyboard('{Enter}');
    await tabTo(user, await screen.findByRole('button', { name: 'Sign in and turn on' }));
    await user.keyboard('{Enter}');

    // Signed in: "Turn on" (AI is off here) and "Sign out", each with the keyboard.
    expect(await screen.findByText(`Signed in as ${TOM}`)).toBeTruthy();
    await tabTo(user, screen.getByRole('button', { name: 'Turn on' }));
    await user.keyboard(' ');
    await waitFor(() =>
      expect(sent()).toContainEqual({ type: 'saveSource', config: expect.objectContaining({ kind: 'server' }) }),
    );
    await tabTo(user, screen.getByRole('button', { name: 'Sign out' }));
    await user.keyboard('{Enter}');
    expect(await screen.findByLabelText('Server address')).toBeTruthy();
    expect(sentTypes()).toEqual(expect.arrayContaining(['serverDiscover', 'serverSignIn', 'saveSource', 'serverSignOut']));
  });
});

describe('manifest', () => {
  const CHROMIUMAPP = `https://${devKey.id}.chromiumapp.org/*`;
  const permissionsOf = (m: ReturnType<typeof manifestFor>) => [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];

  it('test_manifest_for_modes', () => {
    expect(devKey.id).toBe('aokmlebkpkeniofcnbeajmgabinicggm');

    vi.stubEnv('UA_CLOUD', undefined);
    const store = manifestFor('production');
    expect(permissionsOf(store)).not.toContain('identity');
    expect(store).not.toHaveProperty('key');
    expect(manifestFor('production').host_permissions?.join(' ')).not.toContain('chromiumapp.org');

    vi.stubEnv('UA_CLOUD', '1');
    const cloud = manifestFor('production');
    expect(cloud.optional_permissions).toContain('identity');
    expect(cloud.permissions).not.toContain('identity');
    expect(cloud).not.toHaveProperty('key');
    expect(cloud.host_permissions?.join(' ')).not.toContain('chromiumapp.org');
    // Everything else is the store manifest, apart from sync's `alarms` (CL3-20).
    expect(store.permissions).not.toContain('alarms');
    expect(cloud.permissions).toContain('alarms');
    const withoutAlarms = cloud.permissions?.filter((p) => p !== 'alarms');
    expect({ ...cloud, optional_permissions: undefined, permissions: withoutAlarms }).toEqual({
      ...store,
      optional_permissions: undefined,
    });
    vi.unstubAllEnvs();

    for (const env of [undefined, '1']) {
      vi.stubEnv('UA_CLOUD', env);
      const dev = manifestFor('development');
      expect(dev.permissions).toContain('alarms');
      expect(dev.optional_permissions).toContain('identity');
      expect(dev.permissions).not.toContain('identity');
      expect(dev).toHaveProperty('key', devKey.key);
      expect(dev.host_permissions?.join(' ')).not.toContain('chromiumapp.org');

      // Playwright can't answer a permission prompt, and the e2e sign-in tab reports its redirect only to a host
      // permission for it (CL1-16).
      const e2e = manifestFor('e2e');
      expect(e2e.permissions).toContain('alarms');
      expect(e2e.permissions).toContain('identity');
      expect(e2e.optional_permissions ?? []).not.toContain('identity');
      expect(e2e).toHaveProperty('key', devKey.key);
      expect(e2e.host_permissions).toContain(CHROMIUMAPP);
      expect(e2e.host_permissions).toContain('http://127.0.0.1/*');
      expect(e2e.permissions).not.toContain('tabs');
    }
  });
});
