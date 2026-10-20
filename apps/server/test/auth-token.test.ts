import { createHash } from 'node:crypto';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZE_API_PATH,
  AuthorizeResponseSchema,
  chromiumRedirectUri,
  FIREFOX_ADDON_ID,
  geckoRedirectUri,
  ServerErrorSchema,
  TOKEN_PATH,
  TokenResponseSchema,
} from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPkce } from '../src/auth/tokens.ts';
import { authCodes, devices, refreshTokens, user } from '../src/db/schema.ts';
import {
  authorizeRequest,
  codeExchange,
  codeFrom,
  DEV_EXTENSION_ID,
  DEV_EXTENSION_ORIGIN,
  FIREFOX_EXTENSION_ID,
  FIREFOX_EXTENSION_ORIGIN,
  pkcePair,
  postAuthorize,
  postJson,
  postToken,
  signInWeb,
} from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const OTHER_ID = 'b'.repeat(32);
const UNLISTED_ID = 'c'.repeat(32);
/** Firefox's redirect address for the development add-on id: the SHA-1 of `feed-dev@unalgorithmfeed.com`. */
const FIREFOX_REDIRECT = 'https://050785fd621b7eeb0c98874aa5418eafb61158f5.extensions.allizom.org/';
const UNLISTED_FIREFOX_ID = 'someone-else@example.org';
/** Every refused exchange answers exactly this, so a caller cannot tell why. */
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome; fake timers and spies are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file, and every secret the tests saw, for the log test at the end (AC 13). */
const allLines: string[] = [];
const secrets: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function tokenApp(env: Record<string, string> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM, ...env }) });
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

async function webSession(t: TestApp): Promise<string> {
  const cookie = await signInWeb(t.app, t.outbox, TOM);
  secrets.push(...cookie.split('; ').map((c) => c.slice(c.indexOf('=') + 1)));
  return cookie;
}

/** A PKCE pair and a code for it, as the sign-in page gets it for the extension. */
async function authorized(t: TestApp, cookie: string, clientId = DEV_EXTENSION_ID) {
  const { verifier, challenge } = pkcePair();
  const code = await codeFrom(await postAuthorize(t.app, cookie, authorizeRequest(challenge, clientId)));
  secrets.push(verifier, code);
  return { code, verifier };
}

/** Exchanges a code; a 200 answer's tokens join `secrets`. */
async function exchange(t: TestApp, body: unknown) {
  const res = await postToken(t.app, body);
  if (res.status === 200) {
    const tokens = TokenResponseSchema.parse(await res.clone().json());
    secrets.push(tokens.access_token, tokens.refresh_token);
  }
  return res;
}

async function expectAuthRequired(res: Response) {
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(AUTH_REQUIRED);
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(ServerErrorSchema.parse(await res.json()).code).toBe('permission');
}

const codeRows = (t: TestApp) => t.deps.db.db.select().from(authCodes);

