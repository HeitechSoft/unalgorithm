/**
 * The page the setup link opens, `/setup#<token>`: the person signs in with an emailed code, then the page claims the
 * link, which makes them the server's first admin. The token comes from the address's fragment, leaves the address bar
 * before any request and is kept nowhere but the page's state. `fetch` is the shared fake server, whose setup route
 * takes `SETUP_TOKEN` once, as the real one does; each test opens the page at its own address.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ADMIN_PAGE_PATH, ADMIN_SETUP_PATH, SERVER_INFO_PATH, SETUP_PAGE_PATH } from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';
import { Setup } from '../src/Setup.tsx';
import { type Answer, fakeServer, INFO, SESSION_GONE, SETUP_REFUSED, SETUP_TOKEN, TOM } from './support/fake-server.ts';

const SIGN_IN_INTRO = 'Sign in with the address the setup link was made for.';
const DONE = `You're now the admin of ${INFO.name}.`;
const NO_LINK = 'This page needs the link from the setup-link command. Ask the person who runs this server.';
const REFUSED =
  "This setup link doesn't work. It may have expired or been used, or it was made for another address. Run setup-link again for a new one.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const OFFLINE = "Couldn't reach the server. Try again.";
const FAILED = 'Something went wrong. Try again.';

/** Opens the page at `/setup#<fragment>` (just `/setup` for an empty one). */
function openSetup(fragment: string = SETUP_TOKEN, { strict = false } = {}) {
  window.history.replaceState(null, '', fragment ? `${SETUP_PAGE_PATH}#${fragment}` : SETUP_PAGE_PATH);
  const user = setupUser();
  const view = render(
    strict ? (
      <StrictMode>
        <Setup />
      </StrictMode>
    ) : (
      <Setup />
    ),
  );
  return { user, ...view };
}

