/**
 * Server discovery, sign-in with PKCE and the device tokens (R10, ADR 0005). The network is an injected fetch and the
 * sign-in window an injected `webAuthFlow`; the secrets store is fake-indexeddb and extension storage the WXT fake
 * browser, so the tests can look at every place a token could end up.
 */
import { AIError, describeError } from '@unalgorithm/ai';
import {
  AUTHORIZE_PAGE_PATH,
  AuthorizeRequestSchema,
  REVOKE_PATH,
  RevokeRequestSchema,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
  TokenRequestSchema,
  type TokenResponse,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { clearSecrets, getSecret } from '../src/background/idb.ts';
import {
  discoverServer,
  getAccessToken,
  type ServerAccount,
  serverAccountItem,
  signIn,
  signOut,
  webAuthFlow,
} from '../src/background/server-auth.ts';
import { PINNED_CLOUD_ORIGIN, serverLabel } from '../src/lib/server-label.ts';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const REDIRECT = `https://${ID}.chromiumapp.org/`;
const ORIGIN = 'https://ai.example.org';
const NOW = Date.UTC(2026, 9, 12, 9);
const MINUTE = 60_000;
const CODE = 'code-0123456789abcdefghijklmnop';

const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://github.com/example/unalgorithm',
  billing: false,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
  limits: { maxPostsPerRequest: 12 },
};

