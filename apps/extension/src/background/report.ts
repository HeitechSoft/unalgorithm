import {
  cleanReportMessage,
  type Device,
  isPaused,
  noticeFor,
  noticeSnoozeKey,
  presetOf,
  REPORT_SNOOZE_MS,
  type Settings,
  snooze,
} from '@unalgorithm/core';
import { adapterFor } from '@unalgorithm/platforms';
import {
  ADAPTER_VERSION_PATTERN,
  DEV_CHROMIUM_ID,
  FIREFOX_DEV_ADDON_ID,
  GeckoIdSchema,
  MAX_REPORT_BODY_BYTES,
  NOTICE_KINDS,
  type NoticeKind,
  PLATFORMS,
  type PlatformId,
  type ProblemReport,
  ProblemReportSchema,
  REPORT_LOCAL_PER_DAY,
  REPORT_LOCAL_PER_HOUR,
  REPORT_SEND_TIMEOUT_MS,
  REPORTS_URL,
  ReportAcceptedSchema,
  type ReportChannel,
  type ReportEnv,
  type ReportPage,
  reportFailure,
  uuid,
} from '@unalgorithm/protocol';
import { type Browser, browser } from 'wxt/browser';
import { browserMajor, reportBrowser } from '../lib/browser-kind.ts';
import { hasConsent, reportConsent } from '../lib/data-consent.ts';
import { FEED_HOSTS } from '../lib/feed-hosts.ts';
import {
  type ReportAbout,
  type ReportDraftInput,
  type ReportPageData,
  type ReportSendResult,
  sendToTab,
} from '../lib/messages.ts';
import { aiKindOf, choicesFor, validChoices } from '../lib/report-links.ts';
import { updateDevice } from '../lib/settings-store.ts';
import {
  REPORT_KEY_PREFIX,
  type ReportDraft,
  readDevice,
  readSettings,
  reportItem,
  reportLogItem,
  type StoredReport,
} from '../lib/storage.ts';
import { keepAwake } from './keep-awake.ts';
import { createLock } from './util.ts';

declare global {
  interface ImportMetaEnv {
    /** `reportsUrlFor()` in wxt.config.ts: the test server in e2e builds, null in every other build. */
    readonly UA_REPORTS_URL: string | null;
  }
}

/**
 * Problem reports in the background (ADR 0009 §2): it keeps each draft for its report page, and sends a report only for
 * that page's *Send report* click, once, to unAlgorithm Cloud. There is no queue, beacon or automatic retry, and this is
 * the only module that knows where reports go.
 */

/** A draft waits this long for its page. */
export const REPORT_DRAFT_TTL_MS = 60 * 60 * 1000;
/** Drafts kept at once; opening another forgets the oldest. */
export const MAX_REPORT_DRAFTS = 5;
/** A feed tab opens at most one report page this often: its page's own scripts can't open a stream of tabs. */
export const REPORT_TAB_INTERVAL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type Sender = Browser.runtime.MessageSender;

/** Where reports go: unAlgorithm Cloud, from every build but the e2e one (the test server). */
function reportsUrl(): string {
  return import.meta.env.UA_REPORTS_URL ?? REPORTS_URL;
}

/**
 * Where this copy came from: development and e2e builds; a store build carrying the development identity, which only the
 * GitHub release's sideload builds have; otherwise the store its build is for. A Chrome Web Store copy in Edge says
 * `chrome-store` (and `browser: 'edge'`).
 */
export function reportChannel(
  mode: string = import.meta.env.MODE,
  target: string = import.meta.env.BROWSER,
  id: string = browser.runtime.id,
): ReportChannel {
  if (mode !== 'production') return 'development';
  if (id === DEV_CHROMIUM_ID || id === FIREFOX_DEV_ADDON_ID) return 'sideload';
  if (target === 'chrome' || target === 'edge' || target === 'firefox') return `${target}-store`;
  return 'other';
}

/** What every report says about this copy of unAlgorithm: versions and the browser, never an id for the person. */
export function reportEnv(): ReportEnv {
  const browserName = reportBrowser();
  // Firefox's add-on id says whether the server lists this build; the server reads it and never stores it.
  const client =
    browserName === 'firefox' && GeckoIdSchema.safeParse(browser.runtime.id).success ? browser.runtime.id : undefined;
  return {
    extension: browser.runtime.getManifest().version,
    channel: reportChannel(),
    browser: browserName,
    browserMajor: browserMajor(globalThis.navigator?.userAgent ?? ''),
    ...(client ? { client } : {}),
  };
}

