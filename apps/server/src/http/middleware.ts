/**
 * The HTTP rules every route depends on, fixed once: a request log that holds no bodies, query strings, headers or
 * addresses; the client address taken from exactly one proxy hop; and CORS that answers extension pages only. The
 * problem report route has CORS of its own (`reportsCors`, `extensionOriginOnly`).
 */
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import { clientKind, REPORT_ERRORS } from '@unalgorithm/protocol';
import type { Context, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { Config } from '../config.ts';
import type { Logger } from '../log.ts';

/** What the middleware stores on each request, for routes to read. */
export interface AppVariables {
  /** This request's id: in the `http` log line, in `X-Request-Id`, and in every log line about the request. */
  rid: string;
  /** See `getClientIp`. */
  clientIp: string | null;
}

export interface AppEnv {
  Variables: AppVariables;
}

/**
 * One `http` line per request, written after the response: the request id, method, path, status and duration. Never
 * the query string, a header, the body, the address or the user agent. The id is ours (`crypto.randomUUID()`) and goes
 * back in `X-Request-Id`; a client's own `X-Request-Id` is ignored.
 */
export function requestLog(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    const rid = crypto.randomUUID();
    c.set('rid', rid);
    await next();
    c.header('X-Request-Id', rid);
    log.info('http', {
      rid,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}

/**
 * Hono hands only `Error`s to `onError`. Any other thrown value (a string, a plain object, an abort reason) would
 * escape the app: Node would answer an empty 500 with no CORS header, and no `http` line would be written. This turns
 * such a value into an `Error` named `NonError` that leaves the value behind (it may hold post text), so `onError`
 * answers and logs it like any other failure. Registered after the other middleware, closest to the routes, so every
 * middleware above it still adds its headers and writes its log line.
 */
export function nonErrorsAsErrors(): MiddlewareHandler {
  return async (_c, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof Error) throw err;
      const wrapped = new Error('A value that is not an Error was thrown.');
      wrapped.name = 'NonError';
      throw wrapped;
    }
  };
}

/** Counts the requests whose handlers are still running, so a stopping server can wait for them. */
export interface InFlightRequests {
  /** The middleware that counts; registered first, so a request counts until every handler and middleware is done. */
  readonly track: MiddlewareHandler;
  readonly count: number;
  /** Resolves true once no request is in flight, or false when `limitMs` runs out first. */
  drained(limitMs: number): Promise<boolean>;
}

/**
 * A handler can outlive its connection: when a stopping server closes it, the classify route still releases or settles
 * the hold and writes its usage row. The server waits for this count to reach 0 before it closes the database.
 */
export function inFlightRequests(): InFlightRequests {
  let count = 0;
  const waiters = new Set<() => void>();
  return {
    track: async (_c, next) => {
      count++;
      try {
        await next();
      } finally {
        if (--count === 0) for (const wake of waiters) wake();
      }
    },
    get count() {
      return count;
    },
    drained: (limitMs) =>
      new Promise<boolean>((resolve) => {
        if (count === 0) return resolve(true);
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(false);
        }, limitMs);
        waiters.add(wake);
      }),
  };
}

/**
 * Once `stopping` is aborted, every answer says `Connection: close`, and Node closes the connection after it. Without
 * that, a stopping server keeps a connection open while its client sends the next request on it (the extension's sync
 * loop does, every few seconds), and the stop waits its whole grace period.
 */
export function closeWhenStopping(stopping: AbortSignal): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (stopping.aborted) c.header('Connection', 'close');
  };
}

/**
 * Stores the client's address for `getClientIp`. With `none` it is the socket's address and `X-Forwarded-For` is
 * ignored entirely. With `one-hop` (behind our nginx, which sets the header to the address it saw) it is the right-most
 * `X-Forwarded-For` entry: anything left of it was written by the client. The socket address stands in when that entry
 * is missing or not an address.
 */
export function clientIp(trustProxy: Config['trustProxy']): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const forwarded = trustProxy === 'one-hop' ? rightMostForwarded(c.req.header('x-forwarded-for')) : null;
    c.set('clientIp', forwarded ?? socketAddress(c));
    await next();
  };
}