const access = (n: number) => `access-token-${n}`;
const refresh = (n: number) => `refresh-token-${n}-0123456789abcdef`;
const tokens = (n: number): TokenResponse => ({
  access_token: access(n),
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: refresh(n),
  device_id: '0199d6a4-3f1e-7c2a-9b5d-2e8f4a6c1b3d',
  account: { email: 'ada@example.org' },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

/** A server at any origin: discovery answers `info`, the token endpoint `token`, the revoke endpoint `revoke`. */
function fakeServer(
  opts: {
    info?: () => Response | Promise<Response>;
    token?: (init: RequestInit) => Response | Promise<Response>;
    revoke?: () => Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { pathname } = new URL(url);
    if (pathname === SERVER_INFO_PATH) return (opts.info ?? (() => json(INFO)))();
    if (pathname === TOKEN_PATH) return (opts.token ?? (() => json(tokens(1))))(init);
    if (pathname === REVOKE_PATH) return (opts.revoke ?? (async () => json({ ok: true })))();
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const posts = (path: string) => calls.filter((c) => new URL(c.url).pathname === path);
  const bodyOf = (c: Call | undefined) => JSON.parse(String(c?.init.body)) as unknown;
  return { fetch, calls, posts, bodyOf };
}

/** The sign-in window: sends the browser back with a code and the state it was given, unless told otherwise. */
function authFlow(back: (q: URLSearchParams) => string = (q) => `${q.get('redirect_uri')}?code=${CODE}&state=${q.get('state')}`) {
  return vi.fn(async (details: { url: string; interactive: boolean }) => back(new URL(details.url).searchParams));
}

async function signedIn(server = fakeServer()) {
  const result = await signIn('ai.example.org', { fetch: server.fetch, webAuthFlow: authFlow(), now: () => NOW });
  expect(result.ok).toBe(true);
  return server;
}

const stored = async (area: 'local' | 'session') => JSON.stringify(await fakeBrowser.storage[area].get(null));
const isRefresh = (init: RequestInit) => (JSON.parse(String(init.body)) as { grant_type: string }).grant_type === 'refresh_token';

beforeEach(async () => {
  fakeBrowser.reset();
  fakeBrowser.runtime.id = ID;
  vi.spyOn(fakeBrowser.identity, 'getRedirectURL').mockReturnValue(REDIRECT);
  await clearSecrets();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('discovery', () => {
  it('test_discover_bare_domain_uses_https', async () => {
    const s = fakeServer();
    expect(await discoverServer('ai.example.org', { fetch: s.fetch })).toStrictEqual({ ok: true, origin: ORIGIN, info: INFO });
    expect(s.calls.map((c) => c.url)).toStrictEqual(['https://ai.example.org/.well-known/unalgorithm.json']);
    // A path, a trailing slash or surrounding spaces still mean the server's origin.
    expect(await discoverServer(' https://ai.example.org/v1/ ', { fetch: s.fetch })).toMatchObject({ ok: true, origin: ORIGIN });
  });

  it('test_discover_requires_https_except_loopback', async () => {
    const s = fakeServer();
    expect(await discoverServer('http://ai.example.org', { fetch: s.fetch })).toStrictEqual({
      ok: false,
      error: { code: 'bad-request', message: 'Use an https:// address.' },
    });
    for (const input of ['', 'not an address', 'ftp://ai.example.org']) {
      expect(await discoverServer(input, { fetch: s.fetch }), input).toStrictEqual({
        ok: false,
        error: { code: 'bad-request', message: "Enter the server's address, like https://ai.example.org" },
      });
    }
    expect(s.calls).toHaveLength(0);
    for (const origin of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(await discoverServer(origin, { fetch: s.fetch }), origin).toStrictEqual({ ok: true, origin, info: INFO });
    }
    expect(s.calls).toHaveLength(3);
  });

  it('test_discover_rejects_non_server_and_network', async () => {
    const notServer = { ok: false, error: { code: 'unsupported', message: "That address isn't an unAlgorithm server." } };
    for (const [what, info] of [
      ['wrong version', () => json({ ...INFO, v: 2 })],
      ['no email sign-in', () => json({ ...INFO, auth: { ...INFO.auth, methods: ['passkey'] } })],
      ['not found', () => json(INFO, 404)],
      ['not JSON', () => new Response('<!doctype html><title>Hello</title>', { headers: { 'content-type': 'text/html' } })],
    ] as const) {
      expect(await discoverServer(ORIGIN, { fetch: fakeServer({ info }).fetch }), what).toStrictEqual(notServer);
    }

    const down = fakeServer({ info: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect(await discoverServer(ORIGIN, { fetch: down.fetch })).toStrictEqual({
      ok: false,
      error: { code: 'network', message: describeError('network') },
    });
    // No cookies for the server's web session, no following a redirect to another host, and a bounded wait.
    expect(down.calls[0]?.init).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(down.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('sign-in', () => {
  it('test_sign_in_sends_pkce_s256', async () => {
    const s = fakeServer();
    const flow = authFlow();
    expect(await signIn('ai.example.org', { fetch: s.fetch, webAuthFlow: flow, now: () => NOW })).toMatchObject({ ok: true });

    expect(flow).toHaveBeenCalledOnce();
    const details = flow.mock.calls[0]?.[0];
    expect(details?.interactive).toBe(true);
    const url = new URL(details?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}${AUTHORIZE_PAGE_PATH}`);
    const q = url.searchParams;
    expect(q.get('client_id')).toBe(ID);
    expect(q.get('redirect_uri')).toBe(REDIRECT);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toMatch(/^[\w-]{22}$/);
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(AuthorizeRequestSchema.safeParse(Object.fromEntries(q)).success).toBe(true);

    const tokenCalls = s.posts(TOKEN_PATH);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    const body = TokenRequestSchema.parse(s.bodyOf(tokenCalls[0]));
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: CODE, client_id: ID, redirect_uri: REDIRECT });
    if (body.grant_type !== 'authorization_code') throw new Error('unreachable');
    expect(body.code_verifier).toMatch(/^[\w-]{43}$/);
    // Recomputed here with Node's own encoder, not the one under test.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier));
    expect(q.get('code_challenge')).toBe(Buffer.from(digest).toString('base64url'));
  });

  it('test_sign_in_stores_tokens_in_safe_places', async () => {
    const s = fakeServer();
    const result = await signIn('ai.example.org', { fetch: s.fetch, webAuthFlow: authFlow(), now: () => NOW });
    const account = {
      origin: ORIGIN,
      email: 'ada@example.org',
      deviceId: tokens(1).device_id,
      signedInAt: NOW,
      info: INFO,
      needsSignIn: false,
    };
    expect(result).toStrictEqual({ ok: true, account });
    expect(await serverAccountItem.getValue()).toStrictEqual(account);

    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBe(refresh(1));
    expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({
      serverAccess: { origin: ORIGIN, token: access(1), expiresAt: NOW + 900 * 1000 },
    });
    const local = await stored('local');
    expect(local).toContain('ada@example.org');
    expect(local).not.toContain(access(1));
    expect(local).not.toContain(refresh(1));
    expect(await stored('session')).not.toContain(refresh(1));
  });

  it('test_sign_in_rejects_state_mismatch', async () => {
    const unfinished = { ok: false, error: { code: 'auth-required', message: "Sign-in didn't finish. Try again." } };
    for (const back of [
      (q: URLSearchParams) => `${q.get('redirect_uri')}?code=${CODE}&state=someone-elses-state`,
      (q: URLSearchParams) => `${q.get('redirect_uri')}?code=${CODE}`,
      (q: URLSearchParams) => `${q.get('redirect_uri')}?state=${q.get('state')}`,
      (q: URLSearchParams) => `https://evil.example/?code=${CODE}&state=${q.get('state')}`,
    ]) {
      const s = fakeServer();
      expect(await signIn(ORIGIN, { fetch: s.fetch, webAuthFlow: authFlow(back), now: () => NOW })).toStrictEqual(unfinished);
      expect(s.posts(TOKEN_PATH)).toHaveLength(0);
    }
    expect(await serverAccountItem.getValue()).toBeNull();
  });

  it('test_sign_in_cancelled', async () => {
    const s = fakeServer();
    const flow = vi.fn(() => Promise.reject(new Error('The user did not approve access.')));
    expect(await signIn(ORIGIN, { fetch: s.fetch, webAuthFlow: flow, now: () => NOW })).toStrictEqual({
      ok: false,
      error: { code: 'auth-required', message: 'Sign-in was cancelled.' },
    });
    expect(s.posts(TOKEN_PATH)).toHaveLength(0);
    expect(await serverAccountItem.getValue()).toBeNull();
  });

  it('test_sign_in_elsewhere_signs_previous_server_out', async () => {
    const s = await signedIn();
    const result = await signIn('https://other.example.org', {
      fetch: s.fetch,
      webAuthFlow: authFlow(),
      now: () => NOW,
    });
    expect(result).toMatchObject({ ok: true, account: { origin: 'https://other.example.org' } });
    // One account at a time: the first server's device is ended there and its refresh token forgotten here.
    const revokes = s.posts(REVOKE_PATH);
    expect(revokes.map((c) => c.url)).toStrictEqual([`${ORIGIN}${REVOKE_PATH}`]);
    expect(s.bodyOf(revokes[0])).toStrictEqual({ refresh_token: refresh(1), client_id: ID });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
    expect(await getSecret('server-refresh:https://other.example.org')).toBe(refresh(1));
  });

  it('test_sign_in_again_while_a_refresh_runs', async () => {
    let refused = false;
    let issued = 0;
    const s = await signedIn(
      fakeServer({
        token: (init) =>
          refused && isRefresh(init)
            ? json({ code: 'auth-required', message: 'Sign in to Example AI again.' }, 401)
            : json(tokens(++issued)),
      }),
    );
    const LATER = NOW + 16 * MINUTE;
    refused = true;
    await expect(getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => LATER })).rejects.toMatchObject({
      code: 'auth-required',
    });
    expect(await serverAccountItem.getValue()).toMatchObject({ needsSignIn: true });
    refused = false;

    // "Sign in to … again", while a classify batch asks for a token just as the new account is put in place.
    let racing: Promise<unknown> | undefined;
    const now = () => {
      racing ??= getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => LATER }).catch((e: unknown) => e);
      return LATER;
    };
    expect(await signIn(ORIGIN, { fetch: s.fetch, webAuthFlow: authFlow(), now })).toMatchObject({ ok: true });
    const token = await racing;
    expect(token).toMatch(/^access-token-\d+$/);

    // The new sign-in stands: its refresh token is kept, and the account isn't marked for signing in again.
    expect(await serverAccountItem.getValue()).toMatchObject({ signedInAt: LATER, needsSignIn: false });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBe(refresh(issued));
    expect(await getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => LATER })).toBe(token);
  });
});

describe('tokens', () => {
  it('test_access_token_cached_and_refresh_single_flight', async () => {
    let answer: (r: Response) => void = () => {};
    let replies = 0;
    const s = await signedIn(
      fakeServer({
        token: () => {
          replies++;
          return replies === 1 ? json(tokens(1)) : new Promise<Response>((resolve) => (answer = resolve));
        },
      }),
    );
    const before = s.calls.length;

    // Valid for 5 more minutes: served from the session, no request.
    expect(await getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => NOW + 10 * MINUTE })).toBe(access(1));
    expect(s.calls).toHaveLength(before);

    // Expired: three callers, one refresh.
    const later = { fetch: s.fetch, now: () => NOW + 16 * MINUTE };
    const all = Promise.all([
      getAccessToken(ORIGIN, {}, later),
      getAccessToken(ORIGIN, {}, later),
      getAccessToken(ORIGIN, {}, later),
    ]);
    await vi.waitFor(() => expect(s.posts(TOKEN_PATH)).toHaveLength(2));
    answer(json(tokens(2)));
    expect(await all).toStrictEqual([access(2), access(2), access(2)]);
    expect(s.posts(TOKEN_PATH)).toHaveLength(2);
    expect(s.bodyOf(s.posts(TOKEN_PATH)[1])).toStrictEqual({
      grant_type: 'refresh_token',
      refresh_token: refresh(1),
      client_id: ID,
    });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBe(refresh(2));
    expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({
      serverAccess: { origin: ORIGIN, token: access(2), expiresAt: NOW + 16 * MINUTE + 900 * 1000 },
    });
    expect(await getAccessToken(ORIGIN, {}, later)).toBe(access(2));
    expect(s.posts(TOKEN_PATH)).toHaveLength(2);

    // After a 401 from the server, a forced refresh ignores the cached token.
    const forced = getAccessToken(ORIGIN, { forceRefresh: true }, later);
    await vi.waitFor(() => expect(s.posts(TOKEN_PATH)).toHaveLength(3));
    answer(json(tokens(3)));
    expect(await forced).toBe(access(3));
    expect(s.bodyOf(s.posts(TOKEN_PATH)[2])).toMatchObject({ refresh_token: refresh(2) });
  });

  it('test_refresh_401_requires_sign_in', async () => {
    let refused = false;
    const s = await signedIn(
      fakeServer({
        token: () => (refused ? json({ code: 'auth-required', message: 'Sign in to Example AI again.' }, 401) : json(tokens(1))),
      }),
    );
    refused = true;
    const later = { fetch: s.fetch, now: () => NOW + 16 * MINUTE };

    const err = await getAccessToken(ORIGIN, {}, later).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIError);
    expect(err).toMatchObject({ code: 'auth-required', message: 'Sign in to ai.example.org again.' });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
    expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({});
    expect(await serverAccountItem.getValue()).toMatchObject({ origin: ORIGIN, needsSignIn: true });

    // Without a refresh token there is nothing to ask the server.
    const calls = s.calls.length;
    await expect(getAccessToken(ORIGIN, {}, later)).rejects.toMatchObject({ code: 'auth-required' });
    expect(s.calls).toHaveLength(calls);

    // A server that can't be reached is a network error, and the sign-in is kept.
    refused = false;
    await signedIn(s);
    const down = { fetch: vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))), now: later.now };
    await expect(getAccessToken(ORIGIN, {}, down)).rejects.toMatchObject({ code: 'network' });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBe(refresh(1));
    expect(await serverAccountItem.getValue()).toMatchObject({ needsSignIn: false });
  });

  it('test_sign_out_clears_even_when_revoke_fails', async () => {
    const s = await signedIn();
    await signOut(ORIGIN, { fetch: s.fetch });
    const revokes = s.posts(REVOKE_PATH);
    expect(revokes.map((c) => c.url)).toStrictEqual([`${ORIGIN}${REVOKE_PATH}`]);
    expect(revokes[0]?.init).toMatchObject({ method: 'POST', credentials: 'omit' });
    const body = RevokeRequestSchema.parse(s.bodyOf(revokes[0]));
    expect(body).toStrictEqual({ refresh_token: refresh(1), client_id: ID });
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
    expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({});
    expect(await serverAccountItem.getValue()).toBeNull();

    // The server is gone: the local sign-out still happens.
    const gone = await signedIn(fakeServer({ revoke: () => Promise.reject(new TypeError('Failed to fetch')) }));
    await expect(signOut(ORIGIN, { fetch: gone.fetch })).resolves.toBeUndefined();
    expect(gone.posts(REVOKE_PATH)).toHaveLength(1);
    expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
    expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({});
    expect(await serverAccountItem.getValue()).toBeNull();
  });

  it('test_refresh_token_goes_only_to_the_account_server', async () => {
    const s = await signedIn();
    const later = { fetch: s.fetch, now: () => NOW + 16 * MINUTE };
    const withTokenPath = (a: ServerAccount, tokenPath: string) => ({
      ...a,
      info: { ...a.info, auth: { ...a.info.auth, tokenPath } },
    });
    // The account sits in storage.local, which a content script can write (ADR 0005).
    const rewrites: Array<(a: ServerAccount) => unknown> = [
      (a) => withTokenPath(a, '//attacker.example/collect'),
      (a) => withTokenPath(a, '/\\attacker.example/collect'),
      (a) => withTokenPath(a, 'https://attacker.example/collect'),
      (a) => ({ ...a, info: { ...a.info, auth: undefined } }),
    ];
    for (const rewrite of rewrites) {
      await signedIn(s);
      const account = await serverAccountItem.getValue();
      if (!account) throw new Error('not signed in');
      await fakeBrowser.storage.local.set({ serverAccount: rewrite(account) });
      const before = s.calls.length;
      await expect(getAccessToken(ORIGIN, {}, later)).rejects.toMatchObject({ code: 'auth-required' });
      expect(s.calls.slice(before)).toStrictEqual([]);
    }

    // An account moved to another origin finds no refresh token there, and none for its own origin.
    await signedIn(s);
    const account = await serverAccountItem.getValue();
    await fakeBrowser.storage.local.set({ serverAccount: { ...account, origin: 'https://attacker.example' } });
    const before = s.calls.length;
    await expect(getAccessToken('https://attacker.example', {}, later)).rejects.toMatchObject({ code: 'auth-required' });
    await expect(getAccessToken(ORIGIN, {}, later)).rejects.toMatchObject({ code: 'auth-required' });
    expect(s.calls.slice(before)).toStrictEqual([]);
  });

  it('test_sign_out_wins_over_refresh', async () => {
    let answer: (r: Response) => void = () => {};
    let release: (r: Response) => void = () => {};
    const s = await signedIn(
      fakeServer({
        token: (init) => (isRefresh(init) ? new Promise<Response>((resolve) => (answer = resolve)) : json(tokens(1))),
        revoke: () => new Promise<Response>((resolve) => (release = resolve)),
      }),
    );
    const refreshes = () => s.posts(TOKEN_PATH).filter((c) => isRefresh(c.init));
    const cleared = async () => {
      expect(await getSecret(`server-refresh:${ORIGIN}`)).toBeUndefined();
      expect(await fakeBrowser.storage.session.get(null)).toStrictEqual({});
      expect(await serverAccountItem.getValue()).toBeNull();
    };

    // Asked for a token close to expiry while the server is still answering the revoke: nothing is left to refresh.
    const out = signOut(ORIGIN, { fetch: s.fetch });
    const racing = getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => NOW + 14.5 * MINUTE }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(s.posts(REVOKE_PATH)).toHaveLength(1));
    expect(await racing).toMatchObject({ code: 'auth-required' });
    release(json({ ok: true }));
    await out;
    expect(refreshes()).toHaveLength(0);
    await cleared();

    // A refresh already in flight finishes first, and the refresh token it got is the one revoked.
    await signedIn(s);
    const inFlight = getAccessToken(ORIGIN, {}, { fetch: s.fetch, now: () => NOW + 16 * MINUTE });
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    const again = signOut(ORIGIN, { fetch: s.fetch });
    answer(json(tokens(2)));
    expect(await inFlight).toBe(access(2));
    await vi.waitFor(() => expect(s.posts(REVOKE_PATH)).toHaveLength(2));
    expect(s.bodyOf(s.posts(REVOKE_PATH)[1])).toStrictEqual({ refresh_token: refresh(2), client_id: ID });
    release(json({ ok: true }));
    await again;
    await cleared();
  });

  it('test_e2e_web_auth_flow_uses_a_tab', async () => {
    vi.stubEnv('MODE', 'e2e');
    const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined as never);
    const url = `${ORIGIN}${AUTHORIZE_PAGE_PATH}?state=abc`;

    const done = webAuthFlow({ url, interactive: true });
    await vi.waitFor(async () => expect(await fakeBrowser.tabs.query({ url })).toHaveLength(1));
    const [tab] = await fakeBrowser.tabs.query({ url });
    await fakeBrowser.tabs.update(tab?.id ?? -1, { url: `${ORIGIN}/authorize?step=code` });
    await fakeBrowser.tabs.update(tab?.id ?? -1, { url: `${REDIRECT}?code=${CODE}&state=abc` });
    expect(await done).toBe(`${REDIRECT}?code=${CODE}&state=abc`);
    expect(remove).toHaveBeenCalledWith(tab?.id);

    // Closing the tab before the redirect is a cancelled sign-in.
    const closed = webAuthFlow({ url, interactive: true });
    await vi.waitFor(async () => expect(await fakeBrowser.tabs.query({ url })).toHaveLength(1));
    const [second] = await fakeBrowser.tabs.query({ url });
    await fakeBrowser.tabs.onRemoved.trigger(second?.id ?? -1, { isWindowClosing: false, windowId: 0 });
    await expect(closed).rejects.toThrow();
  });
});

describe('copy', () => {
  // The default texts and the scan of packages/ai/src for the hosted service name (AC 11) are in
  // packages/ai/test/ai.test.ts ('error messages'); this checks the names the extension passes in.
  it('test_describe_error_uses_server_name', () => {
    expect(describeError('auth-required', serverLabel(PINNED_CLOUD_ORIGIN).title)).toBe('Sign in to unAlgorithm Cloud again.');
    expect(describeError('auth-required', serverLabel(ORIGIN, INFO).title)).toBe('Sign in to ai.example.org again.');
  });
});
