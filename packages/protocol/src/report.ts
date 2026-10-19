/**
 * Problem reports (ADR 0009): the one wire contract the extension's report page, the server's `POST /v1/reports` and
 * the admin page share. A report holds versions, codes, counts and the person's choices; a correction adds the person's
 * own words and, if they want a reply, an email address. Nothing in it can carry post text, a name, a link, an id or a
 * page address: every string is an enum, a version, or a code, id or key held to a pattern.
 *
 * Every object is a plain `z.object`: unknown keys are stripped, never stored and never a 400, so a newer extension's
 * extra field reaches an older server harmlessly. Codes are checked by pattern only, so a newer extension's new code is
 * never refused; the server then keeps only the codes listed in `report-codes.ts` (`keepKnownCodes`).
 */
import { z } from 'zod';
import type { WireError } from './errors.ts';
import { LIST_KINDS } from './perspectives.ts';
import { AUTHOR_KINDS, MEDIA_KINDS, PLATFORMS, type PlatformId } from './platform.ts';
import { GeckoIdSchema } from './server.ts';
import { CLOUD_ORIGIN } from './site.ts';

/** The one route reports go to. No other path, server or third party, from any build or browser (ADR 0009 §1). */
export const REPORTS_PATH = '/v1/reports';
/** unAlgorithm Cloud's report route, whatever AI source or server the person uses. Only e2e builds point elsewhere. */
export const REPORTS_URL = `${CLOUD_ORIGIN}${REPORTS_PATH}`;

/** The largest report body the server reads; anything bigger is a 413. A real report is a few KiB. */
export const MAX_REPORT_BODY_BYTES = 16 * 1024;
/** A correction's own words, in UTF-16 code units (`String.length`), after cleaning. */
export const MAX_CORRECTION_MESSAGE = 1000;
/** The largest count a report may carry; real pages have a few hundred items. */
export const MAX_REPORT_COUNT = 1_000_000;

/** Reports are deleted this many days after they arrive (corrections first become quarterly counts). */
export const REPORT_KEEP_DAYS = 90;
/** A reply email is never kept longer than this many days after the report arrived. */
export const REPORT_CONTACT_KEEP_DAYS = 60;
/** ...and is cleared this many days after the report is handled, if that comes first. */
export const REPORT_CONTACT_AFTER_HANDLED_DAYS = 30;
/** Deleted rows stay in the encrypted nightly backups for at most this many more nights. */
export const REPORT_BACKUP_NIGHTS = 14;
/** Local limits the extension keeps (timestamps only, never sent): sends per hour and per day from one browser. */
export const REPORT_LOCAL_PER_HOUR = 3;
export const REPORT_LOCAL_PER_DAY = 10;
/** One send waits this long for the server, then says it couldn't send. There is no automatic retry. */
export const REPORT_SEND_TIMEOUT_MS = 15_000;
/** Corrections are answered within this many business days (docs/site/corrections.md); the admin page counts against it. */
export const CORRECTION_ANSWER_BUSINESS_DAYS = 5;

export const REPORT_KINDS = ['detection', 'wrong-call', 'correction', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
/** Where this copy of unAlgorithm came from. `development` covers dev and e2e builds; the admin page hides them. */
export const REPORT_CHANNELS = ['chrome-store', 'edge-store', 'firefox-store', 'sideload', 'development', 'other'] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];
export const REPORT_BROWSERS = ['chrome', 'edge', 'firefox', 'other'] as const;
export type ReportBrowser = (typeof REPORT_BROWSERS)[number];
/**
 * The page's route class. `other` is a platform page that isn't the feed; `unknown` means the page wasn't checked (the
 * popup's tab didn't answer, or the report started in Settings).
 */