/** The client's address as `clientIp` decided it, or null when there is none (an in-process request in tests). */
export function getClientIp(c: Context<AppEnv>): string | null {
  return c.get('clientIp') ?? null;
}

function rightMostForwarded(header: string | undefined): string | null {
  const entry = header?.split(',').at(-1)?.trim();
  return entry && isIP(entry) ? entry : null;
}

/** The peer's address from @hono/node-server's request bindings; null when the app is called without a socket. */
function socketAddress(c: Context): string | null {
  const bindings = c.env as { incoming?: { socket?: unknown } } | undefined;
  if (!bindings?.incoming?.socket) return null;
  return getConnInfo(c).remote.address ?? null;
}

/** A Firefox extension page's origin: a UUID Firefox picks at random for each profile and install. */
const MOZ_EXTENSION_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * CORS for `/v1/*`, for the methods and headers the extension uses: `chrome-extension://<id>` for each configured
 * Chrome and Edge id, and any `moz-extension://<uuid>` once a Firefox id is configured, since that UUID cannot be tied
 * to an add-on id. No credentials: the extension sends bearer tokens, never cookies. `Retry-After` is exposed: without
 * that, a cross-origin fetch cannot read it and the extension could not wait as told.
 *
 * CORS is not the access control here (ADR 0008). It never refuses a request; it only lets a browser page read the
 * answer. Every `/v1` route needs a bearer token, a web session or a secret (a code and its verifier, a refresh
 * token, a billing provider's signature); `Access-Control-Allow-Credentials` is never sent, so no other origin can
 * read an answer to a session cookie; and session writes stay behind `ownPageOnly`. Sign-in itself is guarded by the
 * listed client ids, the redirect bound to each id, and PKCE.
 */
export function extensionCors(extensionIds: readonly string[]): MiddlewareHandler {
  const allowed = new Set(extensionIds.filter((id) => clientKind(id) === 'chromium').map((id) => `chrome-extension://${id}`));
  const firefox = extensionIds.some((id) => clientKind(id) === 'gecko');
  return cors({
    origin: (origin) => (allowed.has(origin) || (firefox && MOZ_EXTENSION_ORIGIN.test(origin)) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    exposeHeaders: ['Retry-After'],
    maxAge: 600,
  });
}

/** A Chrome or Edge extension page's origin: any extension id. */
const CHROMIUM_EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

/** Whether `origin` is an extension page's: Chrome's or Edge's (any id), or Firefox's (any UUID). */
export function isExtensionOrigin(origin: string | undefined): boolean {
  return origin !== undefined && (CHROMIUM_EXTENSION_ORIGIN.test(origin) || MOZ_EXTENSION_ORIGIN.test(origin));
}

/**
 * CORS for `POST /v1/reports` only (ADR 0009 §6): any extension page's origin, whatever `EXTENSION_IDS` lists, so a
 * report from Edge works before the Edge Add-ons id is listed (the route reduces the origin to `listed`). POST and
 * `content-type` only; never `Access-Control-Allow-Credentials`, since the route reads no cookie or token.
 * `Retry-After` is exposed so the report page can read it.
 */
export function reportsCors(): MiddlewareHandler {
  return cors({
    origin: (origin) => (isExtensionOrigin(origin) ? origin : null),
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
    exposeHeaders: ['Retry-After'],
    maxAge: 600,
  });
}

/**
 * 403 (`REPORT_ERRORS.origin`) before the body is read, unless the request comes from an extension page: no Origin
 * (a script, a server) or a web page's. CORS alone would only stop a page from reading the answer, not the write. The
 * Origin is never kept: the route reduces it to whether the extension is listed.
 */
export function extensionOriginOnly(): MiddlewareHandler {
  return async (c, next) => {
    if (!isExtensionOrigin(c.req.header('origin'))) return c.json(REPORT_ERRORS.origin, 403);
    await next();
  };
}
