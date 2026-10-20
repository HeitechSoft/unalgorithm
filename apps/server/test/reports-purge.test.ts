/**
 * Retention for problem reports (ADR 0009 §6): `reports.purge` clears reply addresses after 30 days handled or 60 days
 * kept, and deletes rows at 90 days, a correction first counted in `correction_counts` for the transparency report.
 */
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { correctionCounts, problemReports } from '../src/db/schema.ts';
import type { JobHandler, JobRegistry } from '../src/jobs/worker.ts';
import { purgeReports, REPORTS_PURGE_SCHEDULE, REPORTS_PURGE_TASK, registerReportJobs } from '../src/reports/purge.ts';
import { createTestDb } from './support/db.ts';
import { captureLog } from './support/log.ts';
import { correctionDetails, insertReport } from './support/reports.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY);

/** Databases a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function db(): Promise<Db> {
  const handle = await createTestDb();
  cleanup.push(() => handle.close());
  return handle.db;
}

/** A correction received `received` days ago, handled `handled` days ago (null: open), with a reply address. */
function correction(d: Db, received: number, handled: number | null, extra: Partial<typeof problemReports.$inferInsert> = {}) {
  return insertReport(d, daysAgo(received), {
    kind: 'correction',
    from: 'sidepanel',
    platform: null,
    adapter: null,
    adapterOrder: null,
    topic: 'factcheck',
    choices: ['verdict-wrong'],
    firstFromNetwork: false,
    details: correctionDetails(),
    message: 'The claim was about 2024.',
    contact: 'ann@example.org',
    ...(handled === null ? {} : { handledAt: daysAgo(handled), resolution: 'corrected' as const }),
    ...extra,
  });
}

async function contactOf(d: Db): Promise<Record<string, string | null>> {
  const rows = await d.select({ id: problemReports.id, contact: problemReports.contact }).from(problemReports);
  return Object.fromEntries(rows.map((r) => [r.id, r.contact]));
}

describe('purge', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_purge_clears_reply_addresses', async () => {
    const d = await db();
    const handledLongAgo = await correction(d, 40, 31);
    const handledRecently = await correction(d, 40, 29);
    const keptTooLong = await correction(d, 61, null);
    const handledButOld = await correction(d, 61, 1);
    const fresh = await correction(d, 59, null);
    const purged = await purgeReports(d, NOW);
    expect(purged).toEqual({ contacts: 3, corrections: 0, deleted: 0 });
    expect(await contactOf(d)).toEqual({
      [handledLongAgo]: null,
      [handledRecently]: 'ann@example.org',
      [keptTooLong]: null,
      [handledButOld]: null,
      [fresh]: 'ann@example.org',
    });
    // The words stay until the row goes.
    const messages = await d.select({ message: problemReports.message }).from(problemReports);
    expect(messages.every((m) => m.message === 'The claim was about 2024.')).toBe(true);
  });

  it('test_purge_deletes_at_90_days_and_counts_corrections', async () => {
    const d = await db();
    // 91 days before 2026-10-19 is 2026-07-20: the third quarter. One more from June: the second.
    await correction(d, 91, 10);
    await correction(d, 91, null);
    await correction(d, 92, null);
    await correction(d, 125, 100, { details: correctionDetails('perspectives'), resolution: 'no-change' });
    await insertReport(d, daysAgo(91));
    const kept = [await correction(d, 89, null), await insertReport(d, daysAgo(89))];

    const purged = await purgeReports(d, NOW);
    // Every correction here is over 60 days old, so its reply address went first: the 89-day-old one's too.
    expect(purged).toEqual({ contacts: 5, corrections: 4, deleted: 5 });
    const left = await d.select({ id: problemReports.id }).from(problemReports);
    expect(left.map((r) => r.id).sort()).toEqual([...kept].sort());
    const counts = await d
      .select()
      .from(correctionCounts)
      .orderBy(asc(correctionCounts.quarter), asc(correctionCounts.feature), asc(correctionCounts.resolution));
    expect(counts).toEqual([
      { quarter: '2026-Q2', feature: 'perspectives', resolution: 'no-change', n: 1 },
      { quarter: '2026-Q3', feature: 'factcheck', resolution: 'corrected', n: 1 },
      { quarter: '2026-Q3', feature: 'factcheck', resolution: 'none', n: 2 },
    ]);

    // A later purge adds to the counts already kept.
    await correction(d, 95, null);
    expect(await purgeReports(d, NOW)).toEqual({ contacts: 1, corrections: 1, deleted: 1 });
    const [unhandled] = await d
      .select({ n: correctionCounts.n })
      .from(correctionCounts)
      .where(sqlEq('2026-Q3', 'factcheck', 'none'));
    expect(unhandled?.n).toBe(3);
    // Nothing left to do: a purge changes nothing.
    expect(await purgeReports(d, NOW)).toEqual({ contacts: 0, corrections: 0, deleted: 0 });
  });

  it('test_purge_job_registered_and_logs_counts', async () => {
    const d = await db();
    const tasks = new Map<string, JobHandler>();
    const schedules: [string, string][] = [];
    const recording: JobRegistry = {
      task: (name, handler) => tasks.set(name, handler),
      cron: (task, match) => schedules.push([task, match]),
    };
    registerReportJobs(recording, { db: d });
    expect([...tasks.keys()]).toEqual([REPORTS_PURGE_TASK]);
    expect(schedules).toEqual([['reports.purge', '23 * * * *']]);
    expect(REPORTS_PURGE_SCHEDULE).toBe('23 * * * *');

    await correction(d, 200, null);
    const { log, events } = captureLog();
    await tasks.get(REPORTS_PURGE_TASK)?.({}, { signal: new AbortController().signal, log });
    expect(events()).toEqual([
      { t: expect.any(String), level: 'info', event: 'reports.purged', contacts: 1, corrections: 1, deleted: 1 },
    ]);
  });
});

/** One `correction_counts` row's key. */
function sqlEq(quarter: string, feature: string, resolution: string) {
  return and(
    eq(correctionCounts.quarter, quarter),
    eq(correctionCounts.feature, feature),
    eq(correctionCounts.resolution, resolution),
  );
}