/**
 * The page part of a report that starts without the page's own facts (the popup's tab didn't answer, or Settings):
 * the platform and its detection version, the person's settings, and `route: 'unknown'`.
 */
export function pageWithoutFacts(platform: PlatformId, settings: Settings, device: Device): ReportPage {
  const ps = settings.platforms[platform];
  return {
    platform,
    adapter: adapterFor(platform)?.version ?? `${platform}@0000.0.0`,
    route: 'unknown',
    lang: 'unknown',
    preset: presetOf(platform, ps),
    ai: aiKindOf(device.aiSource),
    paused: isPaused(device, platform) || !ps.enabled,
  };
}

/**
 * Checks a draft against the wire schema, as it will be sent once the person has answered: a stand-in answer (and, for
 * a correction, stand-in words) fill the parts only the page adds. Returns the draft as the schema read it (unknown
 * keys gone), or null when no answer could make it a valid report.
 */
export function checkDraft(draft: ReportDraft): ReportDraft | null {
  if (draft.kind === 'correction' && !draft.correction) return null;
  const choices = draft.kind === 'detection' ? [] : choicesFor(draft).slice(0, 1);
  const probe = {
    ...draft,
    choices,
    ...(draft.correction ? { correction: { ...draft.correction, message: 'x' } } : {}),
  };
  const parsed = ProblemReportSchema.safeParse(probe);
  if (!parsed.success) return null;
  const { choices: _choices, correction, ...rest } = parsed.data;
  if (!correction) return rest;
  const { message: _message, contact: _contact, ...facts } = correction;
  return { ...rest, correction: facts };
}

/** A draft from a private window: nothing about the page (Mozilla 6.3); only the versions and the person's answers. */
function privately(draft: ReportDraft): ReportDraft {
  const { page: _page, health: _health, detection: _detection, post: _post, ...rest } = draft;
  return { ...rest, private: true };
}

const lock = createLock();

/** Every stored draft, by id. */
async function storedReports(): Promise<Map<string, StoredReport>> {
  const all = (await browser.storage.session.get(null)) as Record<string, unknown>;
  const found = new Map<string, StoredReport>();
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(REPORT_KEY_PREFIX) && value && typeof value === 'object') {
      found.set(key.slice(REPORT_KEY_PREFIX.length), value as StoredReport);
    }
  }
  return found;
}

/** Past its hour, or dated in the future (a clock moved back): either way, gone. */
const expired = (r: StoredReport, now: number) => now - r.createdAt > REPORT_DRAFT_TTL_MS || r.createdAt > now + HOUR_MS;

/** Forgets expired drafts, and the oldest beyond `keep`. */
async function prune(keep: number, now = Date.now()): Promise<Map<string, StoredReport>> {
  const live = [...(await storedReports())].sort((a, b) => b[1].createdAt - a[1].createdAt);
  const kept = live.filter(([, r]) => !expired(r, now)).slice(0, keep);
  for (const [id] of live) if (!kept.some(([k]) => k === id)) await reportItem(id).removeValue();
  return new Map(kept);
}

/** The report page's address for the draft `id`. */
const reportPageUrl = (id: string) => browser.runtime.getURL(`/report.html#${id}`);

/** Opens report.html for `id` next to `near` (in its window, as its opener), or in the current window. */
async function openReportTab(id: string, near: Browser.tabs.Tab | undefined): Promise<number | undefined> {
  const url = reportPageUrl(id);
  const beside =
    near?.id !== undefined ? { index: near.index + 1, openerTabId: near.id, windowId: near.windowId } : ({} as const);
  try {
    return (await browser.tabs.create({ url, active: true, ...beside })).id;
  } catch {
    // A private window may not take an extension page (Chrome's default for extensions): any window will do.
    return (await browser.tabs.create({ url, active: true })).id;
  }
}

async function tabById(id: number | null | undefined): Promise<Browser.tabs.Tab | undefined> {
  if (id === null || id === undefined) return undefined;
  return browser.tabs.get(id).catch(() => undefined);
}

