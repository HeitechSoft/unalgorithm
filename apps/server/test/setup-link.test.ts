import { ACCOUNT_DELETE_PATH, ADMIN_SETUP_PATH } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLE, activeAdminCount, removeAccess } from '../src/admin/access.ts';
import { addInvite, isInvited } from '../src/admin/invites.ts';
import {
  claimSetup,
  createSetupLink,
  logSetupNeeded,
  SETUP_LINK_TTL_MS,
  SETUP_REFUSED,
  type SetupLink,
} from '../src/admin/setup.ts';
import { hashSecret, newSecret } from '../src/auth/tokens.ts';
import { REFUSED } from '../src/auth/web-session.ts';
import { main as setupLinkMain } from '../src/cli/setup-link.ts';
import { CONFIG_VARIABLES } from '../src/config.ts';
import { type DbHandle, openPostgres } from '../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/db/migrate.ts';
import { setupTokens, signupInvites, user } from '../src/db/schema.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { createPostgresTestDb, TEST_DATABASE_URL } from './support/postgres.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { postJson, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_ENV, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const YOU = 'you@example.org';
const ANN = 'ann@example.org';
const BOB = 'bob@example.org';
const CAT = 'cat@example.org';
const ADA = 'ada@example.com';
const BEA = 'bea@example.com';
const PAGE = { Origin: TEST_PUBLIC_URL };
const SETUP_URL = new RegExp(`^${TEST_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/setup#[A-Za-z0-9_-]{43}$`);
const USAGE = 'usage: node apps/server/src/cli/setup-link.ts <email> [--recover]';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps, databases and environment changes a test made, undone after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** For the privacy test at the end: every log line, every link's token, and every line the command printed but a link. */
const everyLine: string[] = [];
const everyToken: string[] = [];
const cliLines: string[] = [];

/** A test server with an empty `SIGNUP_ALLOWLIST` unless `env` sets one, on PGlite unless `db` is given. */
async function setupApp(env: Record<string, string> = {}, db?: DbHandle) {
  const t = await createTestApp({ config: testConfig(env), db });
  cleanup.push(async () => {
    everyLine.push(...t.lines);
    await t.close();
  });
  return t;
}

/** The secret in a setup link's fragment, remembered for the privacy test. */
function tokenOf(link: SetupLink): string {
  if (!link.ok) throw new Error('No link.');
  const token = link.url.split('#')[1] ?? '';
  everyToken.push(token);
  return token;
}

const makeLink = async (t: TestApp, email: string, opts?: { recover?: boolean; now?: number }) =>
  tokenOf(await createSetupLink(t.deps.db.db, t.deps.config, email, opts));

/** The setup route as the page calls it: the session cookie and the page's `Origin` unless `headers` replaces them. */
const claim = (t: TestApp, cookie: string, token: string, headers: Record<string, string> = PAGE) =>
  postJson(t.app, ADMIN_SETUP_PATH, { token }, { ...headers, ...(cookie ? { Cookie: cookie } : {}) });

async function userId(t: TestApp, email: string): Promise<string> {
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) throw new Error('No account.');
  return row.id;
}

async function accountRow(t: TestApp, email: string) {
  const [row] = await t.deps.db.db.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.email, email));
  return row;
}

const setRole = (t: TestApp, email: string, role: string | null) =>
  t.deps.db.db.update(user).set({ role }).where(eq(user.email, email));
const allTokens = (t: TestApp) => t.deps.db.db.select().from(setupTokens);
const allInvites = (t: TestApp) => t.deps.db.db.select().from(signupInvites);
const refusals = (t: TestApp) =>
  t
    .events()
    .filter((e) => e.event === 'setup.refused')
    .map((e) => e.reason);

