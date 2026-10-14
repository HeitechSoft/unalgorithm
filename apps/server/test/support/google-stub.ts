/**
 * Google, stubbed, for tests of Google sign-in (CL3-13). `stubGoogle` answers Google's token endpoint with an id token
 * for the identity it is given, signed with an RS256 key made here, and Google's certificate endpoint with that key;
 * every other URL goes to the real `fetch`. Better Auth's fetch helper reads `globalThis.fetch` on every call, so the
 * stub works once it is installed before the request. `signInWithGoogle` walks a browser through the flow on the
 * server's own routes.
 */
import { randomInt } from 'node:crypto';
import { ACCOUNT_PAGE_PATH } from '@unalgorithm/protocol';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { vi } from 'vitest';
import type { App } from '../../src/http/app.ts';
import { cookieHeader, postJson } from './sign-in.ts';
import { TEST_PUBLIC_URL } from './test-app.ts';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** The test server's Google OAuth client, added to `testConfig` to turn Google sign-in on. */
export const TEST_GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const GOOGLE_ENV: Readonly<Record<string, string>> = {
  GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: 'test-secret',
};
/** The access token the stub hands out; the server must neither keep nor log it. */
export const GOOGLE_ACCESS_TOKEN = 'ya29.test';
/** The code Google sends the browser back with in these tests. */
export const GOOGLE_CODE = 'test-code';

/** The two Better Auth routes Google sign-in uses: start it, and Google's redirect back. */
export const GOOGLE_SIGN_IN = '/api/auth/sign-in/social';
export const GOOGLE_CALLBACK = '/api/auth/callback/google';

export interface GoogleIdentity {
  email: string;
  /** Google's `email_verified` claim. Default: true. */
  emailVerified?: boolean;
  /** Google's account id. Default: a random 21-digit number, as Google's are. */
  sub?: string;
  /** The id token's audience. Default: `TEST_GOOGLE_CLIENT_ID`. */
  clientId?: string;
}

export interface GoogleStub {
  /** The account id the id tokens carry. */
  sub: string;
  /** Each token request the server made: its form body. */
  tokenRequests: URLSearchParams[];
  /** Each id token handed out. */
  idTokens: string[];
  /** Puts the real `fetch` back (`vi.restoreAllMocks` does too). */
  restore(): void;
}

/** Answers Google's token and certificate endpoints for `identity` until `restore()`. One stub at a time. */
export async function stubGoogle(identity: GoogleIdentity): Promise<GoogleStub> {
  // A second spy would take over the first and call itself for every other URL.
  if (vi.isMockFunction(globalThis.fetch)) throw new Error('fetch is already stubbed: restore() the earlier stub first.');
  const { email, emailVerified = true, clientId = TEST_GOOGLE_CLIENT_ID } = identity;
  const sub = identity.sub ?? `1${Array.from({ length: 20 }, () => randomInt(10)).join('')}`;
  const kid = 'test-key';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const tokenRequests: URLSearchParams[] = [];
  const idTokens: string[] = [];

  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GOOGLE_TOKEN_URL && url !== GOOGLE_CERTS_URL) return realFetch(input, init);
    const request = new Request(input, init);
    if (url === GOOGLE_TOKEN_URL && request.method === 'POST') {
      tokenRequests.push(new URLSearchParams(await request.text()));
      const idToken = await new SignJWT({ email, email_verified: emailVerified })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer('https://accounts.google.com')
        .setAudience(clientId)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
      idTokens.push(idToken);
      return Response.json({
        access_token: GOOGLE_ACCESS_TOKEN,
        expires_in: 3599,
        token_type: 'Bearer',
        scope: 'openid email',
        id_token: idToken,
      });
    }
    if (request.method === 'GET' && url === GOOGLE_CERTS_URL) return Response.json({ keys: [jwk] });
    return new Response(null, { status: 405 });
  });
  return { sub, tokenRequests, idTokens, restore: () => spy.mockRestore() };
}

/** What the server's own page posts to start Google sign-in, coming back to `back` whether it works or not. */
export function googleSignInBody(back: string = ACCOUNT_PAGE_PATH) {
  return { provider: 'google', callbackURL: back, errorCallbackURL: back, disableRedirect: true };
}

/** Starts Google sign-in from the server's own page: the answer holds Google's address and sets the state cookie. */
export function startGoogleSignIn(app: App, body: unknown = googleSignInBody()): Promise<Response> {
  return postJson(app, GOOGLE_SIGN_IN, body, { Origin: TEST_PUBLIC_URL });
}

/** Google sending the browser back with `code` and `state`, and the browser's `cookie` (none when omitted). */
export function googleCallback(app: App, state: string, cookie?: string, code = GOOGLE_CODE): Promise<Response> {
  const query = new URLSearchParams({ code, state });
  return Promise.resolve(app.request(`${GOOGLE_CALLBACK}?${query}`, cookie ? { headers: { Cookie: cookie } } : {}));
}

/**
 * The whole Google sign-in as a browser goes through it, with `stubGoogle` installed: the page starts it, the person
 * picks their Google account, and Google sends the browser back. Returns the callback's answer, a redirect: to `back`
 * with a session cookie, or to `back` with an `error` parameter.
 */
export async function signInWithGoogle(app: App, back: string = ACCOUNT_PAGE_PATH): Promise<Response> {
  const start = await startGoogleSignIn(app, googleSignInBody(back));
  if (start.status !== 200) throw new Error(`Starting Google sign-in answered ${start.status}.`);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error("Google's address holds no state.");
  return googleCallback(app, state, cookieHeader(start));
}
