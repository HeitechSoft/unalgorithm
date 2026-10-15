/**
 * Who administers this server, and removing a person's access (R38). The role and the removal are Better Auth's admin
 * plugin's `user.role` and `user.banned`: `null` reads as `user` and as not removed. The plugin's own session hook
 * refuses a sign-in to a removed account; `issueTokens` refuses it a device or a refresh; `removeAccess` signs out the
 * devices it has. None of the plugin's routes is mounted: the admin routes (CL4-06) call it server-side with the
 * admin's own request headers, so it checks the admin's session and role itself.
 *
 * Log lines name accounts and devices by id and count only, never by address.
 */
import type { WireError } from '@unalgorithm/protocol';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Auth } from '../auth/better-auth.ts';
import { revokeDevice } from '../auth/tokens.ts';
import type { WebSessionEnv } from '../auth/web-session.ts';
import type { Db } from '../db/client.ts';
import { devices, user } from '../db/schema.ts';
import type { AppDeps } from '../http/app.ts';
import type { Logger } from '../log.ts';
import { NOT_FOUND } from '../routes/openapi.ts';

export const ADMIN_ROLE = 'admin';
/** Answered with c.json, not an AIError: describeError('permission') talks about an API key. */
export const NOT_ADMIN: WireError = { code: 'permission', message: "This account isn't an admin of this server." };

/** What `removeAccess` writes to `user.ban_reason`, and to `devices.revoked_reason` of each device it signs out. */
const REMOVED = 'removed-by-admin';

const OWN_ACCESS: WireError = { code: 'bad-request', message: "You can't change your own access." };
const SIGN_IN_AGAIN: WireError = { code: 'auth-required', message: 'Sign in again.' };

/** An account's role and whether its access is removed; undefined when no account has this id (CL4-06's 404). */
export async function findAccount(db: Db, userId: string): Promise<{ role: string | null; banned: boolean } | undefined> {
  const [row] = await db.select({ role: user.role, banned: user.banned }).from(user).where(eq(user.id, userId)).limit(1);
  return row ? { role: row.role, banned: row.banned === true } : undefined;
}

/** After requireWebSession. Reads role and banned on every request (no cache), so a demotion or removal acts at once. */
export function requireAdmin(deps: Pick<AppDeps, 'db'>): MiddlewareHandler<WebSessionEnv> {
  return createMiddleware<WebSessionEnv>(async (c, next) => {
    const account = await findAccount(deps.db.db, c.var.webUser.userId);
    if (account?.role !== ADMIN_ROLE || account.banned) return c.json(NOT_ADMIN, 403);
    await next();
  });
}

/** Accounts with role admin that are not banned. */
export async function activeAdminCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.role, ADMIN_ROLE), sql`${user.banned} is not true`));
  return row?.n ?? 0;
}

export interface AccessDeps {
  db: Db;
  auth: Auth;
  log: Logger;
}

/**
 * Bans through the plugin (with the admin's own request headers), then revokes every device of the account. The plugin
 * checks the admin and the account, and refuses the admin's own; it deletes the account's web sessions. A code issued
 * before the ban gets no device (`issueTokens`), and a device stored while the ban waited for its lock is found here.
 */
export async function removeAccess(
  { db, auth, log }: AccessDeps,
  headers: Headers,
  adminId: string,
  userId: string,
): Promise<{ devicesRevoked: number }> {
  await auth.api.banUser({ headers, body: { userId, banReason: REMOVED } });
  const live = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  let devicesRevoked = 0;
  for (const { id } of live) if (await revokeDevice(db, id, REMOVED)) devicesRevoked += 1;
  log.info('admin.access_removed', { admin_id: adminId, user_id: userId, devices: devicesRevoked });
  return { devicesRevoked };
}

/** Lifts the removal. The revoked devices stay revoked: the person signs in again from the extension. */
export async function restoreAccess({ auth, log }: AccessDeps, headers: Headers, adminId: string, userId: string): Promise<void> {
  await auth.api.unbanUser({ headers, body: { userId } });
  log.info('admin.access_restored', { admin_id: adminId, user_id: userId });
}

/**
 * A Better Auth refusal as our answer, or undefined for anything else (the caller rethrows: 500). Matched by name and
 * status, not `instanceof`: Better Auth throws more than one `APIError` class across its packages.
 */
export function adminApiError(err: unknown): { status: 400 | 401 | 403 | 404; body: WireError } | undefined {
  if (typeof err !== 'object' || err === null || (err as { name?: unknown }).name !== 'APIError') return undefined;
  switch ((err as { statusCode?: unknown }).statusCode) {
    case 400:
      return { status: 400, body: OWN_ACCESS };
    case 401:
      return { status: 401, body: SIGN_IN_AGAIN };
    case 403:
      return { status: 403, body: NOT_ADMIN };
    case 404:
      return { status: 404, body: NOT_FOUND };
    default:
      return undefined;
  }
}
