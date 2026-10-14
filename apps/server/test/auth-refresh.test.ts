import { REVOKE_PATH, ServerErrorSchema, type TokenResponse, TokenResponseSchema } from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { decodeJwt, decodeProtectedHeader, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireDevice } from '../src/auth/bearer.ts';
import { REFRESH_TOKEN_TTL_DAYS } from '../src/auth/tokens.ts';
import { devices, refreshTokens, user } from '../src/db/schema.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, postJson, postToken, signInDevice } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const OTHER_ID = 'b'.repeat(32);
const UNLISTED_ID = 'c'.repeat(32);
/** A test-only route behind `requireDevice` that answers with the account it set. */
const ME = '/v1/test/me';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Every refused refresh and every refused bearer token answers exactly this. */
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome; fake timers are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file, and every token the tests saw, for the log test at the end (AC 10). */
const allLines: string[] = [];
const secrets: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with `GET /v1/test/me` behind `requireDevice`, mounted before the first request. */
async function refreshApp(env: Record<string, string> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM, ...env }) });
  t.app.get(ME, requireDevice(t.deps), (c) => c.json(c.var.account));
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

/** The extension's whole sign-in; its tokens join `secrets`. */
async function signedIn(t: TestApp, clientId = DEV_EXTENSION_ID): Promise<TokenResponse> {
  const tokens = await signInDevice(t.app, t.outbox, TOM, clientId);
  secrets.push(tokens.access_token, tokens.refresh_token);
  return tokens;
}

/** The refresh the extension makes; a 200 answer's tokens join `secrets`. */
async function refresh(t: TestApp, refreshToken: string, clientId = DEV_EXTENSION_ID): Promise<Response> {
  const res = await postToken(t.app, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  if (res.status === 200) {
    const tokens = TokenResponseSchema.parse(await res.clone().json());
    secrets.push(tokens.access_token, tokens.refresh_token);
  }
  return res;
}

/** A refresh that must succeed: the new tokens. */
async function refreshed(t: TestApp, refreshToken: string): Promise<TokenResponse> {
  const res = await refresh(t, refreshToken);
  expect(res.status).toBe(200);
  return TokenResponseSchema.parse(await res.json());
}

/** "Sign out" as the extension sends it. */
const revoke = (t: TestApp, refreshToken: string, clientId = DEV_EXTENSION_ID) =>
  postJson(t.app, REVOKE_PATH, { refresh_token: refreshToken, client_id: clientId }, { Origin: DEV_EXTENSION_ORIGIN });

/** `GET /v1/test/me` with this `Authorization` header, or none. */
const me = async (t: TestApp, authorization?: string): Promise<Response> =>
  t.app.request(ME, authorization === undefined ? {} : { headers: { Authorization: authorization } });
const withBearer = (t: TestApp, token: string) => me(t, `Bearer ${token}`);

async function expectAuthRequired(res: Response) {
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual(AUTH_REQUIRED);
}

/** What `requireDevice` answers for any token it does not accept. */
async function expectRejected(res: Response) {
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  await expectAuthRequired(res);
}

async function device(t: TestApp, id: string) {
  const [row] = await t.deps.db.db.select().from(devices).where(eq(devices.id, id));
  if (!row) throw new Error('No such device.');
  return row;
}

const tokenRows = (t: TestApp, deviceId: string) =>
  t.deps.db.db.select().from(refreshTokens).where(eq(refreshTokens.deviceId, deviceId));

async function userId(t: TestApp): Promise<string> {
  const [owner] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, TOM));
  if (!owner) throw new Error('No account.');
  return owner.id;
}

