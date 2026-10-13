/**
 * The sign-in page as the extension's `launchWebAuthFlow` opens it: the link is checked before anything is fetched,
 * then the email and code steps (or "Continue as") end with the browser sent back to the extension. `fetch` is a fake
 * server per test, and `location` a stand-in whose `assign` records the redirect: jsdom's own cannot be spied on.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTHORIZE_API_PATH, chromiumRedirectUri, SERVER_INFO_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Authorize } from '../src/Authorize.tsx';
import { SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';

const EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
const TOM = 'tom@example.com';

/** The query `launchWebAuthFlow` opens the page with. */
const PARAMS = {
  client_id: EXTENSION_ID,
  redirect_uri: chromiumRedirectUri(EXTENSION_ID),
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  state: 'Qm9vdHN0cmFwLXN0YXRlLTE',
};
const REDIRECT = `${PARAMS.redirect_uri}?code=${'c'.repeat(43)}&state=${PARAMS.state}`;

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

const INVALID_LINK = "This sign-in link isn't valid. Start again from the UnAlgorithm extension.";
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const REFUSED = "This server doesn't accept sign-ins from this extension.";

type Reply = { status: number; body?: unknown };
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stubs `fetch` with the server's routes, each answering 200 unless `replies` says otherwise (keyed `METHOD path`).
 * `session` is the address `get-session` reports, or null for none.
 */
function fakeServer({ session = null, replies = {} }: { session?: string | null; replies?: Record<string, Reply> } = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Reply> = {
    [`GET ${SERVER_INFO_PATH}`]: { status: 200, body: INFO },
    [`GET ${SESSION_PATH}`]: { status: 200, body: session ? { session: { userId: 'u1' }, user: { email: session } } : null },
    [`POST ${SEND_CODE_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${SIGN_IN_PATH}`]: { status: 200, body: { token: 'session-token', user: { email: TOM } } },
    [`POST ${SIGN_OUT_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${AUTHORIZE_API_PATH}`]: { status: 200, body: { redirect: REDIRECT } },
    ...replies,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = routes[`${method} ${path}`] ?? { status: 404, body: { code: 'bad-request', message: 'Not found.' } };
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

/** Opens `/authorize` with this query and renders the page. */
function openPage(params: Record<string, string> = PARAMS) {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname: '/authorize', search: `?${new URLSearchParams(params)}`, assign });
  const user = userEvent.setup();
  render(<Authorize />);
  return { assign, user };
}

/** Sends a code to `email` from the Email step and waits for the code field. */
async function sendCodeTo(user: ReturnType<typeof userEvent.setup>, email = TOM) {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  return screen.findByLabelText('6-digit code');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('link validation', () => {
  it('test_invalid_link_makes_no_requests', async () => {
    const server = fakeServer();
    const { state: _state, ...noState } = PARAMS;
    const invalid: Record<string, string>[] = [
      { ...PARAMS, code_challenge_method: 'plain' },
      noState,
      { ...PARAMS, redirect_uri: 'https://evil.example/' },
      { ...PARAMS, redirect_uri: chromiumRedirectUri('b'.repeat(32)) },
      {},
    ];
    for (const params of invalid) {
      openPage(params);
      expect(screen.getByText(INVALID_LINK)).toBeTruthy();
      expect(screen.queryByLabelText('Email')).toBeNull();
      cleanup();
    }
    // Effects have run and settled: still nothing was asked of the server.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.fetch).not.toHaveBeenCalled();
  });
});

describe('email-code flow', () => {
  it('test_send_code_posts_sign_in_type', async () => {
    const server = fakeServer();
    const { user } = openPage();
    const codeField = await sendCodeTo(user);
    expect(codeField).toBeTruthy();
    expect(server.posts()).toEqual([{ method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } }]);
  });

  it('test_verify_then_authorize_then_redirect', async () => {
    const server = fakeServer();
    const { user, assign } = openPage();
    await user.type(await sendCodeTo(user), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(server.posts()).toEqual([
      { method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } },
      { method: 'POST', path: SIGN_IN_PATH, body: { email: TOM, otp: '123456' } },
      { method: 'POST', path: AUTHORIZE_API_PATH, body: PARAMS },
    ]);
  });

  it('test_wrong_code_message', async () => {
    const server = fakeServer({
      replies: { [`POST ${SIGN_IN_PATH}`]: { status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } } },
    });
    const { user, assign } = openPage();
    await user.type(await sendCodeTo(user), '654321');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(WRONG_CODE)).toBeTruthy();
    expect(screen.getByLabelText('6-digit code')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeTruthy();
    expect(server.posts().map((c) => c.path)).toEqual([SEND_CODE_PATH, SIGN_IN_PATH]);
    expect(assign).not.toHaveBeenCalled();
  });

  it('test_locked_code_shows_send_new_code', async () => {
    const server = fakeServer({
      replies: { [`POST ${SIGN_IN_PATH}`]: { status: 403, body: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } } },
    });
    const { user, assign } = openPage();
    await user.type(await sendCodeTo(user), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(WRONG_CODE)).toBeTruthy();
    expect(screen.getByLabelText('6-digit code')).toBeTruthy();
    expect(screen.queryByText(REFUSED)).toBeNull();
    expect(assign).not.toHaveBeenCalled();

    // The way out of a locked code: a new one, for the same address.
    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(server.posts()).toHaveLength(3));
    expect(server.posts()[2]).toEqual({ method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } });
    expect(screen.queryByText(WRONG_CODE)).toBeNull();
    expect(server.posts().some((c) => c.path === AUTHORIZE_API_PATH)).toBe(false);
  });

  it('test_rate_limited_message', async () => {
    // Sending the code.
    fakeServer({ replies: { [`POST ${SEND_CODE_PATH}`]: { status: 429, body: { message: 'Too many requests.' } } } });
    let page = openPage();
    await page.user.type(await screen.findByLabelText('Email'), TOM);
    await page.user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(TOO_MANY)).toBeTruthy();
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
    cleanup();

    // Signing in with it.
    fakeServer({ replies: { [`POST ${SIGN_IN_PATH}`]: { status: 429, body: { message: 'Too many requests.' } } } });
    page = openPage();
    await page.user.type(await sendCodeTo(page.user), '123456');
    await page.user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(TOO_MANY)).toBeTruthy();
    expect(page.assign).not.toHaveBeenCalled();
  });
});

