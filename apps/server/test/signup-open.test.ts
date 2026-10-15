import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { user } from '../src/db/schema.ts';
import { GOOGLE_ENV, signInWithGoogle, stubGoogle } from './support/google-stub.ts';
import { postJson, SEND_CODE, SIX_DIGITS, sentCode, sessionCookie, sessionOf, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** `SIGNUP=open` (CL5-02): every address its provider verified may create an account, with no allowlist or invite. */
const NEW = 'new@example.org';
const OTHER = 'other@example.org';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function openApp(env: Record<string, string> = {}, options: Omit<TestAppOptions, 'config'> = {}) {
  const t = await createTestApp({ config: testConfig({ SIGNUP: 'open', SIGNUP_ALLOWLIST: '', ...env }), ...options });
  cleanup.push(() => t.close());
  return t;
}

const usersWithEmail = (t: TestApp, email: string) => t.deps.db.db.select().from(user).where(eq(user.email, email));

describe('open sign-ups', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_open_signup_creates_account_for_any_verified_address', async () => {
    const t = await openApp();
    expect(t.deps.config.signupAllowlist).toEqual([]);

    const cookie = await signInWeb(t.app, t.outbox, NEW);
    expect(t.outbox.filter((m) => m.to === NEW)).toHaveLength(1);
    expect(cookie).toContain('better-auth.session_token=');
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(NEW);
    const rows = await usersWithEmail(t, NEW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: NEW, emailVerified: true });
  });

  it('test_open_signup_google_needs_verified_address', async () => {
    const t = await openApp(GOOGLE_ENV);

    const verified = await stubGoogle({ email: NEW, emailVerified: true });
    const res = await signInWithGoogle(t.app);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/account');
    expect(sessionCookie(res)).not.toBe('');
    expect(await usersWithEmail(t, NEW)).toHaveLength(1);
    verified.restore();

    // Open sign-ups still need an address Google verified.
    await stubGoogle({ email: OTHER, emailVerified: false });
    const refused = await signInWithGoogle(t.app);
    expect(refused.status).toBe(302);
    const location = new URL(refused.headers.get('location') ?? '', TEST_PUBLIC_URL);
    expect(location.pathname).toBe('/account');
    expect(location.searchParams.get('error')).toBe('SIGNUP_CLOSED');
    expect(sessionCookie(refused)).toBe('');
    expect(await usersWithEmail(t, OTHER)).toHaveLength(0);

    // Neither the sign-up nor the refusal logs an address (AC 8).
    expect(t.lines.length).toBeGreaterThan(0);
    expect(t.lines.filter((line) => line.includes('@'))).toEqual([]);
  });
});

describe('privacy', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_open_signup_logs_no_address_or_code', async () => {
    const t = await openApp({ TRUST_PROXY: 'one-hop' }, { authRateLimit: true });
    let n = 0;
    /** A client address of its own for every request, past Better Auth's per-client limits. */
    const fresh = () => ({ Origin: TEST_PUBLIC_URL, 'X-Forwarded-For': `192.0.2.${++n}` });

    // A sign-up, then six code requests for one address and one for its case variant: the last two are limited.
    const cookie = await signInWeb(t.app, t.outbox, OTHER);
    expect((await sessionOf(t.app, cookie))?.user?.email).toBe(OTHER);
    for (let i = 0; i < 6; i++) {
      expect((await postJson(t.app, SEND_CODE, { email: NEW, type: 'sign-in' }, fresh())).status).toBe(200);
    }
    expect((await postJson(t.app, SEND_CODE, { email: NEW.toUpperCase(), type: 'sign-in' }, fresh())).status).toBe(200);
    expect(t.outbox.filter((m) => m.to === NEW)).toHaveLength(5);

    const limited = t.events().filter((e) => e.event === 'auth.code_limited');
    expect(limited).toHaveLength(2);
    expect(limited[0]).toEqual({ t: expect.any(String), level: 'warn', event: 'auth.code_limited' });
    const codes = t.outbox.map((m) => sentCode([m], m.to));
    expect(t.lines.length).toBeGreaterThan(0);
    for (const line of t.lines) {
      expect(line).not.toContain('@');
      expect(line).not.toMatch(SIX_DIGITS);
      for (const code of codes) expect(line).not.toContain(code);
    }
  });
});
