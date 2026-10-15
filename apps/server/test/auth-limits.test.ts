import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/ai/limits.ts';
import { CODE_SENDS_PER_EMAIL, emailLimitKey, SIGNIN_CODES_PER_ADDRESS_PER_HOUR } from '../src/auth/better-auth.ts';
import { postJson, SEND_CODE, SIGN_IN, sentCode } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/**
 * The per-address limit on emailed sign-in codes (`mountAuth`'s wrapper, CL5-02): `SIGNIN_CODES_PER_ADDRESS_PER_HOUR`
 * an address, whoever asks, refused before Better Auth so a refusal never makes or swaps a code. The failed sign-in
 * limit's tests are in `auth.test.ts`.
 */
const A = 'a@example.org';
const B = 'b@example.org';
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 15, 12);

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Open sign-ups, so any address is sent codes, with the limiters on and each request from a client of its own. */
async function limitedApp() {
  const t = await createTestApp({
    config: testConfig({ SIGNUP: 'open', SIGNUP_ALLOWLIST: '', TRUST_PROXY: 'one-hop' }),
    authRateLimit: true,
  });
  cleanup.push(() => t.close());
  let n = 0;
  const fresh = () => ({ Origin: TEST_PUBLIC_URL, 'X-Forwarded-For': `192.0.2.${++n}` });
  const sendCode = (email: string) => postJson(t.app, SEND_CODE, { email, type: 'sign-in' }, fresh());
  const signIn = (email: string, otp: string) => postJson(t.app, SIGN_IN, { email, otp }, fresh());
  return { t, sendCode, signIn };
}

const sentTo = (t: TestApp, email: string) => t.outbox.filter((m) => m.to === email).length;

/** Only the clock's date is faked: PGlite and the app's timers keep running. */
function fakeClock(at: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

describe('code limit', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_sixth_code_in_an_hour_refused_fifth_code_still_works', async () => {
    const { t, sendCode, signIn } = await limitedApp();
    fakeClock(T0);
    const codes: string[] = [];
    for (let i = 0; i < SIGNIN_CODES_PER_ADDRESS_PER_HOUR; i++) {
      // A second apart: Better Auth finds the newest code by its creation time.
      vi.setSystemTime(T0 + i * 1000);
      expect((await sendCode(A)).status).toBe(200);
      codes.push(sentCode(t.outbox, A));
    }
    expect(sentTo(t, A)).toBe(5);

    // The sixth: Better Auth's own answer, but no email and no call to Better Auth, so no code is made or swapped.
    const handler = vi.spyOn(t.deps.auth, 'handler');
    // Within the code's five minutes, so the fifth code can still be used below.
    vi.setSystemTime(T0 + 2 * MINUTE);
    const sixth = await sendCode(A);
    expect(sixth.status).toBe(200);
    expect(await sixth.json()).toEqual({ success: true });
    expect(sentTo(t, A)).toBe(5);
    expect(handler).not.toHaveBeenCalled();
    expect(t.events().filter((e) => e.event === 'auth.code_limited')).toHaveLength(1);
    handler.mockRestore();

    // The fifth code, the one last emailed, still signs in.
    const res = await signIn(A, codes[4] ?? '');
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('better-auth.session_token='))).toBe(true);
  });

  it('test_refused_code_requests_do_not_extend_window', async () => {
    const { t, sendCode } = await limitedApp();
    fakeClock(T0);
    for (let i = 0; i < 5; i++) expect((await sendCode(A)).status).toBe(200);
    expect(sentTo(t, A)).toBe(5);

    // Refused requests in between take nothing and push nothing back.
    for (const minutes of [1, 6, 11]) {
      vi.setSystemTime(T0 + minutes * MINUTE);
      expect(await (await sendCode(A)).json()).toEqual({ success: true });
    }
    expect(sentTo(t, A)).toBe(5);

    // The count refills over the hour: one code every 12 minutes from the first send...
    vi.setSystemTime(T0 + 12 * MINUTE);
    expect((await sendCode(A)).status).toBe(200);
    expect(sentTo(t, A)).toBe(6);
    vi.setSystemTime(T0 + 13 * MINUTE);
    await sendCode(A);
    expect(sentTo(t, A)).toBe(6);
    // ...and 61 minutes after the first send, codes go out again.
    vi.setSystemTime(T0 + 61 * MINUTE);
    expect((await sendCode(A)).status).toBe(200);
    expect(sentTo(t, A)).toBe(7);
  });

  it('test_code_limit_is_per_normalised_address', async () => {
    const { t, sendCode } = await limitedApp();
    // Case only: Better Auth refuses an address with surrounding spaces (400).
    for (let i = 0; i < 5; i++) expect((await sendCode(i % 2 === 0 ? A : 'A@Example.ORG')).status).toBe(200);
    expect(sentTo(t, A)).toBe(5);
    expect((await sendCode('A@Example.ORG')).status).toBe(200);
    expect((await sendCode(A)).status).toBe(200);
    expect(sentTo(t, A)).toBe(5);

    // Another address has its own five.
    expect((await sendCode(B)).status).toBe(200);
    expect(sentTo(t, B)).toBe(1);
  });

  it('test_code_limiter_holds_only_hashes_and_forgets', () => {
    const keys = [' A@Example.org ', 'a@example.org', 'someone.else@example.com'].map(emailLimitKey);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain('@');
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);

    const sends = createRateLimiter(CODE_SENDS_PER_EMAIL);
    expect(sends.take(keys[0] ?? '', T0).ok).toBe(true);
    expect(sends.size).toBe(1);
    // After an hour without a request, the address's count is dropped on the next request for any address.
    expect(sends.take(keys[2] ?? '', T0 + 60 * MINUTE).ok).toBe(true);
    expect(sends.size).toBe(1);
  });
});
