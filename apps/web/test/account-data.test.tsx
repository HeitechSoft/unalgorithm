/**
 * The account page's "Your data" section: downloading the account's export, and deleting the account after an alert
 * dialog that asks for the address typed again. `fetch` is the shared fake server (support/fake-server.ts), whose
 * export and delete routes answer as the server's do; `URL.createObjectURL` and `revokeObjectURL` are stubs (jsdom has
 * neither) and the anchor's `click` a spy, so no download really starts. Dialogs run on the jsdom stand-in for
 * `showModal` (loaded by the setup file): Escape is a `cancel` event. The browser's own focus trap and Escape key are
 * checked by `test_account_dialogs_trap_focus` in the extension's `cloud.spec.ts`. On a server that advertises billing,
 * the dialog warns about purchased credit from the answer to `GET /v1/billing/account`, asked once per opening.
 */
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_EXPORT_PATH,
  CREDIT_ACCOUNT_PATH,
  type CreditAccount,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { ToastProvider } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { SIGN_OUT_PATH } from '../src/api.ts';
import { EXPORT, fakeServer, INFO, type Reply, SIGNED_IN, TOM } from './support/fake-server.ts';

vi.mock('@simplewebauthn/browser');

const DOWNLOAD = 'Download your data';
const DELETE_ROW = 'Delete account…';
const DELETE = 'Delete account';
const TITLE = 'Delete your account?';
const FIELD = `Type ${TOM} to confirm`;
const DELETED = 'Your account was deleted.';
const SIGN_IN_TO_DELETE = 'For your safety, sign in again, then delete your account within 10 minutes.';
const MISMATCH = 'The address you typed does not match this account.';
const FAILED = 'Something went wrong. Try again.';
const PURCHASED_TEXT = 'Deleting your account gives it up. To get it back, ask for a refund before you delete your account.';
const CREDIT_UNCHECKED = "We couldn't check your credit balance.";
const REFUNDS = 'https://unalgorithm.app/refunds';
const BILLING: ServerInfo = { ...INFO, billing: true };
const OBJECT_URL = 'blob:http://localhost/4f5d8a2e-6b1c-4c3d-9e8f-0a1b2c3d4e5f';

const createObjectURL = vi.fn((_blob: Blob) => OBJECT_URL);
const revokeObjectURL = vi.fn((_url: string) => undefined);
let click: MockInstance<HTMLAnchorElement['click']>;

/** Opens the account page signed in as TOM. */
function openAccount(options: { routes?: Record<string, Reply>; info?: ServerInfo } = {}) {
  const server = fakeServer({ session: TOM, ...options });
  const user = setupUser();
  render(
    <ToastProvider>
      <Account />
    </ToastProvider>,
  );
  return { server, user };
}

/** The delete dialog (an alert dialog), open or not: a closed one has no accessible name, so its label tells it apart. */
function dialog(): HTMLDialogElement {
  const found = screen.getAllByRole('alertdialog', { hidden: true }).find((d) => d.getAttribute('aria-label') === TITLE);
  if (!found) throw new Error(`No dialog titled ${TITLE}`);
  return found as HTMLDialogElement;
}

/** The open dialog's "Delete account" button. */
function deleteButton(): HTMLButtonElement {
  return within(dialog()).getByRole('button', { name: DELETE }) as HTMLButtonElement;
}

/** Opens the page and the delete dialog with a click on its row. */
async function openDeleteDialog(options: Parameters<typeof openAccount>[0] = {}) {
  const page = openAccount(options);
  await page.user.click(await screen.findByRole('button', { name: DELETE_ROW }));
  expect(dialog().open).toBe(true);
  return page;
}

/** A credit account holding `purchasedMicros` of purchased credit and $0.50 of promotional credit. */
function credit(purchasedMicros: number, rest: Partial<Omit<CreditAccount, 'balance'>> = {}): CreditAccount {
  const promoMicros = 500_000;
  return {
    v: 1,
    balance: {
      v: 1,
      balanceMicros: promoMicros + purchasedMicros,
      promoMicros,
      purchasedMicros,
      promoExpiresAt: '2027-01-11T15:00:00.000Z',
      starter: 'active',
    },
    history: [],
    ...rest,
  };
}

