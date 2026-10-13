/**
 * The extension's sign-in secrets (R10): single-use authorization codes bound to a PKCE challenge, and the device tokens
 * a code is exchanged for, a 15-minute access JWT signed by Better Auth's key and an opaque refresh token. Codes and
 * refresh tokens are stored as SHA-256 hashes only and never logged; whoever reads the database cannot use them.
 *
 * A refresh token works once: each refresh spends it and issues the next. A spent token coming back means two copies
 * exist, one of them in someone else's hands, so that revokes the device (CL1-10).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AIError } from '@unalgorithm/ai';
import { ACCESS_TOKEN_TTL_SECONDS, type TokenResponse } from '@unalgorithm/protocol';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authCodes, devices, refreshTokens, user } from '../db/schema.ts';
import type { Auth } from './better-auth.ts';

/** How long a code works. The extension exchanges it as soon as `launchWebAuthFlow` returns. */
export const AUTH_CODE_TTL_SECONDS = 60;
/** How long a refresh token works. Every rotation issues a new one with a fresh lifetime (CL1-10). */
export const REFRESH_TOKEN_TTL_DAYS = 60;

const DAY_MS = 86_400_000;

/** 32 random bytes, base64url: 43 characters. */
export function newSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** base64url(SHA-256(secret)): the only form of a code or a refresh token the database holds. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

/** PKCE S256 (RFC 7636): whether base64url(SHA-256(verifier)) is `challenge`, compared in constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(hashSecret(verifier));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface AuthCodeGrant {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

/** Stores a new code for this grant, valid for `AUTH_CODE_TTL_SECONDS`, and returns it. Only its hash is kept. */
export async function issueAuthCode(db: Db, grant: AuthCodeGrant, now = Date.now()): Promise<string> {
  const code = newSecret();
  await db.insert(authCodes).values({
    ...grant,
    codeHash: hashSecret(code),
    expiresAt: new Date(now + AUTH_CODE_TTL_SECONDS * 1000),
  });
  return code;
}

export type AuthCode = typeof authCodes.$inferSelect;

/**
 * Claims a code: marks it used and returns its grant, or null when it is unknown, already used or expired. One
 * statement, so of two exchanges racing for one code exactly one gets it. The code is spent whatever the caller finds
 * next: a wrong verifier ends it too. Expiry is judged by this server's clock, which also set it.
 */
export async function consumeAuthCode(db: Db, code: string, now = Date.now()): Promise<AuthCode | null> {
  const at = new Date(now);
  const [row] = await db
    .update(authCodes)
    .set({ usedAt: at })
    .where(and(eq(authCodes.codeHash, hashSecret(code)), isNull(authCodes.usedAt), gt(authCodes.expiresAt, at)))
    .returning();
  return row ?? null;
}

export interface DeviceGrant {
  userId: string;
  deviceId: string;
  clientId: string;
}

export interface TokenDeps {
  db: Db;
  auth: Auth;
}

export interface IssueOptions {
  /** Store the device along with its first tokens: a new sign-in. Default: the device exists already. */
  newDevice?: boolean;
  /**
   * The id of the refresh token these tokens replace (a rotation): spent in the transaction that stores the new one.
   * When another request spent it first, nothing is stored and `TokenAlreadyUsed` is thrown.
   */
  replaces?: string;
  now?: number;
}

/** The refresh token a rotation replaces was already spent: see `IssueOptions.replaces`. */
export class TokenAlreadyUsed extends Error {
  constructor() {
    super('The refresh token was already used.');
    this.name = 'TokenAlreadyUsed';
  }
}

/**
 * New tokens for a device: an access JWT (`sub` the user, `did` the device, `cid` the extension; issuer, audience,
 * EdDSA and 15 minutes from Better Auth's jwt plugin) and a refresh token stored by its hash. The answer names the
 * account's address, which the extension shows.
 *
 * All or nothing: the JWT is signed before anything is written, and the new refresh token is stored in one transaction
 * with the new device, or with spending the token it replaces. So a failure leaves no device without a token, and a
 * refresh that fails does not spend its token: tried again, it is not taken for reuse. Signing stays outside the
 * transaction: Better Auth runs its own queries, which under PGlite would wait for the transaction's connection.
 */
