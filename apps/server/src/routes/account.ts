/**
 * The account's devices (R11): the list of what is signed in now, and revoking one of them, for the account page (the
 * web session) and the extension (a device token) alike, behind `requireAccount`. Revoking is CL1-10's `revokeDevice`:
 * the device is marked revoked and its refresh tokens are spent, and `requireDevice` refuses its access token from the
 * next request on. A device may revoke itself, which signs it out like "Sign out" does.
 *
 * Another account's device answers exactly like an id no device has, so a caller cannot probe ids. No line logs an
 * address or a device's name, which can hold a person's own label.
 */
import { createRoute } from '@hono/zod-openapi';
import {
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  AccountDevicesResponseSchema,
  MAX_ACCOUNT_DEVICES,
  OkResponseSchema,
  RevokeDeviceRequestSchema,
} from '@unalgorithm/protocol';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requireAccount } from '../auth/account-access.ts';
import { revokeDevice } from '../auth/tokens.ts';
import { devices } from '../db/schema.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

/** Mounts the devices list and revoke routes on the app. */
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
}
