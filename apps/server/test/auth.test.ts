import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authLog, authOptions, CLIENT_IP_HEADER, isEmailAllowed } from '../src/auth/better-auth.ts';
import { jwks, user, verification } from '../src/db/schema.ts';
import { memoryMailer } from '../src/mail/mailer.ts';
import { captureLog } from './support/log.ts';
import { postJson, SEND_CODE, SIGN_IN, SIX_DIGITS, sentCode, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const GET_SESSION = '/api/auth/get-session';
const TOM = 'tom@example.com';
const STRANGER = 'stranger@example.com';
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** Apps a test opened, closed after it whatever the outcome; fake timers are put back too. */
const cleanup: (() => Promise<unknown>)[] = [];
/** Every log line of every app in this file, for the log test at the end (AC 12). */
const allLines: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function authApp(env: Record<string, string> = {}, options: Omit<TestAppOptions, 'config'> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM, ...env }), ...options });
  cleanup.push(async () => {
    allLines.push(...t.lines);
    await t.close();
  });
  return t;
}

/** A JSON POST from the sign-in page: Better Auth refuses state-changing requests from other origins. */
const post = (t: TestApp, path: string, body: unknown, headers: Record<string, string> = {}) =>
  postJson(t.app, path, body, { Origin: TEST_PUBLIC_URL, ...headers });

const sendCode = (t: TestApp, email: string, headers?: Record<string, string>) =>
  post(t, SEND_CODE, { email, type: 'sign-in' }, headers);
const signIn = (t: TestApp, email: string, otp: string) => post(t, SIGN_IN, { email, otp });
const codeFor = (t: TestApp, email: string) => sentCode(t.outbox, email);
/** Signs `email` in through the two mounted endpoints and returns the session cookie. */
const signedIn = (t: TestApp, email = TOM) => signInWeb(t.app, t.outbox, email);

/** A six-digit code that is not `code`. */
const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

const usersWithEmail = (t: TestApp, email: string) => t.deps.db.db.select().from(user).where(eq(user.email, email));

/** The JSON of one JWT segment. */
const segment = (jwt: string, i: 0 | 1) =>
  JSON.parse(Buffer.from(jwt.split('.')[i] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

describe('sign-in flow', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_otp_sent_to_allowed_email', async () => {
    const t = await authApp();
    const res = await sendCode(t, TOM);
    expect(res.status).toBe(200);
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]?.to).toBe(TOM);
    expect(t.outbox[0]?.text).toMatch(SIX_DIGITS);
    expect(t.outbox[0]?.subject).toBe('Your sign-in code for Test server');
  });

  it('test_otp_sign_in_sets_session', async () => {
    const t = await authApp();
    await sendCode(t, TOM);
    // A name and an image are not kept: the privacy notice covers the email address only.
    const res = await post(t, SIGN_IN, { email: TOM, otp: codeFor(t, TOM), name: 'Tom H', image: 'https://x.example/a.png' });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('better-auth.session_token='))).toBe(true);

    const rows = await usersWithEmail(t, TOM);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: TOM, emailVerified: true, name: '', image: null });
  });

  it('test_unlisted_email_gets_no_code_and_no_account', async () => {
    const t = await authApp();
    const res = await sendCode(t, STRANGER);
    // The same answer as for an allowed address: the endpoint never tells who may sign in.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(t.outbox).toHaveLength(0);

    const attempt = await signIn(t, STRANGER, '123456');
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(attempt.headers.getSetCookie()).toEqual([]);
    expect(await usersWithEmail(t, STRANGER)).toHaveLength(0);
    // Even the right code (never mailed; made here on the server) creates no account: the user-create hook refuses it.
    const otp = await t.deps.auth.api.createVerificationOTP({ body: { email: STRANGER, type: 'sign-in' } });
    const rightCode = await signIn(t, STRANGER, otp);
    expect(rightCode.status).toBe(403);
    expect(await rightCode.json()).toMatchObject({ message: 'Sign-up is closed.' });
    expect(rightCode.headers.getSetCookie()).toEqual([]);
    expect(await usersWithEmail(t, STRANGER)).toHaveLength(0);
    // Other types send nothing either, even to an allowed address.
    expect((await post(t, SEND_CODE, { email: TOM, type: 'email-verification' })).status).toBe(200);
    expect(t.outbox).toHaveLength(0);
  });

  it('test_existing_user_outside_allowlist_can_sign_in', async () => {
    const t = await authApp();
    const now = new Date();
    await t.deps.db.db
      .insert(user)
      .values({ id: 'old-user', name: '', email: 'old@example.com', emailVerified: true, createdAt: now, updatedAt: now });
    expect(isEmailAllowed('old@example.com', t.deps.config.signupAllowlist)).toBe(false);

    await signedIn(t, 'old@example.com');
    expect(t.outbox.map((m) => m.to)).toEqual(['old@example.com']);
    expect(await usersWithEmail(t, 'old@example.com')).toHaveLength(1);
  });
});

