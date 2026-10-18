import { randomUUID } from 'node:crypto';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_EXPORT_PATH,
  type AccountExport,
  AccountExportSchema,
  formatHlc,
  type TokenResponse,
} from '@unalgorithm/protocol';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE_FRESH_MS } from '../src/account/data.ts';
import { requireDevice } from '../src/auth/bearer.ts';
import { revokeDevice } from '../src/auth/tokens.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { type BillingProvider, noopBilling } from '../src/billing/provider.ts';
import {
  account,
  authCodes,
  devices,
  jwks,
  passkey,
  refreshTokens,
  session,
  syncItems,
  syncPushes,
  usageEvents,
  user,
  userLimits,
  verification,
} from '../src/db/schema.ts';
import { ensureUserSpace } from '../src/sync/spaces.ts';
import { scanAllTables } from './support/scan-tables.ts';
import {
  DEV_EXTENSION_ID,
  FIREFOX_EXTENSION_ORIGIN,
  postJson,
  postToken,
  SEND_CODE,
  sessionOf,
  signInDevice,
  signInWeb,
} from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const ANA = 'ana@example.com';
const WINDOWS = 'Chrome on Windows';
const LINUX = 'Chrome on Linux';
/** A test-only route behind `requireDevice`, as CL1-10's tests mount it: whether a device's access token still works. */
const ME = '/v1/test/me';
/** Starting a passkey registration on the account page (CL3-14): stores a challenge holding the user's id. */
const REGISTER_OPTIONS = '/api/auth/passkey/generate-register-options';
const ATTACHMENT = 'attachment; filename="account-export.json"';
const EXPORT_ON_PAGE = { code: 'permission', message: 'Download your data on the account page.' };
const DELETE_ON_PAGE = { code: 'permission', message: 'Delete your account on the account page.' };
const SIGN_IN_AGAIN = { code: 'auth-required', message: 'Sign in again to delete your account.' };
const MISMATCH = { code: 'bad-request', message: 'The address you typed does not match this account.' };
const UNKNOWN = { code: 'unknown', message: 'Something went wrong on the server.' };
const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to Test server again.' };
/** The operator's cost of each seeded usage row: distinctive, so a search of the export finds it if it leaked. */
const COST_MICROS = 9_876_543;
/** A raw `User-Agent` header longer than the export's cap of 500. */
const LONG_USER_AGENT = `Mozilla/5.0 ${'x'.repeat(588)}`;
/** A 250-character passkey name, longer than the export's cap of 200: the plugin stores whatever name the page sent. */
const passkeyName = (label: string) => `${label}'s phone `.padEnd(250, 'x');
/** Two UTC days of usage: two requests on the first (at its first and last minute), one on the second. */
const DAY_ONE = '2026-10-01';
const DAY_TWO = '2026-10-02';
/** The usage `seedAccount` stores for one account, as the export groups it: by UTC day and task; counts, never cost. */
const SEEDED_USAGE = [
  { day: DAY_ONE, task: 'classify', requests: 2, postsRequested: 10, postsOk: 8 },
  { day: DAY_TWO, task: 'classify', requests: 1, postsRequested: 2, postsOk: 2 },
];

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server for Tom and Ana with `GET /v1/test/me` behind `requireDevice`, mounted before the first request. */
async function dataApp(options: Omit<TestAppOptions, 'config'> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${TOM},${ANA}` }), ...options });
  t.app.get(ME, requireDevice(t.deps), (c) => c.json(c.var.account));
  cleanup.push(() => t.close());
  return t;
}

/** A billing provider that is the no-op one plus these members. */
const billingWith = (members: Pick<BillingProvider, 'exportAccount' | 'deleteAccount'>): BillingProvider => ({
  ...noopBilling,
  ...members,
});

const bearer = (tokens: TokenResponse) => ({ Authorization: `Bearer ${tokens.access_token}` });
/** A request from the account page: the session cookie and the server's own origin. */
const page = (cookie: string) => ({ Cookie: cookie, Origin: TEST_PUBLIC_URL });

const exportWith = (t: TestApp, headers: Record<string, string>) => t.app.request(ACCOUNT_EXPORT_PATH, { headers });
const deleteWith = (t: TestApp, confirm: unknown, headers: Record<string, string>) =>
  postJson(t.app, ACCOUNT_DELETE_PATH, { confirm }, headers);

/** The export a request downloads, after checking its status, headers and that the contract parses it unchanged. */
async function exported(t: TestApp, cookie: string): Promise<{ text: string; body: AccountExport }> {
  const res = await exportWith(t, { Cookie: cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-disposition')).toBe(ATTACHMENT);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const text = await res.text();
  const body = AccountExportSchema.parse(JSON.parse(text));
  expect(body).toEqual(JSON.parse(text));
  return { text, body };
}

/** A delete that must succeed. */
async function deleted(t: TestApp, confirm: string, cookie: string) {
  const res = await deleteWith(t, confirm, page(cookie));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({ ok: true });
}

const me = (t: TestApp, tokens: TokenResponse) => t.app.request(ME, { headers: bearer(tokens) });
const refresh = (t: TestApp, tokens: TokenResponse) =>
  postToken(t.app, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: DEV_EXTENSION_ID });

async function userIdOf(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No such account.');
  return row.id;
}

/** Every row of every table, parsed. */
async function allRows(t: TestApp): Promise<Map<string, Record<string, unknown>[]>> {
  const scanned = await scanAllTables(t.deps.db);
  return new Map([...scanned].map(([table, json]) => [table, JSON.parse(json) as Record<string, unknown>[]]));
}

/** The rows of each table whose JSON holds any of `needles`, by table (tables without one left out). */
function rowsHolding(tables: Map<string, Record<string, unknown>[]>, needles: string[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [table, rows] of tables) {
    const matching = rows.map((row) => JSON.stringify(row)).filter((json) => needles.some((n) => json.includes(n)));
    if (matching.length > 0) found[table] = matching.sort();
  }
  return found;
}

/** The one session `seedAccount` leaves the account, as the export shows it: its 600-character user agent cut to 500. */
async function exportedSession(t: TestApp, userId: string): Promise<AccountExport['sessions'][number]> {
  const rows = await t.deps.db.db.select().from(session).where(eq(session.userId, userId));
  expect(rows.map((s) => s.userAgent)).toEqual([LONG_USER_AGENT]);
  const [row] = rows;
  if (!row) throw new Error('No session.');
  return {
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: LONG_USER_AGENT.slice(0, 500),
  };
}

/** How many rows each table has. */
async function rowCounts(t: TestApp): Promise<Record<string, number>> {
  return Object.fromEntries([...(await allRows(t))].map(([table, rows]) => [table, rows.length]));
}

interface Seeded {
  userId: string;
  /** Signed in as the extension does; still active. */
  windows: TokenResponse;
  /** Signed in, then revoked by the person. */
  linux: TokenResponse;
  /** The account page's web session: the only session of the account. */
  cookie: string;
  spaceId: string;
  /** The keys of the account's three sync items, the last one a tombstone. */
  keys: [string, string, string];
}

/**
 * An account with everything the server can hold about it: two devices (one revoked) with their codes and refresh
 * tokens, one web session with a 600-character user agent, a linked Google account, a passkey with a 250-character
 * name, usage on two UTC days, its own daily cap, and a sync space with two live items and a tombstone and one push
 * record. Device and session rows come from the real sign-in routes; the rest is inserted directly.
 */
async function seedAccount(t: TestApp, email: string): Promise<Seeded> {
  const db = t.deps.db.db;
  const windows = await signInDevice(t.app, t.outbox, email, DEV_EXTENSION_ID, WINDOWS);
  const linux = await signInDevice(t.app, t.outbox, email, DEV_EXTENSION_ID, LINUX);
  const userId = await userIdOf(t, email);
  await revokeDevice(db, linux.device_id, 'revoked-by-user');
  // The sessions the extension's two sign-ins started on the sign-in page; then the account page's own, as the
  // browser that sent the long header would have started it.
  await db.delete(session).where(eq(session.userId, userId));
  const cookie = await signInWeb(t.app, t.outbox, email);
  await db.update(session).set({ userAgent: LONG_USER_AGENT }).where(eq(session.userId, userId));

  const now = new Date();
  const label = email.slice(0, email.indexOf('@'));
  await db.insert(account).values({
    id: randomUUID(),
    accountId: `google-sub-${randomUUID()}`,
    providerId: 'google',
    userId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(passkey).values({
    id: randomUUID(),
    name: passkeyName(label),
    publicKey: `public-key-${randomUUID()}`,
    userId,
    credentialID: `credential-${randomUUID()}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    createdAt: now,
  });
  const usage = (createdAt: string, postsRequested: number, postsOk: number) => ({
    requestId: randomUUID(),
    userId,
    deviceId: windows.device_id,
    task: 'classify',
    model: 'mock-model',
    outcome: postsOk === postsRequested ? 'ok' : 'partial',
    postsRequested,
    postsOk,
    calls: 1,
    failedCalls: 0,
    uncachedInput: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 20,
    webSearches: 0,
    estimated: false,
    costMicros: COST_MICROS,
    chargeableCostMicros: COST_MICROS,
    createdAt: new Date(createdAt),
  });
  await db
    .insert(usageEvents)
    .values([
      usage(`${DAY_ONE}T00:00:00.000Z`, 6, 5),
      usage(`${DAY_ONE}T23:59:59.000Z`, 4, 3),
      usage(`${DAY_TWO}T00:00:00.000Z`, 2, 2),
    ]);
  await db.insert(userLimits).values({ userId, dailyPostCap: 500 });

  const space = await ensureUserSpace(db, userId);
  const keys: [string, string, string] = [`${label}.theme`, `${label}.rule`, `${label}.removed`];
  const hlc = (n: number) => formatHlc({ ms: now.getTime() - 60_000 + n, counter: 0, device: windows.device_id });
  const item = (n: number, value: unknown) => ({
    spaceId: space.id,
    collection: 'settings',
    key: keys[n] ?? '',
    value: value ?? null,
    deleted: value === undefined,
    hlc: hlc(n),
    deviceId: windows.device_id,
    seq: n + 1,
    bytes: 40,
  });
  await db.insert(syncItems).values([item(0, { mode: 'dark' }), item(1, ['always', `${label} Example`]), item(2, undefined)]);
  await db.insert(syncPushes).values({
    spaceId: space.id,
    pushId: randomUUID(),
    deviceId: windows.device_id,
    response: { results: [{ key: keys[0], status: 'applied', seq: 1 }] },
  });
  return { userId, windows, linux, cookie, spaceId: space.id, keys };
}