export const REPORT_ROUTES = ['feed', 'feed-candidate', 'other', 'unknown'] as const;
export type ReportRoute = (typeof REPORT_ROUTES)[number];
export const REPORT_PRESETS = ['light', 'balanced', 'calm', 'custom'] as const;
/** Which AI the person uses, as a kind only: never a server address, a model or a key. */
export const REPORT_AI_KINDS = ['off', 'on-device', 'own-key', 'own-server', 'cloud'] as const;
export type ReportAiKind = (typeof REPORT_AI_KINDS)[number];
/** The AI that made a result being corrected. On-device AI never makes Fact-check or UnEcho Chamber results. */
export const CORRECTION_VIA = ['own-key', 'own-server', 'cloud'] as const;
export const CORRECTION_FEATURES = ['factcheck', 'perspectives'] as const;
export type CorrectionFeature = (typeof CORRECTION_FEATURES)[number];
/** Page health as the extension saw it; `not-started` is a page the controller never ran on (the watchdog's finding). */
export const REPORT_HEALTH_STATUSES = ['ok', 'degraded', 'broken', 'unsupported-locale', 'not-started'] as const;
export const EVIDENCE_STRENGTHS = ['strong', 'medium', 'weak'] as const;
export const REPORT_RELATIONSHIPS = ['followed', 'not-followed', 'unknown'] as const;
/** A post's text, as a size only: `short` is under 200 characters. */
export const TEXT_BUCKETS = ['none', 'short', 'long'] as const;
export type TextBucket = (typeof TEXT_BUCKETS)[number];

/** How an admin closes a report. */
export const REPORT_RESOLUTIONS = ['fixed', 'duplicate', 'cant-reproduce', 'not-a-bug', 'older-version', 'spam'] as const;
/** ...and, for corrections, the outcomes docs/site/corrections.md names. */
export const CORRECTION_RESOLUTIONS = ['corrected', 'no-change', 'out-of-scope'] as const;
export const ALL_REPORT_RESOLUTIONS = [...REPORT_RESOLUTIONS, ...CORRECTION_RESOLUTIONS] as const;
export type ReportResolution = (typeof ALL_REPORT_RESOLUTIONS)[number];

/** A code: an issue, a choice, an origin, a filter reason, a module kind. Lowercase words joined by hyphens. */
export const REPORT_CODE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** A detector, observation or strategy id: `li.` or `fb.`, then up to five lowercase segments. */
export const REPORT_ID_PATTERN = /^(li|fb)[.][a-z0-9-]+([.][a-z0-9-]+){0,4}$/;
/** A count, landmark or error key, or a degraded signal: one camelCase word. */
export const REPORT_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
/** The word of a feed address unAlgorithm doesn't know yet (`foryou` in `/feed/foryou/`). Never a path. */
export const FEED_WORD_PATTERN = /^[a-z][a-z0-9-]{1,24}$/;
/** An adapter's detection version, `linkedin@2026.10.2`: the platform, then year, month and a patch number. */
export const ADAPTER_VERSION_PATTERN = /^(linkedin|facebook)@[0-9]{4}[.][0-9]{1,2}[.][0-9]{1,3}$/;
/**
 * Words that make an address not the feed on any platform: posts, hashtags, people lists, saved items and news. A
 * report never carries one as its feed word, so a candidate route can't name a section that holds people or posts.
 */
export const FEED_WORD_DENY: readonly string[] = Object.freeze(['update', 'hashtag', 'following', 'followers', 'saved', 'news']);

const Code = z.string().regex(REPORT_CODE_PATTERN);
const ReportId = z.string().max(64).regex(REPORT_ID_PATTERN);
const Key = z.string().regex(REPORT_KEY_PATTERN);
const Count = z.number().int().min(0).max(MAX_REPORT_COUNT);
const Iso = z.iso.datetime();

/** A record of counts with at most `max` keys, each held to `key`. Keys like `__proto__` never match a pattern. */
function counts(key: z.ZodString, max: number) {
  return z.record(key, Count).refine((r) => Object.keys(r).length <= max, { message: `At most ${max} keys.` });
}

/** A list of distinct codes. */
function codes<T extends z.ZodString>(item: T, max: number) {
  return z
    .array(item)
    .max(max)
    .refine((list) => new Set(list).size === list.length, { message: 'Duplicate code.' });
}

export const ReportCodeSchema = Code;
export const ReportIdSchema = ReportId;
export const ReportKeySchema = Key;
export const AdapterVersionSchema = z.string().regex(ADAPTER_VERSION_PATTERN);
export const FeedWordSchema = z
  .string()
  .regex(FEED_WORD_PATTERN)
  .refine((w) => !FEED_WORD_DENY.includes(w), { message: 'Not a feed word.' });
