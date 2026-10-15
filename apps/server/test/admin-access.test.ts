import type { TokenResponse } from '@unalgorithm/protocol';
import { count, eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE,
  activeAdminCount,
  adminApiError,
  findAccount,
  NOT_ADMIN,
  removeAccess,
  requireAdmin,
  restoreAccess,
} from '../src/admin/access.ts';
import { requireDevice } from '../src/auth/bearer.ts';
import { requireWebSession } from '../src/auth/web-session.ts';
import { devices, refreshTokens, session, user } from '../src/db/schema.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { queryRows } from './support/db.ts';
import {
  authorizeRequest,
  codeExchange,
  codeFrom,
  DEV_EXTENSION_ID,
  pkcePair,
  postAuthorize,
  postJson,
  postToken,
  SEND_CODE,
  SIGN_IN,
  sentCode,
  signInDevice,
  signInWeb,
} from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const TOM = 'tom@example.com';
/** A test-only route behind `requireWebSession` and `requireAdmin`. */
const PROBE = '/v1/test/admin-probe';
/** A test-only route behind `requireDevice`: whether a device's access token still works. */
const ME = '/v1/test/me';
const PAGE = { Origin: TEST_PUBLIC_URL };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Every log line of every app below, for the privacy test at the end. */
const everyLine: string[] = [];

