import { REVOKE_PATH, type TokenResponse } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requireAccount } from '../src/auth/account-access.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { user } from '../src/db/schema.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, postJson, signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';

/** Starting PGlite (Postgres compiled to WebAssembly) takes a moment, more on a busy CI runner. */
const PGLITE_TIMEOUT = 30_000;

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
/** A test-only route, for `GET` and `POST`, behind `requireAccount` that answers with the principal it set. */
const WHOAMI = '/v1/test/whoami';
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with `GET` and `POST /v1/test/whoami` behind `requireAccount`, mounted before the first request. */
async function accountApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${TOM},${ANA}` }) });
  t.app.get(WHOAMI, requireAccount(t.deps), (c) => c.json(c.var.principal));
  t.app.post(WHOAMI, requireAccount(t.deps), (c) => c.json(c.var.principal));
  cleanup.push(() => t.close());
  return t;
}

/** `GET` or `POST /v1/test/whoami` with these headers (an `Authorization`, a `Cookie`, an `Origin`). */
const whoami = (t: TestApp, headers: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') =>
  t.app.request(WHOAMI, { method, headers });
const bearer = (tokens: TokenResponse) => ({ Authorization: `Bearer ${tokens.access_token}` });

async function userId(t: TestApp, email: string): Promise<string> {
  const [owner] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!owner) throw new Error('No account.');
  return owner.id;
}

/** What `requireAccount` answers without a credential it accepts: a bearer challenge, whichever was sent. */
async function expectRefused(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.json()).toEqual(AUTH_REQUIRED);
}

describe('credentials', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_require_account_accepts_device_token', async () => {
    const t = await accountApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM);

    const res = await whoami(t, bearer(tokens));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: await userId(t, TOM),
      deviceId: tokens.device_id,
      via: 'device',
      sessionCreatedAt: null,
    });
  });

  it('test_require_account_accepts_web_session', async () => {
    const t = await accountApp();
    const signedInAt = Date.now();
    const cookie = await signInWeb(t.app, t.outbox, TOM);

    const res = await whoami(t, { Cookie: cookie });
    expect(res.status).toBe(200);
    const principal = (await res.json()) as { sessionCreatedAt: string };
    expect(principal).toEqual({
      userId: await userId(t, TOM),
      deviceId: null,
      via: 'session',
      sessionCreatedAt: expect.any(String),
    });
    expect(Math.abs(Date.parse(principal.sessionCreatedAt) - signedInAt)).toBeLessThan(5_000);
  });

  it('test_require_account_without_credentials_is_401', async () => {
    const t = await accountApp();
    await expectRefused(await whoami(t));
    // A cookie that names no session is no credential either.
    await expectRefused(await whoami(t, { Cookie: 'better-auth.session_token=not-a-session' }));
  });

  it('test_bad_bearer_never_falls_back_to_cookie', async () => {
    const t = await accountApp();
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    expect((await whoami(t, { Cookie: cookie })).status).toBe(200);

    for (const authorization of ['Bearer not-a-token', 'Bearer a.b.c', 'Basic abc', 'Bearer', '']) {
      await expectRefused(await whoami(t, { Authorization: authorization, Cookie: cookie }));
      await expectRefused(await whoami(t, { Authorization: authorization, Cookie: cookie, Origin: TEST_PUBLIC_URL }, 'POST'));
    }
  });

  it('test_revoked_device_is_401', async () => {
    const t = await accountApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    expect((await whoami(t, bearer(tokens))).status).toBe(200);

    // "Sign out" as the extension sends it revokes the device; its access token has not expired.
    const signOut = { refresh_token: tokens.refresh_token, client_id: DEV_EXTENSION_ID };
    expect((await postJson(t.app, REVOKE_PATH, signOut, { Origin: DEV_EXTENSION_ORIGIN })).status).toBe(200);
    await expectRefused(await whoami(t, bearer(tokens)));
    await expectRefused(await whoami(t, bearer(tokens), 'POST'));
    // Not even with the same person's live web session beside it.
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    await expectRefused(await whoami(t, { ...bearer(tokens), Cookie: cookie }));
  });
});

describe('CSRF', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_session_writes_need_own_origin', async () => {
    const t = await accountApp();
    const cookie = await signInWeb(t.app, t.outbox, TOM);

    const own = await whoami(t, { Cookie: cookie, Origin: TEST_PUBLIC_URL }, 'POST');
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ userId: await userId(t, TOM), via: 'session' });

    const elsewhere: Record<string, string>[] = [
      { Cookie: cookie, Origin: 'https://evil.example' },
      { Cookie: cookie, Origin: DEV_EXTENSION_ORIGIN },
      { Cookie: cookie },
    ];
    for (const headers of elsewhere) {
      const res = await whoami(t, headers, 'POST');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
    }
  });

  it('test_device_writes_need_no_origin', async () => {
    const t = await accountApp();
    const tokens = await signInDevice(t.app, t.outbox, TOM);

    const res = await whoami(t, bearer(tokens), 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: await userId(t, TOM),
      deviceId: tokens.device_id,
      via: 'device',
      sessionCreatedAt: null,
    });
    // And from the extension's own origin.
    expect((await whoami(t, { ...bearer(tokens), Origin: DEV_EXTENSION_ORIGIN }, 'POST')).status).toBe(200);
  });
});

describe('isolation', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_principal_is_per_account', async () => {
    const t = await accountApp();
    const tomCookie = await signInWeb(t.app, t.outbox, TOM);
    const anaCookie = await signInWeb(t.app, t.outbox, ANA);
    const tomDevice = await signInDevice(t.app, t.outbox, TOM);
    const anaDevice = await signInDevice(t.app, t.outbox, ANA);
    const tomId = await userId(t, TOM);
    const anaId = await userId(t, ANA);
    expect(tomId).not.toBe(anaId);

    const principal = async (headers: Record<string, string>) => {
      const res = await whoami(t, headers);
      expect(res.status).toBe(200);
      return (await res.json()) as { userId: string; deviceId: string | null };
    };
    expect(await principal({ Cookie: tomCookie })).toMatchObject({ userId: tomId, deviceId: null });
    expect(await principal({ Cookie: anaCookie })).toMatchObject({ userId: anaId, deviceId: null });
    expect(await principal(bearer(tomDevice))).toMatchObject({ userId: tomId, deviceId: tomDevice.device_id });
    expect(await principal(bearer(anaDevice))).toMatchObject({ userId: anaId, deviceId: anaDevice.device_id });
    // A device token speaks for its own account, whoever's cookie comes with it.
    expect(await principal({ ...bearer(tomDevice), Cookie: anaCookie })).toMatchObject({ userId: tomId });

    // Nothing here logs an address, a cookie or a token.
    const secrets = [TOM, ANA, tomDevice.access_token, anaDevice.access_token];
    for (const cookie of [tomCookie, anaCookie]) {
      secrets.push(...cookie.split('; ').map((c) => c.slice(c.indexOf('=') + 1)));
    }
    expect(t.lines.length).toBeGreaterThan(0);
    for (const line of t.lines) for (const secret of secrets) expect(line).not.toContain(secret);
  });
});