/** The drafts a report page about no page facts starts from, built here from the settings. */
async function draftsAbout(about: ReportAbout, tab: Browser.tabs.Tab | undefined): Promise<ReportDraft[]> {
  const [settings, device] = await Promise.all([readSettings(), readDevice()]);
  const env = reportEnv();
  const base = { v: 1 as const, id: uuid(), env };
  if (about.from === 'settings') {
    // The page asks what it's about first: LinkedIn, Facebook, or something else.
    return [
      ...PLATFORMS.map((platform) => ({
        ...base,
        kind: 'detection' as const,
        from: 'settings',
        page: pageWithoutFacts(platform, settings, device),
      })),
      { ...base, kind: 'other' as const, from: 'settings' },
    ];
  }
  if (!about.platform) return [{ ...base, kind: 'other', from: about.from }];
  const draft: ReportDraft = {
    ...base,
    kind: 'detection',
    from: about.from,
    page: pageWithoutFacts(about.platform, settings, device),
    // The popup asked the tab and nothing answered: the content script isn't running there.
    ...(about.from === 'popup-no-script'
      ? { health: { status: 'not-started' as const, issues: ['no-content-script'], degraded: [] } }
      : {}),
  };
  return [tab?.incognito ? privately(draft) : draft];
}

/** True when `sender` is a content script in a LinkedIn or Facebook tab: only those may report about a page. */
function fromFeedTab(sender: Sender): boolean {
  try {
    return !!sender.tab && FEED_HOSTS.includes(new URL(sender.url ?? sender.tab.url ?? '').hostname);
  } catch {
    return false;
  }
}

/** Whether two sets of drafts are the same report, whatever their random ids. */
function sameDrafts(a: readonly ReportDraft[], b: readonly ReportDraft[]): boolean {
  const facts = (drafts: readonly ReportDraft[]) => drafts.map(({ id: _id, ...rest }) => rest);
  return sameJson(facts(a), facts(b));
}

/**
 * Keeps a draft and opens its report page (ADR 0009 §2). A content script's draft is checked against the schema with
 * `env` added; a page about no page facts gets its drafts built here. False when the draft can't be a report.
 *
 * A feed tab opens at most one report tab a minute, since the page's own scripts can click our buttons. While the one
 * it opened is still unsent, the same report again (a double click) brings that tab back, and another report (*Wrong
 * call?* on another post) takes its place there, so the person sees what they chose. One already sent is done with:
 * the next report gets a new tab.
 */
export async function openReport(
  msg: { draft: ReportDraftInput; notice?: NoticeKind; nextTo?: number } | { about: ReportAbout },
  sender: Sender,
): Promise<{ ok: boolean }> {
  return lock(async () => {
    const now = Date.now();
    const feed = fromFeedTab(sender);
    let drafts: ReportDraft[];
    let near: Browser.tabs.Tab | undefined = sender.tab;
    let notice: NoticeKind | undefined;
    let site: PlatformId | undefined;
    if ('about' in msg) {
      const tab = msg.about.from === 'settings' ? undefined : await tabById(msg.about.tabId);
      near = sender.tab ?? tab;
      drafts = await draftsAbout(msg.about, tab);
      // The popup was looking at that feed tab: the page offers to go back to it.
      if (msg.about.from !== 'settings' && msg.about.platform && tab) site = msg.about.platform;
    } else {
      // Page facts only from the tab they describe: an extension page may send a correction, never a page.
      const input = msg.draft;
      if (!feed && (input.page || input.health || input.detection || input.post || input.kind !== 'correction'))
        return { ok: false };
      if (feed && input.kind === 'correction') return { ok: false };
      const checked = checkDraft({ ...input, v: 1, id: uuid(), env: reportEnv() } as ReportDraft);
      if (!checked) return { ok: false };
      drafts = [sender.tab?.incognito ? privately(checked) : checked];
      if (!sender.tab) near = await tabById(msg.nextTo);
      notice = msg.notice && (NOTICE_KINDS as readonly string[]).includes(msg.notice) ? msg.notice : undefined;
      if (feed) site = drafts[0]?.page?.platform ?? platformOfHost(sender);
    }

    const live = await prune(MAX_REPORT_DRAFTS - 1, now);
    /** This feed tab's unsent report tab of the last minute, which the new report takes over. */
    let replace: { id: string; tabId: number } | undefined;
    if (feed && sender.tab?.id !== undefined) {
      for (const [oldId, r] of live) {
        if (r.openerTabId !== sender.tab.id || r.state === 'sent' || r.tabId === undefined) continue;
        if (now - r.createdAt > REPORT_TAB_INTERVAL_MS) continue;
        const open = await tabById(r.tabId);
        if (open?.id === undefined) continue;
        if (sending.has(oldId) || sameDrafts(r.drafts, drafts)) {
          await browser.tabs.update(open.id, { active: true }).catch(() => undefined);
          return { ok: true };
        }
        replace = { id: oldId, tabId: open.id };
        break;
      }
    }

    const id = drafts[0]?.id ?? uuid();
    const record: StoredReport = {
      drafts,
      createdAt: now,
      state: 'open',
      ...(near?.id !== undefined ? { openerTabId: near.id } : {}),
      ...(site ? { site } : {}),
      ...(notice ? { notice } : {}),
    };
    if (replace) {
      await reportItem(replace.id).removeValue();
      await reportItem(id).setValue({ ...record, tabId: replace.tabId });
      // The page loads the new draft when its address changes (report/main.tsx).
      await browser.tabs.update(replace.tabId, { url: reportPageUrl(id), active: true }).catch(() => undefined);
      return { ok: true };
    }
    await reportItem(id).setValue(record);
    const tabId = await openReportTab(id, near);
    if (tabId !== undefined) await reportItem(id).setValue({ ...record, tabId });
    return { ok: true };
  });
}