/** Signs in on the page's `SignIn` with an emailed code, as TOM. */
async function signIn(user: ReturnType<typeof setupUser>) {
  await user.type(await screen.findByLabelText('Email'), TOM);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('6-digit code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** The done step: the server's name, and the way to the admin page. */
async function expectDone() {
  expect(await screen.findByText(DONE)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the admin page' }).getAttribute('href')).toBe(ADMIN_PAGE_PATH);
}

/** Lets every answer already given reach the page. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});

describe('flow', () => {
  it('test_setup_signs_in_then_claims', async () => {
    const server = fakeServer();
    const { user } = openSetup();
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(server.count('POST', ADMIN_SETUP_PATH)).toBe(0);
    await signIn(user);

    await expectDone();
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${SERVER_INFO_PATH}`,
      `GET ${SESSION_PATH}`,
      `POST ${SEND_CODE_PATH}`,
      `POST ${SIGN_IN_PATH}`,
      `POST ${ADMIN_SETUP_PATH}`,
    ]);
    expect(server.calls.at(-1)?.body).toEqual({ token: SETUP_TOKEN });
  });

  it('test_setup_claims_with_existing_session', async () => {
    let answerClaim: (answer: Answer) => void = () => {};
    const server = fakeServer({
      session: TOM,
      routes: {
        [`POST ${ADMIN_SETUP_PATH}`]: () =>
          new Promise((resolve) => {
            answerClaim = resolve;
          }),
      },
    });
    const view = openSetup();
    // While the claim is out: busy, and no sign-in.
    await waitFor(() => expect(server.count('POST', ADMIN_SETUP_PATH)).toBe(1));
    await settle();
    expect(view.container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByText(SIGN_IN_INTRO)).toBeNull();
    answerClaim({ status: 200, body: { ok: true } });

    await expectDone();
    expect(server.calls).toEqual([
      { method: 'GET', path: SERVER_INFO_PATH, body: undefined },
      { method: 'GET', path: SESSION_PATH, body: undefined },
      { method: 'POST', path: ADMIN_SETUP_PATH, body: { token: SETUP_TOKEN } },
    ]);
  });

  it('test_setup_removes_token_from_address_bar', async () => {
    const seen: string[] = [];
    fakeServer({
      routes: {
        [`GET ${SERVER_INFO_PATH}`]: () => {
          seen.push(window.location.href);
          return { status: 200, body: INFO };
        },
      },
    });
    const historyLength = window.history.length;
    openSetup();
    // Gone as soon as the page has rendered, before its first request, and replaced rather than added to the history.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe(SETUP_PAGE_PATH);
    expect(window.history.length).toBe(historyLength);
    expect(window.history.state).toBeNull();
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(seen).toEqual([`${window.location.origin}${SETUP_PAGE_PATH}`]);
    expect(window.location.href).not.toContain(SETUP_TOKEN);
  });

  it('test_setup_without_valid_token_sends_nothing', async () => {
    for (const fragment of ['', SETUP_TOKEN.slice(0, 42)]) {
      const server = fakeServer({ session: TOM });
      openSetup(fragment);
      expect(await screen.findByText(NO_LINK)).toBeTruthy();
      await settle();
      expect(server.count('POST', ADMIN_SETUP_PATH), fragment).toBe(0);
      expect(screen.queryByLabelText('Email')).toBeNull();
      expect(screen.queryByText(DONE)).toBeNull();
      expect(window.location.hash).toBe('');
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('test_setup_claims_once_under_strict_mode', async () => {
    const server = fakeServer({ session: TOM });
    openSetup(SETUP_TOKEN, { strict: true });

    await expectDone();
    // StrictMode loads twice; the fake server, like the real one, refuses a second use of the token.
    await waitFor(() => expect(server.count('GET', SESSION_PATH)).toBe(2));
    await settle();
    expect(server.calls.filter((c) => c.method === 'POST')).toEqual([
      { method: 'POST', path: ADMIN_SETUP_PATH, body: { token: SETUP_TOKEN } },
    ]);
    expect(screen.getByText(DONE)).toBeTruthy();
    expect(screen.queryByText(REFUSED)).toBeNull();
  });
});

describe('errors', () => {
  it('test_setup_refused_offers_sign_out', async () => {
    let claims = 0;
    const server = fakeServer({
      session: 'other@example.com',
      routes: {
        // Made for TOM's address: refused for the other one, taken once TOM signs in.
        [`POST ${ADMIN_SETUP_PATH}`]: () => (claims++ === 0 ? SETUP_REFUSED : { status: 200, body: { ok: true } }),
      },
    });
    const { user } = openSetup();
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(screen.queryByText(DONE)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(server.count('POST', SIGN_OUT_PATH)).toBe(1);
    await signIn(user);

    await expectDone();
    expect(server.calls.filter((c) => c.path === ADMIN_SETUP_PATH).map((c) => c.body)).toEqual([
      { token: SETUP_TOKEN },
      { token: SETUP_TOKEN },
    ]);
  });

  it('test_setup_session_lost_and_offline', async () => {
    // The session ended before the claim: sign in again, and the claim follows with the same token.
    let lost = 0;
    let server = fakeServer({
      session: TOM,
      routes: {
        [`POST ${ADMIN_SETUP_PATH}`]: () => (lost++ === 0 ? SESSION_GONE : { status: 200, body: { ok: true } }),
      },
    });
    let view = openSetup();
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT)).toBeTruthy();
    await signIn(view.user);
    await expectDone();
    expect(server.count('POST', ADMIN_SETUP_PATH)).toBe(2);
    cleanup();
    vi.unstubAllGlobals();

    // No answer, or a server error: said, and "Try again" repeats the claim.
    for (const [failure, message] of [
      ['offline', OFFLINE],
      [{ status: 500, body: { code: 'unknown', message: 'Something went wrong.' } }, FAILED],
    ] as const) {
      let tries = 0;
      server = fakeServer({
        session: TOM,
        routes: {
          [`POST ${ADMIN_SETUP_PATH}`]: () => {
            if (tries++ > 0) return { status: 200, body: { ok: true } };
            if (failure === 'offline') throw new TypeError('Failed to fetch');
            return failure;
          },
        },
      });
      view = openSetup();
      expect(await screen.findByText(message)).toBeTruthy();
      expect(screen.queryByLabelText('Email')).toBeNull();
      await view.user.click(screen.getByRole('button', { name: 'Try again' }));
      await expectDone();
      expect(server.calls.filter((c) => c.path === ADMIN_SETUP_PATH).map((c) => c.body)).toEqual([
        { token: SETUP_TOKEN },
        { token: SETUP_TOKEN },
      ]);
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});

describe('naming and storage', () => {
  it('test_setup_names_server_from_discovery', async () => {
    fakeServer();
    const { user } = openSetup();
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(document.title).toBe(`Set up · ${INFO.name}`);
    expect(screen.getByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(document.body.textContent).not.toContain('unAlgorithm Cloud');
    await signIn(user);

    await expectDone();
    expect(document.title).toBe(`Set up · ${INFO.name}`);
    expect(screen.getByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(document.body.textContent).not.toContain('unAlgorithm Cloud');
  });

  it('test_setup_stores_nothing', async () => {
    fakeServer();
    const { user } = openSetup();
    await signIn(user);
    await expectDone();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.history.state).toBeNull();
    expect(window.location.href).not.toContain(SETUP_TOKEN);
  });
});