describe('links', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_create_setup_link_stores_hash_and_invites', async () => {
    const t = await setupApp();
    const now = Date.now();
    const link = await createSetupLink(t.deps.db.db, t.deps.config, 'You@Example.org', { now });

    expect(link).toMatchObject({ ok: true, expiresAt: new Date(now + SETUP_LINK_TTL_MS), restored: false });
    if (!link.ok) throw new Error('No link.');
    expect(link.url).toMatch(SETUP_URL);
    const token = tokenOf(link);
    const rows = await allTokens(t);
    expect(rows).toEqual([
      {
        tokenHash: hashSecret(token),
        email: YOU,
        recover: false,
        createdAt: new Date(now),
        expiresAt: new Date(now + 60 * 60_000),
        usedAt: null,
      },
    ]);
    expect(JSON.stringify(await scanAllTables(t.deps.db).then((m) => [...m.values()]))).not.toContain(token);
    expect(await isInvited(t.deps.db.db, YOU)).toBe(true);
    expect(await allInvites(t)).toEqual([{ email: YOU, createdAt: expect.any(Date), invitedBy: null }]);

    // A bad address is refused before anything is written, and the error does not repeat it.
    const bad = await createSetupLink(t.deps.db.db, t.deps.config, 'not-an-address').catch((err: unknown) => err);
    expect(bad).toBeInstanceOf(TypeError);
    expect(String(bad)).not.toContain('not-an-address');
    expect(await allTokens(t)).toHaveLength(1);
  });

  it('test_setup_link_for_existing_account_adds_no_invite', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: ANN });
    await signInWeb(t.app, t.outbox, ANN);

    const link = await createSetupLink(t.deps.db.db, t.deps.config, ANN);
    expect(link).toMatchObject({ ok: true, restored: false });
    tokenOf(link);
    expect(await allInvites(t)).toEqual([]);
    expect(await allTokens(t)).toEqual([expect.objectContaining({ email: ANN, usedAt: null })]);
  });

  it('test_new_setup_link_replaces_unused_one', async () => {
    const t = await setupApp();
    const first = await makeLink(t, ANN);
    const second = await makeLink(t, ANN);
    expect((await allTokens(t)).map((row) => row.tokenHash)).toEqual([hashSecret(second)]);

    await signInWeb(t.app, t.outbox, ANN);
    const ann = { userId: await userId(t, ANN), email: ANN };
    expect(await claimSetup(t.deps.db.db, ann, first)).toEqual({ ok: false, reason: 'unknown' });
    expect(await claimSetup(t.deps.db.db, ann, second)).toEqual({ ok: true, recover: false });

    // A used link is kept, and a new one does not replace it.
    const third = await makeLink(t, ANN, { recover: true });
    expect((await allTokens(t)).map((row) => row.tokenHash).sort()).toEqual([hashSecret(second), hashSecret(third)].sort());
  });

  it('test_new_setup_link_drops_replaced_links_invite', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: ADA });
    await signInWeb(t.app, t.outbox, ADA);
    const ada = await userId(t, ADA);

    // A mistyped address's invite goes with its link.
    await makeLink(t, ANN);
    expect(await isInvited(t.deps.db.db, ANN)).toBe(true);
    await makeLink(t, CAT);
    expect(await isInvited(t.deps.db.db, ANN)).toBe(false);
    expect(await isInvited(t.deps.db.db, CAT)).toBe(true);

    // An invite an admin added before the link stays when the link is replaced.
    await addInvite(t.deps.db.db, BOB, ada);
    await makeLink(t, BOB);
    await makeLink(t, CAT);
    expect(await isInvited(t.deps.db.db, BOB)).toBe(true);
    expect((await allInvites(t)).find((row) => row.email === BOB)?.invitedBy).toBe(ada);
  });

  it('test_setup_link_refused_when_admin_exists_unless_recover', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: ADA });
    await signInWeb(t.app, t.outbox, ADA);
    await setRole(t, ADA, ADMIN_ROLE);

    expect(await createSetupLink(t.deps.db.db, t.deps.config, ANN)).toEqual({ ok: false, reason: 'has-admin' });
    expect(await allTokens(t)).toEqual([]);
    expect(await allInvites(t)).toEqual([]);

    const link = await createSetupLink(t.deps.db.db, t.deps.config, ANN, { recover: true });
    expect(link).toMatchObject({ ok: true, restored: false });
    if (!link.ok) throw new Error('No link.');
    expect(link.url).toMatch(SETUP_URL);
    tokenOf(link);
    expect(await allTokens(t)).toEqual([expect.objectContaining({ email: ANN, recover: true })]);
  });
});

