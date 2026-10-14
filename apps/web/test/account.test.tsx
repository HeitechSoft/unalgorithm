/**
 * The account page every server serves at `/account`: who is signed in here and signing out, or the email-code sign-in
 * when nobody is, and the home page's link to it. `fetch` is a fake server per test that keeps a session as the real one
 * does: an accepted code starts it and signing out ends it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ACCOUNT_PAGE_PATH, SERVER_INFO_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';
import { Home } from '../src/main.tsx';

const TOM = 'tom@example.com';
const SIGNED_IN = `Signed in as ${TOM}`;
const UNREACHABLE = "Couldn't reach the server. Try again.";

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://example.org/source/server-v0.1.0',
  billing: false,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
  limits: { maxPostsPerRequest: 12 },
};

type Answer = { status: number; body?: unknown };
/** An answer, `'offline'` for none at all (`fetch` rejects), or a function for one that arrives when the test says. */
type Reply = Answer | 'offline' | (() => Answer | Promise<Answer>);
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stubs `fetch` with the server's routes (keyed `METHOD path`; `routes` replaces any of them). `session` is the address
 * signed in at the start, or null for none; an accepted code signs in as TOM and signing out ends the session.
 */
function fakeServer({
  session = null,
  info = INFO,
  routes = {},
}: {
  session?: string | null;
  info?: ServerInfo;
  routes?: Record<string, Reply>;
} = {}) {
  const calls: Call[] = [];
  let current = session;
  const all: Record<string, Reply> = {
    [`GET ${SERVER_INFO_PATH}`]: { status: 200, body: info },
    [`GET ${SESSION_PATH}`]: () => ({
      status: 200,
      body: current ? { session: { userId: 'u1' }, user: { email: current } } : null,
    }),
    [`POST ${SEND_CODE_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${SIGN_IN_PATH}`]: () => {
      current = TOM;
      return { status: 200, body: { token: 'session-token', user: { email: TOM } } };
    },
    [`POST ${SIGN_OUT_PATH}`]: () => {
      current = null;
      return { status: 200, body: { success: true } };
    },
    ...routes,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = all[`${method} ${path}`] ?? { status: 404, body: { code: 'bad-request', message: 'Not found.' } };
    if (route === 'offline') throw new TypeError('Failed to fetch');
    const reply = typeof route === 'function' ? await route() : route;
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length };
}

/** Renders the account page. */
function openAccount() {
  const user = userEvent.setup();
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
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(screen.getByText('Your account on this server.')).toBeTruthy();
    expect(document.title).toBe(`Account · ${INFO.name}`);
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('test_account_sign_out', async () => {
    const server = fakeServer({ session: TOM });
    const { user } = openAccount();
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
    expect(screen.queryByLabelText('Email')).toBeNull();
    // The address shown is the one the server reports for the new session, asked for again.
    expect(server.count('GET', SESSION_PATH)).toBe(2);
    expect(server.calls.map((c) => `${c.method} ${c.path}`).slice(2)).toEqual([
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
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
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
    const pages: string[] = [];
    for (const billing of [false, true]) {
      const server = fakeServer({ session: TOM, info: { ...INFO, billing } });
      const { container } = openAccount();
      await screen.findByText(SIGNED_IN);
      await new Promise((resolve) => setTimeout(resolve, 0));
      pages.push(container.innerHTML);
      expect(server.calls.map((c) => c.path)).toEqual([SERVER_INFO_PATH, SESSION_PATH]);
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
    expect(screen.getByText('This server provides AI for the UnAlgorithm Feed extension.')).toBeTruthy();
  });
});
