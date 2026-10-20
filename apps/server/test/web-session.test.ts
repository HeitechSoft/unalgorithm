import { AUTHORIZE_API_PATH } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { ownPageOnly, REFUSED, requireWebSession } from '../src/auth/web-session.ts';
import { user } from '../src/db/schema.ts';
import {
  authorizeRequest,
  DEV_EXTENSION_ORIGIN,
  FIREFOX_EXTENSION_ORIGIN,
  pkcePair,
  postAuthorize,
  postJson,
  signInWeb,
} from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
/** A test-only route behind `requireWebSession` that answers with the user it set. */
const WHOAMI = '/v1/test/whoami';
const SIGN_OUT = '/api/auth/sign-out';
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file, and every cookie value the tests saw, for the log test (AC 6). */
const allLines: string[] = [];
const cookieValues: string[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with `GET /v1/test/whoami` behind `requireWebSession`, mounted before the first request. */
async function sessionApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }) });
  t.app.get(WHOAMI, requireWebSession(t.deps), (c) => c.json(c.get('webUser')));
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

/** Signs Tom in on the server's own page; the cookie's values join `cookieValues`. */
async function webSession(t: TestApp): Promise<string> {
  const cookie = await signInWeb(t.app, t.outbox, TOM);
  cookieValues.push(...cookie.split('; ').map((c) => c.slice(c.indexOf('=') + 1)));
  return cookie;
}

const whoami = (t: TestApp, cookie?: string) => t.app.request(WHOAMI, cookie ? { headers: { Cookie: cookie } } : {});
const signOut = (t: TestApp, cookie: string) => postJson(t.app, SIGN_OUT, {}, { Origin: TEST_PUBLIC_URL, Cookie: cookie });

describe('session', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_web_session_required', async () => {
    const t = await sessionApp();
    const none = await whoami(t);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual(AUTH_REQUIRED);

    const cookie = await webSession(t);
    expect((await whoami(t, cookie)).status).toBe(200);
    expect((await signOut(t, cookie)).status).toBe(200);
    // The same cookie, for a session that no longer exists.
    const after = await whoami(t, cookie);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual(AUTH_REQUIRED);
  });

  it('test_web_session_sets_web_user', async () => {
    const t = await sessionApp();
    const cookie = await webSession(t);
    const [account] = await t.deps.db.db.select().from(user).where(eq(user.email, TOM));
    expect(account).toBeDefined();

    const res = await whoami(t, cookie);
    expect(res.status).toBe(200);
    // Exactly these two fields: no session id, token or cookie.
    expect(await res.json()).toEqual({ userId: account?.id, email: TOM });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('test_web_session_401_headers', async () => {
    const t = await sessionApp();
    const cookie = await webSession(t);
    await signOut(t, cookie);

    for (const sent of [undefined, 'better-auth.session_token=not-a-session', cookie]) {
      const res = await whoami(t, sent);
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      // Cookie auth, not bearer; and the refusal neither sets nor clears a cookie.
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('test_authorize_checks_session_before_body', async () => {
    const t = await sessionApp();
    const { client_id: _, ...noClientId } = authorizeRequest(pkcePair().challenge);

    // From the own page without a session: refused before the body is looked at.
    const anonymous = await postAuthorize(t.app, '', noClientId);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual(AUTH_REQUIRED);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');

    // From elsewhere, the Origin is still checked first.
    for (const origin of [DEV_EXTENSION_ORIGIN, FIREFOX_EXTENSION_ORIGIN]) {
      const foreign = await postAuthorize(t.app, '', noClientId, origin);
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toEqual(REFUSED);
    }

    // With a session the body is validated as before.
    const cookie = await webSession(t);
    const invalid = await postAuthorize(t.app, cookie, noClientId);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(NOT_VALID);
  });

  it('test_web_session_logs_no_cookie', async () => {
    const t = await sessionApp();
    const cookie = await webSession(t);
    await whoami(t, cookie);
    await postAuthorize(t.app, cookie, authorizeRequest(pkcePair().challenge));
    await postJson(t.app, AUTHORIZE_API_PATH, {}, { Origin: TEST_PUBLIC_URL, Cookie: cookie });
    await signOut(t, cookie);
    await whoami(t, cookie);

    expect(t.lines.length).toBeGreaterThan(0);
    expect(cookieValues.length).toBeGreaterThan(1);
    for (const value of cookieValues) expect(value.length).toBeGreaterThan(10);
    // This test's lines and every line the earlier tests in this file wrote.
    for (const line of [...t.lines, ...allLines]) {
      for (const value of cookieValues) expect(line).not.toContain(value);
    }
  });
});

describe('same origin', () => {
  it('test_own_page_only', async () => {
    const app = new Hono().post('/change', ownPageOnly(TEST_PUBLIC_URL), (c) => c.json({ ok: true }));
    const post = (headers: Record<string, string>) => app.request('/change', { method: 'POST', headers });

    const elsewhere: Record<string, string>[] = [{ Origin: 'https://evil.example' }, {}];
    for (const headers of elsewhere) {
      const res = await post(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'permission', message: "This server doesn't accept sign-ins from here." });
    }
    const own = await post({ Origin: TEST_PUBLIC_URL });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true });
  });
});