describe('export', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_export_includes_everything_about_the_account', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const db = t.deps.db.db;
    const before = Date.now();

    const { body } = await exported(t, tom.cookie);

    expect(Date.parse(body.exportedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(body.v).toBe(1);
    expect(body.server).toEqual({ name: 'Test server', origin: TEST_PUBLIC_URL, version: t.deps.config.version });
    const [userRow] = await db.select().from(user).where(eq(user.id, tom.userId));
    expect(body.account).toEqual({ email: TOM, createdAt: userRow?.createdAt.toISOString(), linkedProviders: ['google'] });

    // Both devices, the revoked one with its reason.
    const deviceRows = await db.select().from(devices).where(eq(devices.userId, tom.userId)).orderBy(asc(devices.createdAt));
    expect(body.devices).toEqual(
      deviceRows.map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
        revokedAt: d.revokedAt?.toISOString() ?? null,
        revokedReason: d.revokedReason,
      })),
    );
    expect(body.devices.map((d) => [d.id, d.name, d.revokedReason])).toEqual([
      [tom.windows.device_id, WINDOWS, null],
      [tom.linux.device_id, LINUX, 'revoked-by-user'],
    ]);
    expect(body.devices[1]?.revokedAt).toEqual(expect.any(String));

    // The passkey, its 250-character name cut to the contract's 200.
    const [key] = await db.select().from(passkey).where(eq(passkey.userId, tom.userId));
    expect(key?.name).toHaveLength(250);
    expect(body.passkeys).toEqual([
      {
        name: passkeyName('tom').slice(0, 200),
        createdAt: key?.createdAt?.toISOString(),
        deviceType: 'multiDevice',
        backedUp: true,
      },
    ]);

    // The one session, its 600-character user agent cut to the contract's 500.
    expect(LONG_USER_AGENT).toHaveLength(600);
    expect(body.sessions).toEqual([await exportedSession(t, tom.userId)]);

    // Grouped by UTC day and task; counts, never cost.
    expect(body.usage).toEqual(SEEDED_USAGE);

    // The three items, the tombstone without a value.
    const itemRows = await db.select().from(syncItems).where(eq(syncItems.spaceId, tom.spaceId));
    const updatedAt = (k: string) => itemRows.find((r) => r.key === k)?.updatedAt.toISOString();
    const hlc = (k: string) => itemRows.find((r) => r.key === k)?.hlc;
    const [theme, rule, removed] = tom.keys;
    expect(body.sync).toEqual({
      spaces: [
        {
          id: tom.spaceId,
          kind: 'user',
          items: [
            { collection: 'settings', key: removed, deleted: true, hlc: hlc(removed), updatedAt: updatedAt(removed) },
            {
              collection: 'settings',
              key: rule,
              deleted: false,
              value: ['always', 'tom Example'],
              hlc: hlc(rule),
              updatedAt: updatedAt(rule),
            },
            {
              collection: 'settings',
              key: theme,
              deleted: false,
              value: { mode: 'dark' },
              hlc: hlc(theme),
              updatedAt: updatedAt(theme),
            },
          ],
        },
      ],
    });
    expect(body.sync.spaces[0]?.items[0]).not.toHaveProperty('value');

    // The no-op provider has nothing to report.
    expect(body.billing).toBeNull();
  });

  it('test_export_holds_no_secrets', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const db = t.deps.db.db;
    // An unused sign-in code and an unfinished passkey registration, both stored in `verification`.
    expect((await postJson(t.app, SEND_CODE, { email: TOM, type: 'sign-in' }, page(tom.cookie))).status).toBe(200);
    expect((await t.app.request(REGISTER_OPTIONS, { headers: { Cookie: tom.cookie } })).status).toBe(200);

    const { text } = await exported(t, tom.cookie);

    const secrets: [string, string][] = [];
    const add = (what: string, value: string | null | undefined) => {
      if (!value) throw new Error(`Nothing stored for ${what}.`);
      secrets.push([what, value]);
    };
    for (const tokens of [tom.windows, tom.linux]) {
      add('access token', tokens.access_token);
      add('refresh token', tokens.refresh_token);
    }
    const deviceIds = [tom.windows.device_id, tom.linux.device_id];
    for (const id of deviceIds) {
      for (const row of await db.select().from(refreshTokens).where(eq(refreshTokens.deviceId, id))) {
        add('refresh token hash', row.tokenHash);
      }
    }
    for (const row of await db.select().from(authCodes).where(eq(authCodes.userId, tom.userId))) add('code hash', row.codeHash);
    for (const row of await db.select().from(jwks)) {
      add('JWKS public key', row.publicKey);
      add('JWKS private key', row.privateKey);
    }
    for (const row of await db.select().from(passkey).where(eq(passkey.userId, tom.userId))) {
      add('passkey public key', row.publicKey);
      add('credential id', row.credentialID);
    }
    for (const row of await db.select().from(session).where(eq(session.userId, tom.userId))) add('session token', row.token);
    for (const row of await db.select().from(account).where(eq(account.userId, tom.userId))) add('Google subject', row.accountId);
    const otp = await db
      .select()
      .from(verification)
      .where(eq(verification.identifier, `sign-in-otp-${TOM}`));
    expect(otp).toHaveLength(1);
    add('OTP value', otp[0]?.value);
    add('OTP hash', otp[0]?.value.slice(0, otp[0].value.lastIndexOf(':')));
    const challenges = (await db.select().from(verification)).filter((row) => row.value.includes('"registration"'));
    expect(challenges).toHaveLength(1);
    add('passkey challenge', (JSON.parse(challenges[0]?.value ?? '{}') as { expectedChallenge?: string }).expectedChallenge);
    add('cost_micros', String(COST_MICROS));

    for (const [what, value] of secrets) expect(text.includes(value), what).toBe(false);
  });

  it('test_export_includes_billing_module_data', async () => {
    const exportAccount = vi.fn(async () => ({ balanceMicros: 970000 }));
    const t = await dataApp({ billing: billingWith({ exportAccount }) });
    const tom = await seedAccount(t, TOM);

    const { body } = await exported(t, tom.cookie);
    expect(body.billing).toEqual({ balanceMicros: 970000 });
    expect(exportAccount.mock.calls).toEqual([[tom.userId]]);

    // The no-op provider implements no export: null.
    const plain = await dataApp();
    const cookie = await signInWeb(plain.app, plain.outbox, TOM);
    expect((await exported(plain, cookie)).body.billing).toBeNull();
  });

  it('test_export_session_only_and_isolation', async () => {
    const t = await dataApp();
    const db = t.deps.db.db;
    const tom = await seedAccount(t, TOM);
    const ana = await seedAccount(t, ANA);
    // Ana signs in by email only: Tom's Google account is the only linked one.
    await db.delete(account).where(eq(account.userId, ana.userId));

    // A device token, even with the page's origin and the session cookie beside it, never downloads the account.
    for (const headers of [bearer(tom.windows), { ...bearer(tom.windows), ...page(tom.cookie) }]) {
      const res = await exportWith(t, headers);
      expect(res.status).toBe(403);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(await res.json()).toEqual(EXPORT_ON_PAGE);
    }
    // Without a credential: 401.
    const none = await exportWith(t, {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual(AUTH_REQUIRED);

    // Ana's session downloads Ana's account, and nothing of Tom's: not his providers, devices, passkey, session (its IP
    // address and user agent), usage or sync items.
    const { text, body } = await exported(t, ana.cookie);
    const [anaUser] = await db.select().from(user).where(eq(user.id, ana.userId));
    expect(body.account).toEqual({ email: ANA, createdAt: anaUser?.createdAt.toISOString(), linkedProviders: [] });
    expect(body.devices.map((d) => d.id)).toEqual([ana.windows.device_id, ana.linux.device_id]);
    expect(body.passkeys.map((p) => p.name)).toEqual([passkeyName('ana').slice(0, 200)]);
    expect(body.sessions).toEqual([await exportedSession(t, ana.userId)]);
    expect(body.usage).toEqual(SEEDED_USAGE);
    expect(body.sync.spaces.map((s) => s.id)).toEqual([ana.spaceId]);
    for (const value of [TOM, tom.userId, tom.windows.device_id, tom.linux.device_id, "tom's phone", tom.spaceId, ...tom.keys]) {
      expect(text).not.toContain(value);
    }
    // And Tom's his own.
    expect((await exported(t, tom.cookie)).body.account.email).toBe(TOM);
  });
});