describe('rotation', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_refresh_rotates_token_same_device', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);

    const res = await refresh(t, first.refresh_token);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    const next = TokenResponseSchema.parse(await res.json());
    expect(next).toMatchObject({ token_type: 'Bearer', expires_in: 900, device_id: first.device_id, account: { email: TOM } });
    expect(next.refresh_token).not.toBe(first.refresh_token);
    expect(next.refresh_token).toMatch(/^[\w-]{43}$/);

    // The new access token works.
    const answer = await withBearer(t, next.access_token);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ userId: await userId(t), deviceId: first.device_id, clientId: DEV_EXTENSION_ID });

    // The old token is spent, the new one carries a fresh 60-day lifetime, and the device stays the only one.
    const rows = await tokenRows(t, first.device_id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.usedAt !== null)).toHaveLength(1);
    const live = rows.filter((r) => r.usedAt === null);
    expect(live).toHaveLength(1);
    const lifetime = (live[0]?.expiresAt.getTime() ?? 0) - Date.now();
    expect(lifetime).toBeGreaterThan(REFRESH_TOKEN_TTL_DAYS * DAY_MS - MINUTE_MS);
    expect(lifetime).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_DAYS * DAY_MS);
    expect(await t.deps.db.db.select().from(devices)).toHaveLength(1);

    // And it rotates again.
    expect((await refreshed(t, next.refresh_token)).device_id).toBe(first.device_id);
  });

  it('test_refresh_reuse_revokes_device', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);
    const next = await refreshed(t, first.refresh_token);
    const latest = await refreshed(t, next.refresh_token);

    // The old token again, after the token its refresh issued was used: someone else holds a copy.
    await expectAuthRequired(await refresh(t, first.refresh_token));
    const revoked = await device(t, first.device_id);
    expect(revoked.revokedReason).toBe('refresh-reuse');
    expect(revoked.revokedAt).not.toBeNull();
    expect((await tokenRows(t, first.device_id)).every((r) => r.usedAt !== null)).toBe(true);

    // No copy works any longer: not the newest refresh token, not an access token that has not expired.
    await expectAuthRequired(await refresh(t, latest.refresh_token));
    await expectRejected(await withBearer(t, first.access_token));
    await expectRejected(await withBearer(t, latest.access_token));
    expect((await device(t, first.device_id)).revokedReason).toBe('refresh-reuse');
  });

  it('test_refresh_replay_within_a_minute', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);
    vi.useFakeTimers({ toFake: ['Date'] });
    // The answer to this refresh is lost: the extension still holds `first`, and nobody holds `lost`.
    const lost = await refreshed(t, first.refresh_token);

    // 50 seconds later the extension tries `first` again: new tokens for the same device, nothing revoked.
    vi.setSystemTime(Date.now() + 50_000);
    const again = await refreshed(t, first.refresh_token);
    expect(again.device_id).toBe(first.device_id);
    expect(again.refresh_token).not.toBe(lost.refresh_token);
    expect(await device(t, first.device_id)).toMatchObject({ revokedAt: null, revokedReason: null });
    // Lost once more: the allowance still counts from the first refresh of `first`.
    const third = await refreshed(t, first.refresh_token);
    const next = await refreshed(t, third.refresh_token);
    expect((await withBearer(t, next.access_token)).status).toBe(200);

    // A token a replay superseded is a copy: it revokes the device, and the chain that went on dies with it.
    await expectAuthRequired(await refresh(t, lost.refresh_token));
    expect((await device(t, first.device_id)).revokedReason).toBe('refresh-reuse');
    await expectAuthRequired(await refresh(t, next.refresh_token));
    await expectRejected(await withBearer(t, next.access_token));
  });

  it('test_refresh_replay_after_a_minute_revokes', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);
    vi.useFakeTimers({ toFake: ['Date'] });
    const next = await refreshed(t, first.refresh_token);

    vi.setSystemTime(Date.now() + 61_000);
    await expectAuthRequired(await refresh(t, first.refresh_token));
    expect((await device(t, first.device_id)).revokedReason).toBe('refresh-reuse');
    await expectAuthRequired(await refresh(t, next.refresh_token));
  });

  it('test_refresh_expired_is_401_without_revoke', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);
    // Only Date is faked: PGlite and the request path keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });

    // 59 days on, the token still works, and its successor lives 60 days from now.
    vi.setSystemTime(Date.now() + 59 * DAY_MS);
    const next = await refreshed(t, first.refresh_token);
    // 61 days after that one was issued, it does not.
    vi.setSystemTime(Date.now() + 61 * DAY_MS);
    await expectAuthRequired(await refresh(t, next.refresh_token));

    const kept = await device(t, first.device_id);
    expect(kept).toMatchObject({ revokedAt: null, revokedReason: null });
    // An expired token is not spent by the refusal.
    expect((await tokenRows(t, first.device_id)).filter((r) => r.usedAt === null)).toHaveLength(1);
  });

  it('test_refresh_wrong_client_401', async () => {
    const t = await refreshApp({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${OTHER_ID}` });
    const first = await signedIn(t);

    // Another listed extension cannot use this device's token, and the attempt neither spends it nor revokes anything.
    await expectAuthRequired(await refresh(t, first.refresh_token, OTHER_ID));
    expect(await device(t, first.device_id)).toMatchObject({ revokedAt: null, revokedReason: null });
    // An extension the server does not list is refused before the token is looked at.
    const unlisted = await refresh(t, first.refresh_token, UNLISTED_ID);
    expect(unlisted.status).toBe(403);
    expect(ServerErrorSchema.parse(await unlisted.json()).code).toBe('permission');

    expect((await refreshed(t, first.refresh_token)).device_id).toBe(first.device_id);
  });

  it('test_failed_refresh_keeps_token', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);
    const serverError = { code: 'unknown', message: 'Something went wrong on the server.' };

    // Signing fails, then storing the new token fails: neither spends the old one, so trying again is not reuse.
    vi.spyOn(t.deps.auth.api, 'signJWT').mockRejectedValueOnce(new Error('No signing key.'));
    const unsigned = await refresh(t, first.refresh_token);
    expect(unsigned.status).toBe(500);
    expect(await unsigned.json()).toEqual(serverError);
    await t.deps.db.db.execute(sql`ALTER TABLE refresh_tokens ADD CONSTRAINT refuse_all CHECK (false) NOT VALID`);
    const unstored = await refresh(t, first.refresh_token);
    expect(unstored.status).toBe(500);
    expect(await unstored.json()).toEqual(serverError);
    await t.deps.db.db.execute(sql`ALTER TABLE refresh_tokens DROP CONSTRAINT refuse_all`);

    expect(await tokenRows(t, first.device_id)).toMatchObject([{ usedAt: null }]);
    expect((await refreshed(t, first.refresh_token)).device_id).toBe(first.device_id);
    expect(await device(t, first.device_id)).toMatchObject({ revokedAt: null, revokedReason: null });
  });

  it('test_concurrent_refresh_revokes', async () => {
    const t = await refreshApp();
    const first = await signedIn(t);

    const answers = await Promise.all([refresh(t, first.refresh_token), refresh(t, first.refresh_token)]);
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThanOrEqual(1);
    expect((await device(t, first.device_id)).revokedReason).toBe('refresh-reuse');

    // Whatever a winner received is dead too.
    for (const res of answers.filter((r) => r.status === 200)) {
      const won = TokenResponseSchema.parse(await res.json());
      await expectAuthRequired(await refresh(t, won.refresh_token));
      await expectRejected(await withBearer(t, won.access_token));
    }
    await expectRejected(await withBearer(t, first.access_token));
  });
});

describe('sign-out', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_revoke_signs_device_out', async () => {
    const t = await refreshApp({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${OTHER_ID}` });
    const first = await signedIn(t);
    const current = await refreshed(t, first.refresh_token);
    const other = await signedIn(t);

    const res = await revoke(t, current.refresh_token);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV_EXTENSION_ORIGIN);
    expect(await res.json()).toEqual({ ok: true });
    expect((await device(t, first.device_id)).revokedReason).toBe('sign-out');

    await expectAuthRequired(await refresh(t, current.refresh_token));
    await expectRejected(await withBearer(t, current.access_token));
    // Trying the signed-out token is not taken for theft: the device stays signed out, as it was.
    expect((await device(t, first.device_id)).revokedReason).toBe('sign-out');

    // Unknown tokens, and a token named with another extension's id, are answered alike and change nothing.
    for (const [token, clientId] of [
      ['x'.repeat(43), DEV_EXTENSION_ID],
      [other.refresh_token, OTHER_ID],
    ] as const) {
      const quiet = await revoke(t, token, clientId);
      expect(quiet.status).toBe(200);
      expect(await quiet.json()).toEqual({ ok: true });
    }
    expect(await device(t, other.device_id)).toMatchObject({ revokedAt: null, revokedReason: null });
    expect((await withBearer(t, other.access_token)).status).toBe(200);
  });
});