/** A test server for Ada, Bea and Tom with the probe and `me` routes, mounted before the first request. */
async function adminApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ADA},${BEA},${TOM}` }) });
  t.app.get(PROBE, requireWebSession(t.deps), requireAdmin(t.deps), (c) => c.json({ ok: true }));
  t.app.get(ME, requireDevice(t.deps), (c) => c.json(c.var.account));
  cleanup.push(async () => {
    everyLine.push(...t.lines);
    await t.close();
  });
  return t;
}

const access = (t: TestApp) => ({ db: t.deps.db.db, auth: t.deps.auth, log: t.deps.log });
const headersOf = (cookie: string) => new Headers({ Cookie: cookie });
const probe = (t: TestApp, cookie?: string) => t.app.request(PROBE, { headers: cookie ? { Cookie: cookie } : {} });
const me = (t: TestApp, tokens: TokenResponse) =>
  t.app.request(ME, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
const refresh = (t: TestApp, tokens: TokenResponse) =>
  postToken(t.app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: DEV_EXTENSION_ID });

async function userId(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No account.');
  return row.id;
}

/** Sets an account's role with a direct update, as an operator or CL4-04's setup link would. */
async function setRole(t: TestApp, email: string, role: string | null) {
  await t.deps.db.db.update(user).set({ role }).where(eq(user.email, email));
}

/** Signs `email` in on the page and makes the account an admin; returns the session cookie and the account's id. */
async function signInAdmin(t: TestApp, email: string) {
  const cookie = await signInWeb(t.app, t.outbox, email);
  await setRole(t, email, ADMIN_ROLE);
  return { cookie, id: await userId(t, email) };
}

async function accountRow(t: TestApp, email: string) {
  const [row] = await t.deps.db.db
    .select({ role: user.role, banned: user.banned, banReason: user.banReason, name: user.name })
    .from(user)
    .where(eq(user.email, email));
  return row;
}

async function sessionCount(t: TestApp, id: string): Promise<number> {
  const [row] = await t.deps.db.db.select({ n: count() }).from(session).where(eq(session.userId, id));
  return row?.n ?? 0;
}

async function deviceCount(t: TestApp, id: string): Promise<number> {
  const [row] = await t.deps.db.db.select({ n: count() }).from(devices).where(eq(devices.userId, id));
  return row?.n ?? 0;
}

/** What `fn` throws, through `adminApiError`. */
async function refusal(fn: () => Promise<unknown>) {
  const err = await fn().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeDefined();
  return adminApiError(err);
}

describe('schema and plugin', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_plugin_columns_exist', async () => {
    const t = await adminApp();
    const rows = await queryRows(
      t.deps.db,
      sql`select table_name, column_name from information_schema.columns
          where table_schema = 'public' and table_name in ('user', 'session')`,
    );
    const columns = rows.map((r) => `${String(r.table_name)}.${String(r.column_name)}`);
    expect(columns).toEqual(
      expect.arrayContaining(['user.role', 'user.banned', 'user.ban_reason', 'user.ban_expires', 'session.impersonated_by']),
    );
  });

  it('test_new_account_role_is_user', async () => {
    const t = await adminApp();
    await signInWeb(t.app, t.outbox, TOM);
    expect(await accountRow(t, TOM)).toEqual({ role: 'user', banned: false, banReason: null, name: '' });
  });

  it('test_admin_plugin_routes_not_mounted', async () => {
    const t = await adminApp();
    const { cookie, id } = await signInAdmin(t, ADA);
    const headers = { ...PAGE, Cookie: cookie };
    const answers = [
      await postJson(t.app, '/api/auth/admin/ban-user', { userId: id }, headers),
      await postJson(t.app, '/api/auth/admin/set-role', { userId: id, role: 'admin' }, headers),
      await postJson(t.app, '/api/auth/admin/impersonate-user', { userId: id }, headers),
      await t.app.request('/api/auth/admin/list-users', { headers }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
    }
  });
});

describe('requireAdmin', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_require_admin_allows_only_active_admins', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    const bea = await signInAdmin(t, BEA);
    const tom = await signInWeb(t.app, t.outbox, TOM);
    expect((await probe(t, ada.cookie)).status).toBe(200);

    const user403 = await probe(t, tom);
    expect(user403.status).toBe(403);
    expect(await user403.json()).toEqual(NOT_ADMIN);

    await setRole(t, TOM, null);
    const null403 = await probe(t, tom);
    expect(null403.status).toBe(403);
    expect(await null403.json()).toEqual(NOT_ADMIN);

    // A direct ban keeps Bea's session, so only requireAdmin stands in the way.
    await t.deps.db.db.update(user).set({ banned: true }).where(eq(user.id, bea.id));
    const banned403 = await probe(t, bea.cookie);
    expect(banned403.status).toBe(403);
    expect(await banned403.json()).toEqual(NOT_ADMIN);

    expect((await probe(t)).status).toBe(401);
  });

  it('test_require_admin_reads_role_every_request', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    expect((await probe(t, ada.cookie)).status).toBe(200);
    await setRole(t, ADA, 'user');
    const res = await probe(t, ada.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(NOT_ADMIN);
  });
});

describe('access', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_remove_access_bans_and_revokes_devices', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    const first = await signInDevice(t.app, t.outbox, TOM);
    const second = await signInDevice(t.app, t.outbox, TOM);
    const tom = await userId(t, TOM);
    expect(await sessionCount(t, tom)).toBeGreaterThan(0);

    const result = await removeAccess(access(t), headersOf(ada.cookie), ada.id, tom);

    expect(result).toEqual({ devicesRevoked: 2 });
    expect(await accountRow(t, TOM)).toMatchObject({ banned: true, banReason: 'removed-by-admin' });
    expect(await sessionCount(t, tom)).toBe(0);
    const reasons = await t.deps.db.db.select({ reason: devices.revokedReason }).from(devices).where(eq(devices.userId, tom));
    expect(reasons).toEqual([{ reason: 'removed-by-admin' }, { reason: 'removed-by-admin' }]);
    for (const tokens of [first, second]) {
      expect((await refresh(t, tokens)).status).toBe(401);
      expect((await me(t, tokens)).status).toBe(401);
    }
    const [line] = t.events().filter((e) => e.event === 'admin.access_removed');
    expect(line).toMatchObject({ admin_id: ada.id, user_id: tom, devices: 2 });
  });

  it('test_banned_account_gets_no_new_tokens', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);

    // A code issued before the removal, exchanged after it.
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    const { verifier, challenge } = pkcePair();
    const code = await codeFrom(await postAuthorize(t.app, cookie, authorizeRequest(challenge)));
    const tom = await userId(t, TOM);
    await removeAccess(access(t), headersOf(ada.cookie), ada.id, tom);
    const exchanged = await postToken(t.app, codeExchange(code, verifier));
    expect(exchanged.status).toBe(401);
    expect(await exchanged.json()).toMatchObject({ code: 'auth-required' });
    expect(await deviceCount(t, tom)).toBe(0);

    // A refresh for a device that is not revoked, of an account banned directly.
    const tokens = await signInDevice(t.app, t.outbox, BEA);
    const bea = await userId(t, BEA);
    await t.deps.db.db.update(user).set({ banned: true }).where(eq(user.id, bea));
    const before = await t.deps.db.db.select({ n: count() }).from(refreshTokens);
    const refreshed = await refresh(t, tokens);
    expect(refreshed.status).toBe(401);
    expect(await t.deps.db.db.select({ n: count() }).from(refreshTokens)).toEqual(before);
    // Refused, not reuse: the device stays as it was and its token unspent.
    const [device] = await t.deps.db.db.select({ revokedAt: devices.revokedAt }).from(devices).where(eq(devices.userId, bea));
    expect(device?.revokedAt).toBeNull();
  });

  it('test_removed_account_cannot_sign_in', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    await signInWeb(t.app, t.outbox, TOM);
    const tom = await userId(t, TOM);
    await removeAccess(access(t), headersOf(ada.cookie), ada.id, tom);

    expect((await postJson(t.app, SEND_CODE, { email: TOM, type: 'sign-in' }, PAGE)).status).toBe(200);
    const res = await postJson(t.app, SIGN_IN, { email: TOM, otp: sentCode(t.outbox, TOM) }, PAGE);
    expect(res.status).toBe(403);
    expect(await sessionCount(t, tom)).toBe(0);
  });

  it('test_restore_access_allows_sign_in_again', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    const tokens = await signInDevice(t.app, t.outbox, TOM);
    const tom = await userId(t, TOM);
    await removeAccess(access(t), headersOf(ada.cookie), ada.id, tom);

    await restoreAccess(access(t), headersOf(ada.cookie), ada.id, tom);

    expect(await accountRow(t, TOM)).toMatchObject({ banned: false });
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    expect(cookie).toContain('better-auth.session_token=');
    expect((await me(t, tokens)).status).toBe(401);
    expect((await refresh(t, tokens)).status).toBe(401);
    expect(t.events().some((e) => e.event === 'admin.access_restored' && e.user_id === tom)).toBe(true);
  });

  it('test_admin_api_error_mapping', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    const tom = await signInWeb(t.app, t.outbox, TOM);
    await signInWeb(t.app, t.outbox, BEA);
    const beaId = await userId(t, BEA);

    expect(await refusal(() => removeAccess(access(t), headersOf(ada.cookie), ada.id, ada.id))).toEqual({
      status: 400,
      body: { code: 'bad-request', message: "You can't change your own access." },
    });
    expect(await refusal(() => removeAccess(access(t), headersOf(ada.cookie), ada.id, 'no-such-account'))).toEqual({
      status: 404,
      body: NOT_FOUND,
    });
    expect(await refusal(() => removeAccess(access(t), headersOf(tom), ada.id, beaId))).toEqual({
      status: 403,
      body: NOT_ADMIN,
    });
    expect(await refusal(() => restoreAccess(access(t), new Headers(), ada.id, beaId))).toEqual({
      status: 401,
      body: { code: 'auth-required', message: 'Sign in again.' },
    });
    expect(adminApiError(new Error('boom'))).toBeUndefined();
    // Nothing was changed by a refused call.
    expect(await accountRow(t, BEA)).toMatchObject({ banned: false });
  });

  it('test_active_admin_count', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    await signInAdmin(t, BEA);
    await signInWeb(t.app, t.outbox, TOM);
    expect(await activeAdminCount(t.deps.db.db)).toBe(2);

    await removeAccess(access(t), headersOf(ada.cookie), ada.id, await userId(t, BEA));
    expect(await activeAdminCount(t.deps.db.db)).toBe(1);
  });

  it('test_find_account', async () => {
    const t = await adminApp();
    const ada = await signInAdmin(t, ADA);
    await signInWeb(t.app, t.outbox, TOM);
    const tom = await userId(t, TOM);
    const db = t.deps.db.db;

    expect(await findAccount(db, ada.id)).toEqual({ role: 'admin', banned: false });
    await setRole(t, TOM, null);
    expect(await findAccount(db, tom)).toEqual({ role: null, banned: false });
    await removeAccess(access(t), headersOf(ada.cookie), ada.id, tom);
    expect(await findAccount(db, tom)).toEqual({ role: null, banned: true });
    expect(await findAccount(db, 'no-such-account')).toBeUndefined();
  });
});

describe('privacy', () => {
  it('test_access_logs_hold_no_address', () => {
    expect(everyLine.some((line) => line.includes('"admin.access_removed"'))).toBe(true);
    expect(everyLine.some((line) => line.includes('"admin.access_restored"'))).toBe(true);
    // `err_stack` holds file paths, whose package directories have an `@` (`hono@4.13.13`): it is checked for the
    // addresses themselves, and every other field for any `@`.
    expect(everyLine.filter((line) => [ADA, BEA, TOM].some((address) => line.includes(address)))).toEqual([]);
    const withoutStacks = everyLine.map((line) => {
      const { err_stack: _stack, ...fields } = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify(fields);
    });
    expect(withoutStacks.filter((line) => line.includes('@'))).toEqual([]);
  });
});
