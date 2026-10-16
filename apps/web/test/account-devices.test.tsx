/**
 * The account page's Devices and Passkeys sections: the devices signed in to the account, each revocable after a
 * confirm dialog, and the person's passkeys, added with the browser's passkey prompt and removed after a confirm
 * dialog. `fetch` is the shared fake server (support/fake-server.ts), which keeps the account's devices and passkeys,
 * and `@simplewebauthn/browser` a mock, so each test says what the authenticator answers. Dialogs run on the jsdom
 * stand-in for `showModal` (`@unalgorithm/ui/test-support/dialog`, loaded by the setup file): Escape is a `cancel` event.
 */
import { browserSupportsWebAuthn, type RegistrationResponseJSON, startRegistration } from '@simplewebauthn/browser';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  type AccountDevice,
  CREDIT_ACCOUNT_PATH,
  type CreditAccount,
} from '@unalgorithm/protocol';
import { ToastProvider } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import {
  PASSKEY_DELETE_PATH,
  PASSKEY_LIST_PATH,
  PASSKEY_REGISTER_OPTIONS_PATH,
  PASSKEY_REGISTER_VERIFY_PATH,
} from '../src/api.ts';
import {
  ADDED_PASSKEY,
  fakeServer,
  INFO,
  type PasskeyRow,
  passkeyRow,
  REGISTER_OPTIONS,
  type Reply,
  SIGNED_IN,
  TOM,
} from './support/fake-server.ts';

vi.mock('@simplewebauthn/browser');

const DEVICES_HEADER = 'Devices signed in with UnAlgorithm Feed';
const PASSKEYS_HEADER = 'Passkeys';
const PASSKEYS_FOOTER = 'Sign in with your fingerprint, face or device PIN instead of an emailed code.';
const NO_DEVICES = 'No devices are signed in.';
const REVOKE_TEXT = "It's signed out at once and has to sign in again to use this server.";
const REMOVE_TITLE = 'Remove this passkey?';
const REMOVE_TEXT = 'You can still sign in with an emailed code.';
const NO_WEBAUTHN = "This browser can't create passkeys.";
const CANCELLED = 'Adding the passkey was cancelled.';
const ALREADY_ADDED = 'A passkey from this device is already added.';
const SIGNED_OUT = 'You were signed out. Sign in again.';
const FAILED = 'Something went wrong. Try again.';

const LAPTOP: AccountDevice = {
  id: '4f5d8a2e-6b1c-4c3d-9e8f-0a1b2c3d4e5f',
  name: 'Chrome on Windows',
  createdAt: '2026-09-02T15:00:00.000Z',
  lastUsedAt: '2026-10-13T09:30:00.000Z',
  current: false,
};
/** Signed in before devices had names (CL3-11), and never used since. */
const OLD: AccountDevice = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  name: null,
  createdAt: '2026-08-20T12:00:00.000Z',
  lastUsedAt: null,
  current: false,
};
const KEYCHAIN = passkeyRow('pk-keychain', 'iCloud Keychain', '2026-09-01T12:00:00.000Z');
const UNNAMED = passkeyRow('pk-unnamed', null, '2026-09-15T12:00:00.000Z');

/** What the authenticator hands back, as `startRegistration` returns it. */
const REGISTRATION: RegistrationResponseJSON = {
  id: 'bmV3LWNyZWRlbnRpYWw',
  rawId: 'bmV3LWNyZWRlbnRpYWw',
  response: {
    clientDataJSON: 'Y2xpZW50LWRhdGE',
    attestationObject: 'YXR0ZXN0YXRpb24',
    transports: ['internal', 'hybrid'],
  },
  type: 'public-key',
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
};

/** A day as the sections write it: in the browser's time zone, as Credits writes its days. */
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const day = (iso: string) => DAY.format(new Date(iso));

/**
 * A failed ceremony as the library reports it: its `WebAuthnError` is a plain `Error` carrying the browser error's
 * name, never a `DOMException` (the mocked module's own class would be a mock, so the shape is built here).
 */
