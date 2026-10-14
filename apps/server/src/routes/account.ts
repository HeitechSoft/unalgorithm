/**
 * The account routes (R11, R12), for the account page (the web session) and the extension (a device token) alike,
 * behind `requireAccount`. The account's devices: the list of what is signed in now, and revoking one of them. Revoking
 * is CL1-10's `revokeDevice`: the device is marked revoked and its refresh tokens are spent, and `requireDevice` refuses
 * its access token from the next request on. A device may revoke itself, which signs it out like "Sign out" does.
 *
 * The account's data (`account/data.ts`): downloading everything the server holds about it, and deleting it. Both take
 * the web session only, so a stolen device token can neither read every session's address and browser nor delete the
 * account; deleting also takes a sign-in within the last 10 minutes and the address typed again.
 *
 * Another account's device answers exactly like an id no device has, so a caller cannot probe ids. No line logs an
 * address, an account's id or a device's name, which can hold a person's own label.
 */
import { createRoute } from '@hono/zod-openapi';
import { AIError } from '@unalgorithm/ai';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_EXPORT_PATH,
  AccountDevicesResponseSchema,
  AccountExportSchema,
  DeleteAccountRequestSchema,
  MAX_ACCOUNT_DEVICES,
  OkResponseSchema,
  RevokeDeviceRequestSchema,
  type WireError,
} from '@unalgorithm/protocol';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DELETE_FRESH_MS, deleteAccount, exportAccount } from '../account/data.ts';
import { requireAccount } from '../auth/account-access.ts';
import { revokeDevice } from '../auth/tokens.ts';
import { devices, user } from '../db/schema.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

/** The export's answer to a device token: the extension links to the account page instead. */
const EXPORT_ON_PAGE: WireError = { code: 'permission', message: 'Download your data on the account page.' };
/** Deletion's answer to a device token. */
const DELETE_ON_PAGE: WireError = { code: 'permission', message: 'Delete your account on the account page.' };
/** Deletion's answer to a session signed in too long ago: the page signs out and asks for a fresh sign-in (CL3-18). */
const SIGN_IN_AGAIN: WireError = { code: 'auth-required', message: 'Sign in again to delete your account.' };
const MISMATCH: WireError = { code: 'bad-request', message: 'The address you typed does not match this account.' };
/** The download's file name, the same on every server. */
const EXPORT_DISPOSITION = 'attachment; filename="account-export.json"';

/** Mounts the devices list and revoke routes, and the account's export and deletion, on the app. */
export function accountRoutes(app: App, deps: AppDeps): void {
  const { db, log } = deps;

  app.openapi(
    createRoute({
      method: 'get',
      path: ACCOUNT_DEVICES_PATH,
      middleware: [requireAccount(deps)] as const,
      responses: {
        200: { description: 'The devices signed in now, most recently used first', content: json(AccountDevicesResponseSchema) },
        401: errorResponse('No valid device token or web session'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId, deviceId } = c.var.principal;
      // Revoked devices are not listed: the export holds them, with their reason (CL3-15).
      const rows = await db.db
        .select({ id: devices.id, name: devices.name, createdAt: devices.createdAt, lastUsedAt: devices.lastUsedAt })
        .from(devices)
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
        .orderBy(sql`${devices.lastUsedAt} desc nulls last`, desc(devices.createdAt))
        .limit(MAX_ACCOUNT_DEVICES);
      const list = rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
        // Never one for the web session, whose `deviceId` is null.
        current: row.id === deviceId,
      }));
      return c.json({ v: 1 as const, devices: list }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ACCOUNT_DEVICE_REVOKE_PATH,
      // Before the body is read: a caller without a credential, or a web session from another page, learns nothing.
      middleware: [requireAccount(deps)] as const,
      request: { body: { content: json(RevokeDeviceRequestSchema), required: true } },
      responses: {
        200: { description: 'Revoked, or revoked before', content: json(OkResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No valid device token or web session'),
        403: errorResponse("A web session's request from anywhere but this server's own page"),
        404: errorResponse('No device of this account has the id'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId, via } = c.var.principal;
      const { device_id } = c.req.valid('json');
      const [device] = await db.db
        .select({ id: devices.id, revokedAt: devices.revokedAt })
        .from(devices)
        .where(and(eq(devices.id, device_id), eq(devices.userId, userId)))
        .limit(1);
      if (!device) return c.json(NOT_FOUND, 404);
      // A device revoked before (here, by a sign-out or by a reused refresh token) keeps its first reason and time.
      if (device.revokedAt === null && (await revokeDevice(db.db, device.id, 'revoked-by-user'))) {
        log.info('account.device_revoked', { rid: c.get('rid'), device_id: device.id, via });
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: ACCOUNT_EXPORT_PATH,
      middleware: [requireAccount(deps)] as const,
      responses: {
        200: { description: 'Everything the server holds about the account, as a download', content: json(AccountExportSchema) },
        401: errorResponse('No valid device token or web session'),
        403: errorResponse('A device token: the account page downloads the data'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId, via } = c.var.principal;
      if (via !== 'session') return c.json(EXPORT_ON_PAGE, 403);
      const body = await exportAccount(deps, userId);
      log.info('account.exported', { rid: c.get('rid'), via });
      c.header('Content-Disposition', EXPORT_DISPOSITION);
      return c.json(body, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ACCOUNT_DELETE_PATH,
      // Before the body is read: a caller without a credential, or a web session from another page, learns nothing.
      middleware: [requireAccount(deps)] as const,
      request: { body: { content: json(DeleteAccountRequestSchema), required: true } },
      responses: {
        200: { description: 'The account and everything stored about it are deleted', content: json(OkResponseSchema) },
        400: errorResponse("The request was not valid, or the address typed is not the account's"),
        401: errorResponse('No valid device token or web session, or a session signed in over 10 minutes ago'),
        403: errorResponse("A device token, or a web session's request from anywhere but this server's own page"),
        500: errorResponse('The billing module refused, or the deletion failed: nothing was deleted'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId, via, sessionCreatedAt } = c.var.principal;
      // A stolen device token must not be able to delete the account.
      if (via !== 'session' || sessionCreatedAt === null) return c.json(DELETE_ON_PAGE, 403);
      if (Date.now() - sessionCreatedAt.getTime() > DELETE_FRESH_MS) return c.json(SIGN_IN_AGAIN, 401);
      const { confirm } = c.req.valid('json');
      const [owner] = await db.db.select({ email: user.email }).from(user).where(eq(user.id, userId));
      // Deleted since the session was checked: the session went with it.
      if (!owner) throw new AIError('auth-required', 'The account no longer exists.');
      if (confirm.toLowerCase() !== owner.email.toLowerCase()) return c.json(MISMATCH, 400);
      // A billing module's refusal, or a failed transaction, reaches `onError`: 500 `unknown`, and nothing is deleted.
      if (await deleteAccount(deps, userId)) log.info('account.deleted', { rid: c.get('rid') });
      return c.json({ ok: true as const }, 200);
    },
  );
}