describe('claim route', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_setup_claim_makes_first_admin', async () => {
    const t = await setupApp();
    const token = await makeLink(t, YOU);
    const cookie = await signInWeb(t.app, t.outbox, YOU);

    const res = await claim(t, cookie, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await accountRow(t, YOU)).toEqual({ role: ADMIN_ROLE, banned: false });
    expect(await activeAdminCount(t.deps.db.db)).toBe(1);
    expect((await allTokens(t))[0]?.usedAt).toBeInstanceOf(Date);
    expect(t.events().filter((e) => e.event === 'admin.setup_claimed')).toEqual([
      expect.objectContaining({ user_id: await userId(t, YOU), recover: false }),
    ]);
  });

  it('test_setup_claim_refusals', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: BOB });
    const bob = await signInWeb(t.app, t.outbox, BOB);

    // Made 61 minutes ago: expired.
    const old = await makeLink(t, ANN, { now: Date.now() - 61 * 60_000 });
    const ann = await signInWeb(t.app, t.outbox, ANN);
    let res = await claim(t, ann, old);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(SETUP_REFUSED);

    // Another address's session.
    const token = await makeLink(t, ANN);
    res = await claim(t, bob, token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(SETUP_REFUSED);

    // The same token a second time.
    expect((await claim(t, ann, token)).status).toBe(200);
    res = await claim(t, ann, token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(SETUP_REFUSED);
    expect(refusals(t)).toEqual(['expired', 'other-address', 'used']);

    // Answered before the claim: no session, no Origin, a malformed token. None logs a refusal.
    res = await claim(t, '', token);
    expect(res.status).toBe(401);
    res = await claim(t, ann, token, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REFUSED);
    res = await claim(t, ann, token.slice(0, 42));
    expect(res.status).toBe(400);
    expect(refusals(t)).toEqual(['expired', 'other-address', 'used']);
    expect(await accountRow(t, BOB)).toEqual({ role: 'user', banned: false });
  });

  it('test_setup_claim_refused_once_admin_exists', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: ADA });
    const token = await makeLink(t, ANN);
    await signInWeb(t.app, t.outbox, ADA);
    await setRole(t, ADA, ADMIN_ROLE);
    const ann = await signInWeb(t.app, t.outbox, ANN);

    const res = await claim(t, ann, token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(SETUP_REFUSED);
    expect(refusals(t)).toEqual(['has-admin']);
    expect((await accountRow(t, ANN))?.role).toBe('user');
    expect((await allTokens(t))[0]?.usedAt).toBeNull();
  });

  it('test_recover_link_lifts_removal', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` });
    const ada = await signInWeb(t.app, t.outbox, ADA);
    await signInWeb(t.app, t.outbox, BEA);
    await setRole(t, ADA, ADMIN_ROLE);
    await setRole(t, BEA, ADMIN_ROLE);
    const access = { db: t.deps.db.db, auth: t.deps.auth, log: t.deps.log };
    await removeAccess(access, new Headers({ Cookie: ada }), await userId(t, ADA), await userId(t, BEA));
    await expect(signInWeb(t.app, t.outbox, BEA)).rejects.toThrow();

    const link = await createSetupLink(t.deps.db.db, t.deps.config, BEA, { recover: true });
    expect(link).toMatchObject({ ok: true, restored: true });
    const token = tokenOf(link);
    const bea = await signInWeb(t.app, t.outbox, BEA);

    const res = await claim(t, bea, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await accountRow(t, BEA)).toEqual({ role: ADMIN_ROLE, banned: false });
    expect(t.events().filter((e) => e.event === 'admin.setup_claimed')).toEqual([expect.objectContaining({ recover: true })]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('postgres', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_concurrent_claims_make_one_admin', async () => {
    const pg = await createPostgresTestDb('ua_setup');
    cleanup.push(() => pg.drop());
    const handle = openPostgres(pg.url);
    cleanup.push(() => handle.close());
    await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: captureLog().log });
    const t = await setupApp({}, handle);

    // Two live links inserted directly: `createSetupLink` keeps one, and the first claim would find it gone.
    const links = [ANN, BOB].map((email) => ({ email, token: newSecret() }));
    everyToken.push(...links.map((link) => link.token));
    await handle.db.insert(setupTokens).values(
      links.map(({ email, token }) => ({
        tokenHash: hashSecret(token),
        email,
        recover: false,
        expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS),
      })),
    );
    const claims: (() => ReturnType<typeof claimSetup>)[] = [];
    for (const { email, token } of links) {
      await addInvite(handle.db, email, null);
      await signInWeb(t.app, t.outbox, email);
      const id = await userId(t, email);
      claims.push(() => claimSetup(handle.db, { userId: id, email }, token));
    }

    const results = await Promise.all(claims.map((run) => run()));
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, recover: false }]);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'has-admin' }]);
    expect(await activeAdminCount(handle.db)).toBe(1);
  });
});

describe('command', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_setup_link_cli_outputs_and_exit_codes', async () => {
    const t = await setupApp({ SIGNUP_ALLOWLIST: `${ADA},${BEA}` });
    const lines: string[] = [];
    /** `fromEnv`: no config given, so the command loads it from the environment. */
    const run = (argv: string[], { fromEnv = false } = {}) => {
      lines.length = 0;
      const config = fromEnv ? undefined : t.deps.config;
      return setupLinkMain(argv, { db: t.deps.db, config, out: (line) => lines.push(line) });
    };
    const keep = () => {
      for (const line of lines) {
        if (SETUP_URL.test(line)) everyToken.push(line.split('#')[1] ?? '');
        else cliLines.push(line);
      }
    };

    expect(await run(['You@Example.org'])).toBe(0);
    keep();
    expect(lines).toEqual([
      "Open this link within 60 minutes and sign in as you@example.org to become this server's admin:",
      expect.stringMatching(SETUP_URL),
    ]);
    expect(await isInvited(t.deps.db.db, YOU)).toBe(true);

    for (const argv of [[], ['not-an-address'], ['a@example.org', '--force'], ['--recover'], [YOU, '--recover', 'x']]) {
      expect(await run(argv), argv.join(' ')).toBe(1);
      expect(lines).toEqual([USAGE]);
    }

    // With an admin: the hint, and with --recover a link that also restores a removed account.
    const ada = await signInWeb(t.app, t.outbox, ADA);
    await signInWeb(t.app, t.outbox, BEA);
    await setRole(t, ADA, ADMIN_ROLE);
    expect(await run([YOU])).toBe(1);
    keep();
    expect(lines).toEqual([
      `This server already has an admin, who invites people at ${TEST_PUBLIC_URL}/admin. To make an admin anyway (for ` +
        'example, when the only admin lost their mailbox), add --recover.',
    ]);

    const access = { db: t.deps.db.db, auth: t.deps.auth, log: t.deps.log };
    await removeAccess(access, new Headers({ Cookie: ada }), await userId(t, ADA), await userId(t, BEA));
    expect(await run([BEA, '--recover'])).toBe(0);
    keep();
    expect(lines).toEqual([
      `Open this link within 60 minutes and sign in as ${BEA} to become this server's admin:`,
      expect.stringMatching(SETUP_URL),
      "This address's account had been removed from this server; it can sign in again.",
    ]);
    expect(await accountRow(t, BEA)).toEqual({ role: 'user', banned: false });

    // The environment of a test server without PUBLIC_URL, whatever the shell running the tests has set.
    for (const name of CONFIG_VARIABLES) vi.stubEnv(name, undefined);
    for (const [name, value] of Object.entries(TEST_ENV)) vi.stubEnv(name, value);
    vi.stubEnv('PUBLIC_URL', undefined);
    expect(await run([YOU], { fromEnv: true })).toBe(1);
    expect(lines).toEqual(['missing: PUBLIC_URL']);
  });
});