describe('existing session', () => {
  it('test_continue_as_signed_in_user', async () => {
    let server = fakeServer({ session: TOM });
    let page = openPage();
    await page.user.click(await screen.findByRole('button', { name: `Continue as ${TOM}` }));
    await waitFor(() => expect(page.assign).toHaveBeenCalledWith(REDIRECT));
    expect(server.posts()).toEqual([{ method: 'POST', path: AUTHORIZE_API_PATH, body: PARAMS }]);
    cleanup();

    server = fakeServer({ session: TOM });
    page = openPage();
    await page.user.click(await screen.findByRole('button', { name: 'Use another email' }));
    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Continue as ${TOM}` })).toBeNull();
    expect(server.posts()).toEqual([{ method: 'POST', path: SIGN_OUT_PATH, body: {} }]);
    expect(page.assign).not.toHaveBeenCalled();
  });

  it('test_authorize_forbidden_message', async () => {
    fakeServer({
      session: TOM,
      replies: {
        [`POST ${AUTHORIZE_API_PATH}`]: {
          status: 403,
          body: { code: 'permission', message: "This server doesn't accept sign-ins from here." },
        },
      },
    });
    const { user, assign } = openPage();
    await user.click(await screen.findByRole('button', { name: `Continue as ${TOM}` }));
    expect(await screen.findByText(REFUSED)).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('presentation', () => {
  it('test_heading_and_source_link_from_discovery', async () => {
    fakeServer();
    openPage();
    expect(await screen.findByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(screen.getByText('Sign in to use AI in the UnAlgorithm Feed extension.')).toBeTruthy();
    expect(document.title).toBe(`Sign in · ${INFO.name}`);
    const source = screen.getByRole('link', { name: 'Source' });
    expect(source.getAttribute('href')).toBe(INFO.source);
    expect(source.getAttribute('rel')).toContain('noreferrer');
    expect(source.closest('footer')?.textContent).toBe(`${INFO.name} · Source`);
  });

  it('test_labels_and_keyboard_submit', async () => {
    fakeServer();
    let page = openPage();
    const email = await screen.findByLabelText('Email');
    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    await page.user.type(email, `${TOM}{Enter}`);

    const code = await screen.findByLabelText('6-digit code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('maxlength')).toBe('6');
    await page.user.type(code, '123456{Enter}');
    await waitFor(() => expect(page.assign).toHaveBeenCalledWith(REDIRECT));
    cleanup();

    // "Continue as" takes the focus, so Enter alone continues.
    fakeServer({ session: TOM });
    page = openPage();
    const button = await screen.findByRole('button', { name: `Continue as ${TOM}` });
    expect(document.activeElement).toBe(button);
    await page.user.keyboard('{Enter}');
    await waitFor(() => expect(page.assign).toHaveBeenCalledWith(REDIRECT));
  });

  it('test_web_source_never_hardcodes_cloud_name', async () => {
    // `import.meta.url` is not a file URL under jsdom; `import.meta.dirname` is the folder on disk.
    const root = join(import.meta.dirname, '..');
    const src = join(root, 'src');
    const files = [
      ...(await readdir(src, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name)),
      join(root, 'index.html'),
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(await readFile(file, 'utf8'), file).not.toContain('UnAlgorithm Cloud');
    }
  });
});
