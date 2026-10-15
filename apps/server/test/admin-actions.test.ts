import { describeError } from '@unalgorithm/ai';
import {
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_USERS_PATH,
  type AdminUser,
  AdminUsersSchema,
  adminUserActionPath,
  MAX_DAILY_POST_CAP,
} from '@unalgorithm/protocol';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE, NOT_ADMIN } from '../src/admin/access.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { main as userCap } from '../src/cli/user-cap.ts';
import { devices, signupInvites, user, userLimits } from '../src/db/schema.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { classifyBody, postClassify, serverPost } from './support/classify.ts';
import { postJson, signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const NEW = 'new@example.org';
const UNKNOWN_ID = 'no-such-account';
const OWN_ACCESS = { code: 'bad-request', message: "You can't change your own access." };
const OWN_ROLE = { code: 'bad-request', message: "You can't change your own role." };
const HAS_ACCOUNT = { code: 'bad-request', message: 'This address already has an account.' };
const NOT_VALID = { code: 'bad-request', message: 'The request was not valid.' };
const OK = { ok: true };

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function userId(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No account.');
  return row.id;
}

/** A test server where Ada is the admin and Bea a user, both signed in on the page; `deviceForBea` signs Bea's extension in. */
async function adminApp({ deviceForBea = false } = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` }) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  const member = await signInWeb(t.app, t.outbox, BEA);
  const beaDevice = deviceForBea ? await signInDevice(t.app, t.outbox, BEA) : undefined;
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const adaId = await userId(t, ADA);
  const beaId = await userId(t, BEA);
  /** A POST from the page (or from `origin`, or with no `Origin` when null) with this session cookie (none when null). */
  const post = (path: string, body: unknown, cookie: string | null = admin, origin: string | null = TEST_PUBLIC_URL) =>
    postJson(t.app, path, body, { ...(origin === null ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}) });
  const get = (path: string, cookie = admin) => t.app.request(path, { headers: { Cookie: cookie } });
  const list = async () => {
    const res = await get(ADMIN_USERS_PATH);
    expect(res.status).toBe(200);
    return AdminUsersSchema.parse(await res.json());
  };
  const listed = async (id: string): Promise<AdminUser | undefined> => (await list()).users.find((u) => u.id === id);
  return { t, admin, member, beaDevice, adaId, beaId, post, get, list, listed };
}

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
}

async function capRows(t: TestApp) {
  return t.deps.db.db.select({ userId: userLimits.userId, cap: userLimits.dailyPostCap }).from(userLimits);
}

describe('caps', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_sets_and_clears_cap', async () => {
    const { t, beaId, post, listed } = await adminApp();
    const cap = adminUserActionPath(beaId, 'cap');

    await expectAnswer(await post(cap, { dailyPostCap: 50 }), 200, OK);
    expect(await capRows(t)).toEqual([{ userId: beaId, cap: 50 }]);
    expect((await listed(beaId))?.dailyPostCap).toBe(50);

    await expectAnswer(await post(cap, { dailyPostCap: 0 }), 200, OK);
    expect(await capRows(t)).toEqual([{ userId: beaId, cap: 0 }]);
    expect((await listed(beaId))?.dailyPostCap).toBe(0);

    await expectAnswer(await post(cap, { dailyPostCap: null }), 200, OK);
    expect(await capRows(t)).toEqual([]);
    expect((await listed(beaId))?.dailyPostCap).toBeNull();

    await expectAnswer(await post(cap, { dailyPostCap: MAX_DAILY_POST_CAP + 1 }), 400, NOT_VALID);
    await expectAnswer(await post(cap, { dailyPostCap: -1 }), 400, NOT_VALID);
    await expectAnswer(await post(cap, { dailyPostCap: 1.5 }), 400, NOT_VALID);
    expect(await capRows(t)).toEqual([]);

    const unknown = adminUserActionPath(UNKNOWN_ID, 'cap');
    await expectAnswer(await post(unknown, { dailyPostCap: 50 }), 404, NOT_FOUND);
    await expectAnswer(await post(unknown, { dailyPostCap: null }), 404, NOT_FOUND);
    expect(await capRows(t)).toEqual([]);

    // A path parameter that is not a user id never reaches the database.
    await expectAnswer(await post('/v1/admin/users/no.such/cap', { dailyPostCap: 50 }), 400, NOT_VALID);
  });

  it('test_admin_cap_applies_to_classify', async () => {
    const { t, beaId, beaDevice, post } = await adminApp({ deviceForBea: true });
    const token = beaDevice?.access_token ?? '';
    await expectAnswer(await post(adminUserActionPath(beaId, 'cap'), { dailyPostCap: 1 }), 200, OK);

    const first = await postClassify(t.app, classifyBody([await serverPost('A1', 'A post about automation')]), token);
    expect(first.status).toBe(200);
    const second = await postClassify(t.app, classifyBody([await serverPost('A2', 'Another post about automation')]), token);
    await expectAnswer(second, 429, { code: 'cap-reached', message: describeError('cap-reached', t.deps.config.instanceName) });
  });

  it('test_user_cap_cli_uses_shared_max', async () => {
    const { t, beaId } = await adminApp();
    const lines: string[] = [];
    const run = (argv: string[]) => userCap(argv, { db: t.deps.db, config: t.deps.config, out: (line) => lines.push(line) });

    expect(await run([BEA, String(MAX_DAILY_POST_CAP + 1)])).toBe(1);
    expect(await capRows(t)).toEqual([]);
    expect(await run([BEA, String(MAX_DAILY_POST_CAP)])).toBe(0);
    expect(await capRows(t)).toEqual([{ userId: beaId, cap: MAX_DAILY_POST_CAP }]);
    expect(await run([BEA, String(MAX_DAILY_POST_CAP + 1)])).toBe(1);
    expect(await capRows(t)).toEqual([{ userId: beaId, cap: MAX_DAILY_POST_CAP }]);
  });
});

describe('access and roles', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_removes_and_restores_access', async () => {
    const { t, admin, adaId, beaId, post, get, listed } = await adminApp({ deviceForBea: true });
    const revokedDevices = async (id: string) => {
      const [row] = await t.deps.db.db
        .select({ n: count() })
        .from(devices)
        .where(and(eq(devices.userId, id), isNotNull(devices.revokedAt)));
      return row?.n ?? 0;
    };
    const access = adminUserActionPath(beaId, 'access');

    await expectAnswer(await post(access, { access: 'removed' }), 200, OK);
    expect(await revokedDevices(beaId)).toBe(1);
    expect(await listed(beaId)).toMatchObject({ access: 'removed', activeDevices: 0 });

    await expectAnswer(await post(access, { access: 'active' }), 200, OK);
    expect((await listed(beaId))?.access).toBe('active');

    // The caller's own id, with either value: refused, and nothing changes.
    const own = adminUserActionPath(adaId, 'access');
    await expectAnswer(await post(own, { access: 'removed' }), 400, OWN_ACCESS);
    await expectAnswer(await post(own, { access: 'active' }), 400, OWN_ACCESS);
    expect(await listed(adaId)).toMatchObject({ access: 'active', role: 'admin' });
    expect((await get(ADMIN_USERS_PATH, admin)).status).toBe(200);

    await expectAnswer(await post(access, { access: 'gone' }), 400, NOT_VALID);
    const unknown = adminUserActionPath(UNKNOWN_ID, 'access');
    await expectAnswer(await post(unknown, { access: 'removed' }), 404, NOT_FOUND);
    await expectAnswer(await post(unknown, { access: 'active' }), 404, NOT_FOUND);
  });

  it('test_admin_sets_role_but_not_own', async () => {
    const { admin, member, adaId, beaId, post, get, listed } = await adminApp();
    const role = adminUserActionPath(beaId, 'role');

    await expectAnswer(await get(ADMIN_USERS_PATH, member), 403, NOT_ADMIN);
    await expectAnswer(await post(role, { role: 'admin' }), 200, OK);
    expect((await get(ADMIN_USERS_PATH, member)).status).toBe(200);
    expect((await listed(beaId))?.role).toBe('admin');

    await expectAnswer(await post(role, { role: 'user' }), 200, OK);
    await expectAnswer(await get(ADMIN_USERS_PATH, member), 403, NOT_ADMIN);
    expect((await listed(beaId))?.role).toBe('user');

    await expectAnswer(await post(adminUserActionPath(adaId, 'role'), { role: 'user' }), 400, OWN_ROLE);
    expect((await get(ADMIN_USERS_PATH, admin)).status).toBe(200);
    expect((await listed(adaId))?.role).toBe('admin');

    await expectAnswer(await post(role, { role: 'owner' }), 400, NOT_VALID);
    expect((await listed(beaId))?.role).toBe('user');
    await expectAnswer(await post(adminUserActionPath(UNKNOWN_ID, 'role'), { role: 'admin' }), 404, NOT_FOUND);
  });
});

describe('invites', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_adds_and_removes_invites', async () => {
    const { t, adaId, post, list } = await adminApp();
    const inviteRows = () => t.deps.db.db.select({ email: signupInvites.email, by: signupInvites.invitedBy }).from(signupInvites);

    await expectAnswer(await post(ADMIN_INVITES_PATH, { email: 'New@Example.org' }), 200, OK);
    expect((await list()).invites.map((i) => i.email)).toEqual([NEW]);
    await expectAnswer(await post(ADMIN_INVITES_PATH, { email: NEW }), 200, OK);
    expect(await inviteRows()).toEqual([{ email: NEW, by: adaId }]);

    // An address with an account, however it is typed.
    await expectAnswer(await post(ADMIN_INVITES_PATH, { email: BEA }), 400, HAS_ACCOUNT);
    await expectAnswer(await post(ADMIN_INVITES_PATH, { email: 'Bea@Example.com' }), 400, HAS_ACCOUNT);
    await expectAnswer(await post(ADMIN_INVITES_PATH, { email: 'not an address' }), 400, NOT_VALID);
    expect(await inviteRows()).toHaveLength(1);

    await expectAnswer(await post(ADMIN_INVITE_REMOVE_PATH, { email: 'NEW@example.org' }), 200, OK);
    expect((await list()).invites).toEqual([]);
    await expectAnswer(await post(ADMIN_INVITE_REMOVE_PATH, { email: 'missing@example.org' }), 200, OK);
    expect(await inviteRows()).toEqual([]);
  });
});

describe('guards and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_admin_actions_need_origin_session_and_role', async () => {
    const { t, admin, member, beaId, post } = await adminApp();
    const routes: [string, unknown][] = [
      [adminUserActionPath(beaId, 'cap'), { dailyPostCap: 5 }],
      [adminUserActionPath(beaId, 'access'), { access: 'removed' }],
      [adminUserActionPath(beaId, 'role'), { role: 'admin' }],
      [ADMIN_INVITES_PATH, { email: NEW }],
      [ADMIN_INVITE_REMOVE_PATH, { email: NEW }],
    ];
    await t.deps.db.db.insert(signupInvites).values({ email: NEW });

    for (const [path, body] of routes) {
      await expectAnswer(await post(path, body, admin, null), 403, REFUSED);
      await expectAnswer(await post(path, body, admin, 'https://elsewhere.example'), 403, REFUSED);
      await expectAnswer(await post(path, { nonsense: true }, admin, null), 403, REFUSED);
      expect((await post(path, body, null)).status).toBe(401);
      await expectAnswer(await post(path, body, member), 403, NOT_ADMIN);
    }

    // None of them changed anything.
    expect(await capRows(t)).toEqual([]);
    const [bea] = await t.deps.db.db.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.id, beaId));
    expect(bea).toEqual({ role: 'user', banned: false });
    expect(await t.deps.db.db.select({ email: signupInvites.email }).from(signupInvites)).toEqual([{ email: NEW }]);
  });

  it('test_admin_action_logs_hold_ids_only', async () => {
    const { t, adaId, beaId, post } = await adminApp();
    const ok = async (path: string, body: unknown) => expect((await post(path, body)).status).toBe(200);
    await ok(adminUserActionPath(beaId, 'cap'), { dailyPostCap: 7 });
    await ok(adminUserActionPath(beaId, 'cap'), { dailyPostCap: null });
    await ok(adminUserActionPath(beaId, 'access'), { access: 'removed' });
    await ok(adminUserActionPath(beaId, 'access'), { access: 'active' });
    await ok(adminUserActionPath(beaId, 'role'), { role: 'admin' });
    await ok(ADMIN_INVITES_PATH, { email: NEW });
    await ok(ADMIN_INVITE_REMOVE_PATH, { email: NEW });

    const admin = t.events().filter((e) => typeof e.event === 'string' && e.event.startsWith('admin.'));
    expect(admin.map((e) => e.event)).toEqual([
      'admin.cap_set',
      'admin.cap_set',
      'admin.access_removed',
      'admin.access_restored',
      'admin.role_set',
      'admin.invite_added',
      'admin.invite_removed',
    ]);
    for (const line of admin) expect(line.admin_id).toBe(adaId);
    for (const line of admin.slice(0, 5)) expect(line.user_id).toBe(beaId);
    expect(admin[0]).toMatchObject({ cap: 7 });
    expect(admin[1]).toMatchObject({ cap: null });
    expect(admin[4]).toMatchObject({ role: 'admin' });
    for (const line of admin.slice(5)) expect(Object.keys(line)).not.toContain('user_id');

    expect(t.lines.filter((line) => line.includes('@'))).toEqual([]);
  });
});