describe('start-up and privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_log_setup_needed_only_without_admin', async () => {
    const db = await createTestDb();
    cleanup.push(() => db.close());
    const { log, lines, events } = captureLog();

    await logSetupNeeded(db.db, log);
    expect(events()).toEqual([expect.objectContaining({ level: 'warn', event: 'setup.needed', command: 'setup-link' })]);

    await db.db.insert(user).values({ id: 'u1', name: '', email: ANN, emailVerified: true, role: ADMIN_ROLE });
    await logSetupNeeded(db.db, log);
    expect(lines).toHaveLength(1);
    everyLine.push(...lines);
  });

  it('test_setup_admin_account_deletion_leaves_no_trace', async () => {
    const t = await setupApp();
    const token = await makeLink(t, YOU);
    const cookie = await signInWeb(t.app, t.outbox, YOU);
    expect((await claim(t, cookie, token)).status).toBe(200);
    const id = await userId(t, YOU);
    expect((await scanAllTables(t.deps.db)).get('public.setup_tokens')).toContain(YOU);

    const res = await postJson(t.app, ACCOUNT_DELETE_PATH, { confirm: YOU }, { ...PAGE, Cookie: cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const holding = [...(await scanAllTables(t.deps.db))].filter(([, json]) => json.includes(YOU) || json.includes(id));
    expect(holding.map(([table]) => table)).toEqual([]);
  });

  // Last: it reads what every test above captured.
  it('test_setup_logs_hold_no_token_or_address', () => {
    expect(everyToken.length).toBeGreaterThan(5);
    expect(everyLine.some((line) => line.includes('"setup.refused"'))).toBe(true);
    expect(everyLine.some((line) => line.includes('"admin.setup_claimed"'))).toBe(true);
    const secrets = everyToken.flatMap((token) => [token, hashSecret(token)]);
    expect(everyLine.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([]);
    expect(cliLines.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([]);
    // `err_stack` holds file paths, whose package directories have an `@` (`hono@4.13.13`): every other field is checked.
    const withoutStacks = everyLine.map((line) => {
      const { err_stack: _stack, ...fields } = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify(fields);
    });
    expect(withoutStacks.filter((line) => line.includes('@'))).toEqual([]);
  });
});
