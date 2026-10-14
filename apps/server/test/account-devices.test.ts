import {
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  type AccountDevice,
  AccountDevicesResponseSchema,
  REVOKE_PATH,
  type TokenResponse,
} from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { requireDevice } from '../src/auth/bearer.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { devices } from '../src/db/schema.ts';
import { DEV_EXTENSION_ID, DEV_EXTENSION_ORIGIN, postJson, postToken, signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const WINDOWS = 'Chrome on Windows';
const LINUX = 'Chrome on Linux';
/** A test-only route behind `requireDevice`, as CL1-10's tests mount it: whether a device's access token still works. */
const ME = '/v1/test/me';
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };
/** The app's not-found body (CL1-06): also the answer for another account's device. */
const NOT_FOUND = { code: 'bad-request', message: 'Not found.' };
/** What every request that fails its schema answers (CL1-06). */
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };
const HOUR_MS = 3_600_000;

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server for Tom and Ana with `GET /v1/test/me` behind `requireDevice`, mounted before the first request. */
async function devicesApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${TOM},${ANA}` }) });
  t.app.get(ME, requireDevice(t.deps), (c) => c.json(c.var.account));
  cleanup.push(() => t.close());
  return t;
}

const bearer = (tokens: TokenResponse) => ({ Authorization: `Bearer ${tokens.access_token}` });
/** A request from the account page: the session cookie and the server's own origin. */
const page = (cookie: string) => ({ Cookie: cookie, Origin: TEST_PUBLIC_URL });

/** `GET /v1/account/devices` with these headers (an `Authorization`, a `Cookie`). */
const list = (t: TestApp, headers: Record<string, string> = {}) => t.app.request(ACCOUNT_DEVICES_PATH, { headers });

/** The devices a list request answers, after checking the answer's status, caching and shape. */
async function listed(t: TestApp, headers: Record<string, string>): Promise<AccountDevice[]> {
  const res = await list(t, headers);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = await res.json();
  expect(AccountDevicesResponseSchema.parse(body)).toEqual(body);
  return AccountDevicesResponseSchema.parse(body).devices;
}

/** `POST /v1/account/devices/revoke` for `deviceId` with these headers. */
const revoke = (t: TestApp, deviceId: unknown, headers: Record<string, string> = {}) =>
  postJson(t.app, ACCOUNT_DEVICE_REVOKE_PATH, { device_id: deviceId }, headers);

/** A revoke that must succeed. */
async function revoked(t: TestApp, deviceId: string, headers: Record<string, string>) {
  const res = await revoke(t, deviceId, headers);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ ok: true });
}

/** `GET /v1/test/me` with this device's access token. */
const me = (t: TestApp, tokens: TokenResponse) => t.app.request(ME, { headers: bearer(tokens) });

/** The refresh the extension makes with this device's refresh token. */
const refresh = (t: TestApp, tokens: TokenResponse) =>
  postToken(t.app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: DEV_EXTENSION_ID });

async function device(t: TestApp, id: string) {
  const [row] = await t.deps.db.db.select().from(devices).where(eq(devices.id, id));
  if (!row) throw new Error('No such device.');
  return row;
}

async function expectAuthRequired(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toBe('Bearer');
  expect(await res.json()).toEqual(AUTH_REQUIRED);
}

/** Tom's two named devices, signed in as the extension does, and his web session. */
async function tomsDevices(t: TestApp) {
  const windows = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, WINDOWS);
  const linux = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, LINUX);
  const cookie = await signInWeb(t.app, t.outbox, TOM);
  return { windows, linux, cookie };
}

describe('listing', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_devices_list_marks_current', async () => {
    const t = await devicesApp();
    const { windows, linux, cookie } = await tomsDevices(t);

    // The first device asks: it is the current one, and the most recently used (its request just used it).
    const fromWindows = await listed(t, bearer(windows));
    expect(fromWindows).toEqual([
      { id: windows.device_id, name: WINDOWS, createdAt: expect.any(String), lastUsedAt: expect.any(String), current: true },
      { id: linux.device_id, name: LINUX, createdAt: expect.any(String), lastUsedAt: null, current: false },
    ]);
    const stored = await device(t, windows.device_id);
    expect(fromWindows[0]?.createdAt).toBe(stored.createdAt.toISOString());
    expect(fromWindows[0]?.lastUsedAt).toBe(stored.lastUsedAt?.toISOString());

    // The web session is no device: none is current.
    const fromPage = await listed(t, { Cookie: cookie });
    expect(fromPage.map((d) => [d.id, d.current])).toEqual([
      [windows.device_id, false],
      [linux.device_id, false],
    ]);
    // The second device sees itself as the current one.
    const fromLinux = await listed(t, bearer(linux));
    expect(fromLinux.filter((d) => d.current).map((d) => d.id)).toEqual([linux.device_id]);
  });

  it('test_devices_list_order', async () => {
    const t = await devicesApp();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await signInDevice(t.app, t.outbox, TOM)).device_id);
    const [oldUnused, usedEarlier, usedLater, newUnused] = ids as [string, string, string, string];
    const now = Date.now();
    const set = (id: string, createdAt: number, lastUsedAt: number | null) =>
      t.deps.db.db
        .update(devices)
        .set({ createdAt: new Date(createdAt), lastUsedAt: lastUsedAt === null ? null : new Date(lastUsedAt) })
        .where(eq(devices.id, id));
    await set(oldUnused, now - 4 * HOUR_MS, null);
    await set(usedEarlier, now - 3 * HOUR_MS, now - 2 * HOUR_MS);
    await set(usedLater, now - 3 * HOUR_MS, now - HOUR_MS);
    await set(newUnused, now - HOUR_MS, null);

    // Listed from the web session, which uses no device: most recently used first, never-used ones last, newest first.
    const cookie = await signInWeb(t.app, t.outbox, TOM);
    const order = (await listed(t, { Cookie: cookie })).map((d) => d.id);
    expect(order).toEqual([usedLater, usedEarlier, newUnused, oldUnused]);
  });
});

describe('revoking', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_revoke_device_from_web_session', async () => {
    const t = await devicesApp();
    const { windows, linux, cookie } = await tomsDevices(t);
    expect((await me(t, linux)).status).toBe(200);

    await revoked(t, linux.device_id, page(cookie));

    // Its access token stops working at once, and its refresh token is spent.
    await expectAuthRequired(await me(t, linux));
    const refused = await refresh(t, linux);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(AUTH_REQUIRED);
    const row = await device(t, linux.device_id);
    expect(row.revokedReason).toBe('revoked-by-user');
    expect(row.revokedAt).not.toBeNull();
    // No longer listed; the other device keeps working.
    expect((await listed(t, { Cookie: cookie })).map((d) => d.id)).toEqual([windows.device_id]);
    expect((await me(t, windows)).status).toBe(200);
    expect((await refresh(t, windows)).status).toBe(200);
  });

  it('test_revoke_is_idempotent', async () => {
    const t = await devicesApp();
    const { linux, cookie } = await tomsDevices(t);

    await revoked(t, linux.device_id, page(cookie));
    const first = await device(t, linux.device_id);
    expect(first.revokedAt).not.toBeNull();

    await revoked(t, linux.device_id, page(cookie));
    const again = await device(t, linux.device_id);
    expect(again.revokedAt).toEqual(first.revokedAt);
    expect(again.revokedReason).toBe('revoked-by-user');
    // One line for the one revocation.
    expect(t.events().filter((e) => e.event === 'account.device_revoked')).toHaveLength(1);
  });

  it('test_device_can_revoke_itself', async () => {
    const t = await devicesApp();
    const { windows, linux } = await tomsDevices(t);

    // From the extension: a bearer token and the extension's own origin.
    await revoked(t, windows.device_id, { ...bearer(windows), Origin: DEV_EXTENSION_ORIGIN });

    await expectAuthRequired(await me(t, windows));
    await expectAuthRequired(await list(t, bearer(windows)));
    expect((await device(t, windows.device_id)).revokedReason).toBe('revoked-by-user');
    expect((await listed(t, bearer(linux))).map((d) => d.id)).toEqual([linux.device_id]);
  });

  it('test_revoke_device_already_signed_out_keeps_its_reason', async () => {
    const t = await devicesApp();
    const { linux, cookie } = await tomsDevices(t);
    // "Sign out" in the extension revoked it first.
    const signOut = { refresh_token: linux.refresh_token, client_id: DEV_EXTENSION_ID };
    expect((await postJson(t.app, REVOKE_PATH, signOut, { Origin: DEV_EXTENSION_ORIGIN })).status).toBe(200);

    await revoked(t, linux.device_id, page(cookie));
    expect((await device(t, linux.device_id)).revokedReason).toBe('sign-out');
  });
});

describe('guards', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_revoke_isolates_accounts', async () => {
    const t = await devicesApp();
    const { windows, linux } = await tomsDevices(t);
    const ana = await signInDevice(t.app, t.outbox, ANA, DEV_EXTENSION_ID, WINDOWS);
    const anaCookie = await signInWeb(t.app, t.outbox, ANA);

    // Ana's list holds her device only.
    for (const headers of [bearer(ana), { Cookie: anaCookie }]) {
      expect((await listed(t, headers)).map((d) => d.id)).toEqual([ana.device_id]);
    }

    // Tom's device ids answer exactly like an id no device has, with her cookie or her token.
    const unknown = await revoke(t, crypto.randomUUID(), page(anaCookie));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    expect(JSON.parse(unknownBody)).toEqual(NOT_FOUND);
    for (const headers of [page(anaCookie), bearer(ana)]) {
      for (const id of [windows.device_id, linux.device_id, crypto.randomUUID()]) {
        const res = await revoke(t, id, headers);
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.text()).toBe(unknownBody);
      }
    }

    // Tom's devices keep working and stay listed.
    for (const tokens of [windows, linux]) {
      expect((await me(t, tokens)).status).toBe(200);
      expect((await device(t, tokens.device_id)).revokedAt).toBeNull();
    }
    expect((await listed(t, bearer(windows))).map((d) => d.id).sort()).toEqual([windows.device_id, linux.device_id].sort());
    expect(t.events().filter((e) => e.event === 'account.device_revoked')).toHaveLength(0);
  });

  it('test_session_revoke_needs_own_origin', async () => {
    const t = await devicesApp();
    const { linux, cookie } = await tomsDevices(t);

    const elsewhere: Record<string, string>[] = [
      { Cookie: cookie },
      { Cookie: cookie, Origin: 'https://evil.example' },
      { Cookie: cookie, Origin: DEV_EXTENSION_ORIGIN },
    ];
    for (const headers of elsewhere) {
      const res = await revoke(t, linux.device_id, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
    }

    expect((await device(t, linux.device_id)).revokedAt).toBeNull();
    expect((await me(t, linux)).status).toBe(200);
  });

  it('test_revoke_validates_body_and_auth', async () => {
    const t = await devicesApp();
    const { windows, cookie } = await tomsDevices(t);

    // A device id that is not a uuid, or no body the schema accepts, from the page and from a device.
    for (const headers of [page(cookie), bearer(windows)]) {
      for (const body of [{ device_id: 'not-a-uuid' }, {}, { device_id: 42 }]) {
        const res = await postJson(t.app, ACCOUNT_DEVICE_REVOKE_PATH, body, headers);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual(NOT_VALID);
      }
    }

    // Without credentials both routes answer 401, before the body is read.
    await expectAuthRequired(await list(t));
    await expectAuthRequired(await revoke(t, windows.device_id));
    await expectAuthRequired(await revoke(t, 'not-a-uuid', { Origin: TEST_PUBLIC_URL }));
    await expectAuthRequired(await list(t, { Authorization: 'Bearer not-a-token', Cookie: cookie }));

    expect((await device(t, windows.device_id)).revokedAt).toBeNull();
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_device_routes_log_no_personal_data', async () => {
    const t = await devicesApp();
    // Every outcome once: listed with a token and the cookie, revoked from the page, again, by a device itself,
    // refused for another account, without the own origin, for its body and without credentials.
    const { windows, linux, cookie } = await tomsDevices(t);
    const ana = await signInDevice(t.app, t.outbox, ANA, DEV_EXTENSION_ID, LINUX);
    const third = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, 'My laptop');
    await listed(t, bearer(windows));
    await listed(t, { Cookie: cookie });
    await revoked(t, linux.device_id, page(cookie));
    await revoked(t, linux.device_id, page(cookie));
    await revoked(t, windows.device_id, bearer(windows));
    expect((await revoke(t, third.device_id, bearer(ana))).status).toBe(404);
    expect((await revoke(t, third.device_id, { Cookie: cookie })).status).toBe(403);
    expect((await revoke(t, 'not-a-uuid', bearer(third))).status).toBe(400);
    expect((await revoke(t, third.device_id)).status).toBe(401);

    // The revocation lines name the device by its id, and how the request came.
    const lines = t.events().filter((e) => e.event === 'account.device_revoked');
    expect(lines.map((e) => [e.level, e.device_id, e.via])).toEqual([
      ['info', linux.device_id, 'session'],
      ['info', windows.device_id, 'device'],
    ]);
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(['device_id', 'event', 'level', 'rid', 't', 'via']);

    // No line holds an address, a device's name, a token or the session cookie.
    const secrets = [TOM, ANA, WINDOWS, LINUX, 'My laptop'];
    for (const tokens of [windows, linux, ana, third]) secrets.push(tokens.access_token, tokens.refresh_token);
    secrets.push(...cookie.split('; ').map((c) => c.slice(c.indexOf('=') + 1)));
    for (const line of t.lines) for (const secret of secrets) expect(line).not.toContain(secret);
  });
});
