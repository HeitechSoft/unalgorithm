/**
 * What the problem reports admin page reads and changes (ADR 0009 §7): the summary (days, groups, "Fixed in" floors),
 * a group's rows, one report in full, and the four actions (mark handled or reopen, set a floor, forget a reply
 * address, delete). The routes (`routes/reports-admin.ts`) check the admin; nothing here logs.
 *
 * Groups and daily counts show listed reports only, development builds only when asked for: reports from an extension
 * id the server doesn't list show as one count (`unlisted7d`), which is how a missing Edge id shows up. A group's rows,
 * a lookup by reference and the actions cover every report, listed or not.
 *
 * Times are read through Drizzle's column mapping and answered with `toISOString()`; days are `to_char` text in UTC.
 */
import { describeReport } from '@unalgorithm/core';
import {
  ADMIN_REPORTS_PAGE_SIZE,
  type AdminReportDetail,
  type AdminReportList,
  type AdminReportRow,
  type AdminReportsListQuery,
  type AdminReportsSummary,
  adapterOrder,
  type HandleReportsRequest,
  parseReportGroupKey,
  REPORT_GROUP_DAYS,
  type ReportDay,
  type ReportDetails,
  ReportDetailsSchema,
  type ReportGroup,
  type ReportGroupParts,
  reportGroupKey,
  type SetFloorRequest,
} from '@unalgorithm/protocol';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, type SQL, sql } from 'drizzle-orm';
import { utcDayStart } from '../ai/metering.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { problemReports, reportFloors, user } from '../db/schema.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The admin list's limit on `lines` (`AdminReportDetailSchema`). */
const MAX_LINES = 40;
/** The summary's limit on groups (`AdminReportsSummarySchema`). */
const MAX_GROUPS = 1000;

const r = problemReports;

/** What the page shows by default: listed reports, without development builds unless `dev`. */
function shown(dev: boolean): SQL | undefined {
  return and(eq(r.listed, true), dev ? undefined : ne(r.channel, 'development'));
}

/** The rows of a group: platform, adapter and topic may be absent (null), the kind never is. */
export function groupCondition(g: ReportGroupParts): SQL | undefined {
  return and(
    g.platform === null ? isNull(r.platform) : eq(r.platform, g.platform),
    g.adapter === null ? isNull(r.adapter) : eq(r.adapter, g.adapter),
    eq(r.kind, g.kind),
    g.topic === null ? isNull(r.topic) : eq(r.topic, g.topic),
  );
}