function ceremonyError(name: string): Error {
  return Object.assign(new Error('The ceremony did not finish.'), { name, code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' });
}

/** Opens the account page signed in as TOM, with the toasts the page's root provides. */
function openAccount(
  options: { devices?: AccountDevice[]; passkeys?: PasskeyRow[]; routes?: Record<string, Reply>; billing?: boolean } = {},
) {
  const { billing = false, ...rest } = options;
  const server = fakeServer({ session: TOM, info: { ...INFO, billing }, ...rest });
  const user = setupUser();
  const view = render(
    <ToastProvider>
      <Account />
    </ToastProvider>,
  );
  return { server, user, ...view };
}

/** The list group under `header` (a `ListGroup` is a section headed by its header). */
async function group(header: string): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name: header })).closest('section') as HTMLElement;
}

/** Each row's title and subtitle, in order. */
function rows(section: HTMLElement): (string | null | undefined)[][] {
  return [...section.querySelectorAll('.ua-row')].map((row) =>
    ['.ua-row-title', '.ua-row-subtitle'].map((part) => row.querySelector(part)?.textContent),
  );
}

/** The row whose title is `title`. */
function row(section: HTMLElement, title: string): HTMLElement {
  const found = [...section.querySelectorAll<HTMLElement>('.ua-row')].find(
    (r) => r.querySelector('.ua-row-title')?.textContent === title,
  );
  if (!found) throw new Error(`No row titled ${title}`);
  return found;
}

/** The open dialog (an alert dialog) named `name`. */
function dialog(name: string): HTMLDialogElement {
  return screen.getByRole('alertdialog', { name }) as HTMLDialogElement;
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  vi.mocked(startRegistration).mockReset().mockResolvedValue(REGISTRATION);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = '';
});

