/**
 * The one-time setup link (R38): how a fresh server gets its first admin. The operator runs `setup-link <address>` in
 * the container (`cli/setup-link.ts`), which prints a link valid for 60 minutes and invites that address; once the
 * person signs in on the setup page with it, `POST /v1/admin/setup` (`routes/admin.ts`) makes them the server's admin.
 * The secret travels in the URL's fragment, so no proxy or server log records it, and the database holds only its hash.
 *
 * One live link at a time, bound to one address. `--recover` makes a link that works although the server already has
 * an admin (the only admin lost their mailbox): whoever runs commands in the container controls the server anyway.
 * Nothing here logs a token, its hash or an address.
 */
import { InviteRequestSchema, SETUP_PAGE_PATH, type WireError } from '@unalgorithm/protocol';
import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { hashSecret, newSecret } from '../auth/tokens.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { setupTokens, signupInvites, user } from '../db/schema.ts';
import type { Logger } from '../log.ts';
import { ADMIN_ROLE, activeAdminCount } from './access.ts';
import { addInvite, hasAccount, normalizeEmail } from './invites.ts';

export const SETUP_LINK_TTL_MS = 60 * 60_000;
/** "UNAS" as a 32-bit integer (migrations hold "UNAL", route sync "UNAR"). */
export const SETUP_LOCK_KEY = 1431191891;
/** The one answer to every refused claim: the page cannot tell the reasons apart; the operator reads them in the log. */
export const SETUP_REFUSED: WireError = { code: 'permission', message: "This setup link doesn't work. Ask for a new one." };

/** `restored`: an account with this address existed and its removal (ban) was lifted. */
export type SetupLink = { ok: true; url: string; expiresAt: Date; restored: boolean } | { ok: false; reason: 'has-admin' };
export type SetupRefusal = 'unknown' | 'used' | 'expired' | 'other-address' | 'has-admin';

/**
 * Makes the one live setup link for `email`, replacing any unused one (and the invite it made), and lets the address
 * sign in: an address without an account is invited; an existing account's removal is lifted, since Better Auth refuses
 * a removed account a session and the person could never claim the link. Without `recover`, refuses (writing nothing)
 * when the server already has an admin. Throws `TypeError` (whose message never repeats the value) for a bad address.
 */
export async function createSetupLink(
  db: Db,
  config: Pick<Config, 'publicUrl'>,
  email: string,
  opts: { recover?: boolean; now?: number } = {},
): Promise<SetupLink> {
  const address = normalizeEmail(email);
  if (!InviteRequestSchema.shape.email.safeParse(address).success) throw new TypeError('Not an email address.');
  const recover = opts.recover ?? false;
  if (!recover && (await activeAdminCount(db)) > 0) return { ok: false, reason: 'has-admin' };
  const now = opts.now ?? Date.now();
  const token = newSecret();
  const expiresAt = new Date(now + SETUP_LINK_TTL_MS);

  const restored = await db.transaction(async (tx) => {
    // Only one live link: the unused ones (expired ones included) go, with the invites they made.
    const replaced = await tx.select({ email: setupTokens.email }).from(setupTokens).where(isNull(setupTokens.usedAt));
    await tx.delete(setupTokens).where(isNull(setupTokens.usedAt));
    if (replaced.length > 0) {
      // Invites never expire: without this, a mistyped address could create an account indefinitely. An invite an
      // admin added (`invited_by` set) stays.
      await tx.delete(signupInvites).where(
        and(
          inArray(
            signupInvites.email,
            replaced.map((row) => row.email),
          ),
          isNull(signupInvites.invitedBy),
          notExists(tx.select({ one: sql`1` }).from(user).where(eq(user.email, signupInvites.email))),
        ),
      );
    }
    await tx
      .insert(setupTokens)
      .values({ tokenHash: hashSecret(token), email: address, recover, createdAt: new Date(now), expiresAt });
    if (!(await hasAccount(tx, address))) {
      await addInvite(tx, address, null);
      return false;
    }
    // No invite for an existing account: sign-up would never use it up. Its removal is lifted, so it can sign in.
    const lifted = await tx
      .update(user)
      .set({ banned: false, banReason: null, banExpires: null })
      .where(and(eq(user.email, address), eq(user.banned, true)))
      .returning({ id: user.id });
    return lifted.length > 0;
  });

  return { ok: true, url: `${config.publicUrl}${SETUP_PAGE_PATH}#${token}`, expiresAt, restored };
}

/**
 * Claims the link `token` for the signed-in `who`: makes the account an admin (lifting any removal) and spends the link.
 * Claims take turns on an advisory lock, so two links claimed at once still make one first admin.
 */
export async function claimSetup(
  db: Db,
  who: { userId: string; email: string },
  token: string,
  now: number = Date.now(),
): Promise<{ ok: true; recover: boolean } | { ok: false; reason: SetupRefusal }> {
  const tokenHash = hashSecret(token);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`);
    const [link] = await tx
      .select({
        email: setupTokens.email,
        recover: setupTokens.recover,
        expiresAt: setupTokens.expiresAt,
        usedAt: setupTokens.usedAt,
      })
      .from(setupTokens)
      .where(eq(setupTokens.tokenHash, tokenHash))
      .for('update');
    if (!link) return { ok: false, reason: 'unknown' } as const;
    if (link.usedAt !== null) return { ok: false, reason: 'used' } as const;
    if (link.expiresAt.getTime() <= now) return { ok: false, reason: 'expired' } as const;
    if (link.email !== normalizeEmail(who.email)) return { ok: false, reason: 'other-address' } as const;
    if (!link.recover && (await activeAdminCount(tx)) > 0) return { ok: false, reason: 'has-admin' } as const;
    // The only place our code writes `role` itself: no admin exists yet to call `auth.api.setRole` with.
    await tx
      .update(user)
      .set({ role: ADMIN_ROLE, banned: false, banReason: null, banExpires: null })
      .where(eq(user.id, who.userId));
    await tx
      .update(setupTokens)
      .set({ usedAt: new Date(now) })
      .where(eq(setupTokens.tokenHash, tokenHash));
    return { ok: true, recover: link.recover } as const;
  });
}

/** At start-up: one `setup.needed` line when the server has no admin. It never holds a token or an address. */
export async function logSetupNeeded(db: Db, log: Logger): Promise<void> {
  if ((await activeAdminCount(db)) === 0) log.warn('setup.needed', { command: 'setup-link' });
}