describe('delete', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_delete_guards', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const counts = await rowCounts(t);

    // A device token: refused, whatever else comes with it.
    for (const headers of [bearer(tom.windows), { ...bearer(tom.windows), ...page(tom.cookie) }]) {
      const res = await deleteWith(t, TOM, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(DELETE_ON_PAGE);
    }

    // A wrong address from a fresh session.
    for (const confirm of ['ana@example.com', 'tom@example.co', 'tom']) {
      const res = await deleteWith(t, confirm, page(tom.cookie));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(MISMATCH);
    }

    // A session older than ten minutes, even with the right address.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DELETE_FRESH_MS + 1000);
    const stale = await deleteWith(t, TOM, page(tom.cookie));
    expect(stale.status).toBe(401);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect(await stale.json()).toEqual(SIGN_IN_AGAIN);
    vi.useRealTimers();

    // Nothing was deleted: every table holds as many rows as before, and the account still works.
    expect(await rowCounts(t)).toEqual(counts);
    expect((await sessionOf(t.app, tom.cookie))?.user?.email).toBe(TOM);
    expect((await me(t, tom.windows)).status).toBe(200);
  });

  it('test_delete_cascades_everywhere', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const ana = await seedAccount(t, ANA);
    // Codes keyed by the address: an unused sign-in code, and the reset and verification codes the mounted route also
    // stores for an existing account (it sends none of them); and an unfinished passkey registration, keyed by a random
    // token, whose value holds the user's id.
    for (const type of ['sign-in', 'forget-password', 'email-verification']) {
      expect((await postJson(t.app, SEND_CODE, { email: TOM, type }, page(tom.cookie))).status).toBe(200);
    }
    expect((await t.app.request(REGISTER_OPTIONS, { headers: { Cookie: tom.cookie } })).status).toBe(200);
    // Ana's own unused sign-in code and unfinished passkey registration, which must outlast Tom's deletion.
    expect((await postJson(t.app, SEND_CODE, { email: ANA, type: 'sign-in' }, page(ana.cookie))).status).toBe(200);
    expect((await t.app.request(REGISTER_OPTIONS, { headers: { Cookie: ana.cookie } })).status).toBe(200);

    const tomIs = [tom.userId, TOM];
    const anaIs = [ana.userId, ANA];
    const before = await allRows(t);
    const tomsRows = rowsHolding(before, tomIs);
    // Every kind of row the account has was there to delete.
    expect(Object.keys(tomsRows).sort()).toEqual(
      [
        'account',
        'auth_codes',
        'devices',
        'passkey',
        'session',
        'sync_spaces',
        'usage_events',
        'user',
        'user_limits',
        'verification',
      ].map((table) => `public.${table}`),
    );
    const identifiers = tomsRows['public.verification']?.map((row) => JSON.parse(row).identifier as string) ?? [];
    expect(identifiers).toHaveLength(4);
    expect(identifiers.filter((id) => id.endsWith(`-otp-${TOM}`)).sort()).toEqual([
      `email-verification-otp-${TOM}`,
      `forget-password-otp-${TOM}`,
      `sign-in-otp-${TOM}`,
    ]);
    const anasRows = rowsHolding(before, anaIs);
    expect(anasRows['public.verification']).toHaveLength(2);

    await deleted(t, TOM.toUpperCase(), tom.cookie);

    const after = await allRows(t);
    // Neither Tom's id nor his address is anywhere, and his space's items, push records and refresh tokens are gone.
    expect(rowsHolding(after, tomIs)).toEqual({});
    expect(rowsHolding(after, [tom.spaceId, tom.windows.device_id, tom.linux.device_id, ...tom.keys])).toEqual({});
    expect(after.get('public.sync_items')).toHaveLength(3);
    expect(after.get('public.sync_pushes')).toHaveLength(1);
    expect(after.get('public.refresh_tokens')).toHaveLength(2);
    // Only Tom's four `verification` rows went; every row of Ana's, her code and challenge too, is still there, unchanged.
    expect(after.get('public.verification')).toHaveLength((before.get('public.verification')?.length ?? 0) - 4);
    expect(rowsHolding(after, anaIs)).toEqual(anasRows);
    expect((await me(t, ana.windows)).status).toBe(200);
  });

  it('test_delete_revokes_every_device', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const laptop = await signInDevice(t.app, t.outbox, TOM, DEV_EXTENSION_ID, 'My laptop');
    for (const tokens of [tom.windows, laptop]) expect((await me(t, tokens)).status).toBe(200);

    await deleted(t, TOM, tom.cookie);

    // Every former device: its access token and its refresh token refused; the web session gone.
    for (const tokens of [tom.windows, tom.linux, laptop]) {
      const access = await me(t, tokens);
      expect(access.status).toBe(401);
      expect(await access.json()).toEqual(AUTH_REQUIRED);
      const refused = await refresh(t, tokens);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual(AUTH_REQUIRED);
    }
    expect(await sessionOf(t.app, tom.cookie)).toBeNull();
  });

  it('test_delete_respects_billing_module', async () => {
    // A module that must keep this account's records refuses: nothing is deleted.
    const refuse = vi.fn(async () => {
      throw new Error('records to keep');
    });
    const refused = await dataApp({ billing: billingWith({ deleteAccount: refuse }) });
    const tom = await seedAccount(refused, TOM);
    const counts = await rowCounts(refused);
    const res = await deleteWith(refused, TOM, page(tom.cookie));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(UNKNOWN);
    expect(refuse.mock.calls).toEqual([[tom.userId]]);
    expect(await rowCounts(refused)).toEqual(counts);
    expect((await me(refused, tom.windows)).status).toBe(200);
    expect(refused.events().filter((e) => e.event === 'account.deleted')).toEqual([]);

    // A module that agrees is asked once, while the account is still there.
    let t: TestApp | undefined;
    const present: boolean[] = [];
    const agree = vi.fn(async (id: string) => {
      if (!t) throw new Error('No app yet.');
      present.push((await t.deps.db.db.select().from(user).where(eq(user.id, id))).length === 1);
    });
    t = await dataApp({ billing: billingWith({ deleteAccount: agree }) });
    const ana = await seedAccount(t, ANA);
    await deleted(t, ANA, ana.cookie);
    expect(agree.mock.calls).toEqual([[ana.userId]]);
    expect(present).toEqual([true]);
    expect(await t.deps.db.db.select().from(user).where(eq(user.id, ana.userId))).toEqual([]);
  });

  it('test_delete_needs_own_origin', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    const counts = await rowCounts(t);

    const elsewhere: Record<string, string>[] = [
      { Cookie: tom.cookie },
      { Cookie: tom.cookie, Origin: 'https://evil.example' },
      { Cookie: tom.cookie, Origin: `chrome-extension://${DEV_EXTENSION_ID}` },
      { Cookie: tom.cookie, Origin: FIREFOX_EXTENSION_ORIGIN },
    ];
    for (const headers of elsewhere) {
      const res = await deleteWith(t, TOM, headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(REFUSED);
    }

    expect(await rowCounts(t)).toEqual(counts);
    expect((await sessionOf(t.app, tom.cookie))?.user?.email).toBe(TOM);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_account_data_logs_no_identity', async () => {
    const t = await dataApp();
    const tom = await seedAccount(t, TOM);
    // Every outcome once: exported, export refused to a device, delete refused to a device, for another page, for the
    // address and for a stale session, then deleted.
    await exported(t, tom.cookie);
    expect((await exportWith(t, bearer(tom.windows))).status).toBe(403);
    expect((await deleteWith(t, TOM, bearer(tom.windows))).status).toBe(403);
    expect((await deleteWith(t, TOM, { Cookie: tom.cookie })).status).toBe(403);
    expect((await deleteWith(t, ANA, page(tom.cookie))).status).toBe(400);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DELETE_FRESH_MS + 1000);
    expect((await deleteWith(t, TOM, page(tom.cookie))).status).toBe(401);
    vi.useRealTimers();
    await deleted(t, TOM, tom.cookie);

    const exportedLines = t.events().filter((e) => e.event === 'account.exported');
    expect(exportedLines.map((e) => [e.level, e.via])).toEqual([['info', 'session']]);
    expect(Object.keys(exportedLines[0] ?? {}).sort()).toEqual(['event', 'level', 'rid', 't', 'via']);
    const deletedLines = t.events().filter((e) => e.event === 'account.deleted');
    expect(deletedLines.map((e) => e.level)).toEqual(['info']);
    expect(Object.keys(deletedLines[0] ?? {}).sort()).toEqual(['event', 'level', 'rid', 't']);

    // No line holds the address or the account's id.
    for (const line of t.lines) {
      expect(line).not.toContain(TOM);
      expect(line).not.toContain(tom.userId);
    }
  });
});
