import { AIError, codeForStatus, describeError, isAIError } from '@unalgorithm/ai';
import { createLock, safeExternalUrl } from '@unalgorithm/core';
import {
  b64url,
  chromiumRedirectUri,
  EMAIL_OTP_METHOD,
  REVOKE_PATH,
  RevokeRequestSchema,
  SERVER_INFO_PATH,
  ServerErrorSchema,
  type ServerInfo,
  ServerInfoSchema,
  TokenRequestSchema,
  type TokenResponse,
  TokenResponseSchema,
} from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import type { BgError } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import { getSecret, setSecret } from './idb.ts';

/**
 * Discovery, sign-in and device tokens for a `server` AI source (R10). Sign-in never touches a password: the server's
 * own page runs in `launchWebAuthFlow`, and the single-use code it sends back is traded, with the PKCE verifier, for a
 * device's tokens. The refresh token is a credential, so it lives in the extension-origin secrets store that content
 * scripts cannot open (ADR 0005); the 15-minute access token lives in session storage, which is memory only and closed
 * to content scripts. Neither is ever written to `storage.local`, sent to a content script, logged, synced or exported.
 */

export interface ServerAccount {
  origin: string;
  email: string;
  deviceId: string;
  signedInAt: number;
  info: ServerInfo;
  /** The server refused the refresh token: the account stays (for "Sign in to … again") but has no tokens. */
  needsSignIn: boolean;
}

/** One account at a time. No credentials in here. */
export const serverAccountItem = storage.defineItem<ServerAccount | null>('local:serverAccount', { fallback: null });
const accessItem = storage.defineItem<{ origin: string; token: string; expiresAt: number } | null>('session:serverAccess', {
  fallback: null,
});
const refreshKey = (origin: string) => `server-refresh:${origin}`;

/**
 * Every change to the account and its tokens runs one at a time, so a refresh never reads a half-swapped account and
 * never stores tokens for an account that was signed out or replaced while it waited for the server.
 */
const exclusive = createLock();

export interface AuthDeps {
  fetch: typeof fetch;
  webAuthFlow: typeof webAuthFlow;
  now: () => number;
}

export type DiscoverResult = { ok: true; origin: string; info: ServerInfo } | { ok: false; error: BgError };
export type SignInResult = { ok: true; account: ServerAccount } | { ok: false; error: BgError };

/** Tokens must not cross the network in clear, except to a server on this computer. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TIMEOUT_MS = 10_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** An access token this close to expiry is refreshed first, so it cannot run out in flight. */
const REFRESH_MARGIN_MS = 60_000;
const E2E_FLOW_TIMEOUT_MS = 5 * 60_000;

const NOT_A_SERVER = "That address isn't an UnAlgorithm server.";
const UNFINISHED = "Sign-in didn't finish. Try again.";

function withDefaults(deps: Partial<AuthDeps>): AuthDeps {
  return { fetch: (input, init) => fetch(input, init), webAuthFlow, now: () => Date.now(), ...deps };
}

function toBgError(e: unknown): BgError {
  return isAIError(e) ? { code: e.code, message: e.message } : { code: 'unknown', message: describeError('unknown') };
}

/** Checks that an address is an UnAlgorithm server this extension can sign in to, and reads its discovery document. */
export async function discoverServer(input: string, deps: Partial<AuthDeps> = {}): Promise<DiscoverResult> {
  const href = safeExternalUrl(input);
  if (!href) {
    return { ok: false, error: { code: 'bad-request', message: "Enter the server's address, like https://ai.example.org" } };
  }
  const url = new URL(href);
  if (url.protocol !== 'https:' && !LOOPBACK.has(url.hostname)) {
    return { ok: false, error: { code: 'bad-request', message: 'Use an https:// address.' } };
  }
  try {
    const res = await call(withDefaults(deps), new URL(SERVER_INFO_PATH, url.origin), TIMEOUT_MS);
    const info = res.ok ? ServerInfoSchema.safeParse(await res.json().catch(() => null)) : null;
    if (!info?.success || !info.data.auth.methods.includes(EMAIL_OTP_METHOD)) {
      return { ok: false, error: { code: 'unsupported', message: NOT_A_SERVER } };
    }
    return { ok: true, origin: url.origin, info: info.data };
  } catch (e) {
    return { ok: false, error: toBgError(e) };
  }
}

/** Signs in to the server at `input` and makes it the account, signing the previous account out. */
export async function signIn(input: string, deps: Partial<AuthDeps> = {}): Promise<SignInResult> {
  const d = withDefaults(deps);
  const found = await discoverServer(input, d);
  if (!found.ok) return found;
  try {
    return { ok: true, account: await authorize(found.origin, found.info, d) };
  } catch (e) {
    return { ok: false, error: toBgError(e) };
  }
}