describe('allowlist', () => {
  it('test_is_email_allowed_domain_rules', () => {
    const allowlist = ['@heitechsoft.com', 'tom@example.com'];
    expect(isEmailAllowed('a@heitechsoft.com', allowlist)).toBe(true);
    expect(isEmailAllowed('A@HeitechSoft.COM', allowlist)).toBe(true);
    expect(isEmailAllowed('a@mail.heitechsoft.com', allowlist)).toBe(false);
    expect(isEmailAllowed('a@heitechsoft.com.evil.org', allowlist)).toBe(false);
    // The domain is the part after the last @.
    expect(isEmailAllowed('a@heitechsoft.com@evil.org', allowlist)).toBe(false);
    // Any other entry is a whole address.
    expect(isEmailAllowed('Tom@Example.com', allowlist)).toBe(true);
    expect(isEmailAllowed('tom@example.com.evil.org', allowlist)).toBe(false);
    expect(isEmailAllowed('heitechsoft.com', allowlist)).toBe(false);
    // An empty allowlist lets nobody in.
    expect(isEmailAllowed('tom@example.com', [])).toBe(false);
  });
});

describe('code security', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_three_wrong_codes_lock_the_code', async () => {
    const t = await authApp();
    await sendCode(t, TOM);
    const code = codeFor(t, TOM);
    for (let i = 0; i < 3; i++) expect((await signIn(t, TOM, wrong(code))).status).toBe(400);

    const fourth = await signIn(t, TOM, code);
    // The attempt lock, not the rate limiter (off in tests, as in AC 11's note).
    expect(fourth.status).toBe(403);
    expect(await fourth.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    expect(await usersWithEmail(t, TOM)).toHaveLength(0);
  });

  it('test_expired_code_rejected', async () => {
    const t = await authApp();
    // Only Date is faked: PGlite and the request path keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    await sendCode(t, TOM);
    vi.advanceTimersByTime(301_000);

    const res = await signIn(t, TOM, codeFor(t, TOM));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'OTP_EXPIRED' });
    expect(await usersWithEmail(t, TOM)).toHaveLength(0);
  });

  it('test_otp_stored_hashed', async () => {
    const t = await authApp();
    await sendCode(t, TOM);
    const code = codeFor(t, TOM);
    const rows = await t.deps.db.db.select().from(verification);
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.value).not.toContain(code);
      expect(JSON.stringify(row)).not.toContain(code);
    }
  });

  // How long a code's row stays, as privacy-model.md's "What a server stores" says (Better Auth's own behaviour).
  it('test_code_rows_go_when_tried_or_expired', async () => {
    const t = await authApp();
    const rowsFor = async (email: string) =>
      (await t.deps.db.db.select().from(verification)).filter((row) => row.identifier.endsWith(email));
    vi.useFakeTimers({ toFake: ['Date'] });
    // Each code adds a row, mailed or not, and a newer code leaves the older one in place.
    await sendCode(t, STRANGER);
    vi.advanceTimersByTime(200_000);
    await sendCode(t, TOM);
    vi.advanceTimersByTime(1_000);
    await sendCode(t, TOM);
    expect(await rowsFor(STRANGER)).toHaveLength(1);
    expect(await rowsFor(TOM)).toHaveLength(2);

    // Once STRANGER's code is past its five minutes, anyone trying any code deletes its row.
    vi.advanceTimersByTime(100_000);
    expect((await signIn(t, 'nobody@example.com', '123456')).status).toBe(400);
    expect(await rowsFor(STRANGER)).toHaveLength(0);
    expect(await rowsFor(TOM)).toHaveLength(2);

    // Trying a code deletes every row for the address; a wrong one puts the newest code back with the attempt counted.
    const code = codeFor(t, TOM);
    expect((await signIn(t, TOM, wrong(code))).status).toBe(400);
    const left = await rowsFor(TOM);
    expect(left).toHaveLength(1);
    expect(left[0]?.value).toMatch(/:1$/);
    expect((await signIn(t, TOM, code)).status).toBe(200);
    expect(await rowsFor(TOM)).toHaveLength(0);
  });
});

