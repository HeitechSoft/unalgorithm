/**
 * Deletes the sign-in rows nobody can use any longer: refresh tokens past their 60 days, the extension's codes past their
 * minute, and Better Auth's `verification` rows (emailed codes, Google sign-in state, passkey challenges) past theirs.
 * A spent refresh token stays until its own expiry, so a copy of it coming back is still caught as reuse. Runs every
 * hour on the server's job registry, so on every server backed by Postgres (`docs/privacy-model.md` gives the retention).
 */
import { lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { authCodes, refreshTokens, verification } from '../db/schema.ts';
import type { JobRegistry } from '../jobs/worker.ts';

export const AUTH_PURGE_TASK = 'auth.purge-expired';
/** Every hour, at 23 minutes past (UTC). */
export const AUTH_PURGE_SCHEDULE = '23 * * * *';

/** How many rows of each table a purge deleted. */
export interface AuthPurge {
  refreshTokens: number;
  authCodes: number;
  verification: number;
}

/** Deletes every row of the three tables whose expiry is before `now`. */
export async function purgeExpiredAuthRows(db: Db, now = Date.now()): Promise<AuthPurge> {
  const at = new Date(now);
  const tokens = await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, at)).returning({ id: refreshTokens.id });
  const codes = await db.delete(authCodes).where(lt(authCodes.expiresAt, at)).returning({ id: authCodes.codeHash });
  const rows = await db.delete(verification).where(lt(verification.expiresAt, at)).returning({ id: verification.id });
  return { refreshTokens: tokens.length, authCodes: codes.length, verification: rows.length };
}

/** Registers the hourly purge. Its payload is empty, and its log line holds the counts only. */
export function registerAuthJobs(jobs: JobRegistry, deps: { db: Db }): void {
  jobs.task(AUTH_PURGE_TASK, async (_payload, { log }) => {
    const purged = await purgeExpiredAuthRows(deps.db);
    log.info('auth.purged', {
      refresh_tokens: purged.refreshTokens,
      auth_codes: purged.authCodes,
      verification: purged.verification,
    });
  });
  jobs.cron(AUTH_PURGE_TASK, AUTH_PURGE_SCHEDULE);
}
