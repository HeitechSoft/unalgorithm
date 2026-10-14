import { SERVER_INFO_PATH, ServerInfoSchema } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authRoutesFor } from '../src/auth/better-auth.ts';
import { ConfigError } from '../src/config.ts';
import { account, user } from '../src/db/schema.ts';
import {
  GOOGLE_ACCESS_TOKEN,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CALLBACK,
  GOOGLE_CODE,
  GOOGLE_ENV,
  GOOGLE_SIGN_IN,
  type GoogleStub,
  googleCallback,
  googleSignInBody,
  signInWithGoogle,
  startGoogleSignIn,
  stubGoogle,
  TEST_GOOGLE_CLIENT_ID,
} from './support/google-stub.ts';
import { cookieHeader, postJson, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

const GET_SESSION = '/api/auth/get-session';
const ANN = 'ann@example.org';
const BOB = 'bob@example.org';
const STRANGER = 'stranger@example.com';
const NOT_FOUND = { code: 'bad-request', message: 'Not found.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome; the fetch stub is put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file, and every Google value the stubs handed out, for the log test (AC 10). */
const allLines: string[] = [];
const googleSecrets: string[] = [GOOGLE_ACCESS_TOKEN];
const stubs: GoogleStub[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const stub of stubs.splice(0)) googleSecrets.push(stub.sub, ...stub.idTokens);
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server whose allowlist holds Ann and Bob, with Google sign-in unless `google` is false. */
async function googleApp({ google = true }: { google?: boolean } = {}) {
  const env = { SIGNUP_ALLOWLIST: `${ANN},${BOB}`, ...(google ? GOOGLE_ENV : {}) };
  const t = await createTestApp({ config: testConfig(env) });
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

/** Stubs Google for this identity, after putting back the stub this test installed before. */
async function google(...args: Parameters<typeof stubGoogle>): Promise<GoogleStub> {
  stubs.at(-1)?.restore();
  const stub = await stubGoogle(...args);
  stubs.push(stub);
  return stub;
}

const usersWithEmail = (t: TestApp, email: string) => t.deps.db.db.select().from(user).where(eq(user.email, email));
const accountsOf = (t: TestApp, userId: string) => t.deps.db.db.select().from(account).where(eq(account.userId, userId));
const allUsers = (t: TestApp) => t.deps.db.db.select().from(user);
const allAccounts = (t: TestApp) => t.deps.db.db.select().from(account);

/** The session cookie a response sets, as a `Cookie` header, or '' when it sets none. */
function sessionCookie(res: Response): string {
  return cookieHeader(res)
    .split('; ')
    .filter((c) => c.startsWith('better-auth.session_token=') && c.length > 'better-auth.session_token='.length)
    .join('; ');
}

async function sessionOf(t: TestApp, cookie: string) {
  const res = await t.app.request(GET_SESSION, { headers: { Cookie: cookie } });
  return (await res.json()) as { user?: { id: string; email: string } } | null;
}

/** The `error` parameter of a redirect to the account page; fails when the redirect is anywhere else. */
function errorOf(res: Response): string | null {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '', TEST_PUBLIC_URL);
  expect(location.origin).toBe(TEST_PUBLIC_URL);
  expect(location.pathname).toBe('/account');
  return location.searchParams.get('error');
}

describe('configuration', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_google_config_both_or_neither', () => {
    const id = 'only-id.apps.googleusercontent.com';
    const secret = 'only-secret-value';
    const refusal = (env: Record<string, string>) => {
      try {
        testConfig(env);
      } catch (err) {
        if (err instanceof ConfigError) return err;
      }
      throw new Error('loadConfig accepted the configuration.');
    };

    const idOnly = refusal({ GOOGLE_CLIENT_ID: id });
    expect(idOnly.invalid.map((i) => i.name)).toEqual(['GOOGLE_CLIENT_SECRET']);
    expect(idOnly.message).toContain('GOOGLE_CLIENT_SECRET');
    expect(idOnly.message).not.toContain(id);
    const secretOnly = refusal({ GOOGLE_CLIENT_SECRET: secret });
    expect(secretOnly.invalid.map((i) => i.name)).toEqual(['GOOGLE_CLIENT_ID']);
    expect(secretOnly.message).not.toContain(secret);
    // Blank counts as unset, as for every variable.
    expect(refusal({ GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: ' ' }).invalid.map((i) => i.name)).toEqual([
      'GOOGLE_CLIENT_SECRET',
    ]);

    // The secret is kept exactly as given, like every secret; the id is trimmed.
    expect(testConfig({ GOOGLE_CLIENT_ID: ` ${id} `, GOOGLE_CLIENT_SECRET: ` ${secret}` }).google).toEqual({
      clientId: id,
      clientSecret: ` ${secret}`,
    });
    expect(testConfig().google).toBeUndefined();
    expect(testConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }).google).toBeUndefined();
  });

  it('test_google_routes_absent_without_config', async () => {
    const t = await googleApp({ google: false });
    const start = await startGoogleSignIn(t.app);
    expect(start.status).toBe(404);
    expect(await start.json()).toEqual(NOT_FOUND);
    const callback = await googleCallback(t.app, 'any-state');
    expect(callback.status).toBe(404);
    expect(await callback.json()).toEqual(NOT_FOUND);

    const info = ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json());
    expect(info.auth.methods).toContain('email-otp');
    expect(info.auth.methods).not.toContain('google');

    // The route list grows by exactly the two Google routes when a client is configured.
    const without = authRoutesFor(t.deps.config);
    expect(without.map(([, path]) => path)).not.toContain(GOOGLE_SIGN_IN);
    expect(authRoutesFor(testConfig(GOOGLE_ENV))).toEqual([...without, ['POST', GOOGLE_SIGN_IN], ['GET', GOOGLE_CALLBACK]]);
  });

  it('test_google_sign_in_url_minimal_scopes', async () => {
    const t = await googleApp();
    const info = ServerInfoSchema.parse(await (await t.app.request(SERVER_INFO_PATH)).json());
    expect(info.auth.methods).toEqual(['email-otp', 'google']);

    const res = await startGoogleSignIn(t.app);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);
    const { url, redirect } = (await res.json()) as { url: string; redirect: boolean };
    expect(redirect).toBe(false);
    const google = new URL(url);
    expect(`${google.origin}${google.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    const query = google.searchParams;
    expect(query.get('client_id')).toBe(TEST_GOOGLE_CLIENT_ID);
    expect(query.get('redirect_uri')).toBe(`${TEST_PUBLIC_URL}/api/auth/callback/google`);
    expect(query.get('response_type')).toBe('code');
    // No 'profile': the server never stores a name or a picture.
    expect(query.get('scope')?.split(' ').sort()).toEqual(['email', 'openid']);
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(query.get('state')).toBeTruthy();
    expect(query.get('prompt')).toBe('select_account');
    // No offline access (no refresh token), and no scopes carried over from an earlier grant.
    expect(query.get('access_type')).toBeNull();
    expect(query.get('include_granted_scopes')).toBeNull();

    // With a cookie, Better Auth checks the Origin: another site's, or none, is refused.
    const body = googleSignInBody();
    const foreign = await postJson(t.app, GOOGLE_SIGN_IN, body, { Origin: 'https://evil.example', Cookie: 'a=b' });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.getSetCookie()).toEqual([]);
    expect((await postJson(t.app, GOOGLE_SIGN_IN, body, { Cookie: 'a=b' })).status).toBe(403);
    // Coming back to another site is refused too.
    for (const away of [
      { ...body, callbackURL: 'https://evil.example/account' },
      { ...body, errorCallbackURL: 'https://evil.example/account' },
    ]) {
      expect((await startGoogleSignIn(t.app, away)).status).toBe(403);
    }

    // Every other Better Auth route stays unmounted, and the callback takes GET only.
    const cookie = 'a=b';
    for (const other of [
      await postJson(t.app, '/api/auth/link-social', { provider: 'google' }, { Origin: TEST_PUBLIC_URL, Cookie: cookie }),
      await t.app.request('/api/auth/list-accounts', { headers: { Cookie: cookie } }),
      await postJson(t.app, '/api/auth/unlink-account', { providerId: 'google' }, { Origin: TEST_PUBLIC_URL, Cookie: cookie }),
      await t.app.request('/api/auth/callback/github?code=x&state=y'),
      await t.app.request(`${GOOGLE_CALLBACK}?code=x&state=y`, { method: 'POST' }),
    ]) {
      expect(other.status).toBe(404);
      expect(await other.json()).toEqual(NOT_FOUND);
    }
  });
});

describe('callback', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_google_creates_allowed_account_without_tokens', async () => {
    const t = await googleApp();
    const stub = await google({ email: ANN, emailVerified: true, sub: '109876543210987654321' });

    const res = await signInWithGoogle(t.app);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe('');
    expect((await sessionOf(t, cookie))?.user?.email).toBe(ANN);

    // The code went to Google once, with the PKCE verifier and this server's client.
    expect(stub.tokenRequests).toHaveLength(1);
    const form = stub.tokenRequests[0];
    expect(form?.get('code')).toBe(GOOGLE_CODE);
    expect(form?.get('code_verifier')).toMatch(/^[\w.~-]{43,128}$/);
    expect(form?.get('client_id')).toBe(TEST_GOOGLE_CLIENT_ID);
    expect(form?.get('redirect_uri')).toBe(`${TEST_PUBLIC_URL}/api/auth/callback/google`);

    const users = await usersWithEmail(t, ANN);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: ANN, emailVerified: true, name: '', image: null });
    const noTokens = {
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    };
    const accounts = await accountsOf(t, users[0]?.id ?? '');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: 'google', accountId: stub.sub, ...noTokens });

    // Signing in again finds the same account, and its update keeps no tokens either.
    const again = await signInWithGoogle(t.app);
    expect(again.headers.get('location')).toBe('/account');
    expect((await sessionOf(t, sessionCookie(again)))?.user?.id).toBe(users[0]?.id);
    expect(await allUsers(t)).toHaveLength(1);
    const after = await allAccounts(t);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ providerId: 'google', accountId: stub.sub, ...noTokens });
    expect(JSON.stringify(after)).not.toContain(GOOGLE_ACCESS_TOKEN);
  });

  it('test_google_links_existing_email_account', async () => {
    const t = await googleApp();
    await signInWeb(t.app, t.outbox, BOB);
    const [bob] = await usersWithEmail(t, BOB);
    expect(await accountsOf(t, bob?.id ?? '')).toHaveLength(0);

    const stub = await google({ email: BOB, emailVerified: true });
    const res = await signInWithGoogle(t.app);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
    expect((await sessionOf(t, sessionCookie(res)))?.user?.id).toBe(bob?.id);

    expect(await usersWithEmail(t, BOB)).toHaveLength(1);
    const accounts = await accountsOf(t, bob?.id ?? '');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ providerId: 'google', accountId: stub.sub, accessToken: null, idToken: null });
    // Linking writes no name or picture.
    expect((await usersWithEmail(t, BOB))[0]).toMatchObject({ name: '', image: null });
  });

  it('test_google_refuses_unlisted_address', async () => {
    const t = await googleApp();
    await google({ email: STRANGER, emailVerified: true });

    const res = await signInWithGoogle(t.app);
    expect(errorOf(res)).toBe('SIGNUP_CLOSED');
    expect(sessionCookie(res)).toBe('');
    expect(await allUsers(t)).toHaveLength(0);
    expect(await allAccounts(t)).toHaveLength(0);
  });

  it('test_google_refuses_unverified_address', async () => {
    const t = await googleApp();
    // A new account needs an address Google verified, even an allow-listed one.
    await google({ email: ANN, emailVerified: false });
    const fresh = await signInWithGoogle(t.app);
    expect(errorOf(fresh)).toBe('SIGNUP_CLOSED');
    expect(sessionCookie(fresh)).toBe('');
    expect(await allUsers(t)).toHaveLength(0);
    expect(await allAccounts(t)).toHaveLength(0);

    // An existing account is not linked to an unverified Google address.
    await signInWeb(t.app, t.outbox, BOB);
    await google({ email: BOB, emailVerified: false });
    const existing = await signInWithGoogle(t.app);
    expect(errorOf(existing)).toBe('account_not_linked');
    expect(sessionCookie(existing)).toBe('');
    expect(await allUsers(t)).toHaveLength(1);
    expect(await allAccounts(t)).toHaveLength(0);
  });

  it('test_email_code_sign_up_still_works', async () => {
    const t = await googleApp();
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    expect((await sessionOf(t, cookie))?.user?.email).toBe(ANN);
    const users = await usersWithEmail(t, ANN);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ emailVerified: true, name: '', image: null });
    expect(await allAccounts(t)).toHaveLength(0);
  });

  it('test_google_unknown_state_refused', async () => {
    const t = await googleApp();
    const stub = await google({ email: ANN, emailVerified: true });

    // A state the server never issued goes to the account page with an error.
    const unknown = await googleCallback(t.app, 'never-issued-state');
    const location = unknown.headers.get('location') ?? '';
    expect(location.startsWith(`${TEST_PUBLIC_URL}/account?`)).toBe(true);
    expect(errorOf(unknown)).toBe('state_mismatch');

    // An issued state brought back by a browser without its cookie (another browser) is refused as well.
    const start = await startGoogleSignIn(t.app);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state') ?? '';
    const elsewhere = await googleCallback(t.app, state);
    expect(errorOf(elsewhere)).toBe('state_mismatch');
    expect(sessionCookie(elsewhere)).toBe('');

    expect(stub.tokenRequests).toHaveLength(0);
    expect(await allUsers(t)).toHaveLength(0);
    expect(await allAccounts(t)).toHaveLength(0);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_google_logs_hold_no_identity', async () => {
    const consoleCalls = (['error', 'warn', 'info', 'log', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const t = await googleApp();
    // Each outcome once: a new account, a link, a refusal, an unverified address, a bad state.
    await google({ email: ANN });
    await signInWithGoogle(t.app);
    await signInWeb(t.app, t.outbox, BOB);
    await google({ email: BOB });
    await signInWithGoogle(t.app);
    for (const [email, emailVerified] of [
      [STRANGER, true],
      [BOB, false],
    ] as const) {
      await google({ email, emailVerified });
      await signInWithGoogle(t.app);
    }
    await googleCallback(t.app, 'never-issued-state');
    for (const call of consoleCalls) expect(call).not.toHaveBeenCalled();
    for (const stub of stubs) googleSecrets.push(stub.sub, ...stub.idTokens);

    // Better Auth logged the refusals, through `authLog`.
    expect(t.events().some((e) => e.event === 'auth.log')).toBe(true);
    // This test's lines and those of every earlier test in this file (AC 3 to 9).
    const lines = [...allLines, ...t.lines];
    for (const line of lines) {
      for (const email of [ANN, BOB, STRANGER]) expect(line).not.toContain(email);
      for (const value of googleSecrets) expect(line).not.toContain(value);
    }
    // The callback's query (code and state) stays out of the request log.
    const callbackLines = t.events().filter((e) => e.event === 'http' && e.path === GOOGLE_CALLBACK);
    expect(callbackLines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(GOOGLE_CODE);
  });
});
