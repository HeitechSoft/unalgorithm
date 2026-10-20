/**
 * Retention for problem reports (ADR 0009 §6), run hourly as `reports.purge` on every server backed by Postgres, with
 * REPORTS on or off, so reports kept from before still go:
 * - a reply address is cleared 30 days after its report was handled, and never kept more than 60 days after it arrived;
 * - at 90 days a report is deleted; a correction first adds 1 to `correction_counts` for its quarter, feature and
 *   resolution (`none` when it was never handled), in the same transaction, so the transparency report still counts it.
 *
 * Deleted rows stay in the encrypted nightly backups for up to 14 more nights (`REPORT_BACKUP_NIGHTS`). The log line
 * holds counts only.
 */
import { quarterOf, REPORT_CONTACT_AFTER_HANDLED_DAYS, REPORT_CONTACT_KEEP_DAYS, REPORT_KEEP_DAYS } from '@unalgorithm/protocol';
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { correctionCounts, problemReports } from '../db/schema.ts';
import type { JobRegistry } from '../jobs/worker.ts';

export const REPORTS_PURGE_TASK = 'reports.purge';
/** Every hour, at 23 minutes past (UTC). */
export const REPORTS_PURGE_SCHEDULE = '23 * * * *';

const DAY_MS = 86_400_000;
/** A correction never handled is counted under this resolution. */
export const UNHANDLED = 'none';

/** What one purge did. */
export interface ReportsPurge {
  /** Reply addresses cleared. */
  contacts: number;
  /** Corrections added to `correction_counts` before their rows went. */
  corrections: number;
  /** Rows deleted, corrections included. */
  deleted: number;
}

/** One purge at `now`: see the module comment. */
export async function purgeReports(db: Db, now: number = Date.now()): Promise<ReportsPurge> {
  const r = problemReports;
  const daysAgo = (days: number) => new Date(now - days * DAY_MS);
  const cleared = await db
    .update(r)
    .set({ contact: null })
    .where(
      and(
        isNotNull(r.contact),
        or(lt(r.handledAt, daysAgo(REPORT_CONTACT_AFTER_HANDLED_DAYS)), lt(r.receivedAt, daysAgo(REPORT_CONTACT_KEEP_DAYS))),
      ),
    )
    .returning({ id: r.id });

  const cutoff = daysAgo(REPORT_KEEP_DAYS);
  return db.transaction(async (tx) => {
    const corrections = await tx
      .delete(r)
      .where(and(eq(r.kind, 'correction'), lt(r.receivedAt, cutoff)))
      .returning({
        receivedAt: r.receivedAt,
        feature: sql<string | null>`${r.details} -> 'correction' ->> 'feature'`,
        resolution: r.resolution,
      });
    const tally = new Map<string, { quarter: string; feature: string; resolution: string; n: number }>();
    for (const c of corrections) {
      const entry = {
        quarter: quarterOf(c.receivedAt),
        feature: c.feature ?? 'unknown',
        resolution: c.resolution ?? UNHANDLED,
      };
      const key = `${entry.quarter}|${entry.feature}|${entry.resolution}`;
      tally.set(key, { ...entry, n: (tally.get(key)?.n ?? 0) + 1 });
    }
    if (tally.size > 0) {
      await tx
        .insert(correctionCounts)
        .values([...tally.values()])
        .onConflictDoUpdate({
          target: [correctionCounts.quarter, correctionCounts.feature, correctionCounts.resolution],
          set: { n: sql`${correctionCounts.n} + excluded.n` },
        });
    }
    const others = await tx.delete(r).where(lt(r.receivedAt, cutoff)).returning({ id: r.id });
    return { contacts: cleared.length, corrections: corrections.length, deleted: corrections.length + others.length };
  });
}

/** Registers the hourly purge. Its payload is empty, and its log line holds the counts only. */
export function registerReportJobs(jobs: JobRegistry, deps: { db: Db }): void {
  jobs.task(REPORTS_PURGE_TASK, async (_payload, { log }) => {
    const purged = await purgeReports(deps.db);
    log.info('reports.purged', { contacts: purged.contacts, corrections: purged.corrections, deleted: purged.deleted });
  });
  jobs.cron(REPORTS_PURGE_TASK, REPORTS_PURGE_SCHEDULE);
}
