/**
 * Everything the server holds about an account, as one download, and deleting all of it (R12). Both are for the account
 * page only; the routes (`routes/account.ts`) check that, and that a deletion comes from a recent sign-in with the
 * address typed again.
 *
 * The export carries no secret: no token, hash, code, key, passkey public key, credential id or the operator's cost,
 * and `AccountExportSchema` strips anything else it does not list. Deleting is one transaction: every account table
 * references `user` with `on delete cascade`, so the user row takes devices (and their refresh tokens), codes, sessions,
 * linked Google accounts, passkeys, usage, limits and sync spaces (and their items and push records) with it. Only
 * Better Auth's `verification` rows are not tied to the user by a key, and go by address and id first.
 *
 * A billing module keeps its own records, keyed by the user id with no foreign key: it adds them to the export and
 * hears of a deletion before it happens (`BillingProvider.exportAccount`, `deleteAccount`). Nothing here logs.
 */
import { AIError } from '@unalgorithm/ai';
import { type AccountExport, AccountExportSchema } from '@unalgorithm/protocol';
import { asc, eq, inArray, or, sql } from 'drizzle-orm';
import { normalizeEmail } from '../admin/invites.ts';
import {
  account,
  devices,
  passkey,
  session,
  signupInvites,
  syncItems,
  syncSpaces,
  usageEvents,
  user,
  verification,
} from '../db/schema.ts';
import type { AppDeps } from '../http/app.ts';

/** How recently the web session must have been signed in for its account to be deleted: 10 minutes. */
export const DELETE_FRESH_MS = 10 * 60_000;

/**
 * The export's caps (`AccountExportSchema`) on columns that have none: Better Auth stores the raw `User-Agent` header,
 * and the passkey plugin whatever name the page sent. Longer values are cut, so the person's export never fails on them.
 */
const MAX_USER_AGENT = 500;
const MAX_PASSKEY_NAME = 200;

/**
 * The sign-in code types whose rows Better Auth 1.7.7 keys by address, `<type>-otp-<email>` (its email-otp plugin's
 * `toOTPIdentifier`): every type the mounted `send-verification-otp` route stores. It refuses `change-email`, and stores
 * `forget-password` and `email-verification` rows for an existing account even though the server sends only sign-in
 * codes.
 */
const OTP_TYPES = ['sign-in', 'email-verification', 'forget-password'] as const;

/**
 * Everything about the account `userId`, checked against `AccountExportSchema`. The server's rows are read in one
 * snapshot; the billing module's records (`exportAccount`), or null, come after. 401 `auth-required` when the account
 * is gone (deleted since the request's session was checked).
 */