/** Opens the delete dialog on a billing server whose credits route answers `reply`. */
function openBillingDialog(reply: Reply) {
  return openDeleteDialog({ info: BILLING, routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: reply } });
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(false);
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.title = '';
});

describe('export', () => {
  it('test_export_downloads_validated_json', async () => {
    // A field the contract does not list never reaches the file.
    const answer = { ...EXPORT, token: 'not-in-the-contract' };
    const { server, user } = openAccount({ routes: { [`GET ${ACCOUNT_EXPORT_PATH}`]: { status: 200, body: answer } } });
    expect(
      await screen.findByText('A JSON file with your account, devices, sign-in methods, usage counts and synced settings.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: DOWNLOAD }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(server.count('GET', ACCOUNT_EXPORT_PATH)).toBe(1);

    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('account-export.json');
    expect(anchor.href).toBe(OBJECT_URL);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toEqual(EXPORT);
    // Revoked once the anchor was clicked.
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(revokeObjectURL.mock.invocationCallOrder[0]).toBeGreaterThan(click.mock.invocationCallOrder[0] ?? Infinity);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_export_rejects_bad_answer', async () => {
    const { server, user } = openAccount({
      routes: { [`GET ${ACCOUNT_EXPORT_PATH}`]: { status: 200, body: { ...EXPORT, v: 2 } } },
    });
    await user.click(await screen.findByRole('button', { name: DOWNLOAD }));
    expect((await screen.findByRole('alert')).textContent).toBe(FAILED);
    expect(server.count('GET', ACCOUNT_EXPORT_PATH)).toBe(1);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });
});

describe('delete', () => {
  it('test_delete_requires_typed_address', async () => {
    const { user } = await openDeleteDialog();
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(deleteButton().disabled).toBe(true);
    const field = within(dialog()).getByLabelText(FIELD);
    await user.type(field, 'tom@example.org');
    expect(deleteButton().disabled).toBe(true);
    await user.clear(field);
    await user.type(field, ' TOM@example.com ');
    expect(deleteButton().disabled).toBe(false);
  });

  it('test_delete_success_shows_deleted', async () => {
    const { server, user } = await openDeleteDialog();
    await user.type(within(dialog()).getByLabelText(FIELD), ' TOM@example.com ');
    await user.click(deleteButton());
    expect(await screen.findByText(DELETED)).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: ACCOUNT_DELETE_PATH, body: { confirm: ' TOM@example.com ' } }]);
    // No account view and no sign-in: the session went with the account.
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your data' })).toBeNull();
    expect(screen.queryByRole('alertdialog', { hidden: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send code' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('test_delete_stale_session_asks_to_sign_in', async () => {
    const stale = { status: 401, body: { code: 'auth-required', message: 'Sign in again to delete the account.' } };
    const { server, user } = await openDeleteDialog({ routes: { [`POST ${ACCOUNT_DELETE_PATH}`]: stale } });
    await user.type(within(dialog()).getByLabelText(FIELD), TOM);
    await user.click(deleteButton());
    expect(await screen.findByText(SIGN_IN_TO_DELETE)).toBeTruthy();
    expect(server.posts().map((c) => c.path)).toEqual([ACCOUNT_DELETE_PATH, SIGN_OUT_PATH]);
    expect(screen.getByRole('button', { name: 'Send code' })).toBeTruthy();
    expect(screen.queryByRole('alertdialog', { hidden: true })).toBeNull();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
  });

  it('test_delete_mismatch_message', async () => {
    const mismatch = { status: 400, body: { code: 'bad-request', message: 'The address does not match.' } };
    const { server, user } = await openDeleteDialog({ routes: { [`POST ${ACCOUNT_DELETE_PATH}`]: mismatch } });
    const field = within(dialog()).getByLabelText(FIELD);
    await user.type(field, TOM);
    await user.click(deleteButton());
    expect(await within(dialog()).findByText(MISMATCH)).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(dialog().open).toBe(true);
    expect(deleteButton().disabled).toBe(false);
    expect(server.count('POST', ACCOUNT_DELETE_PATH)).toBe(1);
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it('a failed delete says why in the dialog and changes nothing else', async () => {
    const { server, user } = await openDeleteDialog({ routes: { [`POST ${ACCOUNT_DELETE_PATH}`]: 'offline' } });
    await user.type(within(dialog()).getByLabelText(FIELD), TOM);
    await user.click(deleteButton());
    expect((await within(dialog()).findByRole('alert')).textContent).toBe("Couldn't reach the server. Try again.");
    expect(dialog().open).toBe(true);
    expect(server.posts().map((c) => c.path)).toEqual([ACCOUNT_DELETE_PATH]);
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });

  it('test_delete_cancel_sends_nothing', async () => {
    const { server, user } = await openDeleteDialog();
    await user.type(within(dialog()).getByLabelText(FIELD), TOM);
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(dialog().open).toBe(false);

    // Opened again, the field starts empty; Escape (the dialog's `cancel` event) closes it too.
    await user.click(screen.getByRole('button', { name: DELETE_ROW }));
    expect(dialog().open).toBe(true);
    const field = within(dialog()).getByLabelText(FIELD) as HTMLInputElement;
    expect(field.value).toBe('');
    await user.type(field, TOM);
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(dialog().open).toBe(false);
    await settle();
    expect(server.posts()).toEqual([]);
    expect(screen.getByText(SIGNED_IN)).toBeTruthy();
  });
});

describe('copy and accessibility', () => {
  it('test_delete_dialog_names_server', async () => {
    await openDeleteDialog({ info: { ...INFO, name: 'Lagoon Classifier' } });
    expect(within(dialog()).getByText(/^This deletes your account/).textContent).toBe(
      "This deletes your account on Lagoon Classifier: your synced settings, devices, passkeys and usage history. Every computer signed in with this account is signed out. This can't be undone.",
    );
    // No file in src names a server itself: test_web_source_never_hardcodes_cloud_name (authorize.test.tsx) reads them all.
    expect(dialog().textContent).not.toContain('unAlgorithm');
  });

  it('test_data_section_keyboard', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { server, user } = openAccount();
    const signOut = await screen.findByRole('button', { name: 'Sign out' });
    const download = await screen.findByRole('button', { name: DOWNLOAD });
    const deleteRow = screen.getByRole('button', { name: DELETE_ROW });
    // Both rows come after the page's other controls, in order, with Tab.
    for (const control of [signOut, download, deleteRow]) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }

    // Enter on "Download your data" downloads the file.
    download.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));

    // Space on "Delete account…" opens a native modal with the focus on "Cancel"; Enter there closes it.
    deleteRow.focus();
    await user.keyboard(' ');
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.contexts[0]).toBe(dialog());
    const cancel = within(dialog()).getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);
    await user.keyboard('{Enter}');
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(deleteRow);

    // Again: back to the field, type the address, Tab past "Cancel" to "Delete account" and press Enter.
    await user.keyboard('{Enter}');
    expect(showModal).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog()).getByLabelText(FIELD));
    await user.keyboard(TOM);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(deleteButton());
    await user.keyboard('{Enter}');
    expect(await screen.findByText(DELETED)).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: ACCOUNT_DELETE_PATH, body: { confirm: TOM } }]);
  });
});