describe('bearer middleware', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_require_device_rejects_bad_tokens', async () => {
    const t = await refreshApp();
    const { access_token } = await signedIn(t);
    expect((await withBearer(t, access_token)).status).toBe(200);

    // No header, another scheme, and tokens that are not JWTs at all.
    await expectRejected(await me(t));
    await expectRejected(await me(t, 'Basic abc'));
    await expectRejected(await me(t, 'Bearer'));
    await expectRejected(await withBearer(t, 'not-a-token'));
    await expectRejected(await withBearer(t, 'a.b.c'));

    // The same claims and key id, signed with another Ed25519 key.
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT(decodeJwt(access_token))
      .setProtectedHeader({ alg: 'EdDSA', kid: decodeProtectedHeader(access_token).kid ?? '' })
      .sign(privateKey);
    await expectRejected(await withBearer(t, forged));

    // 16 minutes after it was issued, the access token has expired.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * MINUTE_MS);
    await expectRejected(await withBearer(t, access_token));
  });

  it('test_require_device_rejects_foreign_audience', async () => {
    const t = await refreshApp();
    const tokens = await signedIn(t);
    const { sub, did, cid } = decodeJwt(tokens.access_token);
    const sign = async (payload: Record<string, unknown>) => {
      const { token } = await t.deps.auth.api.signJWT({ body: { payload: { sub, did, cid, ...payload } } });
      secrets.push(token);
      return token;
    };

    // The server's own key and claims: accepted with its own audience, refused with any other.
    expect((await withBearer(t, await sign({}))).status).toBe(200);
    await expectRejected(await withBearer(t, await sign({ aud: 'https://other.example' })));
    await expectRejected(await withBearer(t, await sign({ aud: [TEST_PUBLIC_URL, 'https://other.example'] })));
  });

  it('test_require_device_checks_claims_against_device', async () => {
    const t = await refreshApp({ EXTENSION_IDS: `${DEV_EXTENSION_ID},${OTHER_ID}` });
    const tokens = await signedIn(t);
    const { sub, did, cid } = decodeJwt(tokens.access_token);
    const sign = async (payload: Record<string, unknown>) => {
      const { token } = await t.deps.auth.api.signJWT({ body: { payload } });
      secrets.push(token);
      return token;
    };

    // Each claim must be there, be a string, and match the stored device.
    for (const payload of [
      { sub, cid },
      { sub, did },
      { sub, did: 7, cid },
      { sub, did: 'not-a-uuid', cid },
      { sub, did: crypto.randomUUID(), cid },
      { sub: 'someone-else', did, cid },
      { sub, did, cid: OTHER_ID },
    ]) {
      await expectRejected(await withBearer(t, await sign(payload)));
    }
    expect((await withBearer(t, await sign({ sub, did, cid }))).status).toBe(200);
  });

  it('test_require_device_sets_account_and_last_used', async () => {
    const t = await refreshApp();
    const tokens = await signedIn(t);
    expect((await device(t, tokens.device_id)).lastUsedAt).toBeNull();

    vi.useFakeTimers({ toFake: ['Date'] });
    const res = await withBearer(t, tokens.access_token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: await userId(t), deviceId: tokens.device_id, clientId: DEV_EXTENSION_ID });
    const firstUse = (await device(t, tokens.device_id)).lastUsedAt;
    expect(firstUse?.getTime()).toBe(Date.now());

    // Written at most every 5 minutes, not on every request.
    vi.setSystemTime(Date.now() + 4 * MINUTE_MS);
    expect((await withBearer(t, tokens.access_token)).status).toBe(200);
    expect((await device(t, tokens.device_id)).lastUsedAt).toEqual(firstUse);
    vi.setSystemTime(Date.now() + 2 * MINUTE_MS);
    expect((await withBearer(t, tokens.access_token)).status).toBe(200);
    expect((await device(t, tokens.device_id)).lastUsedAt?.getTime()).toBe(Date.now());
  });
});