export async function exportAccount(
  { config, db, billing }: Pick<AppDeps, 'config' | 'db' | 'billing'>,
  userId: string,
  now = Date.now(),
): Promise<AccountExport> {
  const stored = await db.db.transaction(
    async (tx) => {
      const [owner] = await tx.select({ email: user.email, createdAt: user.createdAt }).from(user).where(eq(user.id, userId));
      if (!owner) return null;
      const providers = await tx
        .selectDistinct({ providerId: account.providerId })
        .from(account)
        .where(eq(account.userId, userId))
        .orderBy(asc(account.providerId));
      const deviceRows = await tx
        .select({
          id: devices.id,
          name: devices.name,
          createdAt: devices.createdAt,
          lastUsedAt: devices.lastUsedAt,
          revokedAt: devices.revokedAt,
          revokedReason: devices.revokedReason,
        })
        .from(devices)
        .where(eq(devices.userId, userId))
        .orderBy(asc(devices.createdAt), asc(devices.id));
      // Never the public key or the credential id.
      const passkeyRows = await tx
        .select({ name: passkey.name, createdAt: passkey.createdAt, deviceType: passkey.deviceType, backedUp: passkey.backedUp })
        .from(passkey)
        .where(eq(passkey.userId, userId))
        .orderBy(asc(passkey.createdAt), asc(passkey.id));
      // Never the session's token.
      const sessionRows = await tx
        .select({
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        })
        .from(session)
        .where(eq(session.userId, userId))
        .orderBy(asc(session.createdAt), asc(session.id));
      // Counts by UTC day and task; never `cost_micros`, the operator's cost (a billing module reports charges itself).
      const day = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const usage = await tx
        .select({
          day,
          task: usageEvents.task,
          requests: sql`count(*)`.mapWith(Number),
          postsRequested: sql`sum(${usageEvents.postsRequested})`.mapWith(Number),
          postsOk: sql`sum(${usageEvents.postsOk})`.mapWith(Number),
        })
        .from(usageEvents)
        .where(eq(usageEvents.userId, userId))
        .groupBy(day, usageEvents.task)
        .orderBy(day, asc(usageEvents.task));
      const spaces = await tx
        .select({ id: syncSpaces.id, kind: syncSpaces.kind })
        .from(syncSpaces)
        .where(eq(syncSpaces.userId, userId))
        .orderBy(asc(syncSpaces.createdAt), asc(syncSpaces.id));
      const spaceIds = spaces.map((s) => s.id);
      const items =
        spaceIds.length === 0
          ? []
          : await tx
              .select({
                spaceId: syncItems.spaceId,
                collection: syncItems.collection,
                key: syncItems.key,
                deleted: syncItems.deleted,
                value: syncItems.value,
                hlc: syncItems.hlc,
                updatedAt: syncItems.updatedAt,
              })
              .from(syncItems)
              .where(inArray(syncItems.spaceId, spaceIds))
              .orderBy(asc(syncItems.collection), asc(syncItems.key));

      return {
        account: {
          email: owner.email,
          createdAt: owner.createdAt.toISOString(),
          linkedProviders: providers.map((p) => p.providerId),
        },
        devices: deviceRows.map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt.toISOString(),
          lastUsedAt: d.lastUsedAt?.toISOString() ?? null,
          revokedAt: d.revokedAt?.toISOString() ?? null,
          revokedReason: d.revokedReason,
        })),
        passkeys: passkeyRows.map((p) => ({
          name: p.name?.slice(0, MAX_PASSKEY_NAME) ?? null,
          createdAt: p.createdAt?.toISOString() ?? null,
          deviceType: p.deviceType,
          backedUp: p.backedUp,
        })),
        sessions: sessionRows.map((s) => ({
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          ipAddress: s.ipAddress,
          userAgent: s.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
        })),
        usage,
        sync: {
          spaces: spaces.map((space) => ({
            id: space.id,
            kind: space.kind,
            items: items
              .filter((item) => item.spaceId === space.id)
              .map((item) => ({
                collection: item.collection,
                key: item.key,
                deleted: item.deleted,
                // A tombstone has no value.
                ...(item.deleted ? {} : { value: item.value }),
                hlc: item.hlc,
                updatedAt: item.updatedAt.toISOString(),
              })),
          })),
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  if (!stored) throw new AIError('auth-required', 'The account no longer exists.');

  return AccountExportSchema.parse({
    v: 1,
    exportedAt: new Date(now).toISOString(),
    server: { name: config.instanceName, origin: config.publicOrigin, version: config.version },
    ...stored,
    billing: (await billing.exportAccount?.(userId)) ?? null,
  });
}

/**
 * Deletes the account `userId` and everything stored about it; returns whether it was there to delete. The billing
 * module is asked first: when it rejects, nothing is deleted and the rejection propagates. Then one transaction removes
 * the `verification` rows Better Auth keeps for the account outside any foreign key (unused codes keyed by the address;
 * an unfinished passkey registration, whose value holds the user's id) and the user row, whose cascade takes every
 * other row. With the devices gone, every device token and refresh token is refused from the next request on.
 */
export async function deleteAccount({ db, billing }: Pick<AppDeps, 'db' | 'billing'>, userId: string): Promise<boolean> {
  await billing.deleteAccount?.(userId);
  return db.db.transaction(async (tx) => {
    // Locked, so a second deletion at the same time waits here and then finds nothing to delete.
    const [owner] = await tx.select({ email: user.email }).from(user).where(eq(user.id, userId)).for('update');
    if (!owner) return false;
    // Better Auth keys codes by the lowercased address.
    const email = owner.email.toLowerCase();
    const codes = OTP_TYPES.map((type) => `${type}-otp-${email}`);
    await tx.delete(verification).where(
      or(
        inArray(verification.identifier, codes),
        // `strpos`, not `like`: no character of the id acts as a wildcard.
        sql`strpos(${verification.value}, ${userId}) > 0`,
      ),
    );
    // Keyed by address, so the cascade from `user` misses an invite a failed consume left behind.
    await tx.delete(signupInvites).where(eq(signupInvites.email, normalizeEmail(owner.email)));
    await tx.delete(user).where(eq(user.id, userId));
    return true;
  });
}
