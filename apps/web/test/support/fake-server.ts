/**
 * A fake server for the web app's tests: `fetch` stubbed with the server's routes, keeping a session as the real one
 * does (an accepted code or passkey starts it and signing out ends it), and every request recorded. Also the query the
 * extension opens the authorize page with, and what Google and a passkey sign-in answer. The account's devices and
 * passkeys are kept too: revoking or removing one takes it off its list and adding a passkey puts one on. The account
 * exports as `EXPORT`, and deleting it (with the address typed again) ends the session. Without a session those routes
 * answer 401, as the real ones do.
 */
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_EXPORT_PATH,
  type AccountDevice,
  type AccountExport,
  AUTHORIZE_API_PATH,
  chromiumRedirectUri,
  SERVER_INFO_PATH,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { vi } from 'vitest';
import {
  PASSKEY_AUTH_OPTIONS_PATH,
  PASSKEY_AUTH_VERIFY_PATH,
  PASSKEY_DELETE_PATH,
  PASSKEY_LIST_PATH,
  PASSKEY_REGISTER_OPTIONS_PATH,
  PASSKEY_REGISTER_VERIFY_PATH,
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

/** The registration options Better Auth's passkey plugin answers, as `startRegistration` receives them. */
export const REGISTER_OPTIONS = {
  challenge: 'cmVnaXN0ZXItY2hhbGxlbmdl',
  rp: { name: 'Example AI', id: 'localhost' },
  user: { id: 'dTE', name: TOM, displayName: TOM },
  pubKeyCredParams: [
    { alg: -8, type: 'public-key' },
    { alg: -7, type: 'public-key' },
  ],
  timeout: 300000,
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  attestation: 'none',
};

/** A passkey as `list-user-passkeys` answers it: the whole row, of which the page shows the id, name and date. */
export interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | null;
  userId: string;
  publicKey: string;
  credentialID: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string;
  aaguid: string | null;
}

/** A passkey of the signed-in account. */
export function passkeyRow(id: string, name: string | null, createdAt: string | null): PasskeyRow {
  return {
    id,
    name,
    createdAt,
    userId: 'u1',
    publicKey: 'cHVibGljLWtleQ',
    credentialID: `Y3JlZGVudGlhbC0${id}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    transports: 'internal,hybrid',
    aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
  };
}

/** The passkey `verify-registration` stores: the server labels it from the authenticator's model (CL3-14). */
export const ADDED_PASSKEY = passkeyRow('pk-added', 'Google Password Manager', '2026-10-14T12:00:00.000Z');

/** What the account routes answer without a session. */
const SESSION_GONE = { status: 401, body: { code: 'auth-required', message: 'Sign in again.' } };

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

/** What `GET /v1/account/export` answers for TOM. */
export const EXPORT: AccountExport = {
  v: 1,
  exportedAt: '2026-10-14T12:00:00.000Z',
  server: { name: INFO.name, origin: 'https://ai.example.org', version: INFO.version },
  account: { email: TOM, createdAt: '2026-08-20T12:00:00.000Z', linkedProviders: ['credential'] },
  devices: [
    {
      id: '4f5d8a2e-6b1c-4c3d-9e8f-0a1b2c3d4e5f',
      name: 'Chrome on Windows',
      createdAt: '2026-09-02T15:00:00.000Z',
      lastUsedAt: '2026-10-13T09:30:00.000Z',
      revokedAt: null,
      revokedReason: null,
    },
  ],
  passkeys: [{ name: 'iCloud Keychain', createdAt: '2026-09-01T12:00:00.000Z', deviceType: 'multiDevice', backedUp: true }],
  sessions: [{ createdAt: '2026-10-14T11:55:00.000Z', expiresAt: '2026-10-15T11:55:00.000Z', ipAddress: null, userAgent: null }],
  usage: [{ day: '2026-10-13', task: 'classify', requests: 3, postsRequested: 30, postsOk: 30 }],
  sync: { spaces: [] },
  billing: null,
};

export type Answer = { status: number; body?: unknown };
export interface Call {
  method: string;
  path: string;
  body: unknown;
}
/**
 * An answer, `'offline'` for none at all (`fetch` rejects), or a function of the request for one that depends on it or
 * arrives when the test says.
 */
export type Reply = Answer | 'offline' | ((call: Call) => Answer | Promise<Answer>);

/**
 * Stubs `fetch` with the server's routes (keyed `METHOD path`; `routes` replaces or adds any of them). `session` is the
 * address signed in at the start, or null for none; an accepted code or passkey signs in as TOM and signing out ends
 * the session. `devices` and `passkeys` are the account's at the start (none by default).
 */
export function fakeServer({
  session = null,
  info = INFO,
  devices = [],
  passkeys = [],
  routes = {},
}: {
  session?: string | null;
  info?: ServerInfo;
  devices?: readonly AccountDevice[];
  passkeys?: readonly PasskeyRow[];
  routes?: Record<string, Reply>;
} = {}) {
  const calls: Call[] = [];
  let current = session;
  let deviceList = [...devices];
  let passkeyList = [...passkeys];
  /** `answer` with a session, 401 without one. */
  const withSession =
    (answer: (call: Call) => Answer): Reply =>
    (call) =>
      current ? answer(call) : SESSION_GONE;
  /** The body's field `name`, when it is a string. */
  const field = (call: Call, name: string): string | undefined => {
    const value = (call.body as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value : undefined;
  };
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
    [`GET ${ACCOUNT_DEVICES_PATH}`]: withSession(() => ({ status: 200, body: { v: 1, devices: deviceList } })),
    [`POST ${ACCOUNT_DEVICE_REVOKE_PATH}`]: withSession((call) => {
      const id = field(call, 'device_id');
      if (!deviceList.some((d) => d.id === id)) return { status: 404, body: { code: 'not-found', message: 'Not found.' } };
      deviceList = deviceList.filter((d) => d.id !== id);
      return { status: 200, body: { ok: true } };
    }),
    [`GET ${PASSKEY_LIST_PATH}`]: withSession(() => ({ status: 200, body: passkeyList })),
    [`GET ${PASSKEY_REGISTER_OPTIONS_PATH}`]: withSession(() => ({ status: 200, body: REGISTER_OPTIONS })),
    [`POST ${PASSKEY_REGISTER_VERIFY_PATH}`]: withSession(() => {
      passkeyList = [...passkeyList, ADDED_PASSKEY];
      return { status: 200, body: ADDED_PASSKEY };
    }),
    [`GET ${ACCOUNT_EXPORT_PATH}`]: withSession(() => ({ status: 200, body: EXPORT })),
    [`POST ${ACCOUNT_DELETE_PATH}`]: withSession((call) => {
      if (field(call, 'confirm')?.trim().toLowerCase() !== current?.toLowerCase()) {
        return { status: 400, body: { code: 'bad-request', message: 'The address does not match.' } };
      }
      current = null;
      return { status: 200, body: { ok: true } };
    }),
    [`POST ${PASSKEY_DELETE_PATH}`]: withSession((call) => {
      const id = field(call, 'id');
      if (!passkeyList.some((p) => p.id === id)) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found.' } };
      passkeyList = passkeyList.filter((p) => p.id !== id);
      return { status: 200, body: { status: true } };
    }),
    ...routes,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    const call: Call = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = all[`${method} ${path}`] ?? { status: 404, body: { code: 'bad-request', message: 'Not found.' } };
    if (route === 'offline') throw new TypeError('Failed to fetch');
    const reply = typeof route === 'function' ? await route(call) : route;
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