export async function issueTokens(
  { db, auth }: TokenDeps,
  grant: DeviceGrant,
  { newDevice = false, replaces, now = Date.now() }: IssueOptions = {},
): Promise<TokenResponse> {
  const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, grant.userId)).limit(1);
  if (!owner) throw new AIError('auth-required', 'The account no longer exists.');
  const { token } = await auth.api.signJWT({
    // Better Auth sets `iat` only when the payload has it.
    body: { payload: { sub: grant.userId, did: grant.deviceId, cid: grant.clientId, iat: Math.floor(now / 1000) } },
  });
  const refreshToken = newSecret();
  await db.transaction(async (tx) => {
    if (newDevice) await tx.insert(devices).values({ id: grant.deviceId, userId: grant.userId, clientId: grant.clientId });
    if (replaces !== undefined) {
      // One statement: of two refreshes racing with one token, exactly one spends it.
      const spent = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date(now) })
        .where(and(eq(refreshTokens.id, replaces), isNull(refreshTokens.usedAt)))
        .returning({ id: refreshTokens.id });
      if (spent.length === 0) throw new TokenAlreadyUsed();
    }
    await tx.insert(refreshTokens).values({
      deviceId: grant.deviceId,
      tokenHash: hashSecret(refreshToken),
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_DAYS * DAY_MS),
    });
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    device_id: grant.deviceId,
    account: { email: owner.email },
  };
}

/** Why a device was revoked, as `devices.revoked_reason` holds it. */
export type RevokeReason = 'sign-out' | 'refresh-reuse';

/**
 * Ends a device: marks it revoked and spends every refresh token it still holds, in one transaction. Its access tokens
 * stop working at once, since `requireDevice` reads the device on every request. A device revoked before keeps its
 * first reason and time. Returns whether this call revoked it.
 */
export async function revokeDevice(db: Db, deviceId: string, reason: RevokeReason, now = Date.now()): Promise<boolean> {
  const at = new Date(now);
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(devices)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
    await tx
      .update(refreshTokens)
      .set({ usedAt: at })
      .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.usedAt)));
    return revoked.length > 0;
  });
}

/** A refresh token found by its hash, with the device it belongs to, or null. */
async function findRefreshToken(db: Db, refreshToken: string) {
  const [row] = await db
    .select({
      id: refreshTokens.id,
      expiresAt: refreshTokens.expiresAt,
      usedAt: refreshTokens.usedAt,
      deviceId: devices.id,
      userId: devices.userId,
      clientId: devices.clientId,
      revokedAt: devices.revokedAt,
    })
    .from(refreshTokens)
    .innerJoin(devices, eq(devices.id, refreshTokens.deviceId))
    .where(eq(refreshTokens.tokenHash, hashSecret(refreshToken)))
    .limit(1);
  return row ?? null;
}

/**
 * What a refresh comes to: new tokens for the same device, or a refusal. `revokedForReuse` names the device when this
 * refusal revoked it because its token had been spent before.
 */
export type Rotation = { ok: true; tokens: TokenResponse } | { ok: false; revokedForReuse?: string };

/**
 * The refresh grant. An unknown token is refused. A spent one is reuse: the device is revoked, so the newer token stops
 * working too, whoever holds it. An expired token, a revoked device or another extension's id is refused without
 * revoking anything. Otherwise the token is spent and replaced (`issueTokens` with `replaces`); when a concurrent
 * refresh spent it first, this one is reuse as well. Expiry is judged by this server's clock, which also set it.
 */
export async function rotateRefreshToken(
  deps: TokenDeps,
  refreshToken: string,
  clientId: string,
  now = Date.now(),
): Promise<Rotation> {
  const found = await findRefreshToken(deps.db, refreshToken);
  if (!found) return { ok: false };
  const reuse = async (): Promise<Rotation> =>
    (await revokeDevice(deps.db, found.deviceId, 'refresh-reuse', now))
      ? { ok: false, revokedForReuse: found.deviceId }
      : { ok: false };
  if (found.usedAt !== null) return reuse();
  if (found.expiresAt.getTime() <= now || found.revokedAt !== null || found.clientId !== clientId) return { ok: false };
  const grant = { userId: found.userId, deviceId: found.deviceId, clientId: found.clientId };
  try {
    return { ok: true, tokens: await issueTokens(deps, grant, { replaces: found.id, now }) };
  } catch (err) {
    if (err instanceof TokenAlreadyUsed) return reuse();
    throw err;
  }
}

/**
 * Sign-out: revokes the device `refreshToken` belongs to, when that device signed in with `clientId`. Returns the
 * device's id when this call revoked it, else null; the caller answers the same either way.
 */
export async function revokeByRefreshToken(
  db: Db,
  refreshToken: string,
  clientId: string,
  now = Date.now(),
): Promise<string | null> {
  const found = await findRefreshToken(db, refreshToken);
  if (!found || found.clientId !== clientId) return null;
  return (await revokeDevice(db, found.deviceId, 'sign-out', now)) ? found.deviceId : null;
}