describe('purchased credit warning', () => {
  it('test_delete_dialog_warns_about_purchased_credit', async () => {
    await openBillingDialog({ status: 200, body: credit(4_200_000, { refundPolicyUrl: REFUNDS }) });
    const banner = (await within(dialog()).findByText('You have $4.20 of purchased credit.')).closest('.ua-banner');
    if (!(banner instanceof HTMLElement)) throw new Error('No purchased-credit banner');
    expect(banner.classList.contains('ua-banner--warning')).toBe(true);
    expect(within(banner).getByText(PURCHASED_TEXT, { exact: false })).toBeTruthy();
    const link = within(banner).getByRole('link', { name: 'Refund policy' });
    expect(link.getAttribute('href')).toBe(REFUNDS);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    // Above the typed-address field.
    const field = within(dialog()).getByLabelText(FIELD);
    expect(banner.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog().textContent).not.toContain('!');
  });

  it('test_delete_dialog_no_warning_without_purchased_credit', async () => {
    const { server } = await openBillingDialog({ status: 200, body: credit(0, { refundPolicyUrl: REFUNDS }) });
    await waitFor(() => expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(2));
    await settle();
    expect(within(dialog()).queryByText(/purchased credit/)).toBeNull();
    expect(within(dialog()).queryByText(CREDIT_UNCHECKED)).toBeNull();
    expect(dialog().querySelector('.ua-banner')).toBeNull();
  });

  it('test_delete_dialog_warning_without_refund_link', async () => {
    await openBillingDialog({ status: 200, body: credit(10_000_000) });
    const banner = (await within(dialog()).findByText('You have $10.00 of purchased credit.')).closest('.ua-banner');
    if (!(banner instanceof HTMLElement)) throw new Error('No purchased-credit banner');
    expect(within(banner).getByText(PURCHASED_TEXT)).toBeTruthy();
    expect(within(banner).queryByRole('link')).toBeNull();
  });

  it('test_delete_dialog_no_credit_request_without_billing', async () => {
    const { server } = await openDeleteDialog({
      routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: { status: 200, body: credit(4_200_000) } },
    });
    await settle();
    expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(0);
    expect(within(dialog()).queryByText(/purchased credit/)).toBeNull();
  });

  for (const status of [500, 401]) {
    it(`test_delete_dialog_credit_failure_does_not_block (${status})`, async () => {
      // The Credits section asks first; only the dialog's own request fails.
      let asked = 0;
      const reply: Reply = () =>
        ++asked === 1
          ? { status: 200, body: credit(0) }
          : { status, body: { code: status === 401 ? 'auth-required' : 'internal', message: 'No.' } };
      const { server, user } = openAccount({ info: BILLING, routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: reply } });
      const row = await screen.findByRole('button', { name: DELETE_ROW });
      // Opens the dialog only once the Credits section has asked: on a slow runner the dialog could ask first.
      await waitFor(() => expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1));
      await user.click(row);
      expect(await within(dialog()).findByText(CREDIT_UNCHECKED)).toBeTruthy();
      expect(dialog().open).toBe(true);
      await user.type(within(dialog()).getByLabelText(FIELD), TOM);
      expect(deleteButton().disabled).toBe(false);
      await user.click(deleteButton());
      expect(await screen.findByText(DELETED)).toBeTruthy();
      expect(server.posts()).toEqual([{ method: 'POST', path: ACCOUNT_DELETE_PATH, body: { confirm: TOM } }]);
    });
  }

  it('test_delete_dialog_one_credit_request_per_opening', async () => {
    const { server, user } = openAccount({
      info: BILLING,
      routes: { [`GET ${CREDIT_ACCOUNT_PATH}`]: { status: 200, body: credit(4_200_000) } },
    });
    const row = await screen.findByRole('button', { name: DELETE_ROW });
    // The Credits section's own request, before any opening.
    await waitFor(() => expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1));
    for (const opening of [1, 2]) {
      await user.click(row);
      expect(await within(dialog()).findByText('You have $4.20 of purchased credit.')).toBeTruthy();
      await settle();
      expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(1 + opening);
      await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
      expect(dialog().open).toBe(false);
    }
    await settle();
    expect(server.count('GET', CREDIT_ACCOUNT_PATH)).toBe(3);
  });
});
