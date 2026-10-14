/**
 * The email-code sign-in every page of the server's web app shares: the email step, the code step and their messages,
 * on their own and inside the authorize page. `fetch` is a fake server per test, as in `authorize.test.tsx`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTHORIZE_API_PATH, chromiumRedirectUri, SERVER_INFO_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Authorize } from '../src/Authorize.tsx';
import { SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH } from '../src/api.ts';
import { SignIn } from '../src/SignIn.tsx';

const TOM = 'tom@example.com';
const EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';

const SENT = `If ${TOM} can sign in here, a 6-digit code is on its way.`;
const NEW_CODE = 'New code requested.';
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const OFFLINE = "Couldn't reach the server. Try again.";
const SIGNED_OUT = 'You were signed out. Sign in again.';

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

/** An answer, `'offline'` for none at all (`fetch` rejects), or a function for one that arrives when the test says. */
type Reply = { status: number; body?: unknown } | 'offline' | (() => Promise<{ status: number; body?: unknown }>);
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Stubs `fetch` with these routes (keyed `METHOD path`); the two sign-in routes answer 200 unless `routes` says otherwise. */
function fakeServer(routes: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const all: Record<string, Reply> = {
    [`POST ${SEND_CODE_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${SIGN_IN_PATH}`]: { status: 200, body: { token: 'session-token', user: { email: TOM } } },
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
  return { calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

/**
 * A user-event session that types without a timer between keys. The default (`delay: 0`) waits a `setTimeout` after
 * every key, which on Windows lasts a whole timer tick (about 15 ms), so each sign-in spent most of its time asleep and
 * the longest tests ran past the 5 s timeout under the full suite's load.
 */
function setupUser() {
  return userEvent.setup({ delay: null });
}

/** Renders `SignIn` on its own, with a spy for `onSignedIn`. */
function renderSignIn(props: { notice?: string; initialEmail?: string } = {}) {
  const onSignedIn = vi.fn();
  const user = setupUser();
  render(<SignIn onSignedIn={onSignedIn} {...props} />);
  return { onSignedIn, user };
}

/** Sends a code to `email` from the email step and waits for the code field. */
async function sendCodeTo(user: ReturnType<typeof userEvent.setup>, email = TOM) {
  await user.type(screen.getByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  return screen.findByLabelText('6-digit code');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('happy path', () => {
  it('test_sign_in_sends_code', async () => {
    const server = fakeServer();
    const { user, onSignedIn } = renderSignIn();
    const email = screen.getByLabelText('Email');
    expect(email.getAttribute('type')).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');

    const code = await sendCodeTo(user);
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('maxlength')).toBe('6');
    expect(screen.getByText(SENT)).toBeTruthy();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(server.posts()).toEqual([{ method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } }]);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('test_sign_in_calls_back_once', async () => {
    const server = fakeServer();
    const { user, onSignedIn } = renderSignIn();
    await user.type(await sendCodeTo(user), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(TOM));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(server.posts()).toEqual([
      { method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } },
      { method: 'POST', path: SIGN_IN_PATH, body: { email: TOM, otp: '123456' } },
    ]);
  });

  it('test_sign_in_resend_and_change_address', async () => {
    const server = fakeServer();
    const { user, onSignedIn } = renderSignIn({ initialEmail: TOM });
    // A pre-filled address needs only the button.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(TOM);
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('6-digit code');

    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    expect(await screen.findByText(NEW_CODE)).toBeTruthy();
    expect(screen.getByLabelText('6-digit code')).toBeTruthy();
    expect(server.posts()).toEqual([
      { method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } },
      { method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } },
    ]);

    // Back to fix the address: no request, and the address is there to edit.
    await user.click(screen.getByRole('button', { name: 'Use another email' }));
    const email = await screen.findByLabelText('Email');
    expect((email as HTMLInputElement).value).toBe(TOM);
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
    expect(screen.queryByText(NEW_CODE)).toBeNull();
    expect(server.calls).toHaveLength(2);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  // One test per answer, each with its own timeout: a slow sign-in under load fails alone instead of taking the
  // remaining cases past the timeout and on into the next test.
  describe('test_sign_in_error_messages', () => {
    it.each<[string, Reply, string]>([
      ['400 INVALID_OTP', { status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } }, WRONG_CODE],
      ['403 TOO_MANY_ATTEMPTS', { status: 403, body: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } }, WRONG_CODE],
      ['429', { status: 429, body: { message: 'Too many requests.' } }, TOO_MANY],
      ['no network', 'offline', OFFLINE],
    ])('signing in: %s', async (_name, reply, message) => {
      fakeServer({ [`POST ${SIGN_IN_PATH}`]: reply });
      const { user, onSignedIn } = renderSignIn();
      await user.type(await sendCodeTo(user), '123456');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByLabelText('6-digit code')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Send a new code' })).toBeTruthy();
      expect(onSignedIn).not.toHaveBeenCalled();
    });

    // Sending the code: the same messages, on the email step.
    it.each<[string, Reply, string]>([
      ['429', { status: 429, body: { message: 'Too many requests.' } }, TOO_MANY],
      ['no network', 'offline', OFFLINE],
    ])('sending the code: %s', async (_name, reply, message) => {
      fakeServer({ [`POST ${SEND_CODE_PATH}`]: reply });
      const { user } = renderSignIn();
      await user.type(screen.getByLabelText('Email'), TOM);
      await user.click(screen.getByRole('button', { name: 'Send code' }));
      expect((await screen.findByRole('alert')).textContent).toBe(message);
      expect(screen.getByLabelText('Email')).toBeTruthy();
      expect(screen.queryByLabelText('6-digit code')).toBeNull();
    });
  });

  it('test_sign_in_single_flight', async () => {
    let answerSend: () => void = () => {};
    let answerSignIn: () => void = () => {};
    const server = fakeServer({
      [`POST ${SEND_CODE_PATH}`]: () =>
        new Promise((resolve) => {
          answerSend = () => resolve({ status: 200, body: { success: true } });
        }),
      [`POST ${SIGN_IN_PATH}`]: () =>
        new Promise((resolve) => {
          answerSignIn = () => resolve({ status: 200, body: { token: 'session-token', user: { email: TOM } } });
        }),
    });
    const { user, onSignedIn } = renderSignIn();
    await user.type(screen.getByLabelText('Email'), TOM);
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    const send = screen.getByRole('button', { name: 'Send code' });
    await waitFor(() => expect(send.getAttribute('aria-busy')).toBe('true'));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Email'), '{Enter}');
    fireEvent.submit(send.closest('form') as HTMLFormElement);
    expect(server.posts()).toHaveLength(1);

    answerSend();
    const code = await screen.findByLabelText('6-digit code');
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const signIn = screen.getByRole('button', { name: 'Sign in' });
    await waitFor(() => expect(signIn.getAttribute('aria-busy')).toBe('true'));
    expect((screen.getByRole('button', { name: 'Send a new code' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(signIn.closest('form') as HTMLFormElement);
    expect(server.posts().map((c) => c.path)).toEqual([SEND_CODE_PATH, SIGN_IN_PATH]);

    answerSignIn();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(TOM));
    expect(onSignedIn).toHaveBeenCalledTimes(1);
  });

  it('test_signed_out_notice_clears_on_send_code', async () => {
    // The authorize page, signed in, and the session ends before "Continue as" asks for the extension's code.
    const params = {
      client_id: EXTENSION_ID,
      redirect_uri: chromiumRedirectUri(EXTENSION_ID),
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 'Qm9vdHN0cmFwLXN0YXRlLTE',
    };
    const server = fakeServer({
      [`GET ${SERVER_INFO_PATH}`]: { status: 200, body: INFO },
      [`GET ${SESSION_PATH}`]: { status: 200, body: { session: { userId: 'u1' }, user: { email: TOM } } },
      [`POST ${AUTHORIZE_API_PATH}`]: { status: 401, body: { code: 'auth-required', message: 'Sign in first.' } },
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/authorize', search: `?${new URLSearchParams(params)}`, assign });
    let user = setupUser();
    render(<Authorize />);
    await user.click(await screen.findByRole('button', { name: `Continue as ${TOM}` }));

    const email = await screen.findByLabelText('Email');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(SIGNED_OUT);
    expect(alert.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText(SIGNED_OUT)).toHaveLength(1);

    await sendCodeTo(user);
    expect(screen.queryByText(SIGNED_OUT)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(SENT)).toBeTruthy();

    // Signed in with the code, and the session is gone again: the same message, with the address kept to send again.
    await user.type(screen.getByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe(SIGNED_OUT);
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe(TOM);
    expect(server.posts().map((c) => c.path)).toEqual([AUTHORIZE_API_PATH, SEND_CODE_PATH, SIGN_IN_PATH, AUTHORIZE_API_PATH]);
    expect(assign).not.toHaveBeenCalled();
    cleanup();

    // SignIn on its own: the notice from the page around it stays until the first request starts.
    fakeServer();
    const notice = 'A message from the page.';
    ({ user } = renderSignIn({ notice }));
    expect(screen.getByRole('alert').textContent).toBe(notice);
    await user.type(screen.getByLabelText('Email'), TOM);
    expect(screen.getByRole('alert').textContent).toBe(notice);
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('6-digit code');
    expect(screen.queryByText(notice)).toBeNull();
  });
});

describe('structure', () => {
  it('test_failure_message_defined_once', async () => {
    // `import.meta.url` is not a file URL under jsdom; `import.meta.dirname` is the folder on disk.
    const src = join(import.meta.dirname, '..', 'src');
    const files = (await readdir(src, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(3);
    const found: string[] = [];
    for (const file of files) {
      const count = (await readFile(file, 'utf8')).split('function failureMessage').length - 1;
      for (let i = 0; i < count; i++) found.push(file);
    }
    expect(found).toEqual([join(src, 'SignIn.tsx')]);
  });
});