/** Extension versions as the manifest has them: two to four numbers. */
export const ExtensionVersionSchema = z.string().regex(/^[0-9]{1,5}([.][0-9]{1,5}){1,3}$/);

/**
 * A link without a scheme: a host with a letter TLD, then a path, query or fragment ("linkedin.com/in/jane",
 * "lnkd.in/abc123", "jane-doe.substack.com/p/x"). Not inside a longer host or an email address. Global, for `replace`;
 * test with `search`, which ignores `lastIndex`.
 */
export const BARE_LINK_PATTERN = /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}_-]{1,63}\.){1,8}\p{L}{2,24}[/?#]\S+/giu;
/**
 * A LinkedIn or Facebook profile or post address with no host ("/in/jane", "/posts/jane_x-123",
 * "profile.php?id=100001234567", "urn:li:activity:7123…"): it points at a person on its own. Global, as above.
 */
export const PROFILE_PATH_PATTERN =
  /(?<![\p{L}\p{N}_@.\-/])(?:\/(?:in|pub|company|school|posts|groups|people|pages|feed\/update)\/\S+|\/?(?:profile|permalink|story|photo)\.php\?\S+|urn:li:[a-z_]+:\S+)/giu;

/**
 * No control characters but the newline, and no link: no web address with a scheme, no host with a path
 * (`BARE_LINK_PATTERN`) and no profile or post address (`PROFILE_PATH_PATTERN`). A cleaned message
 * (`cleanReportMessage`) has none of them, so this catches a sender that skipped the cleaning.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;
const WEB_ADDRESS = /\bhttps?:\/\//i;
export const ReportMessageSchema = z
  .string()
  .max(MAX_CORRECTION_MESSAGE)
  .refine((m) => m.trim().length > 0, { message: 'Empty message.' })
  .refine((m) => !CONTROL.test(m), { message: 'Control character.' })
  .refine((m) => !WEB_ADDRESS.test(m) && m.search(BARE_LINK_PATTERN) < 0 && m.search(PROFILE_PATH_PATTERN) < 0, {
    message: 'Web address.',
  });

export const ReportEnvSchema = z.object({
  extension: ExtensionVersionSchema,
  channel: z.enum(REPORT_CHANNELS),
  browser: z.enum(REPORT_BROWSERS),
  browserMajor: z.number().int().min(0).max(9999),
  /** Firefox only: the add-on id, so the server can tell a listed build. Used for that and never stored. */
  client: GeckoIdSchema.optional(),
});
export type ReportEnv = z.infer<typeof ReportEnvSchema>;

export const ReportPageSchema = z.object({
  platform: z.enum(PLATFORMS),
  adapter: AdapterVersionSchema,
  route: z.enum(REPORT_ROUTES),
  /** Only on a `feed-candidate` route. */
  feedWord: FeedWordSchema.optional(),
  /** The page's language, primary subtag only (`en`), or `unknown`. */
  lang: z.string().regex(/^([a-z]{2,3}|unknown)$/),
  preset: z.enum(REPORT_PRESETS),
  ai: z.enum(REPORT_AI_KINDS),
  paused: z.boolean(),
});
export type ReportPage = z.infer<typeof ReportPageSchema>;

export const ReportHealthSchema = z.object({
  status: z.enum(REPORT_HEALTH_STATUSES),
  issues: codes(Code, 16),
  /** Signals detection stopped trusting on the page (`sponsored`, `relationship`): keys, as core names them. */
  degraded: codes(Key, 8),
});
export type ReportHealth = z.infer<typeof ReportHealthSchema>;

export const ReportDetectionSchema = z.object({
  counts: counts(Key, 16),
  /** Folded items by filter reason. */
  hiddenBy: counts(Code, 16).optional(),
  /** How often each detector matched on the page. */
  detectors: counts(ReportId, 64).optional(),
  /** Landmark counts from the adapter's probe. */
  landmarks: counts(Key, 16).optional(),
  observations: counts(ReportId, 32).optional(),
  /** Adapter exceptions caught, per operation: never their messages. */
  errors: counts(Key, 8).optional(),
  /** The item discovery strategy that won (phase B). */
  strategy: ReportId.optional(),
});
export type ReportDetection = z.infer<typeof ReportDetectionSchema>;