describe('authorize', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_authorize_returns_code_redirect', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    const { challenge } = pkcePair();
    const req = { ...authorizeRequest(challenge), state: 'state-0123456789abcdef' };

    const res = await postAuthorize(t.app, cookie, req);
    expect(res.status).toBe(200);
    // The answer holds a code: no cache may keep it.
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { redirect } = AuthorizeResponseSchema.parse(await res.json());
    expect(redirect.startsWith('https://aokmlebkpkeniofcnbeajmgabinicggm.chromiumapp.org/?code=')).toBe(true);
    expect(redirect.endsWith('&state=state-0123456789abcdef')).toBe(true);
    const code = new URL(redirect).searchParams.get('code') ?? '';
    secrets.push(code);
    expect(code).toMatch(/^[\w-]{43}$/);

    // The state goes back exactly as sent, encoded.
    const odd = await postAuthorize(t.app, cookie, { ...req, state: 'a b&c=d/é+0123456789' });
    const back = new URL(AuthorizeResponseSchema.parse(await odd.json()).redirect);
    expect(back.searchParams.get('state')).toBe('a b&c=d/é+0123456789');
    secrets.push(back.searchParams.get('code') ?? '');
    expect(await codeRows(t)).toHaveLength(2);
  });

  it('test_authorize_firefox_returns_allizom_redirect', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    const { challenge } = pkcePair();
    const req = { ...authorizeRequest(challenge, FIREFOX_EXTENSION_ID), state: 'state-0123456789abcdef' };
    expect(req.redirect_uri).toBe(FIREFOX_REDIRECT);

    const res = await postAuthorize(t.app, cookie, req);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Under the address Firefox's `launchWebAuthFlow` watches for: it resolves on the first request starting with it.
    const { redirect } = AuthorizeResponseSchema.parse(await res.json());
    expect(redirect.startsWith(`${FIREFOX_REDIRECT}?code=`)).toBe(true);
    expect(redirect.endsWith('&state=state-0123456789abcdef')).toBe(true);
    const code = new URL(redirect).searchParams.get('code') ?? '';
    secrets.push(code);
    expect(code).toMatch(/^[\w-]{43}$/);
    // The code is bound to the add-on id and its redirect, as given.
    expect(await codeRows(t)).toMatchObject([{ clientId: FIREFOX_EXTENSION_ID, redirectUri: FIREFOX_REDIRECT }]);
  });

  it('test_authorize_requires_session', async () => {
    const t = await tokenApp();
    const { challenge } = pkcePair();
    for (const cookie of ['', 'better-auth.session_token=not-a-session']) {
      const res = await postAuthorize(t.app, cookie, authorizeRequest(challenge));
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'auth-required' });
    }
    expect(await codeRows(t)).toHaveLength(0);
  });

  it('test_authorize_requires_own_origin', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    const { challenge } = pkcePair();

    // No Origin at all, and the extension itself: only the server's own page may ask for a code.
    await expectRefused(await postJson(t.app, AUTHORIZE_API_PATH, authorizeRequest(challenge), { Cookie: cookie }));
    await expectRefused(await postAuthorize(t.app, cookie, authorizeRequest(challenge), DEV_EXTENSION_ORIGIN));
    await expectRefused(
      await postAuthorize(t.app, cookie, authorizeRequest(challenge, FIREFOX_EXTENSION_ID), FIREFOX_EXTENSION_ORIGIN),
    );
    expect(await codeRows(t)).toHaveLength(0);
  });

  it('test_authorize_checks_client_and_redirect', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    const { challenge } = pkcePair();
    const notValid = { code: 'bad-request', message: 'The request was not valid.' };

    // An extension this server does not list, asking for its own redirect.
    await expectRefused(await postAuthorize(t.app, cookie, authorizeRequest(challenge, UNLISTED_ID)));
    // A listed extension whose code would go somewhere else.
    for (const redirect_uri of ['https://evil.example/', chromiumRedirectUri(OTHER_ID)]) {
      const res = await postAuthorize(t.app, cookie, { ...authorizeRequest(challenge), redirect_uri });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(notValid);
    }

    // The same in Firefox: an add-on this server does not list, and its ids are compared exactly, case included.
    await expectRefused(await postAuthorize(t.app, cookie, authorizeRequest(challenge, UNLISTED_FIREFOX_ID)));
    await expectRefused(await postAuthorize(t.app, cookie, authorizeRequest(challenge, FIREFOX_EXTENSION_ID.toUpperCase())));
    // A listed add-on whose code would go anywhere but the SHA-1 of its own id: another add-on's (listed too), another
    // browser's form, a near miss, Firefox's loopback form, or a Chrome id sent to a Firefox address.
    const hash = new URL(FIREFOX_REDIRECT).hostname.split('.')[0];
    const firefox = authorizeRequest(challenge, FIREFOX_EXTENSION_ID);
    for (const req of [
      { ...firefox, redirect_uri: geckoRedirectUri(FIREFOX_ADDON_ID) },
      { ...firefox, redirect_uri: chromiumRedirectUri(DEV_EXTENSION_ID) },
      { ...firefox, redirect_uri: `https://${'0'.repeat(40)}.extensions.allizom.org/` },
      { ...firefox, redirect_uri: FIREFOX_REDIRECT.slice(0, -1) },
      { ...firefox, redirect_uri: `${FIREFOX_REDIRECT}callback` },
      { ...firefox, redirect_uri: `http://127.0.0.1/mozoauth2/${hash}` },
      { ...authorizeRequest(challenge), redirect_uri: FIREFOX_REDIRECT },
    ]) {
      const res = await postAuthorize(t.app, cookie, req);
      expect(res.status, req.redirect_uri).toBe(400);
      expect(await res.json()).toEqual(notValid);
    }
    expect(await codeRows(t)).toHaveLength(0);
  });
});

