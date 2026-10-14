import { readFileSync } from 'node:fs';
import { SERVER_INFO_PATH, ServerInfoSchema } from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthRoute, authRoutesFor } from '../src/auth/better-auth.ts';
import { passkey, session, user } from '../src/db/schema.ts';
import { createTestDb, queryRows } from './support/db.ts';
import { GOOGLE_ENV } from './support/google-stub.ts';
import { cookieHeader, postJson, sessionCookie, sessionOf, signInWeb } from './support/sign-in.ts';
import {
  type AuthenticationOptionsJSON,
  type RegistrationOptionsJSON,
  type SoftAuthenticator,
  softAuthenticator,
} from './support/soft-authenticator.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const REGISTER_OPTIONS = '/api/auth/passkey/generate-register-options';
const VERIFY_REGISTRATION = '/api/auth/passkey/verify-registration';
const AUTHENTICATE_OPTIONS = '/api/auth/passkey/generate-authenticate-options';
const VERIFY_AUTHENTICATION = '/api/auth/passkey/verify-authentication';
const LIST_PASSKEYS = '/api/auth/passkey/list-user-passkeys';
const DELETE_PASSKEY = '/api/auth/passkey/delete-passkey';
const UPDATE_PASSKEY = '/api/auth/passkey/update-passkey';
/** The six passkey routes the sign-in and account pages use, mounted on every server. */
const PASSKEY_ROUTES: AuthRoute[] = [
  ['GET', REGISTER_OPTIONS],
  ['POST', VERIFY_REGISTRATION],
  ['GET', AUTHENTICATE_OPTIONS],
  ['POST', VERIFY_AUTHENTICATION],
  ['GET', LIST_PASSKEYS],
  ['POST', DELETE_PASSKEY],
];