describe('devices', () => {
  it('test_account_lists_devices', async () => {
    const credits: CreditAccount = {
      v: 1,
      balance: { v: 1, balanceMicros: 0, promoMicros: 0, purchasedMicros: 0, promoExpiresAt: null, starter: 'spent' },
      history: [],
    };
    const { server } = openAccount({
      devices: [LAPTOP, OLD],
      billing: true,
      routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: { status: 200, body: credits } },
    });
    const devices = await group(DEVICES_HEADER);
    await within(devices).findByText('Chrome on Windows');
    expect(rows(devices)).toEqual([
      ['Chrome on Windows', `Signed in ${day(LAPTOP.createdAt)} · Last used ${day(LAPTOP.lastUsedAt ?? '')}`],
      ['Unnamed device', `Signed in ${day(OLD.createdAt)} · Last used not yet`],
    ]);
    expect(within(devices).getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
    expect(within(devices).queryByText(NO_DEVICES)).toBeNull();
    expect(server.count('GET', ACCOUNT_DEVICES_PATH)).toBe(1);

    // Below the "Signed in as" row and the credits, and above the passkeys.
    const position = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(position(screen.getByText(SIGNED_IN), devices)).toBeTruthy();
    expect(position(screen.getByRole('region', { name: 'Credits' }), devices)).toBeTruthy();
    expect(position(devices, await group(PASSKEYS_HEADER))).toBeTruthy();
    cleanup();

    // No device signed in: the section says so, and offers nothing to revoke.
    openAccount();
    const empty = await group(DEVICES_HEADER);
    expect(await within(empty).findByText(NO_DEVICES)).toBeTruthy();
    expect(within(empty).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('test_account_revoke_device_confirmed', async () => {
    const { server, user } = openAccount({ devices: [LAPTOP, OLD] });
    const devices = await group(DEVICES_HEADER);
    await within(devices).findByText('Chrome on Windows');

    // "Cancel" has the focus, and closes the dialog having sent nothing.
    await user.click(within(row(devices, 'Chrome on Windows')).getByRole('button', { name: 'Revoke' }));
    let confirm = dialog('Revoke Chrome on Windows?');
    expect(confirm.open).toBe(true);
    expect(within(confirm).getByText(REVOKE_TEXT)).toBeTruthy();
    const cancel = within(confirm).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    // The destructive button comes after "Cancel".
    const buttons = within(confirm).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Revoke']);
    await user.click(cancel);
    expect(confirm.open).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await settle();
    expect(server.posts()).toEqual([]);
    expect(rows(devices)).toHaveLength(2);

    // "Revoke" there posts the device's id, takes its row away and says so.
    await user.click(within(row(devices, 'Chrome on Windows')).getByRole('button', { name: 'Revoke' }));
    confirm = dialog('Revoke Chrome on Windows?');
    await user.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Revoked.')).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: ACCOUNT_DEVICE_REVOKE_PATH, body: { device_id: LAPTOP.id } }]);
    expect(rows(devices).map(([title]) => title)).toEqual(['Unnamed device']);
    expect(confirm.open).toBe(false);

    // A device without a name is asked about as "this device".
    await user.click(within(row(devices, 'Unnamed device')).getByRole('button', { name: 'Revoke' }));
    await user.click(within(dialog('Revoke this device?')).getByRole('button', { name: 'Revoke' }));
    expect(await within(devices).findByText(NO_DEVICES)).toBeTruthy();
    expect(server.posts().map((c) => c.body)).toEqual([{ device_id: LAPTOP.id }, { device_id: OLD.id }]);
    // The page itself was never reloaded.
    expect(server.count('GET', ACCOUNT_DEVICES_PATH)).toBe(1);
  });

  it('a failed revoke keeps the device and says why', async () => {
    const { server, user } = openAccount({ devices: [LAPTOP], routes: { [`POST ${ACCOUNT_DEVICE_REVOKE_PATH}`]: 'offline' } });
    const devices = await group(DEVICES_HEADER);
    await user.click(await within(devices).findByRole('button', { name: 'Revoke' }));
    await user.click(within(dialog('Revoke Chrome on Windows?')).getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't reach the server. Try again.");
    expect(rows(devices).map(([title]) => title)).toEqual(['Chrome on Windows']);
    expect(screen.queryByText('Revoked.')).toBeNull();
    expect(server.count('POST', ACCOUNT_DEVICE_REVOKE_PATH)).toBe(1);
  });

  it('test_account_session_expired_returns_to_sign_in', async () => {
    const gone: Reply = { status: 401, body: { code: 'auth-required', message: 'Sign in again.' } };
    // The one-day session ended: the devices call, and separately the passkeys call, finds it gone.
    for (const path of [`GET ${ACCOUNT_DEVICES_PATH}`, `GET ${PASSKEY_LIST_PATH}`]) {
      openAccount({ devices: [LAPTOP], passkeys: [KEYCHAIN], routes: { [path]: gone } });
      expect(await screen.findByLabelText('Email')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toBe(SIGNED_OUT);
      expect(screen.getByText('Sign in to see your account.')).toBeTruthy();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      expect(screen.queryByRole('heading', { name: DEVICES_HEADER })).toBeNull();
      expect(screen.queryByRole('heading', { name: PASSKEYS_HEADER })).toBeNull();
      cleanup();
    }

    // A revoke that finds the session gone does the same.
    const { user } = openAccount({ devices: [LAPTOP], routes: { [`POST ${ACCOUNT_DEVICE_REVOKE_PATH}`]: gone } });
    await user.click(await within(await group(DEVICES_HEADER)).findByRole('button', { name: 'Revoke' }));
    await user.click(within(dialog('Revoke Chrome on Windows?')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(SIGNED_OUT);

    // Signing out on purpose is no surprise: no banner.
    cleanup();
    const out = openAccount();
    await out.user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.queryByText(SIGNED_OUT)).toBeNull();
  });

  it('test_late_401_after_sign_out_shows_no_banner', async () => {
    // Every section's first request is still in flight when the person signs out, and answers 401 only afterwards.
    let answer: (a: { status: number; body: unknown }) => void = () => undefined;
    const late = new Promise<{ status: number; body: unknown }>((resolve) => {
      answer = resolve;
    });
    const paths = [ACCOUNT_DEVICES_PATH, PASSKEY_LIST_PATH];
    const { server, user } = openAccount({ routes: Object.fromEntries(paths.map((p) => [`GET ${p}`, () => late])) });
    await waitFor(() => expect(paths.every((p) => server.calls.some((c) => c.path === p))).toBe(true));
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    answer({ status: 401, body: { code: 'auth-required', message: 'Sign in again.' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(SIGNED_OUT)).toBeNull();
    expect(screen.getByLabelText('Email')).toBeTruthy();
  });
});

describe('passkeys', () => {
  it('test_account_add_passkey', async () => {
    const { server, user } = openAccount({ passkeys: [UNNAMED] });
    const passkeys = await group(PASSKEYS_HEADER);
    await within(passkeys).findByText('Passkey');
    expect(rows(passkeys)).toEqual([['Passkey', `Added ${day(UNNAMED.createdAt ?? '')}`]]);
    expect(within(passkeys).getByText(PASSKEYS_FOOTER)).toBeTruthy();
    expect(screen.queryByText(NO_WEBAUTHN)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add a passkey' }));
    await within(passkeys).findByText('Google Password Manager');
    expect(rows(passkeys)).toEqual([
      ['Passkey', `Added ${day(UNNAMED.createdAt ?? '')}`],
      ['Google Password Manager', `Added ${day(ADDED_PASSKEY.createdAt ?? '')}`],
    ]);
    expect(await screen.findByText('Passkey added.')).toBeTruthy();
    expect(startRegistration).toHaveBeenCalledTimes(1);
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: REGISTER_OPTIONS });
    // The options first, then the authenticator's answer without a name (the server labels it), then the list again.
    expect(server.calls.slice(-3)).toEqual([
      { method: 'GET', path: PASSKEY_REGISTER_OPTIONS_PATH, body: undefined },
      { method: 'POST', path: PASSKEY_REGISTER_VERIFY_PATH, body: { response: REGISTRATION } },
      { method: 'GET', path: PASSKEY_LIST_PATH, body: undefined },
    ]);
    const optionsAt = server.fetch.mock.invocationCallOrder.at(-3) ?? 0;
    const ceremonyAt = vi.mocked(startRegistration).mock.invocationCallOrder[0] ?? 0;
    const verifyAt = server.fetch.mock.invocationCallOrder.at(-2) ?? 0;
    expect(optionsAt).toBeLessThan(ceremonyAt);
    expect(ceremonyAt).toBeLessThan(verifyAt);
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();

    // The person closes the prompt (or it times out): the library's error carries the browser's name, and nothing is posted.
    for (const name of ['NotAllowedError', 'AbortError']) {
      vi.mocked(startRegistration).mockRejectedValueOnce(ceremonyError(name));
      const cancelled = openAccount();
      await cancelled.user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
      expect((await screen.findByRole('alert')).textContent).toBe(CANCELLED);
      await settle();
      expect(cancelled.server.posts()).toEqual([]);
      expect(cancelled.server.count('GET', PASSKEY_LIST_PATH)).toBe(1);
      // The button works again.
      expect((screen.getByRole('button', { name: 'Add a passkey' }) as HTMLButtonElement).disabled).toBe(false);
      cleanup();
    }

    // This authenticator already holds a passkey for the account (the options exclude it), or something else failed.
    for (const [error, message] of [
      [ceremonyError('InvalidStateError'), ALREADY_ADDED],
      [new TypeError('Something broke'), FAILED],
    ] as const) {
      vi.mocked(startRegistration).mockRejectedValueOnce(error);
      const failed = openAccount();
      await failed.user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      await settle();
      expect(failed.server.posts()).toEqual([]);
      cleanup();
    }
  });

  it('test_account_remove_passkey', async () => {
    const { server, user } = openAccount({ passkeys: [KEYCHAIN, UNNAMED] });
    const passkeys = await group(PASSKEYS_HEADER);
    await within(passkeys).findByText('iCloud Keychain');
    expect(rows(passkeys).map(([title]) => title)).toEqual(['iCloud Keychain', 'Passkey']);

    // "Cancel" has the focus and sends nothing.
    await user.click(within(row(passkeys, 'iCloud Keychain')).getByRole('button', { name: 'Remove' }));
    let confirm = dialog(REMOVE_TITLE);
    expect(within(confirm).getByText(REMOVE_TEXT)).toBeTruthy();
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(
      within(confirm)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Cancel', 'Remove']);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(server.posts()).toEqual([]);

    // Confirmed: the passkey's id is posted and its row goes.
    await user.click(within(row(passkeys, 'iCloud Keychain')).getByRole('button', { name: 'Remove' }));
    confirm = dialog(REMOVE_TITLE);
    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Passkey removed.')).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: PASSKEY_DELETE_PATH, body: { id: KEYCHAIN.id } }]);
    expect(rows(passkeys).map(([title]) => title)).toEqual(['Passkey']);
    expect(confirm.open).toBe(false);

    // The last one: the list says there are none.
    await user.click(within(row(passkeys, 'Passkey')).getByRole('button', { name: 'Remove' }));
    await user.click(within(dialog(REMOVE_TITLE)).getByRole('button', { name: 'Remove' }));
    expect(await within(passkeys).findByText('No passkeys yet.')).toBeTruthy();
    expect(server.posts().map((c) => c.body)).toEqual([{ id: KEYCHAIN.id }, { id: UNNAMED.id }]);
  });

  it('test_account_without_webauthn', async () => {
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    const { server, user } = openAccount({ passkeys: [KEYCHAIN] });
    const passkeys = await group(PASSKEYS_HEADER);
    await within(passkeys).findByText('iCloud Keychain');
    expect(screen.getByText(NO_WEBAUTHN)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).toBeNull();
    // A passkey made elsewhere can still be removed from here.
    await user.click(within(passkeys).getByRole('button', { name: 'Remove' }));
    await user.click(within(dialog(REMOVE_TITLE)).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(server.count('POST', PASSKEY_DELETE_PATH)).toBe(1));
    expect(startRegistration).not.toHaveBeenCalled();
  });
});

describe('accessibility', () => {
  it('test_account_sections_keyboard_and_dialogs', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { server, user } = openAccount({ devices: [LAPTOP], passkeys: [KEYCHAIN] });
    const devices = await group(DEVICES_HEADER);
    const passkeys = await group(PASSKEYS_HEADER);
    await within(devices).findByText('Chrome on Windows');
    await within(passkeys).findByText('iCloud Keychain');

    // Every control in page order, reached with Tab.
    const revoke = within(devices).getByRole('button', { name: 'Revoke' });
    const remove = within(passkeys).getByRole('button', { name: 'Remove' });
    const add = screen.getByRole('button', { name: 'Add a passkey' });
    for (const control of [screen.getByRole('button', { name: 'Sign out' }), revoke, remove, add]) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }

    // Back to "Revoke" and Enter: a native modal, focus on "Cancel"; Escape (its `cancel` event) closes it, sending nothing.
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(revoke);
    await user.keyboard('{Enter}');
    const revokeDialog = dialog('Revoke Chrome on Windows?');
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.contexts[0]).toBe(revokeDialog);
    expect(document.activeElement).toBe(within(revokeDialog).getByRole('button', { name: 'Cancel' }));
    fireEvent(revokeDialog, new Event('cancel', { cancelable: true }));
    expect(revokeDialog.open).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Focus goes back to the button that opened it.
    expect(document.activeElement).toBe(revoke);

    // Again, and this time Tab to the dialog's "Revoke" and press Enter.
    await user.keyboard('{Enter}');
    expect(showModal).toHaveBeenCalledTimes(2);
    await user.tab();
    expect(document.activeElement).toBe(within(revokeDialog).getByRole('button', { name: 'Revoke' }));
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Revoked.')).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: ACCOUNT_DEVICE_REVOKE_PATH, body: { device_id: LAPTOP.id } }]);

    // Space on "Remove" opens the other dialog; Escape closes it without removing anything.
    remove.focus();
    await user.keyboard(' ');
    const removeDialog = dialog(REMOVE_TITLE);
    expect(showModal).toHaveBeenCalledTimes(3);
    expect(showModal.mock.contexts[2]).toBe(removeDialog);
    expect(document.activeElement).toBe(within(removeDialog).getByRole('button', { name: 'Cancel' }));
    fireEvent(removeDialog, new Event('cancel', { cancelable: true }));
    expect(removeDialog.open).toBe(false);
    expect(document.activeElement).toBe(remove);
    await settle();
    expect(server.count('POST', PASSKEY_DELETE_PATH)).toBe(0);

    // Enter on "Add a passkey" starts the passkey prompt.
    add.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(startRegistration).toHaveBeenCalledTimes(1));

    // Each dialog is named by its own title, and every button, open or not, says what it does in visible text.
    const names = screen.getAllByRole('alertdialog', { hidden: true }).map((d) => d.getAttribute('aria-label'));
    expect(names).toEqual(['Revoke Chrome on Windows?', REMOVE_TITLE, 'Delete your account?']);
    for (const button of screen.getAllByRole('button', { hidden: true })) {
      expect(button.textContent?.trim()).not.toBe('');
      expect(button.getAttribute('aria-label')).toBeNull();
    }
  });
});
