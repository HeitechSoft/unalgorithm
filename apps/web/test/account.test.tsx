/**
 * The account page every server serves at `/account`: who is signed in here and signing out, or the email-code sign-in
 * when nobody is, and the home page's link to it. `fetch` is a fake server per test that keeps a session as the real one
 * does: an accepted code starts it and signing out ends it. The Credits section has its own tests (credits.test.tsx).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_PAGE_PATH,
  CREDIT_ACCOUNT_PATH,
  PRICES_JSON_PATH,
  SERVER_INFO_PATH,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { PASSKEY_LIST_PATH, SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';
import { Home } from '../src/main.tsx';
import { fakeServer, INFO, SIGNED_IN, TOM } from './support/fake-server.ts';

const UNREACHABLE = "Couldn't reach the server. Try again.";
/** What the signed-in page's Devices and Passkeys sections ask for on their own (account-devices.test.tsx). */
const SECTIONS = [ACCOUNT_DEVICES_PATH, PASSKEY_LIST_PATH];

/** Waits until the Devices and Passkeys sections have loaded their lists (none, from the fake server). */
async function sectionsLoaded() {
  await screen.findByText('No devices are signed in.');
  await screen.findByText('No passkeys yet.');
}

/**
 * `html` with each id React generated (`useId`, which a section's heading and its `aria-labelledby` share) renumbered in
 * order of first use: the Credits section takes ids of its own, which shifts those of the sections after it.
 */
function numberIds(html: string): string {
  const ids = new Map<string, number>();
  return html.replace(/_r_[0-9a-z]+_/g, (id) => {
    if (!ids.has(id)) ids.set(id, ids.size);
    return `id-${ids.get(id)}`;
  });
}

