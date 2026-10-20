/**
 * The sign-in page as the extension's `launchWebAuthFlow` opens it, in Chrome and Edge or in Firefox: the link is
 * checked before anything is fetched, then the email and code steps (or "Continue as") end with the browser sent back
 * to the extension, and only to the redirect address the link named. `fetch` is the shared fake server, and `location`
 * a stand-in whose `assign` records the redirect: jsdom's own cannot be spied on.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  AUTHORIZE_API_PATH,
  chromiumRedirectUri,
  FIREFOX_ADDON_ID,
  FIREFOX_DEV_ADDON_ID,
  geckoRedirectUri,
} from '@unalgorithm/protocol';
import { setupUser, type UserEvent } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Authorize } from '../src/Authorize.tsx';
import { SEND_CODE_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../src/api.ts';
import { fakeServer, GECKO_PARAMS, GECKO_REDIRECT, INFO, PARAMS, REDIRECT, TOM } from './support/fake-server.ts';

const INVALID_LINK = "This sign-in link isn't valid. Start again from the unAlgorithm extension.";
const WRONG_CODE = "That code didn't work. Check it, or send a new one.";
const TOO_MANY = 'Too many tries. Wait a minute and try again.';
const REFUSED = "This server doesn't accept sign-ins from this extension.";
const FAILED = 'Something went wrong. Try again.';

/** Opens `/authorize` with this query and renders the page. */
function openPage(params: Record<string, string> = PARAMS) {
  const assign = vi.fn();
  vi.stubGlobal('location', { pathname: '/authorize', search: `?${new URLSearchParams(params)}`, assign });
  const user = setupUser();
  render(<Authorize />);
  return { assign, user };
}

/** Sends a code to `email` from the Email step and waits for the code field. */
async function sendCodeTo(user: UserEvent, email = TOM) {
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
      // Firefox: each id has one redirect address, the SHA-1 of the id exactly as written, with its trailing slash.
      { ...GECKO_PARAMS, redirect_uri: PARAMS.redirect_uri },
      { ...PARAMS, redirect_uri: GECKO_PARAMS.redirect_uri },
      { ...GECKO_PARAMS, redirect_uri: geckoRedirectUri(FIREFOX_DEV_ADDON_ID) },
      { ...GECKO_PARAMS, client_id: FIREFOX_ADDON_ID.toUpperCase() },
      { ...GECKO_PARAMS, redirect_uri: GECKO_PARAMS.redirect_uri.slice(0, -1) },
      { ...GECKO_PARAMS, redirect_uri: GECKO_PARAMS.redirect_uri.replace('https:', 'http:') },
      // Firefox's loopback form, which `launchWebAuthFlow` would take, is not one the extension makes.
      {
        ...GECKO_PARAMS,
        redirect_uri: `http://127.0.0.1/mozoauth2/${new URL(GECKO_PARAMS.redirect_uri).hostname.split('.')[0]}`,
      },
      { ...GECKO_PARAMS, client_id: 'feed@', redirect_uri: geckoRedirectUri('feed@') },
      {
        ...GECKO_PARAMS,
        client_id: `${'a'.repeat(70)}@example.org`,
        redirect_uri: geckoRedirectUri(`${'a'.repeat(70)}@example.org`),
      },
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

  it('test_firefox_verify_then_authorize_then_redirect', async () => {
    const server = fakeServer();
    const { user, assign } = openPage(GECKO_PARAMS);
    await user.type(await sendCodeTo(user), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    // Firefox's sign-in window closes on the first request to its redirect address: the SHA-1 of the add-on id.
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GECKO_REDIRECT));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(GECKO_REDIRECT.startsWith('https://fa1fc373df59566227d5f6860e1bb584c0410048.extensions.allizom.org/?code=')).toBe(
      true,
    );
    expect(server.posts()).toEqual([
      { method: 'POST', path: SEND_CODE_PATH, body: { email: TOM, type: 'sign-in' } },
      { method: 'POST', path: SIGN_IN_PATH, body: { email: TOM, otp: '123456' } },
      { method: 'POST', path: AUTHORIZE_API_PATH, body: GECKO_PARAMS },
    ]);
  });

  it('test_wrong_code_message', async () => {
    const server = fakeServer({
      routes: { [`POST ${SIGN_IN_PATH}`]: { status: 400, body: { code: 'INVALID_OTP', message: 'Invalid OTP' } } },
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
      routes: { [`POST ${SIGN_IN_PATH}`]: { status: 403, body: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts' } } },
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
    fakeServer({ routes: { [`POST ${SEND_CODE_PATH}`]: { status: 429, body: { message: 'Too many requests.' } } } });
    let page = openPage();
    await page.user.type(await screen.findByLabelText('Email'), TOM);
    await page.user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText(TOO_MANY)).toBeTruthy();
    expect(screen.queryByLabelText('6-digit code')).toBeNull();
    cleanup();

    // Signing in with it.
    fakeServer({ routes: { [`POST ${SIGN_IN_PATH}`]: { status: 429, body: { message: 'Too many requests.' } } } });
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

    // The same from Firefox.
    server = fakeServer({ session: TOM });
    page = openPage(GECKO_PARAMS);
    await page.user.click(await screen.findByRole('button', { name: `Continue as ${TOM}` }));
    await waitFor(() => expect(page.assign).toHaveBeenCalledWith(GECKO_REDIRECT));
    expect(page.assign).toHaveBeenCalledTimes(1);
    expect(server.posts()).toEqual([{ method: 'POST', path: AUTHORIZE_API_PATH, body: GECKO_PARAMS }]);
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
      routes: {
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

describe('redirect', () => {
  it('test_redirect_only_under_request_redirect_uri', async () => {
    // A server (or a fork) that answers with another extension's address, in either browser: nobody is sent there.
    const answer = (uri: string) => `${uri}?code=${'c'.repeat(43)}&state=${PARAMS.state}`;
    const elsewhere: [Record<string, string>, string][] = [
      [PARAMS, GECKO_REDIRECT],
      [GECKO_PARAMS, REDIRECT],
      [PARAMS, answer(chromiumRedirectUri('b'.repeat(32)))],
      [GECKO_PARAMS, answer(geckoRedirectUri(FIREFOX_DEV_ADDON_ID))],
    ];
    for (const [params, redirect] of elsewhere) {
      fakeServer({ session: TOM, routes: { [`POST ${AUTHORIZE_API_PATH}`]: { status: 200, body: { redirect } } } });
      const { user, assign } = openPage(params);
      await user.click(await screen.findByRole('button', { name: `Continue as ${TOM}` }));
      expect(await screen.findByText(FAILED)).toBeTruthy();
      expect(assign).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).toBeNull();
      // Still on "Continue as", so the person can try again.
      expect(screen.getByRole('button', { name: `Continue as ${TOM}` })).toBeTruthy();
      cleanup();
    }
  });
});

describe('presentation', () => {
  it('test_heading_and_source_link_from_discovery', async () => {
    fakeServer();
    openPage();
    expect(await screen.findByRole('heading', { level: 1, name: INFO.name })).toBeTruthy();
    expect(screen.getByText('Sign in to use AI in the unAlgorithm Feed extension.')).toBeTruthy();
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
      expect(await readFile(file, 'utf8'), file).not.toContain('unAlgorithm Cloud');
    }
  });
});
