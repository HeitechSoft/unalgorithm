import { ACCOUNT_DELETE_PATH, MAX_INVITES } from '@unalgorithm/protocol';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addInvite, hasAccount, isInvited, listInvites, mayCreateAccount, removeInvite } from '../src/admin/invites.ts';
import { signupInvites, user } from '../src/db/schema.ts';
import { GOOGLE_ENV, type GoogleStub, signInWithGoogle, stubGoogle } from './support/google-stub.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { postJson, SEND_CODE, SIGN_IN, sentCode, sessionCookie, sessionOf, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ANN = 'ann@example.org';
const BOB = 'bob@example.org';
const STRANGER = 'stranger@example.com';
const PAGE = { Origin: TEST_PUBLIC_URL };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome; the fetch stub is put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
const stubs: GoogleStub[] = [];
afterEach(async () => {
  for (const stub of stubs.splice(0)) stub.restore();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A test server with an empty `SIGNUP_ALLOWLIST` unless `env` sets one. */
async function inviteApp(env: Record<string, string> = {}) {
  const t = await createTestApp({ config: testConfig(env) });
  cleanup.push(() => t.close());
  return t;
}

/** Stubs Google for this identity, after putting back the stub this test installed before. */
async function google(...args: Parameters<typeof stubGoogle>): Promise<GoogleStub> {
  stubs.pop()?.restore();
  const stub = await stubGoogle(...args);
  stubs.push(stub);
  return stub;
}

const allUsers = (t: TestApp) => t.deps.db.db.select().from(user);
const allInvites = (t: TestApp) => t.deps.db.db.select().from(signupInvites);
const mailTo = (t: TestApp, email: string) => t.outbox.filter((m) => m.to === email);

async function userIdOf(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No such account.');
  return row.id;
}

/** The `error` parameter of a redirect to the account page; fails when the redirect is anywhere else. */
function errorOf(res: Response): string | null {
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '', TEST_PUBLIC_URL);
  expect(location.origin).toBe(TEST_PUBLIC_URL);
  expect(location.pathname).toBe('/account');
  return location.searchParams.get('error');
}

describe('sign-up through an invite', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_invited_address_creates_account_and_uses_invite', async () => {
    const t = await inviteApp();
    expect(await addInvite(t.deps.db.db, ANN, null)).toEqual({ added: true });

    const cookie = await signInWeb(t.app, t.outbox, ANN);
    expect(mailTo(t, ANN)).toHaveLength(1);
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(ANN);
    expect((await allUsers(t)).map((u) => u.email)).toEqual([ANN]);
    expect(await allInvites(t)).toEqual([]);
  });

  it('test_uninvited_address_gets_same_answer_and_no_mail', async () => {
    const t = await inviteApp();
    await addInvite(t.deps.db.db, ANN, null);

    const invited = await postJson(t.app, SEND_CODE, { email: ANN, type: 'sign-in' }, PAGE);
    const stranger = await postJson(t.app, SEND_CODE, { email: STRANGER, type: 'sign-in' }, PAGE);
    expect(stranger.status).toBe(200);
    expect(stranger.status).toBe(invited.status);
    expect(await stranger.json()).toEqual(await invited.json());
    expect(mailTo(t, ANN)).toHaveLength(1);
    expect(mailTo(t, STRANGER)).toEqual([]);

    // A guessed code creates nothing either.
    const guess = await postJson(t.app, SIGN_IN, { email: STRANGER, otp: '123456' }, PAGE);
    expect(guess.status).not.toBe(200);
    expect(await allUsers(t)).toEqual([]);
  });

  it('test_removed_invite_stops_account_creation', async () => {
    const t = await inviteApp();
    await addInvite(t.deps.db.db, ANN, null);
    expect((await postJson(t.app, SEND_CODE, { email: ANN, type: 'sign-in' }, PAGE)).status).toBe(200);
    const otp = sentCode(t.outbox, ANN);

    expect(await removeInvite(t.deps.db.db, ANN)).toEqual({ removed: true });
    const res = await postJson(t.app, SIGN_IN, { email: ANN, otp }, PAGE);
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBe('');
    expect(await allUsers(t)).toEqual([]);
  });

  it('test_allowlist_still_works_without_invite', async () => {
    const t = await inviteApp({ SIGNUP_ALLOWLIST: ANN });
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(ANN);
    expect(await allInvites(t)).toEqual([]);
    const deps = { db: t.deps.db.db, config: t.deps.config };
    expect(await mayCreateAccount(deps, ' Ann@Example.ORG ')).toBe(true);
    expect(await mayCreateAccount(deps, BOB)).toBe(false);
    await addInvite(deps.db, BOB, null);
    expect(await mayCreateAccount(deps, BOB)).toBe(true);
  });
});

