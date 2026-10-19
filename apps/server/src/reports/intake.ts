/**
 * Taking in a problem report (ADR 0009 §6), in the ADR's order:
 * 1. the schema (`ProblemReportSchema`), whose unknown keys are stripped and never stored;
 * 2. a correction from an extension id the server doesn't list is refused (403 `unlisted`), so a fork's users' words
 *    never reach this server under the wrong privacy policy;
 * 3. an id stored before answers 200 with its reference, and takes no limit;
 * 4. the limits (`limits.ts`);
 * 5. only registry codes are kept (`keepKnownCodes`, the rest counted in `unknown_codes`), the message is cleaned again
 *    and the reply address lowercased;
 * 6. the topic, the adapter's order and `first_from_network` are derived, and a report from below the platform's
 *    "Fixed in" floor is stored already handled (`older-version`);
 * 7. the row is inserted, the time rounded down to the hour, under a reference the server picks.
 *
 * The request's Origin is reduced to one boolean, `listed`, here and nowhere else: neither the Origin, the extension
 * id, the address nor any request header is stored or logged. The one log line, `report.received`, holds the kind,
 * platform, adapter, topic and `listed`.
 */
import { randomBytes } from 'node:crypto';
import { cleanReportMessage } from '@unalgorithm/core';
import {
  adapterOrder,
  clientKind,
  keepKnownCodes,
  type PlatformId,
  type ProblemReport,
  ProblemReportSchema,
  REPORT_ERRORS,
  type ReportAccepted,
  type ReportDetails,
  ReportDetailsSchema,
  reportRef,
  reportTopic,
  type WireError,
} from '@unalgorithm/protocol';
import { count, eq, gte } from 'drizzle-orm';
import type { Config } from '../config.ts';
import { type Db, queryErrorFields } from '../db/client.ts';
import { problemReports, reportFloors } from '../db/schema.ts';
import type { Logger } from '../log.ts';
import type { ReportLimits } from './limits.ts';

const HOUR_MS = 3_600_000;
/** A reference is 40 random bits: a clash is rare, and a few new draws always settle it. */
const REF_ATTEMPTS = 5;

const CHROMIUM_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const GECKO_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `at` rounded down to the hour: the only time a report keeps. */
export function hourOf(at: number): Date {
  return new Date(Math.floor(at / HOUR_MS) * HOUR_MS);
}

/**
 * Whether a report comes from a listed extension: a Chrome or Edge id (read from the Origin) in `EXTENSION_IDS`, or,
 * from a Firefox page, whose Origin is a random UUID, the add-on id the report names (`env.client`) in it. Neither id
 * is kept.
 */
export function isListed(origin: string, client: string | undefined, extensionIds: readonly string[]): boolean {
  const chromium = CHROMIUM_ORIGIN.exec(origin)?.[1];
  if (chromium !== undefined) return extensionIds.includes(chromium);
  if (GECKO_ORIGIN.test(origin)) return client !== undefined && clientKind(client) === 'gecko' && extensionIds.includes(client);
  return false;
}

/** Reports stored since `since`: today's total for the daily cap, read once a day. */
export async function countReportsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(problemReports).where(gte(problemReports.receivedAt, since));
  return row?.n ?? 0;
}

export interface IntakeDeps {
  db: Db;
  config: Pick<Config, 'extensionIds'>;
  log: Logger;
  limits: ReportLimits;
  /** Tests only: the reference's random bytes. Default: `crypto.randomBytes`. */
  random?: (size: number) => Uint8Array;
}

export interface IntakeRequest {
  /** The parsed JSON body, not yet checked. */
  body: unknown;
  /** The request's Origin, already held to an extension's by the route. */
  origin: string;
  /** `getClientIp`: for the limits only, never kept. */
  ip: string | null;
}

/** What the route answers: 201 or 200 with the reference, or a fixed error body (with a wait for 429 and 503). */
export type IntakeAnswer =
  | { outcome: 'accepted'; status: 200 | 201; body: ReportAccepted }
  | { outcome: 'refused'; status: 400 | 403; body: WireError }
  | { outcome: 'wait'; status: 429 | 503; body: WireError; retryAfterMs: number };

/** What the server keeps of a report besides its columns: registry codes only, never the words or reply address. */
function detailsOf(r: ProblemReport): ReportDetails {
  const { message: _message, contact: _contact, ...correction } = r.correction ?? {};
  return ReportDetailsSchema.parse({
    ...(r.private ? { private: true } : {}),
    ...(r.page ? { page: r.page } : {}),
    ...(r.health ? { health: r.health } : {}),
    ...(r.detection ? { detection: r.detection } : {}),
    ...(r.post ? { post: r.post } : {}),
    ...(r.correction ? { correction } : {}),
  });
}