describe('logs', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_refresh_logs_hold_no_tokens', async () => {
    const t = await refreshApp();
    // Every outcome once: rotated, replayed, reused, refused, revoked, a valid and a revoked bearer token.
    const first = await signedIn(t);
    const next = await refreshed(t, first.refresh_token);
    expect((await withBearer(t, next.access_token)).status).toBe(200);
    // The previous token again, its successor unused: a lost answer, replayed.
    const replayed = await refreshed(t, first.refresh_token);
    // The successor that replay superseded: reuse.
    await refresh(t, next.refresh_token);
    // Spent by the revocation: a reuse on a device revoked already.
    await refresh(t, replayed.refresh_token);
    await withBearer(t, replayed.access_token);
    const second = await signedIn(t);
    await revoke(t, second.refresh_token);
    // A signed-out token tried again: also a reuse, and the device stays signed out.
    await refresh(t, second.refresh_token);
    await revoke(t, 'y'.repeat(43));

    const events = t.events();
    // Every reuse writes a line, also one that finds the device revoked already, which keeps its first reason.
    const reuse = events.filter((e) => e.event === 'auth.refresh_reuse');
    expect(reuse.map((e) => [e.level, e.device_id, e.already_revoked])).toEqual([
      ['warn', first.device_id, false],
      ['warn', first.device_id, true],
      ['warn', second.device_id, true],
    ]);
    expect((await device(t, first.device_id)).revokedReason).toBe('refresh-reuse');
    expect((await device(t, second.device_id)).revokedReason).toBe('sign-out');
    for (const e of reuse) expect(Object.keys(e).sort()).toEqual(['already_revoked', 'device_id', 'event', 'level', 'rid', 't']);
    expect(events.filter((e) => e.event === 'auth.refreshed').map((e) => e.device_id)).toEqual([first.device_id]);
    const replays = events.filter((e) => e.event === 'auth.refresh_replayed');
    expect(replays.map((e) => [e.level, e.device_id])).toEqual([['info', first.device_id]]);
    expect(events.filter((e) => e.event === 'auth.revoked').map((e) => e.device_id)).toEqual([second.device_id]);
    for (const e of events.filter((x) => ['auth.refreshed', 'auth.refresh_replayed', 'auth.revoked'].includes(String(x.event)))) {
      expect(Object.keys(e).sort()).toEqual(['device_id', 'event', 'level', 'rid', 't']);
    }

    expect(secrets.length).toBeGreaterThan(10);
    for (const secret of secrets) expect(secret.length).toBeGreaterThan(20);
    // This test's lines and every line the earlier tests in this file wrote.
    for (const line of [...t.lines, ...allLines]) {
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });
});