export const ReportEvidenceSchema = z.object({ detector: ReportId, strength: z.enum(EVIDENCE_STRENGTHS) });

/** The post a *Wrong call?* is about, as `summarizePostForReport` makes it: never its text, author, link or id. */
export const ReportPostSchema = z.object({
  reason: Code,
  source: z.enum(['rule', 'user', 'ai']),
  evidence: z.array(ReportEvidenceSchema).max(24),
  authorKind: z.enum(AUTHOR_KINDS),
  relationship: z.enum(REPORT_RELATIONSHIPS),
  media: z.enum(MEDIA_KINDS),
  text: z.enum(TEXT_BUCKETS),
  /** The feed panel's kind, when a panel was hidden. */
  module: Code.optional(),
});
export type ReportPost = z.infer<typeof ReportPostSchema>;

export const ReportCorrectionSchema = z.object({
  feature: z.enum(CORRECTION_FEATURES),
  promptVersion: z.number().int().min(0).max(100_000),
  /** UnEcho Chamber only: which source list the result used. */
  list: z.enum(LIST_KINDS).optional(),
  via: z.enum(CORRECTION_VIA),
  message: ReportMessageSchema,
  /** Only when the person wants a reply. */
  contact: z.email().max(254).optional(),
});
export type ReportCorrection = z.infer<typeof ReportCorrectionSchema>;

const ReportShape = z.object({
  v: z.literal(1),
  /** Random per report, for idempotency only: *Try again* resends it and gets the same reference. */
  id: z.uuid(),
  kind: z.enum(REPORT_KINDS),
  /** Where the report started (`REPORT_FROM`). */
  from: Code,
  choices: codes(Code, 6),
  /** Sent from a private window: nothing about the page, only the versions and the person's choices (Mozilla 6.3). */
  private: z.literal(true).optional(),
  env: ReportEnvSchema,
  page: ReportPageSchema.optional(),
  health: ReportHealthSchema.optional(),
  detection: ReportDetectionSchema.optional(),
  post: ReportPostSchema.optional(),
  correction: ReportCorrectionSchema.optional(),
});

/** Which parts each kind needs and allows. A private-window report carries none of the page parts. */
function kindRules(r: z.infer<typeof ReportShape>, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  const pagePart = ['page', 'health', 'detection', 'post'] as const;
  if (r.private) {
    for (const part of pagePart) if (r[part] !== undefined) issue(part, 'A private-window report holds nothing about the page.');
  }
  if (r.post !== undefined && r.kind !== 'wrong-call') issue('post', 'Only a wrong-call report has a post.');
  if (r.correction !== undefined && r.kind !== 'correction') issue('correction', 'Only a correction has a correction.');
  if (r.kind !== 'detection' && r.choices.length === 0) issue('choices', 'Choose at least one.');
  if (r.page && !r.page.adapter.startsWith(`${r.page.platform}@`)) issue('page', "The adapter is another platform's.");
  if (r.page?.feedWord !== undefined && r.page.route !== 'feed-candidate') issue('page', 'A feed word needs a candidate route.');
  if (r.correction?.list !== undefined && r.correction.feature !== 'perspectives')
    issue('correction', 'Only UnEcho Chamber uses a list.');
  switch (r.kind) {
    case 'wrong-call':
      if (!r.private) for (const part of pagePart) if (r[part] === undefined) issue(part, 'A wrong call needs this.');
      break;
    case 'detection':
      if (r.private) break;
      if (r.page === undefined) issue('page', 'A detection report needs the page.');
      else if (r.page.route !== 'unknown') {
        if (r.health === undefined) issue('health', 'A detection report needs the health check.');
        if (r.detection === undefined) issue('detection', 'A detection report needs the counts.');
      }
      break;
    case 'correction':
      if (r.correction === undefined) issue('correction', 'A correction needs the correction.');
      for (const part of pagePart) if (r[part] !== undefined) issue(part, 'A correction is about a result, never the page.');
      break;
    case 'other':
      break;
  }
}

export const ProblemReportSchema = ReportShape.superRefine(kindRules);
export type ProblemReport = z.infer<typeof ProblemReportSchema>;

