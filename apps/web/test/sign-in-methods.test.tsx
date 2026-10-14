/**
 * The other ways in that the shared `SignIn` offers next to the emailed code: Google (a redirect there and back) and a
 * passkey (a WebAuthn ceremony on this page), each only when the discovery document lists it, on their own and inside
 * the authorize and account pages. `fetch` is the shared fake server, `location` a stand-in whose `assign` records
 * where the browser is sent, and `@simplewebauthn/browser` a mock, so each test says what the authenticator answers.
 */

import { type AuthenticationResponseJSON, browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  ACCOUNT_PAGE_PATH,
  AUTHORIZE_API_PATH,
  AUTHORIZE_PAGE_PATH,
  EMAIL_OTP_METHOD,
  GOOGLE_METHOD,
  PASSKEY_METHOD,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account } from '../src/Account.tsx';
import { Authorize } from '../src/Authorize.tsx';
import {
  PASSKEY_AUTH_OPTIONS_PATH,
  PASSKEY_AUTH_VERIFY_PATH,
  SEND_CODE_PATH,
  SESSION_PATH,
  SOCIAL_SIGN_IN_PATH,
} from '../src/api.ts';
import { SignIn, type SignInProps } from '../src/SignIn.tsx';
import {
  fakeServer,
  GOOGLE_URL,
  INFO,
  PARAMS,
  PASSKEY_OPTIONS,
  REDIRECT,
  type Reply,
  SIGNED_IN,
  TOM,
} from './support/fake-server.ts';

vi.mock('@simplewebauthn/browser');

const ALL_METHODS = [EMAIL_OTP_METHOD, GOOGLE_METHOD, PASSKEY_METHOD];
/** A server with a Google client: its discovery document lists every method. */
const INFO_ALL: ServerInfo = { ...INFO, auth: { ...INFO.auth, methods: ALL_METHODS } };

const GOOGLE = 'Continue with Google';
const PASSKEY = 'Sign in with a passkey';
const GOOGLE_FAILED = "Google sign-in didn't work. Try again, or sign in with your email.";
const FAILED = 'Something went wrong. Try again.';
const OFFLINE = "Couldn't reach the server. Try again.";
const CANCELLED = 'Passkey sign-in was cancelled.';
const NOT_SET_UP = "That passkey isn't set up for this server. Sign in with your email, then add a passkey on your account page.";

/** What the authenticator hands back, as `startAuthentication` returns it. */
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

/** What Better Auth's Google sign-in is asked for, coming back to `back` whether it works or not. */
function googleBody(back: string) {
  return { provider: 'google', callbackURL: back, errorCallbackURL: back, disableRedirect: true };
}

/** Puts the page at `pathname` with this query; `assign` records where the page sends the browser. */
function stubLocation(pathname: string, search = '') {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname, search, assign });
  return assign;
}