describe('token: authorization_code', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_exchange_issues_jwt_refresh_and_device', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t));

    const res = await exchange(t, codeExchange(code, verifier));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The extension can read the answer.
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    const tokens = TokenResponseSchema.parse(await res.json());
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900, account: { email: TOM } });
    expect(tokens.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(tokens.refresh_token).toMatch(/^[\w-]{43}$/);

    const [owner] = await t.deps.db.db.select().from(user).where(eq(user.email, TOM));
    const { payload } = await t.deps.auth.api.verifyJWT({ body: { token: tokens.access_token } });
    expect(payload).toMatchObject({
      sub: owner?.id,
      did: tokens.device_id,
      cid: DEV_EXTENSION_ID,
      iss: TEST_PUBLIC_URL,
      aud: TEST_PUBLIC_URL,
    });
    expect(typeof payload?.iat).toBe('number');
    expect(Number(payload?.exp) - Number(payload?.iat)).toBe(900);
  });

  it('test_firefox_exchange_issues_tokens_and_device', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t), FIREFOX_EXTENSION_ID);

    const body = codeExchange(code, verifier, FIREFOX_EXTENSION_ID, 'Firefox on Linux');
    expect(body).toMatchObject({ client_id: FIREFOX_EXTENSION_ID, redirect_uri: FIREFOX_REDIRECT });
    const res = await exchange(t, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Sent from a Firefox extension page, whose origin names no add-on: the extension can read the answer.
    expect(res.headers.get('access-control-allow-origin')).toBe(FIREFOX_EXTENSION_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const tokens = TokenResponseSchema.parse(await res.json());
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900, account: { email: TOM } });

    const [owner] = await t.deps.db.db.select().from(user).where(eq(user.email, TOM));
    const { payload } = await t.deps.auth.api.verifyJWT({ body: { token: tokens.access_token } });
    expect(payload).toMatchObject({ sub: owner?.id, did: tokens.device_id, cid: FIREFOX_EXTENSION_ID });
    expect(await t.deps.db.db.select().from(devices)).toMatchObject([
      { id: tokens.device_id, userId: owner?.id, clientId: FIREFOX_EXTENSION_ID, name: 'Firefox on Linux', revokedAt: null },
    ]);
  });

  it('test_code_is_single_use', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t));
    expect((await exchange(t, codeExchange(code, verifier))).status).toBe(200);

    const again = await exchange(t, codeExchange(code, verifier));
    await expectAuthRequired(again);
    expect(again.headers.get('cache-control')).toBe('no-store');
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(1);
  });

  it('test_wrong_verifier_burns_code', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t));

    await expectAuthRequired(await exchange(t, codeExchange(code, pkcePair().verifier)));
    // The failed try spent the code: a thief who guesses wrong cannot leave it for a second guess.
    await expectAuthRequired(await exchange(t, codeExchange(code, verifier)));
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(0);
  });

  it('test_code_expires_after_60s', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    // Only Date is faked: PGlite and the request path keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    const early = await authorized(t, cookie);
    const late = await authorized(t, cookie);

    vi.advanceTimersByTime(59_000);
    expect((await exchange(t, codeExchange(early.code, early.verifier))).status).toBe(200);
    vi.advanceTimersByTime(2_000);
    await expectAuthRequired(await exchange(t, codeExchange(late.code, late.verifier)));
  });

  it('test_exchange_binds_client_and_redirect', async () => {
    const t = await tokenApp({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${OTHER_ID}` });
    const cookie = await webSession(t);

    // Another listed extension cannot redeem a code issued to this one, with its own redirect or with this one's.
    const forOther = await authorized(t, cookie);
    await expectAuthRequired(await exchange(t, codeExchange(forOther.code, forOther.verifier, OTHER_ID)));
    const sameRedirect = await authorized(t, cookie);
    await expectAuthRequired(
      await exchange(t, {
        ...codeExchange(sameRedirect.code, sameRedirect.verifier, OTHER_ID),
        redirect_uri: chromiumRedirectUri(DEV_EXTENSION_ID),
      }),
    );
    // The right extension with another redirect address.
    const elsewhere = await authorized(t, cookie);
    await expectAuthRequired(
      await exchange(t, { ...codeExchange(elsewhere.code, elsewhere.verifier), redirect_uri: 'https://evil.example/' }),
    );

    // An extension the server does not list is refused before the code is looked at, so the code still works.
    const kept = await authorized(t, cookie);
    await expectRefused(await exchange(t, codeExchange(kept.code, kept.verifier, UNLISTED_ID)));
    expect((await exchange(t, codeExchange(kept.code, kept.verifier))).status).toBe(200);
  });

  it('test_exchange_binds_client_across_browsers', async () => {
    const t = await tokenApp({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${FIREFOX_EXTENSION_ID},${FIREFOX_ADDON_ID}` });
    const cookie = await webSession(t);

    // A code issued to Chrome's extension cannot be redeemed by a Firefox one, with either redirect, nor the reverse.
    const forChrome = await authorized(t, cookie);
    await expectAuthRequired(await exchange(t, codeExchange(forChrome.code, forChrome.verifier, FIREFOX_EXTENSION_ID)));
    const forChromeAgain = await authorized(t, cookie);
    await expectAuthRequired(
      await exchange(t, {
        ...codeExchange(forChromeAgain.code, forChromeAgain.verifier, FIREFOX_EXTENSION_ID),
        redirect_uri: chromiumRedirectUri(DEV_EXTENSION_ID),
      }),
    );
    const forFirefox = await authorized(t, cookie, FIREFOX_EXTENSION_ID);
    await expectAuthRequired(await exchange(t, codeExchange(forFirefox.code, forFirefox.verifier)));
    // Nor by the other Firefox add-on, or with another redirect address.
    const forDev = await authorized(t, cookie, FIREFOX_EXTENSION_ID);
    await expectAuthRequired(await exchange(t, codeExchange(forDev.code, forDev.verifier, FIREFOX_ADDON_ID)));
    const elsewhere = await authorized(t, cookie, FIREFOX_EXTENSION_ID);
    await expectAuthRequired(
      await exchange(t, {
        ...codeExchange(elsewhere.code, elsewhere.verifier, FIREFOX_EXTENSION_ID),
        redirect_uri: geckoRedirectUri(FIREFOX_ADDON_ID),
      }),
    );

    // An add-on the server does not list is refused before the code is looked at, so the code still works.
    const kept = await authorized(t, cookie, FIREFOX_EXTENSION_ID);
    await expectRefused(await exchange(t, codeExchange(kept.code, kept.verifier, UNLISTED_FIREFOX_ID)));
    expect((await exchange(t, codeExchange(kept.code, kept.verifier, FIREFOX_EXTENSION_ID))).status).toBe(200);
    expect(await t.deps.db.db.select().from(devices)).toMatchObject([{ clientId: FIREFOX_EXTENSION_ID }]);
  });

  it('test_concurrent_exchange_one_winner', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t));

    const answers = await Promise.all([exchange(t, codeExchange(code, verifier)), exchange(t, codeExchange(code, verifier))]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(1);
    expect(await t.deps.db.db.select().from(refreshTokens)).toHaveLength(1);
  });

  it('test_failed_exchange_stores_no_device', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    const serverError = { code: 'unknown', message: 'Something went wrong on the server.' };
    const stored = async () => ({
      devices: (await t.deps.db.db.select().from(devices)).length,
      refreshTokens: (await t.deps.db.db.select().from(refreshTokens)).length,
    });

    // Signing fails (the key cannot be read after a secret change, say): nothing has been written yet.
    const unsigned = await authorized(t, cookie);
    vi.spyOn(t.deps.auth.api, 'signJWT').mockRejectedValueOnce(new Error('No signing key.'));
    const first = await exchange(t, codeExchange(unsigned.code, unsigned.verifier));
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual(serverError);
    expect(await stored()).toEqual({ devices: 0, refreshTokens: 0 });

    // Storing the refresh token fails: the device it was for is not kept either.
    await t.deps.db.db.execute(sql`ALTER TABLE refresh_tokens ADD CONSTRAINT refuse_all CHECK (false)`);
    const unstored = await authorized(t, cookie);
    const second = await exchange(t, codeExchange(unstored.code, unstored.verifier));
    expect(second.status).toBe(500);
    expect(await second.json()).toEqual(serverError);
    expect(await stored()).toEqual({ devices: 0, refreshTokens: 0 });
  });

  it('test_verify_pkce_s256', () => {
    // RFC 7636, appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN')).toBe(false);
    expect(verifyPkce(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c')).toBe(false);
    expect(verifyPkce(verifier, '')).toBe(false);
  });
});

