import { isAIError } from '@unalgorithm/ai';
import { CLOUD_DATA, hasConsent } from '../lib/data-consent.ts';
import { MAX_SERVER_BODY_BYTES, readBoundedJson } from './bounded-body.ts';
import { getAccessToken, markNeedsSignIn } from './server-auth.ts';

/**
 * Signed-in requests from the background to the account's server (R10): the device's access token as a bearer token,
 * one forced refresh and one retry after a 401, no cookies (the server's web session stays out of it), no redirects to
 * follow, and a bounded wait. Every outcome is a `ServerResult`, never a throw, so each caller decides what a failure
 * means for it. The classify request keeps its own path (CL1-17): it turns every failure into per-post results.
 *
 * In Firefox nothing goes out without the server's data-collection consent (`CLOUD_DATA`, ADR 0008), checked before
 * every request, before the token is even read: the balance, the devices, sync and server jobs all come through here.
 * Only signing out (`server-auth.ts`) reaches the server without it.
 *
 * The token goes into the `Authorization` header and nowhere else: it is never logged, returned or stored here, and
 * the server's message text is handed back as part of `body` only, for the caller to read codes from.
 */

export interface ServerHttpDeps {
  fetch: typeof fetch;
  getAccessToken: typeof getAccessToken;
  markNeedsSignIn: typeof markNeedsSignIn;
}

export type ServerResult =
  /** 2xx; `body` is the parsed JSON, null when empty, not JSON or over the request's `maxBytes`. */
  | { ok: true; status: number; body: unknown }
  /** Any other HTTP status; `body` is the parsed JSON, null when empty, not JSON or over the request's `maxBytes`. */
  | { ok: false; status: number; body: unknown }
  /**
   * No answer to use: 'auth' when the person has to sign in again, 'aborted' when the caller's `signal` fired, 'consent'
   * when Firefox's consent to send to the server is missing (nothing was sent), and 'network' for everything else (no
   * answer, the timeout, a token that couldn't be refreshed, a path off `origin`).
   */
  | { ok: false; status: 0; reason: 'auth' | 'network' | 'aborted' | 'consent' };

export interface ServerRequestInit {
  /** Default GET. A POST sends `body` as JSON. */
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
  /** Each attempt's wait, including reading the answer. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Default true. The balance refresh passes false: there the classify path decides about signing in again (CL2-10). */
  markNeedsSignIn?: boolean;
  /** Largest answer read, default `MAX_SERVER_BODY_BYTES`. A sync pull passes more: a full page can hold megabytes. */
  maxBytes?: number;
}

const failed = (reason: 'auth' | 'network' | 'aborted' | 'consent'): ServerResult => ({ ok: false, status: 0, reason });

function withDefaults(deps: Partial<ServerHttpDeps>): ServerHttpDeps {
  return { fetch: (input, init) => fetch(input, init), getAccessToken, markNeedsSignIn, ...deps };
}

/** A request to `path` on `origin` with the account's access token. Never rejects. */
export async function serverRequest(
  origin: string,
  path: string,
  init: ServerRequestInit,
  deps: Partial<ServerHttpDeps> = {},
): Promise<ServerResult> {
  const d = withDefaults(deps);
  try {
    // The path is a protocol constant, and the token is for `origin` only: a URL that leaves it gets no request.
    const url = new URL(path, origin);
    if (url.origin !== origin) return failed('network');
    if (!(await hasConsent(CLOUD_DATA))) return failed('consent');
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    const post = init.method === 'POST';
    const body = post ? JSON.stringify(init.body) : undefined;

    /** One attempt with `bearer`, read to the end within `timeoutMs`. */
    const send = async (bearer: string): Promise<ServerResult> => {
      const timeout = AbortSignal.timeout(init.timeoutMs);
      try {
        const authorization = `Bearer ${bearer}`;
        const res = await d.fetch(url.href, {
          ...(post
            ? { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body }
            : { method: 'GET', headers: { authorization } }),
          credentials: 'omit',
          redirect: 'error',
          signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
        });
        if (res.status === 401) return { ok: false, status: 401, body: null };
        const parsed = await readBoundedJson(res, init.maxBytes ?? MAX_SERVER_BODY_BYTES);
        return res.ok ? { ok: true, status: res.status, body: parsed } : { ok: false, status: res.status, body: parsed };
      } catch {
        return failed(init.signal?.aborted ? 'aborted' : 'network');
      }
    };

    const first = await token(origin, d, false);
    if (typeof first !== 'string') return first;
    const reply = await send(first);
    if (reply.status !== 401) return reply;
    // The access token was revoked or ran out early: one refresh, one retry (the refresh itself is single-flight).
    const second = await token(origin, d, true);
    if (typeof second !== 'string') return second;
    const retry = await send(second);
    if (retry.status !== 401) return retry;
    // Refused with a freshly refreshed token: the server no longer accepts this device.
    if (init.markNeedsSignIn !== false) await d.markNeedsSignIn(origin).catch(() => undefined);
    return failed('auth');
  } catch {
    return failed('network');
  }
}

/**
 * The account's access token, or the result for a token that can't be had: 'auth' when the person has to sign in
 * again (`getAccessToken` has marked the account), 'network' for any other failure, the refresh's included.
 */
async function token(origin: string, d: ServerHttpDeps, forceRefresh: boolean): Promise<string | ServerResult> {
  try {
    return forceRefresh ? await d.getAccessToken(origin, { forceRefresh: true }) : await d.getAccessToken(origin);
  } catch (err) {
    return failed(isAIError(err) && err.code === 'auth-required' ? 'auth' : 'network');
  }
}
