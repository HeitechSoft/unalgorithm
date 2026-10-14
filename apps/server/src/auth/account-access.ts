/**
 * Who is calling an account route (R11, R12): the extension, with a device's bearer token (`deviceFromBearer`, CL1-10),
 * or the account page, with the server's own web session (`webUserFrom`, CL2-02). `requireAccount` accepts either and
 * says which it was, so a route can allow only one: deleting an account takes the web session alone.
 *
 * A request with an `Authorization` header is judged by that header alone; a refused token never falls back to a
 * cookie sent with it. A state-changing request on the web session must come from the server's own page
 * (`ownPageOnly`). A device's request needs no such check: browsers never attach a bearer token by themselves, so
 * another site cannot make one. Nothing here logs the cookie, the token or the address.
 */
import { AIError } from '@unalgorithm/ai';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../http/app.ts';
import { deviceFromBearer } from './bearer.ts';
import { ownPageOnly, webUserFrom } from './web-session.ts';

/** Who is calling: what `requireAccount` sets as `c.var.principal` for the route behind it. */
export interface Principal {
  userId: string;
  /** The device whose bearer token made the request; null for the web session. */
  deviceId: string | null;
  via: 'device' | 'session';
  /** When the web session was created (for "signed in recently" checks, CL3-15); null for devices. */
  sessionCreatedAt: Date | null;
}

/** The variables a route behind `requireAccount` can read. */
export interface PrincipalEnv {
  Variables: { principal: Principal };
}

/** The methods that change nothing, so a web session needs no `Origin` check for them. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * 401 `auth-required` with `WWW-Authenticate: Bearer` (an AIError, so the app's error mapping answers) unless the
 * request carries a device token this server accepts or, without an `Authorization` header, a live web session; 403
 * `permission` for a web session's state-changing request from anywhere but the server's own page.
 */
export function requireAccount(deps: Pick<AppDeps, 'config' | 'db' | 'auth'>): MiddlewareHandler<PrincipalEnv> {
  const ownPage = ownPageOnly(deps.config.publicOrigin);
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    if (c.req.header('authorization') !== undefined) {
      const { userId, deviceId } = await deviceFromBearer(c, deps);
      c.set('principal', { userId, deviceId, via: 'device', sessionCreatedAt: null });
      await next();
      return;
    }

    const web = await webUserFrom(c, deps);
    if (!web) {
      // These routes take a bearer token too, so the refusal says so.
      c.header('WWW-Authenticate', 'Bearer');
      throw new AIError('auth-required', 'No access token or web session.');
    }
    c.set('principal', { userId: web.userId, deviceId: null, via: 'session', sessionCreatedAt: web.sessionCreatedAt });
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    // `ownPageOnly` reads only the request's `Origin`; it is typed for any route, so it takes the context untyped.
    return ownPage(c as Context, next);
  });
}