describe('sign-up through Google', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_invited_verified_google_address_creates_account', async () => {
    const t = await inviteApp(GOOGLE_ENV);
    await addInvite(t.deps.db.db, ANN, null);
    await google({ email: ANN, emailVerified: true });

    const res = await signInWithGoogle(t.app);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe('');
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(ANN);
    expect(await allInvites(t)).toEqual([]);
  });

  it('test_unverified_or_uninvited_google_address_signup_closed', async () => {
    const t = await inviteApp(GOOGLE_ENV);
    await addInvite(t.deps.db.db, ANN, null);

    // Invited, but Google has not verified the address: whoever holds that Google account may not be its owner.
    await google({ email: ANN, emailVerified: false });
    const unverified = await signInWithGoogle(t.app);
    expect(errorOf(unverified)).toBe('SIGNUP_CLOSED');
    expect(sessionCookie(unverified)).toBe('');
    expect(await allUsers(t)).toEqual([]);
    expect(await isInvited(t.deps.db.db, ANN)).toBe(true);

    // Verified, but neither invited nor allow-listed.
    await google({ email: STRANGER, emailVerified: true });
    const uninvited = await signInWithGoogle(t.app);
    expect(errorOf(uninvited)).toBe('SIGNUP_CLOSED');
    expect(sessionCookie(uninvited)).toBe('');
    expect(await allUsers(t)).toEqual([]);
  });
});