/** Renders the account page. */
function openAccount() {
  const user = setupUser();
  const view = render(<Account />);
  return { user, ...view };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('signed in', () => {
  it('test_account_shows_signed_in_address', async () => {
    fakeServer({ session: TOM });
    openAccount();
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    // The page is the account, under its own title; the top bar names the server and who is signed in.
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeTruthy();
    expect(screen.getByText('Your account on this server.')).toBeTruthy();
    const topBar = document.querySelector('.web-topbar') as HTMLElement;
    expect(within(topBar).getByRole('link', { name: INFO.name }).getAttribute('href')).toBe(ACCOUNT_PAGE_PATH);
    expect(within(topBar).getByText(TOM)).toBeTruthy();
    expect(within(topBar).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    // Someone who isn't an admin gets no sidebar.
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(document.title).toBe(`Account · ${INFO.name}`);
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('test_account_sign_out', async () => {
    const server = fakeServer({ session: TOM });
    const { user } = openAccount();
    await sectionsLoaded();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeTruthy();
    expect(screen.queryByText(SIGNED_IN)).toBeNull();
    expect(screen.getByText('Sign in to see your account.')).toBeTruthy();
    // The page already knows the server: signing out asks for nothing else.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls).toEqual([
      { method: 'GET', path: SERVER_INFO_PATH, body: undefined },
      { method: 'GET', path: SESSION_PATH, body: undefined },
      ...SECTIONS.map((path) => ({ method: 'GET', path, body: undefined })),
      { method: 'POST', path: SIGN_OUT_PATH, body: {} },
    ]);
  });
});

describe('signed out and errors', () => {
  it('test_account_sign_in_then_reload', async () => {
    const server = fakeServer();
    const { user } = openAccount();
    await user.type(await screen.findByLabelText('Email'), TOM);
    expect(screen.getByText('Sign in to see your account.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Account' })).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    // The address shown is the one the server reports for the new session, asked for again.
    expect(server.count('GET', SESSION_PATH)).toBe(2);
    // Then the sections' own requests.
    expect(server.calls.map((c) => `${c.method} ${c.path}`).slice(2, 6)).toEqual([
      `POST ${SEND_CODE_PATH}`,
      `POST ${SIGN_IN_PATH}`,
      `GET ${SERVER_INFO_PATH}`,
      `GET ${SESSION_PATH}`,
    ]);
  });

  it('test_account_loading_and_unreachable_retry', async () => {
    // While the first answers are out: busy, and nothing to fill in.
    let answerInfo: () => void = () => {};
    fakeServer({
      session: TOM,
      routes: {
        [`GET ${SERVER_INFO_PATH}`]: () =>
          new Promise((resolve) => {
            answerInfo = () => resolve({ status: 200, body: INFO });
          }),
      },
    });
    let view = openAccount();
    expect(view.container.querySelector('.web-page')?.getAttribute('aria-busy')).toBe('true');
    expect(view.container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    answerInfo();
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
    // Nothing stays busy once the sections have their lists.
    await waitFor(() => expect(view.container.querySelector('[aria-busy="true"]')).toBeNull());
    cleanup();

    // The discovery document fails, then answers: "Try again" asks for both again.
    for (const failure of ['offline', { status: 500, body: { code: 'unknown', message: 'Something went wrong.' } }] as const) {
      let infoTries = 0;
      const server = fakeServer({
        session: TOM,
        routes: {
          [`GET ${SERVER_INFO_PATH}`]: () => {
            infoTries += 1;
            if (infoTries === 1 && failure === 'offline') throw new TypeError('Failed to fetch');
            return infoTries === 1 && failure !== 'offline' ? failure : { status: 200, body: INFO };
          },
        },
      });
      view = openAccount();
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(UNREACHABLE);
      expect(screen.queryByLabelText('Email')).toBeNull();
      expect(screen.queryByText(SIGNED_IN)).toBeNull();
      await view.user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
      expect(screen.queryByText(UNREACHABLE)).toBeNull();
      expect(server.count('GET', SERVER_INFO_PATH)).toBe(2);
      expect(server.count('GET', SESSION_PATH)).toBe(2);
      cleanup();
    }

    // The session check fails the same way.
    const server = fakeServer({ session: TOM, routes: { [`GET ${SESSION_PATH}`]: { status: 502 } } });
    view = openAccount();
    expect((await screen.findByRole('alert')).textContent).toContain(UNREACHABLE);
    await view.user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(server.count('GET', SESSION_PATH)).toBe(2));
    expect(server.count('GET', SERVER_INFO_PATH)).toBe(2);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('test_account_same_without_billing', async () => {
    // Billing adds the Credits section (CL2-09) below the account row and changes nothing else on the page.
    const pages: string[] = [];
    for (const billing of [false, true]) {
      const server = fakeServer({ session: TOM, info: { ...INFO, billing } });
      const { container } = openAccount();
      await screen.findByText(SIGNED_IN);
      await sectionsLoaded();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const credits = screen.queryByRole('region', { name: 'Credits' });
      expect(credits !== null).toBe(billing);
      credits?.remove();
      pages.push(numberIds(container.innerHTML));
      expect(server.calls.map((c) => c.path)).toEqual(
        billing
          ? [SERVER_INFO_PATH, SESSION_PATH, CREDIT_ACCOUNT_PATH, PRICES_JSON_PATH, ...SECTIONS]
          : [SERVER_INFO_PATH, SESSION_PATH, ...SECTIONS],
      );
      cleanup();
    }
    expect(pages[1]).toBe(pages[0]);
  });
});

describe('home', () => {
  it('test_home_links_account', async () => {
    fakeServer();
    render(<Home />);
    const link = await screen.findByRole('link', { name: 'Your account' });
    expect(link.getAttribute('href')).toBe(ACCOUNT_PAGE_PATH);
    expect(link.getAttribute('href')).toBe('/account');
    // Still the home page: what the server is for, under its name.
    expect(screen.getByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(screen.getByText('This server provides AI for the unAlgorithm Feed extension.')).toBeTruthy();
  });
});