async function authorize(origin: string, info: ServerInfo, d: AuthDeps): Promise<ServerAccount> {
  if (!browser.identity) throw new AIError('permission', 'UnAlgorithm needs permission to open the sign-in window.');
  const clientId = browser.runtime.id;
  const redirectUri = chromiumRedirectUri(clientId);
  // Servers bind every code to this address (CL1-01): a browser that sends the sign-in window elsewhere can't finish.
  if (browser.identity.getRedirectURL() !== redirectUri) {
    throw new AIError('not-available', "This browser can't open the sign-in window.");
  }

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(info.auth.authorizePath, origin);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  let redirect: string | undefined;
  try {
    redirect = await d.webAuthFlow({ url: url.href, interactive: true });
  } catch {
    // The person closed the window (or the browser did).
    throw new AIError('auth-required', 'Sign-in was cancelled.');
  }
  const back = redirect?.startsWith(redirectUri) ? new URL(redirect).searchParams : undefined;
  const request = TokenRequestSchema.safeParse({
    grant_type: 'authorization_code',
    code: back?.get('code') ?? undefined,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (back?.get('state') !== state || !request.success) throw new AIError('auth-required', UNFINISHED);

  const res = await call(d, new URL(info.auth.tokenPath, origin), TIMEOUT_MS, request.data);
  if (res.status === 401) throw new AIError('auth-required', UNFINISHED);
  const tokens = await readTokens(res, origin);

  const now = d.now();
  const account: ServerAccount = {
    origin,
    email: tokens.account.email,
    deviceId: tokens.device_id,
    signedInAt: now,
    info,
    needsSignIn: false,
  };
  // One account at a time: a device left behind on the previous server (or an older one on this server) is ended.
  const replaced = await exclusive(async () => {
    const previous = await serverAccountItem.getValue();
    const spent = previous ? { origin: previous.origin, refreshToken: await forget(previous.origin) } : undefined;
    await storeTokens(origin, tokens, now);
    await serverAccountItem.setValue(account);
    return spent;
  });
  if (replaced) await revoke(replaced.origin, replaced.refreshToken, d);
  return account;
}

/** One refresh per origin at a time: a second refresh with the same token would look like theft and revoke the device. */
const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for the account at `origin`, refreshed when it is close to expiry or `forceRefresh` is set
 * (after the server answered 401). Throws `AIError('auth-required')` when the person has to sign in again.
 */
export async function getAccessToken(
  origin: string,
  opts: { forceRefresh?: boolean } = {},
  deps: Partial<AuthDeps> = {},
): Promise<string> {
  const d = withDefaults(deps);
  if (!opts.forceRefresh) {
    const access = await accessItem.getValue();
    if (access?.origin === origin && access.expiresAt - d.now() > REFRESH_MARGIN_MS) return access.token;
  }
  let pending = refreshing.get(origin);
  if (!pending) {
    pending = exclusive(() => refresh(origin, d)).finally(() => refreshing.delete(origin));
    refreshing.set(origin, pending);
  }
  return pending;
}

/** Runs under `exclusive`. */
async function refresh(origin: string, d: AuthDeps): Promise<string> {
  const account = await serverAccountItem.getValue();
  const refreshToken = account?.origin === origin ? await getSecret(refreshKey(origin)) : undefined;
  const tokenUrl = account && tokenEndpoint(account);
  if (!refreshToken || !tokenUrl) return requireSignIn(origin);
  const body = { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: browser.runtime.id };
  const res = await call(d, tokenUrl, TIMEOUT_MS, body);
  if (res.status === 401) return requireSignIn(origin);
  const tokens = await readTokens(res, origin);
  await storeTokens(origin, tokens, d.now());
  return tokens.access_token;
}

/**
 * Where the account's refresh token may go. The account sits in `storage.local`, which content scripts can write
 * (ADR 0005), so its discovery document is checked again and the endpoint must be on the account's own origin.
 */
function tokenEndpoint(account: ServerAccount): URL | undefined {
  const info = ServerInfoSchema.safeParse(account.info);
  if (!info.success) return undefined;
  try {
    const url = new URL(info.data.auth.tokenPath, account.origin);
    return url.origin === account.origin ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server no longer accepts this device: forget its tokens and keep the account, marked for signing in again.
 * Runs under `exclusive`, so the account it marks is the one whose refresh token was refused.
 */
async function requireSignIn(origin: string): Promise<never> {
  await Promise.all([setSecret(refreshKey(origin), undefined), clearAccess(origin)]);
  await markAccount(origin);
  throw new AIError('auth-required', describeError('auth-required', serverLabel(origin).title));
}

/**
 * The server refused a request made with a freshly refreshed access token (CL1-17): the account is marked for signing
 * in again. Its refresh token stays, so the next sign-in can still end this device on the server.
 */
export function markNeedsSignIn(origin: string): Promise<void> {
  return exclusive(() => markAccount(origin));
}

/** Runs under `exclusive`. */
async function markAccount(origin: string): Promise<void> {
  const account = await serverAccountItem.getValue();
  if (account?.origin === origin && !account.needsSignIn) await serverAccountItem.setValue({ ...account, needsSignIn: true });
}

/**
 * Always forgets the account, its refresh token and its access token here, then ends this device on the server (best
 * effort, the server may be gone).
 */
export async function signOut(origin: string, deps: Partial<AuthDeps> = {}): Promise<void> {
  // Forgotten here before the server is asked, so nothing that starts while it answers finds the account or its tokens.
  // A refresh already in flight finishes first, and the refresh token it stored is the one revoked.
  const refreshToken = await exclusive(() => forget(origin));
  await revoke(origin, refreshToken, withDefaults(deps));
}

/** Forgets the account at `origin` and its tokens here, and returns the refresh token to revoke. Runs under `exclusive`. */
async function forget(origin: string): Promise<string | undefined> {
  const refreshToken = await getSecret(refreshKey(origin)).catch(() => undefined);
  await Promise.all([
    setSecret(refreshKey(origin), undefined),
    clearAccess(origin),
    serverAccountItem.getValue().then((a) => (a?.origin === origin ? serverAccountItem.removeValue() : undefined)),
  ]);
  return refreshToken;
}

/** Ends the device on the server, best effort: the server may be gone, and its refresh token expires on its own. */
async function revoke(origin: string, refreshToken: string | undefined, d: AuthDeps): Promise<void> {
  const body = RevokeRequestSchema.safeParse({ refresh_token: refreshToken, client_id: browser.runtime.id });
  if (!body.success) return;
  try {
    await call(d, new URL(REVOKE_PATH, origin), REVOKE_TIMEOUT_MS, body.data);
  } catch {
    // Signed out here all the same.
  }
}

async function storeTokens(origin: string, tokens: TokenResponse, now: number): Promise<void> {
  // The refresh token first: the old one is spent once the server has answered.
  await setSecret(refreshKey(origin), tokens.refresh_token);
  await accessItem.setValue({ origin, token: tokens.access_token, expiresAt: now + tokens.expires_in * 1000 });
}

async function clearAccess(origin: string): Promise<void> {
  if ((await accessItem.getValue())?.origin === origin) await accessItem.removeValue();
}

/**
 * A request to the server: no cookies (the server's web session stays out of it), no redirects to follow, a bounded
 * wait. A JSON `body` makes it a POST. A request that never gets an answer is a `network` error.
 */
async function call(d: AuthDeps, url: URL, timeoutMs: number, body?: unknown): Promise<Response> {
  try {
    return await d.fetch(url.href, {
      ...(body === undefined
        ? {}
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AIError('network', describeError('network'), { cause: err });
  }
}

/**
 * The tokens in a token endpoint answer. Errors carry the extension's own words for the server's error code, never
 * the server's text, so a server cannot put its own sign-in instructions on the extension's screens.
 */
async function readTokens(res: Response, origin: string): Promise<TokenResponse> {
  const { title } = serverLabel(origin);
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const tokens = TokenResponseSchema.safeParse(body);
    if (tokens.success) return tokens.data;
    throw new AIError('unknown', describeError('unknown'));
  }
  // The server doesn't list this extension (CL1-09).
  if (res.status === 403) throw new AIError('permission', `${title} doesn't accept sign-ins from this extension.`);
  const wire = ServerErrorSchema.safeParse(body);
  const code = wire.success ? wire.data.code : codeForStatus(res.status, '', new URL(origin).hostname);
  throw new AIError(code, describeError(code, title));
}

/**
 * Opens the server's sign-in page and resolves with the URL it sends the browser back to. `--mode e2e` builds use a tab
 * instead of the `launchWebAuthFlow` window, which Playwright cannot drive; everything after the redirect is the same.
 */
export function webAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> {
  if (import.meta.env.MODE === 'e2e') return tabAuthFlow(details.url);
  return browser.identity.launchWebAuthFlow(details);
}

/**
 * e2e builds only. Resolves with the first URL of the opened tab that starts with the redirect address, and closes
 * the tab. Chrome reports that URL only with a host permission for the chromiumapp.org address, which the e2e manifest
 * has (CL1-19); never the `tabs` permission.
 */
function tabAuthFlow(url: string): Promise<string> {
  const redirectUri = chromiumRedirectUri(browser.runtime.id);
  return new Promise((resolve, reject) => {
    let tabId: number | undefined;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
      settle();
    };
    const onUpdated = (id: number, change: { url?: string }) => {
      const next = change.url;
      if (id !== tabId || !next?.startsWith(redirectUri)) return;
      finish(() => resolve(next));
      browser.tabs.remove(id).catch(() => undefined);
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new Error('The sign-in tab was closed.')));
    };
    const timer = setTimeout(() => finish(() => reject(new Error('Sign-in took too long.'))), E2E_FLOW_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.create({ url }).then(
      (tab) => {
        tabId = tab.id;
      },
      (err: unknown) => finish(() => reject(err)),
    );
  });
}