describe('keys and sessions', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sign_jwt_eddsa_15_minutes', async () => {
    const t = await authApp();
    const iat = Math.floor(Date.now() / 1000);
    const { token } = await t.deps.auth.api.signJWT({ body: { payload: { sub: 'u1', iat } } });

    expect(segment(token, 0)).toMatchObject({ alg: 'EdDSA' });
    const payload = segment(token, 1);
    expect(payload).toMatchObject({ sub: 'u1', iat, iss: TEST_PUBLIC_URL, aud: TEST_PUBLIC_URL });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(900);
    expect(await t.deps.db.db.select().from(jwks)).toHaveLength(1);
  });

  it('test_session_has_no_jwt_header', async () => {
    const t = await authApp();
    const cookie = await signedIn(t);
    const res = await t.app.request(GET_SESSION, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-auth-jwt')).toBeNull();
    const body = (await res.json()) as { session?: { userId?: string }; user?: { email?: string } };
    expect(body.user?.email).toBe(TOM);
    expect(typeof body.session?.userId).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(JWT);
  });

  it('test_telemetry_off_in_options', async () => {
    const t = await authApp();
    const { mailer } = memoryMailer();
    const options = authOptions({ config: t.deps.config, db: t.deps.db, mailer, log: captureLog().log });
    expect(options.telemetry).toEqual({ enabled: false });
  });
});