describe('storage and hygiene', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_only_hashes_are_stored', async () => {
    const t = await tokenApp();
    const { code, verifier } = await authorized(t, await webSession(t));
    const res = await exchange(t, codeExchange(code, verifier));
    const tokens = TokenResponseSchema.parse(await res.json());
    const plain = [code, verifier, tokens.refresh_token, tokens.access_token];
    const sha256 = (s: string) => createHash('sha256').update(s).digest('base64url');

    const codes = await codeRows(t);
    const refresh = await t.deps.db.db.select().from(refreshTokens);
    const deviceRows = await t.deps.db.db.select().from(devices);
    for (const row of [...codes, ...refresh, ...deviceRows]) {
      for (const value of Object.values(row)) expect(plain).not.toContain(value);
      for (const secret of plain) expect(JSON.stringify(row)).not.toContain(secret);
    }
    expect(codes.map((r) => r.codeHash)).toEqual([sha256(code)]);
    expect(refresh.map((r) => [r.tokenHash, r.deviceId])).toEqual([[sha256(tokens.refresh_token), tokens.device_id]]);

    const [owner] = await t.deps.db.db.select().from(user).where(eq(user.email, TOM));
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0]).toMatchObject({ id: tokens.device_id, userId: owner?.id, clientId: DEV_EXTENSION_ID, revokedAt: null });
  });

  it('test_token_endpoint_cors_preflight', async () => {
    const t = await tokenApp();
    const res = await t.app.request(TOKEN_PATH, {
      method: 'OPTIONS',
      headers: {
        Origin: DEV_EXTENSION_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');

    // Firefox preflights the same JSON POST from its extension page.
    const firefox = await t.app.request(TOKEN_PATH, {
      method: 'OPTIONS',
      headers: {
        Origin: FIREFOX_EXTENSION_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(firefox.status).toBe(204);
    expect(firefox.headers.get('access-control-allow-origin')).toBe(FIREFOX_EXTENSION_ORIGIN);
    expect(firefox.headers.get('access-control-allow-methods')).toContain('POST');
    expect(firefox.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('test_auth_token_logs_hold_no_secrets', async () => {
    const t = await tokenApp();
    const cookie = await webSession(t);
    // Every outcome once: issued, refused for its origin, spent, wrong verifier, unlisted extension, invalid body.
    const good = await authorized(t, cookie);
    await postAuthorize(t.app, cookie, authorizeRequest(pkcePair().challenge), DEV_EXTENSION_ORIGIN);
    await exchange(t, codeExchange(good.code, good.verifier));
    await exchange(t, codeExchange(good.code, good.verifier));
    const wrong = await authorized(t, cookie);
    const guess = pkcePair().verifier;
    secrets.push(guess);
    await exchange(t, codeExchange(wrong.code, guess));
    const unlisted = await authorized(t, cookie);
    await exchange(t, codeExchange(unlisted.code, unlisted.verifier, UNLISTED_ID));
    await exchange(t, { ...codeExchange(unlisted.code, unlisted.verifier), code_verifier: 'short' });

    expect(t.lines.length).toBeGreaterThan(0);
    expect(secrets.length).toBeGreaterThan(5);
    for (const secret of secrets) expect(secret.length).toBeGreaterThan(10);
    // This test's lines and every line the earlier tests in this file wrote (AC 1 to 12).
    for (const line of [...t.lines, ...allLines]) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