describe('invite store', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_add_invite_normalises_and_is_idempotent', async () => {
    const t = await inviteApp();
    const db = t.deps.db.db;
    expect(await addInvite(db, ' Ann@Example.ORG ', null)).toEqual({ added: true });
    expect((await allInvites(t)).map((i) => i.email)).toEqual([ANN]);
    expect(await isInvited(db, 'ANN@example.org')).toBe(true);

    expect(await addInvite(db, ANN, null)).toEqual({ added: false });
    expect(await allInvites(t)).toHaveLength(1);

    expect(await removeInvite(db, BOB)).toEqual({ removed: false });
    expect(await removeInvite(db, ' ANN@example.org')).toEqual({ removed: true });
    expect(await allInvites(t)).toEqual([]);
  });

  it('test_has_account_normalises', async () => {
    const t = await inviteApp({ SIGNUP_ALLOWLIST: ANN });
    await signInWeb(t.app, t.outbox, ANN);
    expect(await hasAccount(t.deps.db.db, ' Ann@Example.ORG ')).toBe(true);
    expect(await hasAccount(t.deps.db.db, BOB)).toBe(false);
  });

  it('test_list_invites_newest_first_and_bounded', async () => {
    const t = await inviteApp();
    const start = Date.parse('2026-10-01T00:00:00Z');
    const rows = Array.from({ length: MAX_INVITES + 1 }, (_, i) => ({
      email: `person${String(i).padStart(4, '0')}@example.org`,
      createdAt: new Date(start + i * 1000),
    }));
    await t.deps.db.db.insert(signupInvites).values(rows);

    const listed = await listInvites(t.deps.db.db);
    expect(listed).toHaveLength(MAX_INVITES);
    // The oldest is the one left out.
    expect(listed).toEqual(
      rows
        .slice(1)
        .reverse()
        .map(({ email, createdAt }) => ({ email, createdAt })),
    );
  });

  it('test_add_invite_rejects_non_address', async () => {
    const t = await inviteApp();
    for (const value of ['not-an-address', `${'a'.repeat(250)}@example.org`, 'ann@localhost']) {
      let thrown: unknown;
      try {
        await addInvite(t.deps.db.db, value, null);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as TypeError).message).not.toContain(value);
    }
    expect(await allInvites(t)).toEqual([]);
  });

  it('test_invite_survives_inviter_deletion', async () => {
    const t = await inviteApp({ SIGNUP_ALLOWLIST: ANN });
    await signInWeb(t.app, t.outbox, ANN);
    const adminId = await userIdOf(t, ANN);
    await addInvite(t.deps.db.db, BOB, adminId);
    expect((await allInvites(t)).map((i) => i.invitedBy)).toEqual([adminId]);

    await t.deps.db.db.delete(user).where(eq(user.id, adminId));
    const after = await allInvites(t);
    expect(after.map(({ email, invitedBy }) => ({ email, invitedBy }))).toEqual([{ email: BOB, invitedBy: null }]);
  });

  it('test_account_deletion_removes_its_invite', async () => {
    const t = await inviteApp({ SIGNUP_ALLOWLIST: ANN });
    const cookie = await signInWeb(t.app, t.outbox, ANN);
    const userId = await userIdOf(t, ANN);
    // As a failed consume would leave it.
    await t.deps.db.db.insert(signupInvites).values({ email: ANN });

    const res = await postJson(t.app, ACCOUNT_DELETE_PATH, { confirm: ANN }, { Cookie: cookie, Origin: TEST_PUBLIC_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await allInvites(t)).toEqual([]);

    const holding = [...(await scanAllTables(t.deps.db))].filter(([, json]) => json.includes(ANN) || json.includes(userId));
    expect(holding.map(([table]) => table)).toEqual([]);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_invite_logs_hold_no_address', async () => {
    const t = await inviteApp(GOOGLE_ENV);
    const db = t.deps.db.db;
    await addInvite(db, ANN, null);
    await signInWeb(t.app, t.outbox, ANN);
    await postJson(t.app, SEND_CODE, { email: STRANGER, type: 'sign-in' }, PAGE);
    await addInvite(db, STRANGER, null);
    await postJson(t.app, SEND_CODE, { email: STRANGER, type: 'sign-in' }, PAGE);
    const otp = sentCode(t.outbox, STRANGER);
    await removeInvite(db, STRANGER);
    expect((await postJson(t.app, SIGN_IN, { email: STRANGER, otp }, PAGE)).status).toBe(403);
    await google({ email: 'unverified@example.com', emailVerified: false });
    await addInvite(db, 'unverified@example.com', null);
    errorOf(await signInWithGoogle(t.app));

    // A consume that fails with an error whose message names the address: the sign-in still works, the invite stays
    // (harmless), and the log line holds the error's name and code only.
    await db.execute(sql`create function refuse_invite_delete() returns trigger language plpgsql as $$
      begin raise exception 'cannot delete the invite of %', old.email; end $$`);
    await db.execute(sql`create trigger refuse_invite_delete before delete on signup_invites
      for each row execute function refuse_invite_delete()`);
    await addInvite(db, BOB, null);
    const cookie = await signInWeb(t.app, t.outbox, BOB);
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(BOB);
    expect(await isInvited(db, BOB)).toBe(true);
    const failed = t.events().filter((e) => e.event === 'invites.consume_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      t: expect.any(String),
      level: 'warn',
      event: 'invites.consume_failed',
      err_name: 'Error',
      err_code: 'P0001',
    });

    expect(t.lines.length).toBeGreaterThan(0);
    expect(t.lines.filter((line) => line.includes('@'))).toEqual([]);
  });
});