describe('rate limit and IP', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_otp_rate_limit_keyed_by_one_hop_ip', async () => {
    // The only test that turns the limiter on: Better Auth keeps its counts in one store per process.
    const t = await authApp({ TRUST_PROXY: 'one-hop' }, { authRateLimit: true });

    // Four clients behind the proxy: the right-most address is each one's own, whatever the client claims.
    for (let i = 1; i <= 4; i++) {
      const res = await sendCode(t, STRANGER, {
        'X-Forwarded-For': `198.51.100.7, 203.0.113.${i}`,
        [CLIENT_IP_HEADER]: '198.51.100.99',
      });
      expect(res.status).toBe(200);
    }

    // One client four times: a header of its own choosing does not give it a new bucket.
    const statuses: number[] = [];
    for (let i = 1; i <= 4; i++) {
      const res = await sendCode(t, STRANGER, { 'X-Forwarded-For': '198.51.100.7', [CLIENT_IP_HEADER]: `203.0.113.${10 + i}` });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('mounted surface', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_only_allowlisted_auth_paths_are_mounted', async () => {
    const t = await authApp();
    const cookie = await signedIn(t);
    const notFound = { code: 'bad-request', message: 'Not found.' };

    for (const res of [
      await t.app.request('/api/auth/token', { headers: { Cookie: cookie } }),
      await post(t, '/api/auth/update-user', { name: 'Tom H' }, { Cookie: cookie }),
      await t.app.request('/api/auth/list-sessions', { headers: { Cookie: cookie } }),
      await post(t, '/api/auth/email-otp/check-verification-otp', { email: TOM, type: 'sign-in', otp: '123456' }),
      // An allowed path with another method.
      await t.app.request(SIGN_IN, { headers: { Cookie: cookie } }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.headers.get('set-auth-jwt')).toBeNull();
      const text = await res.text();
      expect(text).not.toMatch(JWT);
      expect(JSON.parse(text)).toEqual(notFound);
    }
    const [row] = await usersWithEmail(t, TOM);
    expect(row?.name).toBe('');

    // The mounted ones answer.
    const keys = await t.app.request('/api/auth/jwks');
    expect(keys.status).toBe(200);
    expect(((await keys.json()) as { keys: unknown[] }).keys).toHaveLength(1);
    expect((await t.app.request(GET_SESSION, { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await post(t, '/api/auth/sign-out', {}, { Cookie: cookie })).status).toBe(200);
    const after = await t.app.request(GET_SESSION, { headers: { Cookie: cookie } });
    expect(await after.json()).toBeNull();
  });

  it('test_auth_body_limit_413', async () => {
    const t = await authApp();
    const tooLarge = { code: 'bad-request', message: 'The request was too large.' };
    const pad = (bytes: number) => ({ email: TOM, otp: '123456', pad: 'x'.repeat(bytes) });

    // Refused before Better Auth reads it, on every auth path, mounted or not.
    for (const path of [SIGN_IN, SEND_CODE, '/api/auth/sign-out', '/api/auth/update-user']) {
      const res = await post(t, path, pad(32 * 1024));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(tooLarge);
    }
    // Under the limit the body still reaches Better Auth intact.
    expect(await (await post(t, SIGN_IN, pad(8 * 1024))).json()).toMatchObject({ code: 'INVALID_OTP' });
  });
});

describe('logs', { timeout: PGLITE_TIMEOUT }, () => {
  /** No value holds an email address, and no line holds a six-digit number. */
  function expectNoEmailOrCode(lines: string[]) {
    for (const line of lines) {
      expect(line).not.toMatch(SIX_DIGITS);
      for (const value of Object.values(JSON.parse(line) as Record<string, unknown>)) {
        expect(String(value)).not.toMatch(/@/);
      }
    }
  }

  it('test_auth_logs_hold_no_email_or_code', async () => {
    const t = await authApp();
    await sendCode(t, STRANGER);
    await signIn(t, STRANGER, '123456');
    await sendCode(t, TOM);
    await signIn(t, TOM, wrong(codeFor(t, TOM)));
    const cookie = await signedIn(t);
    await t.app.request(GET_SESSION, { headers: { Cookie: cookie } });
    await post(t, SEND_CODE, { email: 'not-an-address', type: 'sign-in' });

    expect(t.lines.length).toBeGreaterThan(0);
    expectNoEmailOrCode(t.lines);
    // And every line the earlier tests in this file wrote (AC 1 to 11).
    expectNoEmailOrCode(allLines);

    // Better Auth's own message and arguments never reach the log: only the event, the level and the error's fields.
    const capture = captureLog();
    authLog(capture.log)('error', 'No user tom@example.com, code 123456', new Error('tom@example.com 123456'));
    expect(capture.lines).toHaveLength(1);
    const [line] = capture.events();
    expect(line).toMatchObject({ event: 'auth.log', level: 'error', err_name: 'Error' });
    expect(capture.lines[0]).not.toContain('tom@example.com');
    expect(capture.lines[0]).not.toContain('123456');

    authLog(capture.log)('warn', 'Invalid origin: https://evil.example', { origin: 'https://evil.example' });
    expect(capture.events()[1]).toEqual({ t: expect.any(String), level: 'warn', event: 'auth.log' });
  });

  it('test_auth_writes_nothing_to_the_console', async () => {
    const consoleCalls = (['error', 'warn', 'info', 'log', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    // Not `authApp`: this app's error line has stack frames, whose package paths hold an @.
    const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }) });
    cleanup.push(t.close);
    const raw = (headers: Record<string, string>, body: string) =>
      t.app.request(SIGN_IN, { method: 'POST', headers: { Origin: TEST_PUBLIC_URL, ...headers }, body });

    // Refused before any endpoint runs; Better Auth's text for these quotes what the client sent. (It checks the
    // Origin only when the request has a cookie.)
    const crossSite = await post(t, '/api/auth/sign-out', {}, { Origin: 'https://evil.example', Cookie: 'a=b' });
    expect(crossSite.status).toBe(403);
    expect((await raw({ 'Content-Type': 'application/json' }, `{"email":"${TOM}",`)).status).toBe(400);
    expect((await raw({ 'Content-Type': `text/plain; who=${TOM}` }, '{}')).status).toBe(415);
    for (const call of consoleCalls) expect(call).not.toHaveBeenCalled();

    // A database failure: the query's error quotes the address and the code's hash.
    await t.close();
    const down = await signIn(t, TOM, '123456');
    for (const call of consoleCalls) expect(call).not.toHaveBeenCalled();
    expect(down.status).toBe(500);
    expect(await down.json()).toEqual({ code: 'unknown', message: 'Something went wrong on the server.' });
    // The failure is the app's one error line, with the error's fields only.
    const errors = t.events().filter((e) => e.event === 'http.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: 'error', err_name: expect.any(String) });
    expect(t.lines.join('\n')).not.toContain(TOM);
    expect(t.lines.join('\n')).not.toContain('sign-in-otp');
  });
});