/** A report reference, `7KQ3-M2PA`: 40 random bits in Crockford base32 (no I, L, O or U), picked by the server. */
export const REPORT_REF_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
export const ReportRefSchema = z.string().regex(REPORT_REF_PATTERN);
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The reference for 5 random bytes (40 bits). */
export function reportRef(bytes: Uint8Array): string {
  if (bytes.length !== 5) throw new TypeError('A reference takes 5 bytes.');
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * A reference as a person typed it (lowercase, spaces, no hyphen, O for 0, I or L for 1), or null when it can't be
 * one. Admin lookups and privacy requests match the result exactly.
 */
export function parseReportRef(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** The server's answer to a stored report (201) or a repeated id (200). Not strict: a newer server may add fields. */
export const ReportAcceptedSchema = z.object({ ok: z.literal(true), ref: ReportRefSchema });
export type ReportAccepted = z.infer<typeof ReportAcceptedSchema>;

/**
 * The report route's error bodies: fixed strings, so no zod issue or request value is ever echoed. 403 `origin` is a
 * missing or web Origin; 403 `unlisted` a correction from an extension id the server doesn't list (a fork's users'
 * words never reach HeitechSoft under the wrong privacy policy); 400 a body that isn't a valid report.
 */
export const REPORT_ERRORS = {
  origin: { code: 'origin-blocked', message: 'Problem reports come from the unAlgorithm extension only.' },
  unlisted: { code: 'permission', message: 'This copy of unAlgorithm cannot send corrections. Email them instead.' },
  invalid: { code: 'bad-request', message: 'This is not a problem report this server understands.' },
  tooLarge: { code: 'bad-request', message: 'This report is too large.' },
  rateLimit: { code: 'rate-limit', message: 'Too many reports. Try again later.' },
  unavailable: { code: 'not-available', message: 'Reports are not being accepted right now. Try again later.' },
} as const satisfies Record<string, WireError>;

/** What went wrong with a send, as the report page says it. The extension adds its own `consent` and `limit`. */
export type ReportSendFailure = 'network' | 'rate-limit' | 'unavailable' | 'refused' | 'unlisted';

/**
 * The failure an answer means: 429; any 5xx (the intake's own 503, a database failure's 500, or the proxy's 502 or 504
 * during a deploy), which passes, so *Try again* is worth offering; 403 `unlisted`; or anything else refused. Never
 * throws.
 */
export function reportFailure(status: number, body: unknown): ReportSendFailure {
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'unavailable';
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  if (status === 403 && code === REPORT_ERRORS.unlisted.code) return 'unlisted';
  return 'refused';
}

/** The platform an adapter version belongs to, or null when it isn't one. */
export function adapterPlatform(adapter: string): PlatformId | null {
  const m = ADAPTER_VERSION_PATTERN.exec(adapter);
  return m ? (m[1] as PlatformId) : null;
}

/**
 * An adapter version as a sortable number: `linkedin@2026.10.2` is 2026010002. Null when it isn't a version. The server
 * stores it, so "Fixed in" floors and alerts compare versions with `>=`.
 */
export function adapterOrder(adapter: string): number | null {
  if (!ADAPTER_VERSION_PATTERN.test(adapter)) return null;
  const [year, month, patch] = (adapter.split('@')[1] ?? '').split('.').map(Number) as [number, number, number];
  return year * 1_000_000 + month * 1_000 + patch;
}

/**
 * The highest adapter order of `now`'s month (UTC). An adapter version is dated in the month it is built, so the report
 * alerts count none dated after this (a forged or broken version can't page anyone), and an adapter must never be
 * dated ahead: its reports would not alert until that month began.
 */
export function latestAdapterOrder(now: Date | number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 1_000_000 + (d.getUTCMonth() + 1) * 1_000 + 999;
}

/** The calendar quarter a time falls in, in UTC: `2026-Q4`. Corrections are counted by it after 90 days. */
export function quarterOf(date: Date | number): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

// ---------- admin (ADR 0009 §7): behind a web session and the admin role, like every other admin route ----------

export const ADMIN_REPORTS_PATH = '/v1/admin/reports';
export const ADMIN_REPORTS_SUMMARY_PATH = '/v1/admin/reports/summary';
/** OpenAPI-style template for @hono/zod-openapi's createRoute (`{id}`): one report. */
export const ADMIN_REPORT_ROUTE = '/v1/admin/reports/{id}';
export const ADMIN_REPORTS_HANDLE_PATH = '/v1/admin/reports/handle';
export const ADMIN_REPORTS_FLOOR_PATH = '/v1/admin/reports/floor';
export const ADMIN_REPORTS_FORGET_CONTACT_PATH = '/v1/admin/reports/forget-contact';
export const ADMIN_REPORTS_DELETE_PATH = '/v1/admin/reports/delete';
/** Rows per page of the admin list. */
export const ADMIN_REPORTS_PAGE_SIZE = 50;
/** Days of daily counts in each group's sparkline. */
export const REPORT_GROUP_DAYS = 14;

/** `/v1/admin/reports/{id}`; a `TypeError` (which never repeats the value) when `id` is not a report id. */
export function adminReportPath(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new TypeError('Not a report id.');
  return `${ADMIN_REPORTS_PATH}/${id}`;
}

/** A group of reports: platform, detection version, kind and topic, joined by `|` (the first two are empty when absent). */
export const REPORT_GROUP_KEY_PATTERN =
  /^(linkedin|facebook)?\|((linkedin|facebook)@[0-9]{4}[.][0-9]{1,2}[.][0-9]{1,3})?\|(detection|wrong-call|correction|other)\|([a-z][a-z0-9-]{0,39})?$/;
export const ReportGroupKeySchema = z.string().max(120).regex(REPORT_GROUP_KEY_PATTERN);

export interface ReportGroupParts {
  platform: PlatformId | null;
  adapter: string | null;
  kind: ReportKind;
  topic: string | null;
}

export function reportGroupKey(g: ReportGroupParts): string {
  return [g.platform ?? '', g.adapter ?? '', g.kind, g.topic ?? ''].join('|');
}

/** The parts of a group key, or null when it isn't one. */
export function parseReportGroupKey(key: string): ReportGroupParts | null {
  if (!ReportGroupKeySchema.safeParse(key).success) return null;
  const [platform, adapter, kind, topic] = key.split('|') as [string, string, ReportKind, string];
  return { platform: (platform || null) as PlatformId | null, adapter: adapter || null, kind, topic: topic || null };
}

const Platform = z.enum(PLATFORMS);

export const ReportGroupSchema = z.object({
  key: ReportGroupKeySchema,
  platform: Platform.nullable(),
  adapter: AdapterVersionSchema.nullable(),
  kind: z.enum(REPORT_KINDS),
  topic: Code.nullable(),
  total: Count,
  open: Count,
  /** Distinct networks: reports that were the first that day from their network. */
  networks: Count,
  lastAt: Iso,
  /** Daily counts, oldest first, ending today. */
  perDay: z.array(Count).length(REPORT_GROUP_DAYS),
});
export type ReportGroup = z.infer<typeof ReportGroupSchema>;

export const ReportFloorSchema = z.object({ platform: Platform, adapter: AdapterVersionSchema, setAt: Iso });
export type ReportFloor = z.infer<typeof ReportFloorSchema>;

export const ReportDaySchema = z.object({ day: z.iso.date(), linkedin: Count, facebook: Count, other: Count });
export type ReportDay = z.infer<typeof ReportDaySchema>;

export const AdminReportsSummarySchema = z.object({
  /** False when the server runs with REPORTS=off. */
  enabled: z.boolean(),
  /** Reports accepted today (UTC), against `dailyMax`. */
  today: Count,
  dailyMax: Count,
  /** Reports from extension ids the server doesn't list, in the last 7 days (a missing Edge id shows up here). */
  unlisted7d: Count,
  /** Oldest first, ending today. */
  days: z.array(ReportDaySchema).max(366),
  /** Open groups first. */
  groups: z.array(ReportGroupSchema).max(1000),
  floors: z.array(ReportFloorSchema).max(PLATFORMS.length),
});
export type AdminReportsSummary = z.infer<typeof AdminReportsSummarySchema>;

export const AdminReportsListQuerySchema = z.object({
  group: ReportGroupKeySchema.optional(),
  status: z.enum(['open', 'handled', 'all']).default('open'),
  /** Rows received before this time: the next page. */
  before: Iso.optional(),
  /** An exact reference, for privacy requests. */
  ref: ReportRefSchema.optional(),
});
export type AdminReportsListQuery = z.infer<typeof AdminReportsListQuerySchema>;

export const AdminReportRowSchema = z.object({
  id: z.uuid(),
  ref: ReportRefSchema,
  /** Rounded down to the hour when stored. */
  receivedAt: Iso,
  kind: z.enum(REPORT_KINDS),
  from: Code.nullable(),
  channel: z.enum(REPORT_CHANNELS),
  listed: z.boolean(),
  extension: ExtensionVersionSchema,
  browser: z.enum(REPORT_BROWSERS),
  browserMajor: z.number().int().min(0).max(9999),
  platform: Platform.nullable(),
  adapter: AdapterVersionSchema.nullable(),
  topic: Code.nullable(),
  choices: z.array(Code).max(6),
  firstFromNetwork: z.boolean(),
  handledAt: Iso.nullable(),
  resolution: z.enum(ALL_REPORT_RESOLUTIONS).nullable(),
  hasMessage: z.boolean(),
  hasContact: z.boolean(),
});
export type AdminReportRow = z.infer<typeof AdminReportRowSchema>;

export const AdminReportListSchema = z.object({
  rows: z.array(AdminReportRowSchema).max(ADMIN_REPORTS_PAGE_SIZE),
  /** `before` for the next page, or null on the last one. */
  nextBefore: Iso.nullable(),
});
export type AdminReportList = z.infer<typeof AdminReportListSchema>;

/** What the server keeps of a report besides its columns: registry codes only, no message or contact. */
export const ReportDetailsSchema = z.object({
  private: z.literal(true).optional(),
  page: ReportPageSchema.optional(),
  health: ReportHealthSchema.optional(),
  detection: ReportDetectionSchema.optional(),
  post: ReportPostSchema.optional(),
  correction: ReportCorrectionSchema.omit({ message: true, contact: true }).optional(),
});
export type ReportDetails = z.infer<typeof ReportDetailsSchema>;

export const AdminReportDetailSchema = AdminReportRowSchema.extend({
  details: ReportDetailsSchema,
  /** Codes the server dropped because the registry doesn't list them. */
  unknownCodes: Count,
  message: z.string().max(MAX_CORRECTION_MESSAGE).nullable(),
  contact: z.email().max(254).nullable(),
  /** `describeReport`'s plain lines. */
  lines: z.array(z.string().max(2000)).max(40),
  handledBy: z.object({ id: z.string().min(1).max(64), email: z.string().max(254) }).nullable(),
});
export type AdminReportDetail = z.infer<typeof AdminReportDetailSchema>;

/**
 * Mark reports handled (with a resolution) or reopen them: by id, or a whole group (the rows received before the
 * request).
 */
export const HandleReportsRequestSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(500).optional(),
    group: ReportGroupKeySchema.optional(),
    handled: z.boolean(),
    resolution: z.enum(ALL_REPORT_RESOLUTIONS).optional(),
  })
  .refine((r) => (r.ids === undefined) !== (r.group === undefined), { message: 'Ids or a group.', path: ['ids'] })
  .refine((r) => (r.resolution !== undefined) === r.handled, { message: 'A resolution when handled.', path: ['resolution'] });
export type HandleReportsRequest = z.infer<typeof HandleReportsRequestSchema>;

/** "Fixed in": reports from older detection versions count as handled. `adapter: null` clears the floor. */
export const SetFloorRequestSchema = z
  .object({ platform: Platform, adapter: AdapterVersionSchema.nullable() })
  .refine((r) => r.adapter === null || adapterPlatform(r.adapter) === r.platform, {
    message: "The adapter is another platform's.",
    path: ['adapter'],
  });
export type SetFloorRequest = z.infer<typeof SetFloorRequestSchema>;

export const ForgetContactRequestSchema = z.object({ id: z.uuid() });
export type ForgetContactRequest = z.infer<typeof ForgetContactRequestSchema>;

/** A hard delete, for privacy requests or a message holding personal data. */
export const DeleteReportsRequestSchema = z.object({ ids: z.array(z.uuid()).min(1).max(100) });
export type DeleteReportsRequest = z.infer<typeof DeleteReportsRequestSchema>;