/** The feed a content script runs on, by its tab's host. */
function platformOfHost(sender: Sender): PlatformId | undefined {
  try {
    const host = new URL(sender.url ?? sender.tab?.url ?? '').hostname;
    return host.endsWith('linkedin.com') ? 'linkedin' : host.endsWith('facebook.com') ? 'facebook' : undefined;
  } catch {
    return undefined;
  }
}

/** True when `sender` is the extension's report page. */
export function fromReportPage(sender: Sender): boolean {
  return (sender.url ?? '').startsWith(browser.runtime.getURL('/report.html'));
}

/** The report page's draft, or null once it expired, its tab closed or everything was erased. */
export async function reportDraft(id: string): Promise<ReportPageData | null> {
  const record = await reportItem(id).getValue();
  if (!record || expired(record, Date.now())) return null;
  return {
    drafts: record.drafts,
    state: record.state,
    ...(record.ref ? { ref: record.ref } : {}),
    ...(record.openerTabId !== undefined && record.site ? { opener: { tabId: record.openerTabId, site: record.site } } : {}),
  };
}

/** Deep equality of JSON values, whatever the key order. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The report without what the page may add: the person's answers, and a correction's words and reply email. */
function withoutAnswers(report: ProblemReport): ReportDraft {
  const { choices: _choices, correction, ...rest } = report;
  if (!correction) return rest;
  const { message: _message, contact: _contact, ...facts } = correction;
  return { ...rest, correction: facts };
}

/**
 * The body as the background will send it, or why not: valid JSON that the schema reads without dropping anything,
 * equal to one of the stored drafts plus what the page may add, with answers its kind takes and, for a correction,
 * words already cleaned.
 */
export function readBody(body: string, drafts: readonly ReportDraft[]): ProblemReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = ProblemReportSchema.safeParse(raw);
  if (!parsed.success || !sameJson(raw, parsed.data)) return null;
  const report = parsed.data;
  if (!drafts.some((d) => sameJson(withoutAnswers(report), d))) return null;
  if (!validChoices(report, report.choices)) return null;
  if (report.correction && cleanReportMessage(report.correction.message) !== report.correction.message) return null;
  return report;
}

/** Sends this browser made in the last day, oldest first (timestamps only). */
async function recentSends(now: number): Promise<number[]> {
  const log = await reportLogItem.getValue();
  return (Array.isArray(log) ? log : []).filter((t) => typeof t === 'number' && t <= now && now - t < DAY_MS);
}

/** The local limits (ADR 0009 §2): 3 sends an hour and 10 a day from this browser. */
export function overLocalLimit(sends: readonly number[], now: number): boolean {
  const lastHour = sends.filter((t) => now - t < HOUR_MS).length;
  return lastHour >= REPORT_LOCAL_PER_HOUR || sends.length >= REPORT_LOCAL_PER_DAY;
}

