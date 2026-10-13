/**
 * The extension's sign-in secrets (R10): single-use authorization codes bound to a PKCE challenge, and the device tokens
 * a code is exchanged for, a 15-minute access JWT signed by Better Auth's key and an opaque refresh token. Codes and
 * refresh tokens are stored as SHA-256 hashes only and never logged; whoever reads the database cannot use them.
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
  now?: number;
}

/**
 * New tokens for a device: an access JWT (`sub` the user, `did` the device, `cid` the extension; issuer, audience,
 * EdDSA and 15 minutes from Better Auth's jwt plugin) and a refresh token stored by its hash. The answer names the
 * account's address, which the extension shows.
 *
 * All or nothing: the JWT is signed before anything is written, and a new device and its refresh token are stored in
 * one transaction, so a failure leaves no device without a token. Signing stays outside the transaction: Better Auth
 * runs its own queries, which under PGlite would wait for the transaction's connection.
 */
export async function issueTokens(
  { db, auth }: TokenDeps,
  grant: DeviceGrant,
  { newDevice = false, now = Date.now() }: IssueOptions = {},
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