const dayText = sql<string>`to_char(date_trunc('day', ${r.receivedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
const counted = (filter: SQL) => sql<number>`count(*) filter (where ${filter})`.mapWith(Number);

/** `days` UTC day keys, oldest first, ending with `now`'s. */
function dayKeys(now: Date, days: number): string[] {
  const start = utcDayStart(now).getTime() - (days - 1) * DAY_MS;
  return Array.from({ length: days }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

export interface SummaryOptions {
  /** Days of daily counts, ending today. */
  days: number;
  /** Development builds too. */
  dev: boolean;
}

/**
 * The page's summary: today's total against the daily limit (every report, as the cap counts them), unlisted reports
 * of the last 7 days, daily counts per platform, the groups of the last `days` days and every group still open (open
 * ones first, then the latest), and the floors.
 */
export async function reportsSummary(
  db: Db,
  config: Pick<Config, 'reports'>,
  opts: SummaryOptions,
  now: Date = new Date(),
): Promise<AdminReportsSummary> {
  const keys = dayKeys(now, opts.days);
  const windowStart = new Date(`${keys[0]}T00:00:00.000Z`);
  const groupDays = dayKeys(now, REPORT_GROUP_DAYS);
  const groupStart = new Date(`${groupDays[0]}T00:00:00.000Z`);
  const base = shown(opts.dev);

  return db.transaction(
    async (tx) => {
      const [today] = await tx
        .select({ n: count() })
        .from(r)
        .where(gte(r.receivedAt, utcDayStart(now)));
      const [unlisted] = await tx
        .select({ n: count() })
        .from(r)
        .where(
          and(
            eq(r.listed, false),
            opts.dev ? undefined : ne(r.channel, 'development'),
            gte(r.receivedAt, new Date(now.getTime() - 7 * DAY_MS)),
          ),
        );

      const platform = sql<string>`coalesce(${r.platform}, 'other')`;
      const perDay = await tx
        .select({ day: dayText, platform, n: count() })
        .from(r)
        .where(and(base, gte(r.receivedAt, windowStart)))
        .groupBy(dayText, platform);
      const days: ReportDay[] = keys.map((day) => {
        const n = (p: string) => perDay.find((row) => row.day === day && row.platform === p)?.n ?? 0;
        return { day, linkedin: n('linkedin'), facebook: n('facebook'), other: n('other') };
      });

      const inGroups = and(base, sql`(${r.receivedAt} >= ${windowStart} or ${r.handledAt} is null)`);
      const groupRows = await tx
        .select({
          platform: r.platform,
          adapter: r.adapter,
          kind: r.kind,
          topic: r.topic,
          total: count(),
          open: counted(isNull(r.handledAt)),
          networks: counted(eq(r.firstFromNetwork, true)),
          lastAt: sql<Date>`max(${r.receivedAt})`.mapWith(r.receivedAt),
        })
        .from(r)
        .where(inGroups)
        .groupBy(r.platform, r.adapter, r.kind, r.topic);
      const groupDaily = await tx
        .select({ platform: r.platform, adapter: r.adapter, kind: r.kind, topic: r.topic, day: dayText, n: count() })
        .from(r)
        .where(and(inGroups, gte(r.receivedAt, groupStart)))
        .groupBy(r.platform, r.adapter, r.kind, r.topic, dayText);
      const daily = new Map<string, number>();
      for (const row of groupDaily) daily.set(`${reportGroupKey(row)}#${row.day}`, row.n);

      const groups: ReportGroup[] = groupRows
        .map((g) => {
          const key = reportGroupKey(g);
          return {
            key,
            platform: g.platform,
            adapter: g.adapter,
            kind: g.kind,
            topic: g.topic,
            total: g.total,
            open: g.open,
            networks: g.networks,
            lastAt: g.lastAt.toISOString(),
            perDay: groupDays.map((day) => daily.get(`${key}#${day}`) ?? 0),
          };
        })
        .sort(
          (a, b) =>
            Number(b.open > 0) - Number(a.open > 0) ||
            b.lastAt.localeCompare(a.lastAt) ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        )
        .slice(0, MAX_GROUPS);

      const floors = await tx
        .select({ platform: reportFloors.platform, adapter: reportFloors.adapter, setAt: reportFloors.setAt })
        .from(reportFloors)
        .orderBy(asc(reportFloors.platform));

      return {
        enabled: config.reports.enabled,
        today: today?.n ?? 0,
        dailyMax: config.reports.dailyMax,
        unlisted7d: unlisted?.n ?? 0,
        days,
        groups,
        floors: floors.map((f) => ({ platform: f.platform, adapter: f.adapter, setAt: f.setAt.toISOString() })),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

/** The columns a list row reads. */
const ROW = {
  id: r.id,
  ref: r.ref,
  receivedAt: r.receivedAt,
  kind: r.kind,
  from: r.from,
  channel: r.channel,
  listed: r.listed,
  extension: r.extension,
  browser: r.browser,
  browserMajor: r.browserMajor,
  platform: r.platform,
  adapter: r.adapter,
  topic: r.topic,
  choices: r.choices,
  firstFromNetwork: r.firstFromNetwork,
  handledAt: r.handledAt,
  resolution: r.resolution,
  hasMessage: sql<boolean>`${r.message} is not null`.mapWith(Boolean),
  hasContact: sql<boolean>`${r.contact} is not null`.mapWith(Boolean),
};

type StoredRow = Omit<AdminReportRow, 'receivedAt' | 'handledAt'> & { receivedAt: Date; handledAt: Date | null };

function rowOf(row: StoredRow): AdminReportRow {
  return { ...row, receivedAt: row.receivedAt.toISOString(), handledAt: row.handledAt?.toISOString() ?? null };
}

/**
 * A page's cursor. Reports keep only the hour they arrived in, so many share a time: `nextBefore` is the hour of the
 * page's last row plus, in milliseconds, how many rows of that hour the pages so far have shown (rows of an hour go
 * newest id first). An hour on the dot asks for the rows before it.
 */
function parseCursor(before: string): { hour: number; skip: number } {
  const at = Date.parse(before);
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  return { hour, skip: at - hour };
}

/**
 * A page of rows, newest first: by group and status, continuing from `before` (`nextBefore` of the page before). A
 * reference (exact, for privacy requests) finds its report whatever its group or status.
 */
export async function listReports(db: Db, query: AdminReportsListQuery): Promise<AdminReportList> {
  if (query.ref !== undefined) {
    const rows = await db.select(ROW).from(r).where(eq(r.ref, query.ref)).limit(1);
    return { rows: rows.map(rowOf), nextBefore: null };
  }
  const group = query.group === undefined ? null : parseReportGroupKey(query.group);
  const status = query.status === 'open' ? isNull(r.handledAt) : query.status === 'handled' ? isNotNull(r.handledAt) : undefined;
  const filters = and(group ? groupCondition(group) : undefined, status);
  const limit = ADMIN_REPORTS_PAGE_SIZE + 1;
  const cursor = query.before === undefined ? null : parseCursor(query.before);

  let rows: StoredRow[];
  if (cursor === null) {
    rows = await db.select(ROW).from(r).where(filters).orderBy(desc(r.receivedAt), desc(r.id)).limit(limit);
  } else {
    const sameHour =
      cursor.skip === 0
        ? []
        : await db
            .select(ROW)
            .from(r)
            .where(and(filters, eq(r.receivedAt, new Date(cursor.hour))))
            .orderBy(desc(r.id))
            .offset(cursor.skip)
            .limit(limit);
    const older = await db
      .select(ROW)
      .from(r)
      .where(and(filters, lt(r.receivedAt, new Date(cursor.hour))))
      .orderBy(desc(r.receivedAt), desc(r.id))
      .limit(limit);
    rows = [...sameHour, ...older].slice(0, limit);
  }

  const page = rows.slice(0, ADMIN_REPORTS_PAGE_SIZE);
  const last = page.at(-1);
  let nextBefore: string | null = null;
  if (rows.length > ADMIN_REPORTS_PAGE_SIZE && last) {
    const hour = last.receivedAt.getTime();
    let shownInHour = page.filter((row) => row.receivedAt.getTime() === hour).length;
    if (cursor?.hour === hour) shownInHour += cursor.skip;
    nextBefore = new Date(hour + shownInHour).toISOString();
  }
  return { rows: page.map(rowOf), nextBefore };
}

/** One report in full, with `describeReport`'s lines; null when no report has this id. */
export async function reportDetail(db: Db, id: string): Promise<AdminReportDetail | null> {
  const [row] = await db
    .select({
      ...ROW,
      details: r.details,
      unknownCodes: r.unknownCodes,
      message: r.message,
      contact: r.contact,
      handledById: user.id,
      handledByEmail: user.email,
    })
    .from(r)
    .leftJoin(user, eq(user.id, r.handledBy))
    .where(eq(r.id, id))
    .limit(1);
  if (!row) return null;
  const { details: stored, unknownCodes, message, contact, handledById, handledByEmail, ...listed } = row;
  // Written through the same schema; a row a later release can't read still opens, without its details.
  const details: ReportDetails = ReportDetailsSchema.safeParse(stored).data ?? {};
  const lines = describeReport(
    {
      kind: listed.kind,
      choices: listed.choices,
      env: { extension: listed.extension, channel: listed.channel, browser: listed.browser, browserMajor: listed.browserMajor },
      from: listed.from,
      ...(details.private ? { private: true } : {}),
      ...(details.page ? { page: details.page } : {}),
      ...(details.health ? { health: details.health } : {}),
      ...(details.detection ? { detection: details.detection } : {}),
      ...(details.post ? { post: details.post } : {}),
      ...(details.correction ? { correction: { ...details.correction, message, contact } } : {}),
    },
    { words: false },
  );
  return {
    ...rowOf(listed),
    details,
    unknownCodes,
    message,
    contact,
    lines: lines.slice(0, MAX_LINES),
    handledBy: handledById !== null && handledByEmail !== null ? { id: handledById, email: handledByEmail } : null,
  };
}

/**
 * Marks reports handled with a resolution, or reopens them; answers how many changed. By ids, or a whole group: the
 * group's rows received by `now`, so a report that arrives after the admin's click stays open. Marking changes only
 * open rows and reopening only handled ones, so a resolution is never overwritten by a group action.
 */
export async function handleReports(db: Db, adminId: string, req: HandleReportsRequest, now: Date = new Date()): Promise<number> {
  const group = req.group === undefined ? null : parseReportGroupKey(req.group);
  const target = req.ids ? inArray(r.id, req.ids) : group ? and(groupCondition(group), lte(r.receivedAt, now)) : sql`false`;
  const changed = req.handled
    ? await db
        .update(r)
        .set({ handledAt: now, handledBy: adminId, resolution: req.resolution ?? null })
        .where(and(target, isNull(r.handledAt)))
        .returning({ id: r.id })
    : await db
        .update(r)
        .set({ handledAt: null, handledBy: null, resolution: null })
        .where(and(target, isNotNull(r.handledAt)))
        .returning({ id: r.id });
  return changed.length;
}

/**
 * Sets a platform's "Fixed in" floor, and marks its open reports from older detection versions handled
 * (`older-version`); answers how many it marked. `adapter: null` clears the floor (reports it marked stay handled).
 */
export async function setFloor(db: Db, adminId: string, req: SetFloorRequest, now: Date = new Date()): Promise<number> {
  if (req.adapter === null) {
    await db.delete(reportFloors).where(eq(reportFloors.platform, req.platform));
    return 0;
  }
  const order = adapterOrder(req.adapter);
  if (order === null) throw new TypeError('Not a detection version.');
  const adapter = req.adapter;
  return db.transaction(async (tx) => {
    await tx
      .insert(reportFloors)
      .values({ platform: req.platform, adapter, adapterOrder: order, setAt: now, setBy: adminId })
      .onConflictDoUpdate({ target: reportFloors.platform, set: { adapter, adapterOrder: order, setAt: now, setBy: adminId } });
    const marked = await tx
      .update(r)
      .set({ handledAt: now, handledBy: adminId, resolution: 'older-version' })
      .where(and(eq(r.platform, req.platform), lt(r.adapterOrder, order), isNull(r.handledAt)))
      .returning({ id: r.id });
    return marked.length;
  });
}

/** Clears a report's reply address at once; false when no report has this id. */
export async function forgetContact(db: Db, id: string): Promise<boolean> {
  const rows = await db.update(r).set({ contact: null }).where(eq(r.id, id)).returning({ id: r.id });
  return rows.length > 0;
}

/** Deletes reports for good (a privacy request, or a message holding personal data); answers how many. */
export async function deleteReports(db: Db, ids: readonly string[]): Promise<number> {
  const rows = await db
    .delete(r)
    .where(inArray(r.id, [...ids]))
    .returning({ id: r.id });
  return rows.length;
}

/**
 * The admin overview's line, "Problem reports (N open)": listed reports from builds other than development ones, open
 * now and received in the last 24 hours. `enabled` is `REPORTS`.
 */
export async function reportsOverview(
  db: Db,
  config: Pick<Config, 'reports'>,
  now: Date = new Date(),
): Promise<{ enabled: boolean; open: number; last24h: number }> {
  const [row] = await db
    .select({
      open: counted(isNull(r.handledAt)),
      last24h: counted(gte(r.receivedAt, new Date(now.getTime() - DAY_MS))),
    })
    .from(r)
    .where(shown(false));
  return { enabled: config.reports.enabled, open: row?.open ?? 0, last24h: row?.last24h ?? 0 };
}