/** Renders `SignIn` on its own, with a spy for `onSignedIn`. */
function renderSignIn(props: Partial<SignInProps> = {}) {
  const onSignedIn = vi.fn();
  const user = setupUser();
  render(<SignIn onSignedIn={onSignedIn} {...props} />);
  return { onSignedIn, user };
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.mocked(browserSupportsWebAuthn).mockReset().mockReturnValue(true);
  vi.mocked(startAuthentication).mockReset().mockResolvedValue(ASSERTION);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('methods shown', () => {
  it('test_buttons_follow_discovery_methods', () => {
    const shown = () => ({
      google: screen.queryByRole('button', { name: GOOGLE }) !== null,
      passkey: screen.queryByRole('button', { name: PASSKEY }) !== null,
      or: screen.queryByText('or') !== null,
    });

    renderSignIn();
    expect(shown()).toEqual({ google: false, passkey: false, or: false });
    cleanup();

    renderSignIn({ methods: [EMAIL_OTP_METHOD] });
    expect(shown()).toEqual({ google: false, passkey: false, or: false });
    cleanup();

    renderSignIn({ methods: ALL_METHODS });
    expect(shown()).toEqual({ google: true, passkey: true, or: true });
    // The divider is decoration: a screen reader hears the buttons' names, not "or".
    expect(screen.getByText('or').getAttribute('aria-hidden')).toBe('true');
    // "Send code" stays the one primary button.
    expect(screen.getByRole('button', { name: 'Send code' }).className).toContain('ua-button--primary');
    expect(screen.getByRole('button', { name: GOOGLE }).className).not.toContain('ua-button--primary');
    expect(screen.getByRole('button', { name: PASSKEY }).className).not.toContain('ua-button--primary');
    cleanup();

    // A browser without WebAuthn gets no passkey button, and with Google not listed, no divider either.
    vi.mocked(browserSupportsWebAuthn).mockReturnValue(false);
    renderSignIn({ methods: ALL_METHODS });
    expect(shown()).toEqual({ google: true, passkey: false, or: true });
    cleanup();

    renderSignIn({ methods: [EMAIL_OTP_METHOD, PASSKEY_METHOD] });
    expect(shown()).toEqual({ google: false, passkey: false, or: false });
  });
});

describe('Google', () => {
  it('test_google_posts_return_urls_and_navigates', async () => {
    const back = `${AUTHORIZE_PAGE_PATH}?${new URLSearchParams(PARAMS)}`;
    let server = fakeServer();
    let assign = stubLocation('/elsewhere');
    let page = renderSignIn({ methods: ALL_METHODS, returnTo: back });
    await page.user.click(screen.getByRole('button', { name: GOOGLE }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(server.calls).toEqual([{ method: 'POST', path: SOCIAL_SIGN_IN_PATH, body: googleBody(back) }]);
    expect(page.onSignedIn).not.toHaveBeenCalled();
    cleanup();

    // Without `returnTo`, Google sends the browser back to the page's own path.
    server = fakeServer();
    assign = stubLocation(ACCOUNT_PAGE_PATH, '?ignored=1');
    page = renderSignIn({ methods: ALL_METHODS });
    await page.user.click(screen.getByRole('button', { name: GOOGLE }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(server.calls).toEqual([{ method: 'POST', path: SOCIAL_SIGN_IN_PATH, body: googleBody(ACCOUNT_PAGE_PATH) }]);
  });

  describe('test_google_url_must_be_google', () => {
    it.each<[string, Reply, string]>([
      ['another host', { status: 200, body: { url: 'https://evil.example/', redirect: false } }, FAILED],
      ['a look-alike host', { status: 200, body: { url: 'https://accounts.google.com.evil.example/o/oauth2' } }, FAILED],
      ['plain http', { status: 200, body: { url: 'http://accounts.google.com/o/oauth2/v2/auth' } }, FAILED],
      ['a script address', { status: 200, body: { url: 'javascript:alert(1)' } }, FAILED],
      ['no address', { status: 200, body: { redirect: false } }, FAILED],
      ['a refusal', { status: 400, body: { code: 'BAD_REQUEST', message: 'Invalid callbackURL' } }, FAILED],
      ['no network', 'offline', OFFLINE],
    ])('%s', async (_name, reply, message) => {
      fakeServer({ routes: { [`POST ${SOCIAL_SIGN_IN_PATH}`]: reply } });
      const assign = stubLocation('/account');
      const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });
      await user.click(screen.getByRole('button', { name: GOOGLE }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      await settle();
      expect(assign).not.toHaveBeenCalled();
      expect(onSignedIn).not.toHaveBeenCalled();
      // The person can try again, or use the email form.
      expect((screen.getByRole('button', { name: GOOGLE }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByLabelText('Email')).toBeTruthy();
    });
  });

  it('test_google_failed_banner', async () => {
    fakeServer();
    const { user } = renderSignIn({ methods: ALL_METHODS, googleFailed: true });
    const email = screen.getByLabelText('Email');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(GOOGLE_FAILED);
    // Above the form, with the email field and the buttons to try again.
    expect(alert.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: GOOGLE })).toBeTruthy();

    // Like any message, it goes once the next request starts.
    await user.type(email, TOM);
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('6-digit code');
    expect(screen.queryByText(GOOGLE_FAILED)).toBeNull();
    cleanup();

    renderSignIn({ methods: ALL_METHODS, googleFailed: false });
    expect(screen.queryByText(GOOGLE_FAILED)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_authorize_google_error_and_return_url', async () => {
    const server = fakeServer({ info: INFO_ALL });
    const query = new URLSearchParams({ ...PARAMS, error: 'SIGNUP_CLOSED', error_description: 'Sign-ups are closed.' });
    const assign = stubLocation(AUTHORIZE_PAGE_PATH, `?${query}`);
    const user = setupUser();
    render(<Authorize />);

    const email = await screen.findByLabelText('Email');
    expect(screen.getByRole('alert').textContent).toBe(GOOGLE_FAILED);
    expect(screen.getByRole('button', { name: 'Send code' })).toBeTruthy();
    expect(email).toBeTruthy();

    await user.click(screen.getByRole('button', { name: GOOGLE }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    const [post] = server.posts();
    expect(post?.path).toBe(SOCIAL_SIGN_IN_PATH);
    const body = post?.body as ReturnType<typeof googleBody>;
    expect(body).toEqual(googleBody(body.callbackURL));
    // Back to this page with the extension's request, and without the failure that brought the person here.
    const back = new URL(body.callbackURL, 'https://server.example');
    expect(back.origin + back.pathname).toBe(`https://server.example${AUTHORIZE_PAGE_PATH}`);
    expect(Object.fromEntries(back.searchParams)).toEqual(PARAMS);
    expect(server.count('POST', AUTHORIZE_API_PATH)).toBe(0);
  });

  it('test_account_google_returns_to_account', async () => {
    const server = fakeServer({ info: INFO_ALL });
    const assign = stubLocation(ACCOUNT_PAGE_PATH, '?error=SIGNUP_CLOSED');
    const user = setupUser();
    render(<Account />);

    await screen.findByLabelText('Email');
    expect(screen.getByRole('alert').textContent).toBe(GOOGLE_FAILED);
    await user.click(screen.getByRole('button', { name: GOOGLE }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(server.posts()).toEqual([{ method: 'POST', path: SOCIAL_SIGN_IN_PATH, body: googleBody(ACCOUNT_PAGE_PATH) }]);
    cleanup();

    // Without `error` in its address the page shows no failure, and a server without Google shows no button.
    fakeServer();
    stubLocation(ACCOUNT_PAGE_PATH);
    render(<Account />);
    await screen.findByLabelText('Email');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: GOOGLE })).toBeNull();
    expect(screen.queryByRole('button', { name: PASSKEY })).toBeNull();
  });
});

describe('passkey', () => {
  it('test_passkey_sign_in_calls_back', async () => {
    const server = fakeServer();
    const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });
    await user.click(screen.getByRole('button', { name: PASSKEY }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(TOM));
    await settle();
    expect(onSignedIn).toHaveBeenCalledTimes(1);
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: PASSKEY_OPTIONS });
    expect(server.calls).toEqual([
      { method: 'GET', path: PASSKEY_AUTH_OPTIONS_PATH, body: undefined },
      { method: 'POST', path: PASSKEY_AUTH_VERIFY_PATH, body: { response: ASSERTION } },
      { method: 'GET', path: SESSION_PATH, body: undefined },
    ]);
    // The options were asked for before the authenticator ran, and the verify request came after it.
    const optionsAt = server.fetch.mock.invocationCallOrder[0] ?? 0;
    const ceremonyAt = vi.mocked(startAuthentication).mock.invocationCallOrder[0] ?? 0;
    const verifyAt = server.fetch.mock.invocationCallOrder[1] ?? 0;
    expect(optionsAt).toBeLessThan(ceremonyAt);
    expect(ceremonyAt).toBeLessThan(verifyAt);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('test_passkey_cancel_and_unknown', () => {
    // The library rethrows the browser's error as its own `WebAuthnError`: an `Error` carrying the cause's name.
    it.each(['NotAllowedError', 'AbortError'])('cancelled: %s', async (name) => {
      vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error('x'), { name }));
      const server = fakeServer();
      const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });
      await user.click(screen.getByRole('button', { name: PASSKEY }));

      expect((await screen.findByRole('alert')).textContent).toBe(CANCELLED);
      await settle();
      expect(server.count('POST', PASSKEY_AUTH_VERIFY_PATH)).toBe(0);
      expect(server.count('GET', SESSION_PATH)).toBe(0);
      expect(onSignedIn).not.toHaveBeenCalled();
      expect((screen.getByRole('button', { name: PASSKEY }) as HTMLButtonElement).disabled).toBe(false);
    });

    it.each<[string, Reply, string]>([
      ['401', { status: 401, body: { code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' } }, NOT_SET_UP],
      ['400', { status: 400, body: { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed' } }, NOT_SET_UP],
      ['429', { status: 429, body: { message: 'Too many requests.' } }, 'Too many tries. Wait a minute and try again.'],
      ['no network', 'offline', OFFLINE],
    ])('verify answers %s', async (_name, reply, message) => {
      const server = fakeServer({ routes: { [`POST ${PASSKEY_AUTH_VERIFY_PATH}`]: reply } });
      const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });
      await user.click(screen.getByRole('button', { name: PASSKEY }));

      expect((await screen.findByRole('alert')).textContent).toBe(message);
      await settle();
      expect(server.count('POST', PASSKEY_AUTH_VERIFY_PATH)).toBe(1);
      expect(server.count('GET', SESSION_PATH)).toBe(0);
      expect(onSignedIn).not.toHaveBeenCalled();
    });

    it('another authenticator error', async () => {
      vi.mocked(startAuthentication).mockRejectedValue(Object.assign(new Error('x'), { name: 'SecurityError' }));
      const server = fakeServer();
      const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });
      await user.click(screen.getByRole('button', { name: PASSKEY }));

      expect((await screen.findByRole('alert')).textContent).toBe(FAILED);
      expect(server.count('POST', PASSKEY_AUTH_VERIFY_PATH)).toBe(0);
      expect(onSignedIn).not.toHaveBeenCalled();
    });
  });

  it('test_authorize_passkey_then_redirect_and_google_waits', async () => {
    // A passkey on the authorize page: one click, then the extension's code and the redirect.
    let server = fakeServer({ info: INFO_ALL });
    let assign = stubLocation(AUTHORIZE_PAGE_PATH, `?${new URLSearchParams(PARAMS)}`);
    let user = setupUser();
    render(<Authorize />);
    await user.click(await screen.findByRole('button', { name: PASSKEY }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(server.posts()).toEqual([
      { method: 'POST', path: PASSKEY_AUTH_VERIFY_PATH, body: { response: ASSERTION } },
      { method: 'POST', path: AUTHORIZE_API_PATH, body: PARAMS },
    ]);
    cleanup();

    // Back from Google with a session: the page waits for "Continue as", as for any session it finds.
    server = fakeServer({ session: TOM, info: INFO_ALL });
    assign = stubLocation(AUTHORIZE_PAGE_PATH, `?${new URLSearchParams(PARAMS)}`);
    user = setupUser();
    render(<Authorize />);
    const button = await screen.findByRole('button', { name: `Continue as ${TOM}` });
    await settle();
    expect(server.count('POST', AUTHORIZE_API_PATH)).toBe(0);
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(REDIRECT));
    expect(server.posts()).toEqual([{ method: 'POST', path: AUTHORIZE_API_PATH, body: PARAMS }]);
  });

  it('a passkey on the account page shows the account', async () => {
    fakeServer({ info: INFO_ALL });
    stubLocation(ACCOUNT_PAGE_PATH);
    const user = setupUser();
    render(<Account />);
    await user.click(await screen.findByRole('button', { name: PASSKEY }));
    expect(await screen.findByText(SIGNED_IN)).toBeTruthy();
  });
});

describe('accessibility', () => {
  it('test_new_buttons_keyboard_operable', async () => {
    const server = fakeServer();
    const assign = stubLocation(ACCOUNT_PAGE_PATH);
    const { user, onSignedIn } = renderSignIn({ methods: ALL_METHODS });

    // In page order after the email form: the field, "Send code", then Google and the passkey.
    expect(document.activeElement).toBe(screen.getByLabelText('Email'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send code' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: GOOGLE }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: PASSKEY }));

    // Enter on Google goes to Google; Enter in the email field still sends the code, not Google.
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));

    // Space on the passkey signs in.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: PASSKEY }));
    await user.keyboard(' ');
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(TOM));

    await user.type(screen.getByLabelText('Email'), `${TOM}{Enter}`);
    await screen.findByLabelText('6-digit code');
    expect(server.posts().map((c) => c.path)).toEqual([SOCIAL_SIGN_IN_PATH, PASSKEY_AUTH_VERIFY_PATH, SEND_CODE_PATH]);
  });
});