/** Seconds to wait from a `Retry-After` header: a number of seconds, or a date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** One POST, no cookies, no referrer, no redirects, no cache, 15 s at most. Never retried here. */
async function post(body: string): Promise<ReportSendResult> {
  let res: Response;
  try {
    res = await keepAwake(
      fetch(reportsUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REPORT_SEND_TIMEOUT_MS),
      }),
    );
  } catch {
    return { ok: false, code: 'network' };
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // An answer without JSON: the status says enough.
  }
  if (res.status === 200 || res.status === 201) {
    const accepted = ReportAcceptedSchema.safeParse(payload);
    return accepted.success ? { ok: true, ref: accepted.data.ref } : { ok: false, code: 'refused' };
  }
  const code = reportFailure(res.status, payload);
  const retryAfterSec =
    code === 'rate-limit' || code === 'unavailable' ? retryAfterSeconds(res.headers.get('retry-after')) : undefined;
  return { ok: false, code, ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) };
}

/** A sent detection report puts its card away for 7 days on that platform, in every tab, and tells its tab. */
async function afterSend(record: StoredReport, report: ProblemReport): Promise<void> {
  if (report.kind !== 'detection' || !report.page) return;
  const { platform, adapter } = report.page;
  const kind = record.notice ?? (report.health ? noticeFor(report.health.issues, report.health.status) : undefined);
  if (kind) {
    await updateDevice((d) => {
      d.notices = snooze(d.notices, noticeSnoozeKey(platform, kind), REPORT_SNOOZE_MS, adapter);
    }).catch((err: unknown) => console.debug('[unAlgorithm] notice snooze failed', err));
  }
  if (record.openerTabId !== undefined && record.site) {
    void sendToTab(record.openerTabId, { type: 'reportSent', ...(kind ? { kind } : {}) });
  }
}

async function send(id: string, body: string): Promise<ReportSendResult> {
  const item = reportItem(id);
  const record = await item.getValue();
  const now = Date.now();
  if (!record || expired(record, now)) return { ok: false, code: 'expired' };
  // Each draft sends once: a second click, or Try again after it went through, gets the same reference.
  if (record.state === 'sent' && record.ref) return { ok: true, ref: record.ref };
  const report = readBody(body, record.drafts);
  if (!report) return { ok: false, code: 'refused' };
  const sends = await recentSends(now);
  if (overLocalLimit(sends, now)) return { ok: false, code: 'limit' };
  if (!(await hasConsent(reportConsent(report)))) return { ok: false, code: 'consent' };
  if (new TextEncoder().encode(body).length > MAX_REPORT_BODY_BYTES) return { ok: false, code: 'refused' };

  const result = await post(body);
  if (!result.ok) return result;
  await item.setValue({ ...record, state: 'sent', ref: result.ref });
  await reportLogItem.setValue([...sends, now]);
  await afterSend(record, report);
  return result;
}

/** Sends in progress by report id: a double click waits for the first send's answer instead of sending twice. */
const sending = new Map<string, Promise<ReportSendResult>>();

/** The report page's *Send report* (ADR 0009 §2): checked, then sent once. */
export function sendReport(id: string, body: string): Promise<ReportSendResult> {
  const running = sending.get(id);
  if (running) return running;
  const started = send(id, body).finally(() => sending.delete(id));
  sending.set(id, started);
  return started;
}

/** A closed report page forgets its draft. */
export async function forgetReportTab(tabId: number): Promise<void> {
  for (const [id, r] of await storedReports()) if (r.tabId === tabId) await reportItem(id).removeValue();
}

/**
 * Keeps an in-feed card away on `platform` for `ms` (at most 7 days), under the adapter version that raised it, for
 * every tab of this browser (`device.notices`). Ignored for anything that isn't a card, a platform and a version.
 */
export async function snoozeNotice(msg: { platform: string; kind: string; ms: number; adapter: string }): Promise<void> {
  const platform = PLATFORMS.find((p) => p === msg.platform);
  const kind = NOTICE_KINDS.find((k) => k === msg.kind);
  if (!platform || !kind || !ADAPTER_VERSION_PATTERN.test(msg.adapter) || !Number.isFinite(msg.ms)) return;
  const ms = Math.min(Math.max(0, msg.ms), REPORT_SNOOZE_MS);
  await updateDevice((d) => {
    d.notices = snooze(d.notices, noticeSnoozeKey(platform, kind), ms, msg.adapter);
  });
}