const ANN = 'ann@example.org';
const BOB = 'bob@example.org';
/** The test server's `PUBLIC_URL` host: the relying party id its passkeys are bound to. */
const RP_ID = '127.0.0.1';
/** Another site, whose page a phishing attempt would run the ceremony on. */
const EVIL = 'https://evil.example';
const NOT_FOUND = { code: 'bad-request', message: 'Not found.' };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file and every authenticator made here, for the log test (AC 11). */
const allLines: string[] = [];
const authenticators: SoftAuthenticator[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server whose allowlist holds Ann and Bob. */
async function passkeyApp() {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ANN},${BOB}` }) });
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

/**
 * A new credential on a software authenticator for this server's own page, or for `origin`; with `credentialId`, a new
 * key that claims that credential.
 */
function authenticator(options: { origin?: string; credentialId?: string } = {}): SoftAuthenticator {
  const created = softAuthenticator({ rpId: RP_ID, origin: TEST_PUBLIC_URL, ...options });
  authenticators.push(created);
  return created;
}

/** `Cookie` headers merged as a browser's jar holds them: a later cookie replaces an earlier one of the same name. */
function jar(...headers: string[]): string {
  const cookies = new Map<string, string>();
  for (const header of headers) {
    for (const c of header.split('; ')) if (c) cookies.set(c.slice(0, c.indexOf('=')), c);
  }
  return [...cookies.values()].join('; ');
}

/** A request from the server's own page: its origin and the browser's cookies. */
const page = (cookie: string) => ({ Origin: TEST_PUBLIC_URL, ...(cookie ? { Cookie: cookie } : {}) });
const get = (t: TestApp, path: string, cookie = '') => t.app.request(path, cookie ? { headers: { Cookie: cookie } } : {});

/**
 * The account page adding a passkey: the register options with the session, the authenticator's answer, then
 * `verify-registration` with the session and the challenge cookie. `body` adds fields (a `name`).
 */
async function register(t: TestApp, cookie: string, key: SoftAuthenticator, body: Record<string, unknown> = {}) {
  const options = await get(t, REGISTER_OPTIONS, cookie);
  if (options.status !== 200) throw new Error(`The register options answered ${options.status}.`);
  const response = key.register((await options.json()) as RegistrationOptionsJSON);
  return postJson(t.app, VERIFY_REGISTRATION, { response, ...body }, page(jar(cookie, cookieHeader(options))));
}

/**
 * The sign-in page signing in with a passkey: the authenticate options, the authenticator's answer (on the page at
 * `origin`, default the server's own), then verify.
 */
async function signInWithPasskey(t: TestApp, key: SoftAuthenticator, cookie = '', origin?: string) {
  const options = await get(t, AUTHENTICATE_OPTIONS, cookie);
  if (options.status !== 200) throw new Error(`The authenticate options answered ${options.status}.`);
  const response = key.authenticate((await options.json()) as AuthenticationOptionsJSON, { origin });
  return postJson(t.app, VERIFY_AUTHENTICATION, { response }, page(jar(cookie, cookieHeader(options))));
}

const userId = async (t: TestApp, email: string) =>
  (await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email)))[0]?.id ?? '';
const passkeysOf = (t: TestApp, id: string) => t.deps.db.db.select().from(passkey).where(eq(passkey.userId, id));
const allPasskeys = (t: TestApp) => t.deps.db.db.select().from(passkey);
const allUsers = (t: TestApp) => t.deps.db.db.select().from(user);
const allSessions = (t: TestApp) => t.deps.db.db.select().from(session);

describe('setup', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_passkey_package_pinned', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Exactly, and released in lockstep with the Better Auth it plugs into.
    expect(manifest.dependencies['@better-auth/passkey']).toBe('1.7.7');
    expect(manifest.dependencies['better-auth']).toBe('1.7.7');
  });

  it('test_passkey_table_cascades', async () => {
    const h = await createTestDb();
    cleanup.push(() => h.close());

    const columns = await queryRows(
      h,
      sql`select column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'passkey' order by ordinal_position`,
    );
    expect(columns.map((c) => `${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? ' null' : ''}`)).toEqual([
      'id text',
      'name text null',
      'public_key text',
      'user_id text',
      'credential_id text',
      'counter integer',
      'device_type text',
      'backed_up boolean',
      'transports text null',
      'created_at timestamp without time zone null',
      'aaguid text null',
    ]);

    const references = await queryRows(
      h,
      sql`select c.conname, c.confdeltype, a.attname as column_name, f.relname as references_table
          from pg_constraint c
          join pg_class t on t.oid = c.conrelid
          join pg_class f on f.oid = c.confrelid
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
          where c.contype = 'f' and t.relname = 'passkey'`,
    );
    // 'c': on delete cascade.
    expect(references).toEqual([expect.objectContaining({ column_name: 'user_id', references_table: 'user', confdeltype: 'c' })]);

    // Deleting the account (CL3-15) takes its passkeys with it.
    const now = new Date();
    await h.db.insert(user).values({ id: 'u1', name: '', email: ANN, emailVerified: true, createdAt: now, updatedAt: now });
    await h.db.insert(passkey).values({
      id: 'p1',
      userId: 'u1',
      publicKey: 'key',
      credentialID: 'credential',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    });
    expect(await h.db.select().from(passkey)).toHaveLength(1);
    await h.db.delete(user).where(eq(user.id, 'u1'));
    expect(await h.db.select().from(passkey)).toHaveLength(0);
  });

  it('test_discovery_lists_passkey', async () => {
    const t = await passkeyApp();
    const info = ServerInfoSchema.parse(await (await get(t, SERVER_INFO_PATH)).json());
    expect(info.auth.methods).toEqual(['email-otp', 'passkey']);

    // The same six routes on every server, whatever else it offers.
    for (const config of [t.deps.config, testConfig(GOOGLE_ENV)]) {
      const routes = authRoutesFor(config);
      expect(routes.filter(([, path]) => path.startsWith('/api/auth/passkey/'))).toEqual(PASSKEY_ROUTES);
    }
  });

  it('test_register_options_need_session', async () => {
    const t = await passkeyApp();
    const none = await get(t, REGISTER_OPTIONS);
    expect(none.status).toBe(401);
    expect(none.headers.getSetCookie()).toEqual([]);
    expect((await get(t, REGISTER_OPTIONS, 'better-auth.session_token=forged.value')).status).toBe(401);

    const cookie = await signInWeb(t.app, t.outbox, ANN);
    const res = await get(t, REGISTER_OPTIONS, cookie);
    expect(res.status).toBe(200);
    // The challenge is kept server-side under a signed cookie.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('better-auth.better-auth-passkey='))).toBe(true);
    const options = (await res.json()) as Record<string, unknown>;
    expect(options.rp).toEqual({ id: RP_ID, name: 'Test server' });
    // Discoverable credentials: the sign-in page signs in without asking for an address.
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'preferred' });
    expect(options.attestation).toBe('none');
    expect(options.challenge).toEqual(expect.any(String));
  });
});

describe('ceremonies', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_register_then_list_passkey', async () => {
    const t = await passkeyApp();
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    const ann = await userId(t, ANN);
    const key = authenticator();

    const res = await register(t, cookie, key, { name: 'Test key' });
    expect(res.status).toBe(200);
    // Registering signs nobody in: the page keeps the session it has.
    expect(sessionCookie(res)).toBe('');
    const rows = await passkeysOf(t, ann);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Test key',
      userId: ann,
      credentialID: key.credentialId,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'internal',
      aaguid: '00000000-0000-0000-0000-000000000000',
    });

    const list = await get(t, LIST_PASSKEYS, cookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([expect.objectContaining({ id: rows[0]?.id, name: 'Test key', userId: ann })]);
    expect((await get(t, LIST_PASSKEYS)).status).toBe(401);

    // Without a name, the label comes from the authenticator's AAGUID; the all-zero one names nothing.
    const second = authenticator();
    expect((await register(t, cookie, second)).status).toBe(200);
    const named = await passkeysOf(t, ann);
    expect(named.map((p) => [p.credentialID, p.name])).toEqual([
      [key.credentialId, 'Test key'],
      [second.credentialId, null],
    ]);

    // Only the fields the account page sends: registering never starts another session.
    const sessions = (await allSessions(t)).length;
    const extra = await register(t, cookie, authenticator(), { createSession: true });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(sessionCookie(extra)).toBe('');
    expect(await allSessions(t)).toHaveLength(sessions);
    expect(await passkeysOf(t, ann)).toHaveLength(2);
  });

  it('test_sign_in_with_passkey', async () => {
    const t = await passkeyApp();
    const key = authenticator();
    expect((await register(t, await signInWeb(t.app, t.outbox, ANN), key)).status).toBe(200);
    const ann = await userId(t, ANN);

    // No session and no address: the options name no credential, so the authenticator offers its own.
    const options = await get(t, AUTHENTICATE_OPTIONS);
    expect(options.status).toBe(200);
    const optionsJSON = (await options.json()) as Record<string, unknown>;
    expect(optionsJSON.rpId).toBe(RP_ID);
    expect(optionsJSON.allowCredentials).toBeUndefined();

    const res = await signInWithPasskey(t, key);
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe('');
    const signedIn = await sessionOf(t.app, cookie);
    expect(signedIn?.user).toMatchObject({ id: ann, email: ANN });

    // Again, from the session it started: the same account.
    const again = await signInWithPasskey(t, key, cookie);
    expect(again.status).toBe(200);
    expect((await sessionOf(t.app, sessionCookie(again)))?.user?.id).toBe(ann);
  });

  it('test_passkey_rejects_wrong_origin_and_key', async () => {
    const t = await passkeyApp();
    const cookie = await signInWeb(t.app, t.outbox, ANN);

    // Created on another site's page: refused, nothing stored. Better Auth answers 500 and logs the failure (without
    // its message), as it does for any registration that fails verification.
    const evil = await register(t, cookie, authenticator({ origin: EVIL }), { name: 'Evil' });
    expect(evil.ok).toBe(false);
    expect(await evil.json()).toMatchObject({ code: 'FAILED_TO_VERIFY_REGISTRATION' });
    expect(await allPasskeys(t)).toHaveLength(0);

    // A credential signed for with another key: refused, no session.
    const key = authenticator();
    expect((await register(t, cookie, key)).status).toBe(200);
    const sessions = (await allSessions(t)).length;
    const impostor = await signInWithPasskey(t, authenticator({ credentialId: key.credentialId }));
    expect(impostor.ok).toBe(false);
    expect(await impostor.json()).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(sessionCookie(impostor)).toBe('');
    expect(await allSessions(t)).toHaveLength(sessions);
    // Nor does the genuine key sign in from another site's page: the browser reports the origin it signed on.
    const elsewhere = await signInWithPasskey(t, key, '', EVIL);
    expect(elsewhere.ok).toBe(false);
    expect(sessionCookie(elsewhere)).toBe('');
    expect(await allSessions(t)).toHaveLength(sessions);
  });

  it('test_delete_passkey_owner_only', async () => {
    const t = await passkeyApp();
    const annCookie = await signInWeb(t.app, t.outbox, ANN);
    const bobCookie = await signInWeb(t.app, t.outbox, BOB);
    expect((await register(t, annCookie, authenticator())).status).toBe(200);
    const [row] = await passkeysOf(t, await userId(t, ANN));
    const id = row?.id ?? '';

    const bob = await postJson(t.app, DELETE_PASSKEY, { id }, page(bobCookie));
    expect(bob.ok).toBe(false);
    expect(await allPasskeys(t)).toHaveLength(1);
    const anonymous = await postJson(t.app, DELETE_PASSKEY, { id }, page(''));
    expect(anonymous.status).toBe(401);
    expect(await allPasskeys(t)).toHaveLength(1);

    const ann = await postJson(t.app, DELETE_PASSKEY, { id }, page(annCookie));
    expect(ann.status).toBe(200);
    expect(await allPasskeys(t)).toHaveLength(0);
    expect(await (await get(t, LIST_PASSKEYS, annCookie)).json()).toEqual([]);
  });

  it('test_passkey_never_creates_account', async () => {
    const t = await passkeyApp();
    const key = authenticator();

    // No session at all.
    const bare = await postJson(
      t.app,
      VERIFY_REGISTRATION,
      { response: key.register({ challenge: 'x', user: { id: 'y' } }) },
      page(''),
    );
    expect(bare.status).toBe(401);
    expect(await allUsers(t)).toHaveLength(0);

    // A challenge issued to Ann's session, brought back without that session.
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    const options = await get(t, REGISTER_OPTIONS, cookie);
    const challengeOnly = await postJson(
      t.app,
      VERIFY_REGISTRATION,
      { response: key.register((await options.json()) as RegistrationOptionsJSON) },
      page(cookieHeader(options)),
    );
    expect(challengeOnly.status).toBe(401);
    expect(sessionCookie(challengeOnly)).toBe('');

    // A passkey the server never registered signs nobody in.
    const unknown = await signInWithPasskey(t, key);
    expect(unknown.status).toBe(401);
    expect(sessionCookie(unknown)).toBe('');

    expect((await allUsers(t)).map((u) => u.email)).toEqual([ANN]);
    expect(await allPasskeys(t)).toHaveLength(0);
  });

  it('test_update_passkey_not_mounted', async () => {
    const t = await passkeyApp();
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    expect((await register(t, cookie, authenticator(), { name: 'Test key' })).status).toBe(200);
    const [row] = await allPasskeys(t);

    const res = await postJson(t.app, UPDATE_PASSKEY, { id: row?.id, name: 'Renamed' }, page(cookie));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect((await allPasskeys(t))[0]?.name).toBe('Test key');
    // Each mounted route answers its own method only.
    expect((await postJson(t.app, LIST_PASSKEYS, {}, page(cookie))).status).toBe(404);
    expect((await get(t, VERIFY_AUTHENTICATION)).status).toBe(404);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_passkey_logs_hold_no_identifiers', async () => {
    const consoleCalls = (['error', 'warn', 'info', 'log', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const t = await passkeyApp();
    // Each outcome once: options without a session, a registration with and without a name, a sign-in, another site's
    // registration and sign-in, another key, a stranger's delete and the owner's, a registration without a session.
    await get(t, REGISTER_OPTIONS);
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    const bobCookie = await signInWeb(t.app, t.outbox, BOB);
    const key = authenticator();
    await register(t, cookie, key, { name: 'Test key' });
    await register(t, cookie, authenticator());
    await signInWithPasskey(t, key);
    await register(t, cookie, authenticator({ origin: EVIL }));
    await signInWithPasskey(t, key, '', EVIL);
    await signInWithPasskey(t, authenticator({ credentialId: key.credentialId }));
    const [row] = await allPasskeys(t);
    await postJson(t.app, DELETE_PASSKEY, { id: row?.id }, page(bobCookie));
    await postJson(t.app, DELETE_PASSKEY, { id: row?.id }, page(cookie));
    await postJson(
      t.app,
      VERIFY_REGISTRATION,
      { response: authenticator().register({ challenge: 'x', user: { id: 'y' } }) },
      page(''),
    );
    for (const call of consoleCalls) expect(call).not.toHaveBeenCalled();

    // Better Auth logged the failed verifications, through `authLog`.
    expect(t.events().some((e) => e.event === 'auth.log')).toBe(true);
    // This test's lines and those of every earlier test in this file (AC 4 to 9).
    const lines = [...allLines, ...t.lines];
    for (const line of lines) {
      for (const email of [ANN, BOB]) expect(line).not.toContain(email);
      // The public key as Better Auth stores and lists it (base64), and as it travels in a response (base64url).
      for (const a of authenticators) {
        expect(line).not.toContain(a.credentialId);
        expect(line).not.toContain(a.publicKey.toString('base64'));
        expect(line).not.toContain(a.publicKey.toString('base64url'));
      }
    }
  });
});
