/**
 * The admin page at `/admin` (R38): the page frame (sign-in, not an admin, unavailable, loaded), the people table with
 * each person's badges and numbers, and the per-person sheet that sets the cap, removes or restores access and changes
 * the role through CL4-06's routes. Also the sign-in's message for a removed account, whichever way in refused it, and
 * the account page's sidebar link to the admin page. `fetch` is the shared fake server, whose admin routes keep the accounts and answer as
 * the server's do (403 for anyone but an admin, 400 for the admin's own access or role); every request is recorded.
 * Dialogs run on the jsdom stand-in for `showModal` (loaded by the setup file).
 */
import { type AuthenticationResponseJSON, browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { formatApproxCost } from '@unalgorithm/core';
import {
  ACCOUNT_PAGE_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_USERS_PATH,
  type AdminUser,
  type AdminUsers,
  adminUserActionPath,
  EMAIL_OTP_METHOD,
  PASSKEY_METHOD,
} from '@unalgorithm/protocol';
import { ToastProvider } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { Admin } from '../src/Admin.tsx';
import { PASSKEY_AUTH_VERIFY_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';
import { SignIn } from '../src/SignIn.tsx';
import {
  type Answer,
  fakeServer,
  INFO,
  PASSKEY_OPTIONS,
  type Reply,
  SESSION_GONE,
  SIGNED_IN,
  TOM,
} from './support/fake-server.ts';

vi.mock('@simplewebauthn/browser');

const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const UNREACHABLE = "Couldn't reach the server. Try again.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const TRUNCATED = 'Showing the first 1,000 accounts.';
const OWN = "You can't change your own access or role.";
const NOT_POSSIBLE = "That change isn't possible.";
const GONE = 'This account no longer exists.';
const REMOVED = "This account can't sign in to this server. Ask its admin.";
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const GOOGLE_FAILED = "Google sign-in didn't work. Try again, or sign in with your email.";
const USE_SERVER_CAP = "Use the server's cap (1,000)";

const ANA = 'ana@example.com';
const BEN = 'ben@example.com';

function account(id: string, email: string, fields: Partial<AdminUser> = {}): AdminUser {
  return {
    id,
    email,
    role: 'user',
    access: 'active',
    createdAt: '2026-09-01T12:00:00.000Z',
    lastActiveAt: '2026-10-14T09:00:00.000Z',
    activeDevices: 1,
    postsToday: 0,
    posts30Days: 0,
    costMicros30Days: 0,
    dailyPostCap: null,
    ...fields,
  };
}

/** TOM is the signed-in admin; Ana has her own cap; Ben's access was removed. */
const USERS: AdminUsers = {
  users: [
    account('u1', TOM, { role: 'admin', activeDevices: 2, postsToday: 120, posts30Days: 2400, costMicros30Days: 180_000 }),
    account('u2', ANA, { postsToday: 1234, posts30Days: 45_678, costMicros30Days: 2_500_000, dailyPostCap: 500 }),
    account('u3', BEN, { access: 'removed', activeDevices: 0, posts30Days: 12, lastActiveAt: null }),
  ],
  truncated: false,
  invites: [],
  defaultDailyPostCap: 1000,
};

const ASSERTION: AuthenticationResponseJSON = {
  id: 'Y3JlZGVudGlhbC1pZA',
  rawId: 'Y3JlZGVudGlhbC1pZA',
  response: {
    authenticatorData: 'YXV0aGVudGljYXRvci1kYXRh',
    clientDataJSON: 'Y2xpZW50LWRhdGE',
    signature: 'c2lnbmF0dXJl',
    userHandle: 'dXNlci1oYW5kbGU',
  },
  type: 'public-key',
  clientExtensionResults: {},
  authenticatorAttachment: 'platform',
};

/** What the admin plugin answers for a removed account, on every way in (Better Auth's error body). */
const BANNED: Answer = {
  status: 403,
  body: { code: 'BANNED_USER', message: 'This account cannot sign in to this server.' },
};

/** Opens the admin page; by default TOM is signed in as an admin of a server with `USERS`. */
function openAdmin(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({ session: TOM, role: 'admin', adminUsers: USERS, ...options });
  const user = setupUser();
  render(<Admin />);
  return { server, user };
}

/** Signs in on the page's `SignIn` with an emailed code, as TOM. */
async function signIn(user: ReturnType<typeof setupUser>) {
  await user.type(await screen.findByLabelText('Email'), TOM);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('6-digit code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** The people table's row of the account with this address (the open dialog's title repeats it). */
function row(email: string): HTMLElement {
  const found = screen
    .getAllByText(email)
    .map((el) => el.closest('tr'))
    .find((el) => el !== null);
  if (!(found instanceof HTMLElement)) throw new Error(`No row for ${email}`);
  return found;
}

/** A row's cells as their text: the account (address, badges, devices), today, 30 days, AI cost and its actions. */
function cells(email: string): string[] {
  return [...row(email).querySelectorAll('th, td')].map((c) => c.textContent ?? '');
}

/** A row's badges, as their text. */
function badges(email: string): string[] {
  return [...row(email).querySelectorAll('.ua-badge')].map((b) => b.textContent ?? '');
}

/** The per-person dialog, open or not. */
function dialog(): HTMLDialogElement {
  const found = document.querySelector('dialog');
  if (!found) throw new Error('No dialog');
  return found;
}

function button(name: string): HTMLButtonElement {
  return within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
}

/** The open dialog's fact with this label. */
function fact(label: string): string {
  const found = [...dialog().querySelectorAll('.web-facts dt')].find((dt) => dt.textContent === label);
  if (!found) throw new Error(`No fact ${label}`);
  return found.nextElementSibling?.textContent ?? '';
}

/** Waits for the list, then opens the dialog of the account with this address. */
async function manage(user: ReturnType<typeof setupUser>, email: string) {
  await user.click(await screen.findByRole('button', { name: `Manage ${email}` }));
  expect(dialog().open).toBe(true);
  expect(screen.getByRole('dialog', { name: email })).toBe(dialog());
}

/** The admin actions the page sent, in order. */
function actions(server: ReturnType<typeof fakeServer>) {
  return server.posts().filter((c) => c.path.startsWith(`${ADMIN_USERS_PATH}/`));
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(false);
  vi.mocked(startAuthentication).mockReset().mockResolvedValue(ASSERTION);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('page frame', () => {
  it('test_admin_page_signs_in_then_loads', async () => {
    const { server, user } = openAdmin({ session: null });
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(0);

    await signIn(user);
    expect(await screen.findByText(ANA)).toBeTruthy();
    expect(screen.queryByText(SIGN_IN_INTRO)).toBeNull();
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(1);
  });

  it('test_admin_page_not_admin', async () => {
    const { server, user } = openAdmin({ role: 'user' });
    expect(await screen.findByText(NOT_ADMIN)).toBeTruthy();
    // The focus layout: the server's name is the heading, a card says who is signed in, and there is no sidebar.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(INFO.name);
    expect(screen.getByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(screen.queryByText(ANA)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(server.count('POST', SIGN_OUT_PATH)).toBe(1);
    cleanup();

    // A 500: the unavailable Banner, whose "Try again" asks again.
    let tries = 0;
    const flaky: Reply = () =>
      ++tries === 1 ? { status: 500, body: { code: 'internal', message: 'Oops.' } } : { status: 200, body: USERS };
    const again = openAdmin({ routes: { [`GET ${ADMIN_USERS_PATH}`]: flaky } });
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByText(NOT_ADMIN)).toBeNull();
    await again.user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(ANA)).toBeTruthy();
    expect(again.server.count('GET', ADMIN_USERS_PATH)).toBe(2);
  });

  it('test_admin_page_names_server', async () => {
    const { user } = openAdmin();
    expect(await screen.findByText(ANA)).toBeTruthy();
    expect(document.title).toBe(`Admin · ${INFO.name}`);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Overview');
    // The top bar names the server and who is signed in, with "Sign out".
    const topBar = document.querySelector('.web-topbar');
    if (!(topBar instanceof HTMLElement)) throw new Error('No top bar');
    expect(topBar.textContent).toContain(INFO.name);
    expect(within(topBar).getByText(TOM)).toBeTruthy();
    expect(within(topBar).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    await manage(user, ANA);
    expect(document.body.textContent).toContain(INFO.name);
    expect(document.body.textContent).not.toContain('unAlgorithm Cloud');
    cleanup();

    openAdmin({ session: null });
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(document.title).toBe('Admin · Example AI');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Example AI');
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(document.body.textContent).not.toContain('unAlgorithm Cloud');
  });
});

describe('users list', () => {
  it('test_admin_users_rows_and_numbers', async () => {
    openAdmin();
    expect(await screen.findByText(ANA)).toBeTruthy();

    const people = screen.getByRole('region', { name: 'People' });
    const table = within(people).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Account', 'Today', '30 days', 'AI cost', 'Actions']);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(3);

    // Each row: the address with its badges and devices, then today, 30 days, AI cost and "Manage".
    expect(badges(TOM)).toEqual(['Admin']);
    expect(cells(TOM)).toEqual([`T${TOM}Admin2 devices`, '120', '2,400', formatApproxCost(180_000), 'Manage']);
    expect(badges(ANA)).toEqual(['Cap 500']);
    expect(cells(ANA)).toEqual([`A${ANA}Cap 5001 device`, '1,234', '45,678', formatApproxCost(2_500_000), 'Manage']);
    expect(badges(BEN)).toEqual(['Removed']);
    expect(cells(BEN)).toEqual([`B${BEN}Removed0 devices`, '0', '12', formatApproxCost(0), 'Manage']);
    for (const email of [TOM, ANA, BEN]) {
      expect(within(row(email)).getByRole('button', { name: `Manage ${email}` })).toBeTruthy();
    }
    expect(screen.queryByText(TRUNCATED)).toBeNull();
    cleanup();

    openAdmin({ adminUsers: { ...USERS, truncated: true } });
    expect(await screen.findByText(TRUNCATED)).toBeTruthy();
  });

  it('test_admin_sets_and_clears_cap', async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { server, user } = openAdmin();
    await manage(user, ANA);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(showModal.mock.contexts[0]).toBe(dialog());
    // The sheet's facts about Ana.
    expect(
      [...dialog().querySelectorAll('.web-facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    ).toEqual([
      ['Role', 'Regular user'],
      ['Access', 'Can sign in'],
      ['Devices', '1'],
      ['Posts today', '1,234'],
      ['Posts in 30 days', '45,678'],
      ['AI cost in 30 days', formatApproxCost(2_500_000)],
      ['Daily posts', '500 posts a day'],
      ['Joined', 'Sep 1, 2026'],
      ['Last active', 'Oct 14, 2026'],
    ]);

    const field = within(dialog()).getByLabelText('Daily posts') as HTMLInputElement;
    expect(field.value).toBe('500');
    for (const typed of ['-1', '1.5']) {
      await user.clear(field);
      await user.type(field, typed);
      expect(button('Save cap').disabled).toBe(true);
    }
    await user.clear(field);
    expect(button('Save cap').disabled).toBe(true);
    await user.click(button('Save cap'));
    expect(actions(server)).toEqual([]);

    await user.type(field, '50');
    expect(button('Save cap').disabled).toBe(false);
    await user.click(button('Save cap'));
    await waitFor(() => expect(badges(ANA)).toEqual(['Cap 50']));
    expect(fact('Daily posts')).toBe('50 posts a day');
    expect(actions(server)).toEqual([{ method: 'POST', path: adminUserActionPath('u2', 'cap'), body: { dailyPostCap: 50 } }]);
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(2);

    await user.click(button(USE_SERVER_CAP));
    await waitFor(() => expect(badges(ANA)).toEqual([]));
    expect(fact('Daily posts')).toBe('Server cap (1,000)');
    expect(actions(server)[1]).toEqual({ method: 'POST', path: adminUserActionPath('u2', 'cap'), body: { dailyPostCap: null } });
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(3);
  });

  it('test_admin_removes_and_restores_access', async () => {
    const { server, user } = openAdmin();
    await manage(user, ANA);
    const confirm = `${ANA} is signed out on every device and can't sign in until you restore access.`;

    // Asked first: "Cancel" sends nothing.
    await user.click(button('Remove access'));
    expect(within(dialog()).getByText(confirm)).toBeTruthy();
    await user.click(button('Cancel'));
    expect(within(dialog()).queryByText(confirm)).toBeNull();
    await settle();
    expect(actions(server)).toEqual([]);

    await user.click(button('Remove access'));
    await user.click(button('Remove access'));
    expect(await within(dialog()).findByRole('button', { name: 'Restore access' })).toBeTruthy();
    expect(within(row(ANA)).getByText('Removed')).toBeTruthy();
    expect(fact('Access')).toBe('Removed');
    expect(actions(server)).toEqual([{ method: 'POST', path: adminUserActionPath('u2', 'access'), body: { access: 'removed' } }]);

    await user.click(button('Restore access'));
    expect(await within(dialog()).findByRole('button', { name: 'Remove access' })).toBeTruthy();
    expect(within(row(ANA)).queryByText('Removed')).toBeNull();
    expect(fact('Access')).toBe('Can sign in');
    expect(actions(server)[1]).toEqual({ method: 'POST', path: adminUserActionPath('u2', 'access'), body: { access: 'active' } });
  });

  it('test_admin_role_buttons_and_own_row', async () => {
    const { server, user } = openAdmin();
    await manage(user, ANA);
    expect(within(dialog()).queryByText(OWN)).toBeNull();
    await user.click(button('Make admin'));
    expect(await within(dialog()).findByRole('button', { name: 'Make regular user' })).toBeTruthy();
    expect(within(row(ANA)).getByText('Admin')).toBeTruthy();
    expect(fact('Role')).toBe('Admin');
    await user.click(button('Make regular user'));
    expect(await within(dialog()).findByRole('button', { name: 'Make admin' })).toBeTruthy();
    expect(actions(server)).toEqual([
      { method: 'POST', path: adminUserActionPath('u2', 'role'), body: { role: 'admin' } },
      { method: 'POST', path: adminUserActionPath('u2', 'role'), body: { role: 'user' } },
    ]);
    await user.click(button('Done'));
    expect(dialog().open).toBe(false);

    // The signed-in admin's own row: access and role are disabled with the hint; the cap still works.
    await manage(user, TOM);
    expect(within(dialog()).getByText(OWN)).toBeTruthy();
    expect(button('Remove access').disabled).toBe(true);
    expect(button('Make regular user').disabled).toBe(true);
    expect(button(USE_SERVER_CAP).disabled).toBe(false);
    await user.click(button('Remove access'));
    await user.click(button('Make regular user'));
    await settle();
    expect(actions(server)).toHaveLength(2);
  });

  it('test_admin_action_errors', async () => {
    const capPath = adminUserActionPath('u2', 'cap');
    const rolePath = adminUserActionPath('u2', 'role');
    const missing: Answer = { status: 404, body: { code: 'not-found', message: 'No such account.' } };
    const refused: Answer = { status: 400, body: { code: 'bad-request', message: 'No.' } };
    const { server, user } = openAdmin({ routes: { [`POST ${capPath}`]: missing, [`POST ${rolePath}`]: refused } });
    await manage(user, ANA);
    await user.click(button(USE_SERVER_CAP));
    expect(await within(dialog()).findByText(GONE)).toBeTruthy();
    await user.click(button('Make admin'));
    expect(await within(dialog()).findByText(NOT_POSSIBLE)).toBeTruthy();
    expect(within(dialog()).queryByText(GONE)).toBeNull();
    // A failed change reloads nothing.
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(1);
    cleanup();

    // A 401 from an action returns the page to the sign-in.
    const ended = openAdmin({ routes: { [`POST ${capPath}`]: SESSION_GONE } });
    await manage(ended.user, ANA);
    await ended.user.click(button(USE_SERVER_CAP));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT)).toBeTruthy();
    expect(screen.queryByText(ANA)).toBeNull();
    cleanup();

    // And so does a 401 from the list's reload after a change.
    let lists = 0;
    const reloadEnded: Reply = () => (++lists === 1 ? { status: 200, body: USERS } : SESSION_GONE);
    const reload = openAdmin({ routes: { [`GET ${ADMIN_USERS_PATH}`]: reloadEnded } });
    await manage(reload.user, ANA);
    await reload.user.click(button(USE_SERVER_CAP));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(reload.server.count('GET', ADMIN_USERS_PATH)).toBe(2);
  });
});

describe('sign-in and account', () => {
  it('test_sign_in_shows_removed_account_message', async () => {
    // The emailed code.
    fakeServer({ routes: { [`POST ${SIGN_IN_PATH}`]: BANNED } });
    let user = setupUser();
    render(<SignIn onSignedIn={vi.fn()} />);
    await signIn(user);
    expect(await screen.findByText(REMOVED)).toBeTruthy();
    expect(screen.queryByText(WRONG_CODE)).toBeNull();
    cleanup();

    // A 403 without that code: three wrong codes.
    fakeServer({
      routes: { [`POST ${SIGN_IN_PATH}`]: { status: 403, body: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } } },
    });
    user = setupUser();
    render(<SignIn onSignedIn={vi.fn()} />);
    await signIn(user);
    expect(await screen.findByText(WRONG_CODE)).toBeTruthy();
    expect(screen.queryByText(REMOVED)).toBeNull();
    cleanup();

    // A passkey: the browser's prompt answers, and the server refuses the session.
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(true);
    const server = fakeServer({ routes: { [`POST ${PASSKEY_AUTH_VERIFY_PATH}`]: BANNED } });
    user = setupUser();
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} methods={[EMAIL_OTP_METHOD, PASSKEY_METHOD]} />);
    await user.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    expect(await screen.findByText(REMOVED)).toBeTruthy();
    expect(vi.mocked(startAuthentication)).toHaveBeenCalledWith({ optionsJSON: PASSKEY_OPTIONS });
    expect(server.count('POST', PASSKEY_AUTH_VERIFY_PATH)).toBe(1);
    expect(onSignedIn).not.toHaveBeenCalled();
    cleanup();

    // Google: the page came back with `?error=BANNED_USER`.
    render(<SignIn onSignedIn={vi.fn()} googleFailed googleError="BANNED_USER" />);
    expect(screen.getByText(REMOVED)).toBeTruthy();
    expect(screen.queryByText(GOOGLE_FAILED)).toBeNull();
    cleanup();
    render(<SignIn onSignedIn={vi.fn()} googleFailed googleError="access_denied" />);
    expect(screen.getByText(GOOGLE_FAILED)).toBeTruthy();
    expect(screen.queryByText(REMOVED)).toBeNull();
  });

  it('test_account_page_admin_sidebar_link', async () => {
    for (const role of ['admin', 'user', null]) {
      fakeServer({ session: TOM, role });
      render(
        <ToastProvider>
          <Account />
        </ToastProvider>,
      );
      expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
      // No "Admin" link row any more, for anyone.
      expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
      const nav = screen.queryByRole('navigation', { name: 'Pages' });
      if (role === 'admin') {
        if (!nav) throw new Error('No sidebar');
        expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe(ADMIN_PAGE_PATH);
        const own = within(nav).getByRole('link', { name: 'Account' });
        expect(own.getAttribute('href')).toBe(ACCOUNT_PAGE_PATH);
        expect(own.getAttribute('aria-current')).toBe('page');
      } else {
        expect(nav).toBeNull();
        expect(screen.queryByRole('link', { name: 'Overview' })).toBeNull();
      }
      cleanup();
    }
  });
});
