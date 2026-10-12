/**
 * The HTTP rules every route depends on, fixed once: a request log that holds no bodies, query strings, headers or
 * addresses; the client address taken from exactly one proxy hop; and CORS that admits only the configured extensions.
 */
import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
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

/**
 * CORS for `/v1/*`: only `chrome-extension://<id>` origins of the configured extension ids are answered, for the
 * methods and headers the extension uses. No credentials: the extension sends bearer tokens, never cookies.
 */
export function extensionCors(extensionIds: readonly string[]): MiddlewareHandler {
  const allowed = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
    maxAge: 600,
  });
}
