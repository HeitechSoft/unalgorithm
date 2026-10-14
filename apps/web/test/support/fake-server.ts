/**
 * A fake server for the web app's tests: `fetch` stubbed with the server's routes, keeping a session as the real one
 * does (an accepted code or passkey starts it and signing out ends it), and every request recorded. Also the query the
 * extension opens the authorize page with, and what Google and a passkey sign-in answer.
 */
import { AUTHORIZE_API_PATH, chromiumRedirectUri, SERVER_INFO_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { vi } from 'vitest';
import {
  PASSKEY_AUTH_OPTIONS_PATH,
  PASSKEY_AUTH_VERIFY_PATH,
  SEND_CODE_PATH,
  SESSION_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  SOCIAL_SIGN_IN_PATH,
} from '../../src/api.ts';

export const TOM = 'tom@example.com';
export const SIGNED_IN = `Signed in as ${TOM}`;

export const EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
/** The query `launchWebAuthFlow` opens the authorize page with. */
export const PARAMS = {
  client_id: EXTENSION_ID,
  redirect_uri: chromiumRedirectUri(EXTENSION_ID),
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  state: 'Qm9vdHN0cmFwLXN0YXRlLTE',
};
/** Where the authorize endpoint sends the browser: back to the extension with its single-use code. */
export const REDIRECT = `${PARAMS.redirect_uri}?code=${'c'.repeat(43)}&state=${PARAMS.state}`;

/** Google's address `sign-in/social` answers, where the page sends the browser. */
export const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client&state=test-state';
/** The authentication options Better Auth's passkey plugin answers, as `startAuthentication` receives them. */
export const PASSKEY_OPTIONS = {
  challenge: 'cGFzc2tleS1jaGFsbGVuZ2U',
  timeout: 300000,
  rpId: 'localhost',
  userVerification: 'preferred',
};

export const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://example.org/source/server-v0.1.0',
  billing: false,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
  limits: { maxPostsPerRequest: 12 },
};

export type Answer = { status: number; body?: unknown };
/** An answer, `'offline'` for none at all (`fetch` rejects), or a function for one that arrives when the test says. */
export type Reply = Answer | 'offline' | (() => Answer | Promise<Answer>);
export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stubs `fetch` with the server's routes (keyed `METHOD path`; `routes` replaces or adds any of them). `session` is the
 * address signed in at the start, or null for none; an accepted code or passkey signs in as TOM and signing out ends
 * the session.
 */
export function fakeServer({
  session = null,
  info = INFO,
  routes = {},
}: {
  session?: string | null;
  info?: ServerInfo;
  routes?: Record<string, Reply>;
} = {}) {
  const calls: Call[] = [];
  let current = session;
  const all: Record<string, Reply> = {
    [`GET ${SERVER_INFO_PATH}`]: { status: 200, body: info },
    [`GET ${SESSION_PATH}`]: () => ({
      status: 200,
      body: current ? { session: { userId: 'u1' }, user: { email: current } } : null,
    }),
    [`POST ${SEND_CODE_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${SIGN_IN_PATH}`]: () => {
      current = TOM;
      return { status: 200, body: { token: 'session-token', user: { email: TOM } } };
    },
    [`POST ${SIGN_OUT_PATH}`]: () => {
      current = null;
      return { status: 200, body: { success: true } };
    },
    [`POST ${AUTHORIZE_API_PATH}`]: { status: 200, body: { redirect: REDIRECT } },
    [`POST ${SOCIAL_SIGN_IN_PATH}`]: { status: 200, body: { url: GOOGLE_URL, redirect: false } },
    [`GET ${PASSKEY_AUTH_OPTIONS_PATH}`]: { status: 200, body: PASSKEY_OPTIONS },
    [`POST ${PASSKEY_AUTH_VERIFY_PATH}`]: () => {
      current = TOM;
      return { status: 200, body: { session: { userId: 'u1' } } };
    },
    ...routes,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = all[`${method} ${path}`] ?? { status: 404, body: { code: 'bad-request', message: 'Not found.' } };
    if (route === 'offline') throw new TypeError('Failed to fetch');
    const reply = typeof route === 'function' ? await route() : route;
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length,
  };
}