/** Takes in one report: see the module comment for the order. Throws only for a database failure (500). */
export async function receiveReport(deps: IntakeDeps, req: IntakeRequest, now: number = Date.now()): Promise<IntakeAnswer> {
  const { db, config, log, limits } = deps;
  const parsed = ProblemReportSchema.safeParse(req.body);
  if (!parsed.success) return { outcome: 'refused', status: 400, body: REPORT_ERRORS.invalid };
  const report = parsed.data;
  const listed = isListed(req.origin, report.env.client, config.extensionIds);
  if (!listed && report.kind === 'correction') return { outcome: 'refused', status: 403, body: REPORT_ERRORS.unlisted };

  const stored = await storedRef(db, report.id);
  if (stored !== null) return { outcome: 'accepted', status: 200, body: { ok: true, ref: stored } };

  const page = report.page ? { platform: report.page.platform, kind: report.kind } : null;
  const admission = await limits.admit(req.ip, page, now);
  if (!admission.ok) {
    const body = admission.status === 503 ? REPORT_ERRORS.unavailable : REPORT_ERRORS.rateLimit;
    return { outcome: 'wait', status: admission.status, body, retryAfterMs: admission.retryAfterMs };
  }

  try {
    const { report: kept, unknown } = keepKnownCodes(report);
    const message = listed && kept.correction ? cleanReportMessage(kept.correction.message) : null;
    // The extension cleans the words too, so only a message of nothing but invisible characters ends here.
    if (message === '') {
      admission.release();
      return { outcome: 'refused', status: 400, body: REPORT_ERRORS.invalid };
    }
    const contact = listed ? (kept.correction?.contact?.trim().toLowerCase() ?? null) : null;
    const order = kept.page ? adapterOrder(kept.page.adapter) : null;
    const receivedAt = hourOf(now);
    const below = kept.page && order !== null ? await belowFloor(db, kept.page.platform, order) : false;
    const row = {
      id: kept.id,
      receivedAt,
      kind: kept.kind,
      from: kept.from,
      channel: kept.env.channel,
      listed,
      extension: kept.env.extension,
      browser: kept.env.browser,
      browserMajor: kept.env.browserMajor,
      platform: kept.page?.platform ?? null,
      adapter: kept.page?.adapter ?? null,
      adapterOrder: order,
      topic: reportTopic(kept),
      choices: kept.choices,
      firstFromNetwork: admission.firstFromNetwork,
      details: detailsOf(kept),
      unknownCodes: unknown,
      message,
      contact,
      ...(below ? { handledAt: receivedAt, resolution: 'older-version' as const } : {}),
    };

    const ref = await insertReport(db, row, deps.random ?? ((size: number) => randomBytes(size)));
    if (ref === null) {
      // The same id was stored meanwhile (a second send of the same report): its reference, and nothing taken.
      admission.release();
      const winner = await storedRef(db, report.id);
      if (winner === null) throw new Error('A report id conflicted but no row has it.');
      return { outcome: 'accepted', status: 200, body: { ok: true, ref: winner } };
    }
    log.info('report.received', { kind: row.kind, platform: row.platform, adapter: row.adapter, topic: row.topic, listed });
    return { outcome: 'accepted', status: 201, body: { ok: true, ref } };
  } catch (err) {
    admission.release();
    throw err;
  }
}

async function storedRef(db: Db, id: string): Promise<string | null> {
  const [row] = await db.select({ ref: problemReports.ref }).from(problemReports).where(eq(problemReports.id, id)).limit(1);
  return row?.ref ?? null;
}

/** Whether `order` is below the platform's "Fixed in" floor. */
async function belowFloor(db: Db, platform: PlatformId, order: number): Promise<boolean> {
  const [floor] = await db
    .select({ order: reportFloors.adapterOrder })
    .from(reportFloors)
    .where(eq(reportFloors.platform, platform))
    .limit(1);
  return floor !== undefined && order < floor.order;
}

/**
 * Inserts the row under a fresh reference, drawing again when the reference is taken (the unique index answers
 * 23505; a taken id never does, `ON CONFLICT (id) DO NOTHING`). Answers the reference, or null when the id was taken.
 */
async function insertReport(
  db: Db,
  row: Omit<typeof problemReports.$inferInsert, 'ref'>,
  random: (size: number) => Uint8Array,
): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const ref = reportRef(random(5));
    try {
      const [inserted] = await db
        .insert(problemReports)
        .values({ ...row, ref })
        .onConflictDoNothing({ target: problemReports.id })
        .returning({ ref: problemReports.ref });
      return inserted?.ref ?? null;
    } catch (err) {
      if (attempt < REF_ATTEMPTS && queryErrorFields(err).err_code === '23505') continue;
      throw err;
    }
  }
}
