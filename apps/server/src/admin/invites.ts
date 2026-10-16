/**
 * Sign-up invites (CL4-03): an address an admin invited (CL4-06), or the setup link's own (CL4-04), may create an
 * account exactly as an address on `SIGNUP_ALLOWLIST` can. Better Auth's `user.create.after` hook uses the invite up.
 * Invites never expire and no email is sent to an invited person; removing an invite never touches an account.
 *
 * Every function takes a Drizzle `Db`, so a caller can pass a transaction. Nothing here logs: an invite holds the
 * address of someone who may never sign in.
 */
import { InviteRequestSchema, MAX_INVITES } from '@unalgorithm/protocol';
import { asc, desc, eq } from 'drizzle-orm';
import { isEmailAllowed } from '../auth/better-auth.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { signupInvites, user } from '../db/schema.ts';

/** Trimmed and lowercased, as Better Auth stores account addresses. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Idempotent: `added` is false when the address was already invited. Throws `TypeError` (whose message never repeats
 * the value) when the normalised address is not one `InviteRequestSchema` accepts.
 */
export async function addInvite(db: Db, email: string, invitedBy: string | null): Promise<{ added: boolean }> {
  const address = normalizeEmail(email);
  if (!InviteRequestSchema.shape.email.safeParse(address).success) throw new TypeError('Not an email address.');
  const rows = await db
    .insert(signupInvites)
    .values({ email: address, invitedBy })
    .onConflictDoNothing({ target: signupInvites.email })
    .returning({ email: signupInvites.email });
  return { added: rows.length > 0 };
}

export async function removeInvite(db: Db, email: string): Promise<{ removed: boolean }> {
  const rows = await db
    .delete(signupInvites)
    .where(eq(signupInvites.email, normalizeEmail(email)))
    .returning({ email: signupInvites.email });
  return { removed: rows.length > 0 };
}

/** Newest first (then by address), at most `MAX_INVITES`. */
export function listInvites(db: Db): Promise<{ email: string; createdAt: Date }[]> {
  return db
    .select({ email: signupInvites.email, createdAt: signupInvites.createdAt })
    .from(signupInvites)
    .orderBy(desc(signupInvites.createdAt), asc(signupInvites.email))
    .limit(MAX_INVITES);
}

export async function isInvited(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ email: signupInvites.email })
    .from(signupInvites)
    .where(eq(signupInvites.email, normalizeEmail(email)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether an account has this address (normalised first). The one account-by-address lookup: `better-auth.ts`'s
 * `hasUser` delegates to it, and so do the setup link (CL4-04) and the invite route (CL4-06).
 */
export async function hasAccount(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, normalizeEmail(email)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Who may create an account: with `SIGNUP=open`, every address (the caller checks that its provider verified it);
 * otherwise an address on `SIGNUP_ALLOWLIST` (`isEmailAllowed`) or an invited one. The invite is looked up for every
 * address, allow-listed or not, so the work done never depends on the allowlist.
 */
export async function mayCreateAccount(
  deps: { db: Db; config: Pick<Config, 'signup' | 'signupAllowlist'> },
  email: string,
): Promise<boolean> {
  if (deps.config.signup === 'open') return true;
  const address = normalizeEmail(email);
  const invited = await isInvited(deps.db, address);
  return invited || isEmailAllowed(address, deps.config.signupAllowlist);
}
