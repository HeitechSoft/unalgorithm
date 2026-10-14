/**
 * Who is signed in on the server's own pages (R10, R31): the sign-in page asking for an extension's code today, the
 * account page and the billing module's routes next (CL2-04), the device list later (CL3). `requireWebSession` reads
 * the Better Auth web session from the request's cookie here, once; no route looks the session up itself.
 *
 * The rule for a route behind it: a GET needs nothing more. Better Auth's cookie is `SameSite=Lax`, so another site's
 * `fetch` carries no session, and `/v1/*` CORS answers only extension origins, so no page elsewhere can read the
 * answer. A state-changing route adds `ownPageOnly` in front of it, as the authorize route does.
 *
 * The session cookie and its token are never logged, and never copied into `webUser`.
 */
import { AIError } from '@unalgorithm/ai';
import type { WireError } from '@unalgorithm/protocol';
import type { Env, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../http/app.ts';

/** Who is signed in on the server's own page. Never a token: the session cookie stays with Better Auth. */
export interface WebUser {
  userId: string;
  email: string;
}

/** The variables a route behind `requireWebSession` can read. */
export interface WebSessionEnv {
  Variables: { webUser: WebUser };
}

/** The answer to a request from anywhere but the server's own page, or from an extension the server does not list. */
export const REFUSED: WireError = { code: 'permission', message: "This server doesn't accept sign-ins from here." };

/** 401 `auth-required` (an AIError, so the app's error mapping answers) unless the request carries a live web session. */
export function requireWebSession({ auth }: Pick<AppDeps, 'auth'>): MiddlewareHandler<WebSessionEnv> {
  return createMiddleware<WebSessionEnv>(async (c, next) => {
    // First, so the 401 below carries it too: every answer behind this check is about one person.
    c.header('Cache-Control', 'no-store');
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    // No `WWW-Authenticate`: this is cookie auth, not bearer.
    if (!session) throw new AIError('auth-required', 'No web session.');
    c.set('webUser', { userId: session.user.id, email: session.user.email });
    await next();
  });
}

/**
 * 403 `permission` unless the request's `Origin` header is exactly `origin` (state-changing requests from the page).
 * Typed with Hono's base `Env`, not `any`: in a route's middleware list an `any` env would hide `webUser` from the
 * handler.
 */
export function ownPageOnly(origin: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.header('origin') !== origin) return c.json(REFUSED, 403);
    await next();
  };
}
