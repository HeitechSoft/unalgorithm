/**
 * A fake server for the account page's tests: `fetch` stubbed with the server's routes, keeping a session as the real one
 * does (an accepted code starts it and signing out ends it), and every request recorded.
 */
import { SERVER_INFO_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { vi } from 'vitest';
import { SEND_CODE_PATH, SESSION_PATH, SIGN_IN_PATH, SIGN_OUT_PATH } from '../../src/api.ts';

export const TOM = 'tom@example.com';
export const SIGNED_IN = `Signed in as ${TOM}`;

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
 * address signed in at the start, or null for none; an accepted code signs in as TOM and signing out ends the session.
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
  return { calls, count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length };
}
