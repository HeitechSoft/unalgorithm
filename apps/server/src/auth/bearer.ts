/**
 * The check in front of every authenticated `/v1` route (R10): `Authorization: Bearer <access token>`, where the token
 * is a JWT signed with this server's key (Better Auth's `verifyJWT`: signature, expiry, issuer), meant for this server,
 * and names a device that exists, belongs to the token's account and extension, and is not revoked. The device is read
 * on every request, so a revoked device (sign-out, or a reused refresh token) loses access at once, not when its last
 * access token expires. Every refusal answers 401 `auth-required` with `WWW-Authenticate: Bearer`; the token is never
 * logged.
 */
import { AIError } from '@unalgorithm/ai';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { devices } from '../db/schema.ts';
import type { AppDeps } from '../http/app.ts';

/** Who is calling: what `requireDevice` sets as `c.var.account` for the route behind it. */
export interface DeviceAccount {
  userId: string;
  deviceId: string;
  clientId: string;
}

/** The variables a route behind `requireDevice` can read. */
export interface DeviceEnv {
  Variables: { account: DeviceAccount };
}

/** `devices.last_used_at` is written at most this often, not on every request. */
const LAST_USED_EVERY_MS = 5 * 60_000;

/** RFC 6750: the scheme (any case), one space, a token68. */
const BEARER = /^Bearer ([\w.~+/-]+=*)$/i;

/** The claims `issueTokens` signs: the account, the device (a uuid, as the column is) and the extension. */
const DeviceClaims = z.object({ sub: z.string().min(1), did: z.uuid(), cid: z.string().min(1), aud: z.string() });

export function requireDevice({ config, db, auth }: Pick<AppDeps, 'config' | 'db' | 'auth'>) {
  return createMiddleware<DeviceEnv>(async (c, next) => {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) throw refused(c);
    const { payload } = await auth.api.verifyJWT({ body: { token } });
    // Better Auth accepts an `aud` list that includes this server; a token for this server alone is required here.
    const claims = DeviceClaims.safeParse(payload);
    if (!claims.success || claims.data.aud !== config.publicOrigin) throw refused(c);
    const { sub, did, cid } = claims.data;

    const [device] = await db.db.select().from(devices).where(eq(devices.id, did)).limit(1);
    if (!device || device.userId !== sub || device.clientId !== cid || device.revokedAt !== null) throw refused(c);
    const now = Date.now();
    if (device.lastUsedAt === null || now - device.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
      await db.db
        .update(devices)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(devices.id, did));
    }

    c.set('account', { userId: sub, deviceId: did, clientId: cid });
    await next();
  });
}

/** The error to throw for a refused token; the app's error mapping answers it with 401 `auth-required`. */
function refused(c: Context): AIError {
  c.header('WWW-Authenticate', 'Bearer');
  return new AIError('auth-required', 'The access token was not accepted.');
}
