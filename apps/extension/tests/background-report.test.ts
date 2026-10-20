/**
 * The background's half of problem reports (ADR 0009 §2): who may open a report page, read a draft or send one; the
 * draft as it is kept (versions added, checked, a private window's emptied); and the one request a *Send report* click
 * makes: only the body the page showed, equal to the draft plus the person's answers, within this browser's limits and,
 * in Firefox, its consent; to the one address; without cookies, a referrer or a token; never retried by itself. Storage
 * and tabs are the WXT fake browser; `fetch` is stubbed per test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDevice, HEALTHY, REPORT_SNOOZE_MS } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import {
  CLOUD_ORIGIN,
  FIREFOX_ADDON_ID,
  MAX_REPORT_BODY_BYTES,
  type ProblemReport,
  REPORT_ERRORS,
  REPORT_LOCAL_PER_DAY,
  REPORT_LOCAL_PER_HOUR,
  REPORT_SEND_TIMEOUT_MS,
  REPORTS_URL,
} from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  checkDraft,
  forgetReportTab,
  overLocalLimit,
  REPORT_DRAFT_TTL_MS,
  readBody,
  reportChannel,
  reportEnv,
  retryAfterSeconds,
  sameJson,
} from '../src/background/report.ts';
import { serverAccountItem } from '../src/background/server-auth.ts';
import { mergeTabState } from '../src/background/tabs.ts';
import { handlers } from '../src/entrypoints/background.ts';
import { type Answers, composeReport, reportBody } from '../src/entrypoints/report/App.tsx';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import type { BgRequest, BgResponses, ReportDraftInput } from '../src/lib/messages.ts';
import {
  deviceItem,
  type ReportDraft,
  readDevice,
  reportItem,
  reportLogItem,
  type StoredReport,
  tabStateItem,
} from '../src/lib/storage.ts';

const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
  reportBrowser: () => env.kind,
}));

type Sender = Browser.runtime.MessageSender;
const EXT = 'chrome-extension://test-extension-id';
const FEED_URL = 'https://www.linkedin.com/feed/';
const REF = '7KQ3-M2PA';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.55 Safari/537.36';

const PAGE = {
  platform: 'linkedin' as const,
  adapter: linkedinAdapter.version,
  route: 'feed' as const,
  lang: 'en',
  preset: 'balanced' as const,
  ai: 'off' as const,
  paused: false,
};
const DETECTION: ReportDraftInput = {
  kind: 'detection',
  from: 'popup',
  page: PAGE,
  health: { status: 'broken', issues: ['over-filtering'], degraded: [] },
  detection: { counts: { items: 12, posts: 10, hidden: 9 }, hiddenBy: { sponsored: 3 } },
};
const CORRECTION: ReportDraftInput = {
  kind: 'correction',
  from: 'sidepanel',
  correction: { feature: 'factcheck', promptVersion: 3, via: 'own-key' },
};

/** Calls a background handler as the message dispatcher does. */
function call<T extends BgRequest['type']>(msg: Extract<BgRequest, { type: T }>, sender: Sender): Promise<BgResponses[T]> {
  const handler = handlers[msg.type] as unknown as (m: BgRequest, s: Sender) => Promise<BgResponses[T]>;
  return handler(msg, sender);
}

let feedTab: Browser.tabs.Tab;
let fetchSpy: ReturnType<typeof vi.fn>;
let granted: string[] | undefined;
let toTab: MockInstance;

const feedSender = (over: Partial<Browser.tabs.Tab> = {}): Sender => ({ tab: { ...feedTab, ...over }, url: FEED_URL });
const pageSender = (path: string): Sender => ({ url: `${EXT}/${path}` });
const reportSender = (id: string): Sender => ({ url: `${EXT}/report.html#${id}`, tab: { id: 99 } as Browser.tabs.Tab });

/** The stored drafts, by id. */
async function stored(): Promise<Record<string, StoredReport>> {
  const all = (await fakeBrowser.storage.session.get(null)) as Record<string, StoredReport>;
  return Object.fromEntries(
    Object.entries(all)
      .filter(([k]) => k.startsWith('report:'))
      .map(([k, v]) => [k.slice(7), v]),
  );
}

/** Opens a report page from `sender` and returns the stored draft's id. */
async function open(msg: Omit<Extract<BgRequest, { type: 'openReport' }>, 'type'>, sender: Sender): Promise<string> {
  const before = Object.keys(await stored());
  expect(await call({ type: 'openReport', ...msg } as Extract<BgRequest, { type: 'openReport' }>, sender)).toEqual({ ok: true });
  const id = Object.keys(await stored()).find((k) => !before.includes(k));
  if (!id) throw new Error('no draft stored');
  return id;
}

/** The body the report page would send for the draft `id`. */
async function bodyFor(id: string, answers: Partial<Answers> = {}, index = 0): Promise<{ body: string; report: ProblemReport }> {
  const record = (await reportItem(id).getValue()) as StoredReport;
  const draft = record.drafts[index] as ReportDraft;
  const report = composeReport(draft, { choices: ['ads-showing'], words: '', email: '', ...answers });
  return { body: reportBody(report), report };
}

const send = (id: string, body: string) => call({ type: 'sendReport', id, body }, reportSender(id));
const accepted = (ref = REF, status = 201) =>
  new Response(JSON.stringify({ ok: true, ref }), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  fakeBrowser.reset();
  env.kind = 'chrome';
  granted = undefined;
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '0.4.0' } as never);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(UA);
  vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
    origins: [],
    permissions: [],
    ...(granted ? { data_collection: granted } : {}),
  })) as never);
  toTab = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue({ ok: true } as never);
  fetchSpy = vi.fn(async () => accepted());
  vi.stubGlobal('fetch', fetchSpy);
  await deviceItem.setValue(defaultDevice('dev1'));
  feedTab = await fakeBrowser.tabs.create({ url: FEED_URL, active: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('who may do what', () => {
  it('test_sender_checks', async () => {
    // Only the report page reads or sends a draft.
    for (const sender of [feedSender(), pageSender('popup.html'), pageSender('options.html'), { url: 'https://evil.example/' }]) {
      await expect(call({ type: 'reportDraft', id: 'x' }, sender)).rejects.toThrow(/not accepted/);
      await expect(call({ type: 'sendReport', id: 'x', body: '{}' }, sender)).rejects.toThrow(/not accepted/);
    }
    // A web page can't open one at all.
    await expect(call({ type: 'openReport', draft: DETECTION }, { url: 'https://evil.example/', tab: feedTab })).rejects.toThrow(
      /not accepted/,
    );
    // A content script can't ask for a page about no page facts (Settings', the popup's).
    await expect(call({ type: 'openReport', about: { from: 'settings' } }, feedSender())).rejects.toThrow(/not accepted/);
    // Page facts come only from the tab they describe; an extension page sends a correction, never a page.
    expect(await call({ type: 'openReport', draft: DETECTION }, pageSender('sidepanel.html'))).toEqual({ ok: false });
    expect(await call({ type: 'openReport', draft: CORRECTION }, feedSender())).toEqual({ ok: false });
    // A draft no answer can make valid.
    expect(
      await call({ type: 'openReport', draft: { ...DETECTION, page: { ...PAGE, adapter: 'facebook@2026.11.0' } } }, feedSender()),
    ).toEqual({
      ok: false,
    });
    expect(Object.keys(await stored())).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('test_open_report_keeps_the_checked_draft_and_opens_a_tab_beside_the_feed', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const id = await open({ draft: { ...DETECTION, extra: 'dropped' } as ReportDraftInput, notice: 'paused' }, feedSender());
    const record = (await reportItem(id).getValue()) as StoredReport;
    expect(record).toMatchObject({ state: 'open', openerTabId: feedTab.id, site: 'linkedin', notice: 'paused' });
    expect(record.drafts).toHaveLength(1);
    expect(record.drafts[0]).toEqual({
      ...DETECTION,
      v: 1,
      id,
      env: { extension: '0.4.0', channel: 'development', browser: 'chrome', browserMajor: 141 },
    });
    expect(create).toHaveBeenCalledWith({
      url: `${EXT}/report.html#${id}`,
      active: true,
      index: (feedTab.index ?? 0) + 1,
      openerTabId: feedTab.id,
      windowId: feedTab.windowId,
    });
    expect(record.tabId).toBe((await create.mock.results[0]?.value)?.id);
    // The report page reads it back by its id.
    const read = await call({ type: 'reportDraft', id }, reportSender(id));
    expect(read.report).toEqual({ drafts: record.drafts, state: 'open', opener: { tabId: feedTab.id, site: 'linkedin' } });
  });

  it('test_one_report_tab_per_feed_tab_per_minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const update = vi.spyOn(fakeBrowser.tabs, 'update');
    const first = await open({ draft: DETECTION }, feedSender());
    const reportTab = (await reportItem(first).getValue())?.tabId;
    // A second click (or a page script) within the minute brings that tab back instead of opening another.
    expect(await call({ type: 'openReport', draft: DETECTION }, feedSender())).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(reportTab, { active: true });
    // A minute later, or once that tab is closed, a new one opens.
    vi.setSystemTime(Date.now() + 61_000);
    await open({ draft: DETECTION }, feedSender());
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('test_another_report_within_the_minute_takes_over_the_unsent_tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const update = vi.spyOn(fakeBrowser.tabs, 'update');
    const first = await open({ draft: DETECTION }, feedSender());
    const reportTab = (await reportItem(first).getValue())?.tabId;
    // Wrong call? on another post while the first report is still unsent: the same tab shows the new report.
    const other: ReportDraftInput = { ...DETECTION, from: 'popup-banner', detection: { counts: { items: 3 } } };
    const second = await open({ draft: other }, feedSender());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(reportTab, { url: `${EXT}/report.html#${second}`, active: true });
    expect(await reportItem(first).getValue()).toBeNull();
    expect(await reportItem(second).getValue()).toMatchObject({ state: 'open', tabId: reportTab, openerTabId: feedTab.id });
    expect((await reportItem(second).getValue())?.drafts[0]).toMatchObject({ from: 'popup-banner', id: second });
  });

  it('test_a_sent_report_never_takes_the_next_one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    fetchSpy.mockResolvedValue(accepted());
    const first = await open({ draft: DETECTION }, feedSender());
    expect(await send(first, (await bodyFor(first)).body)).toEqual({ ok: true, ref: REF });
    // Back on the feed within the minute, by its tab: the next report gets its own page, the sent one stays as it is.
    const second = await open({ draft: DETECTION }, feedSender());
    expect(second).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await reportItem(first).getValue()).toMatchObject({ state: 'sent', ref: REF });
  });

  it('test_private_window_drafts_hold_nothing_about_the_page', async () => {
    const id = await open({ draft: DETECTION }, feedSender({ incognito: true }));
    const [draft] = (await reportItem(id).getValue())?.drafts ?? [];
    expect(draft).toEqual({ kind: 'detection', from: 'popup', private: true, v: 1, id, env: expect.any(Object) });
    // The popup on a private tab whose script didn't answer: the same.
    const incognito = await fakeBrowser.tabs.create({ url: FEED_URL });
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation((async (tabId: number) =>
      tabId === incognito.id ? { ...incognito, incognito: true } : undefined) as never);
    const popup = await open(
      { about: { from: 'popup-no-script', platform: 'linkedin', tabId: incognito.id ?? null } },
      pageSender('popup.html'),
    );
    const [noScript] = (await reportItem(popup).getValue())?.drafts ?? [];
    expect(noScript).toMatchObject({ kind: 'detection', from: 'popup-no-script', private: true });
    expect(noScript).not.toHaveProperty('page');
  });

  it('test_drafts_about_no_page_facts', async () => {
    // Settings: LinkedIn, Facebook or something else, one id for all three.
    const settings = await open(
      { about: { from: 'settings' } },
      { url: `${EXT}/options.html#/about`, tab: { ...feedTab, id: 5 } },
    );
    const drafts = (await reportItem(settings).getValue())?.drafts ?? [];
    expect(drafts.map((d) => [d.kind, d.page?.platform ?? null, d.page?.route ?? null, d.id])).toEqual([
      ['detection', 'linkedin', 'unknown', settings],
      ['detection', 'facebook', 'unknown', settings],
      ['other', null, null, settings],
    ]);
    // The popup on a feed tab that didn't answer: the issue speaks for itself.
    const noScript = await open(
      { about: { from: 'popup-no-script', platform: 'linkedin', tabId: feedTab.id ?? null } },
      pageSender('popup.html'),
    );
    expect((await reportItem(noScript).getValue())?.drafts[0]).toMatchObject({
      kind: 'detection',
      from: 'popup-no-script',
      page: { platform: 'linkedin', route: 'unknown', lang: 'unknown', adapter: linkedinAdapter.version },
      health: { status: 'not-started', issues: ['no-content-script'], degraded: [] },
    });
    // Off LinkedIn and Facebook: what's it about.
    const other = await open({ about: { from: 'popup', platform: null, tabId: null } }, pageSender('popup.html'));
    expect((await reportItem(other).getValue())?.drafts[0]).toMatchObject({ kind: 'other', from: 'popup' });
    for (const id of [settings, noScript, other])
      expect((await reportItem(id).getValue())?.drafts.every((d) => checkDraft(d))).toBe(true);
  });

  it('test_drafts_expire_are_capped_and_go_with_their_tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      ids.push(await open({ draft: DETECTION }, feedSender()));
    }
    // At most 5, the newest kept.
    expect(Object.keys(await stored()).sort()).toEqual(ids.slice(-5).sort());
    // An hour later, a draft is gone for its page.
    const last = ids.at(-1) as string;
    vi.setSystemTime(Date.now() + REPORT_DRAFT_TTL_MS + 1);
    expect(await call({ type: 'reportDraft', id: last }, reportSender(last))).toEqual({ report: null });
    expect(await send(last, '{}')).toEqual({ ok: false, code: 'expired' });
    // Closing the report page forgets its draft.
    vi.setSystemTime(Date.now() + 61_000);
    const fresh = await open({ draft: DETECTION }, feedSender());
    const tabId = (await reportItem(fresh).getValue())?.tabId as number;
    // What the background's `tabs.onRemoved` listener calls.
    await forgetReportTab(tabId + 1000);
    expect(await reportItem(fresh).getValue()).not.toBeNull();
    await forgetReportTab(tabId);
    expect(await reportItem(fresh).getValue()).toBeNull();
  });
});

describe('sending', () => {
  it('test_one_post_without_cookies_referrer_or_token', async () => {
    // Signed in to a server, with tokens: none of it goes with a report.
    await serverAccountItem.setValue({
      origin: CLOUD_ORIGIN,
      email: 'ada@example.org',
      deviceId: '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e',
      signedInAt: Date.now(),
      needsSignIn: false,
      info: {},
    } as never);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const id = await open({ draft: DETECTION }, feedSender());
    const { body } = await bodyFor(id);
    expect(await send(id, body)).toEqual({ ok: true, ref: REF });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REPORTS_URL);
    expect(init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledWith(REPORT_SEND_TIMEOUT_MS);
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|cookie/i);
    // Sent once: a second click gets the same reference without another request.
    expect(await send(id, body)).toEqual({ ok: true, ref: REF });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await reportItem(id).getValue())?.state).toBe('sent');
  });

  it('test_double_click_sends_once', async () => {
    let answer: (r: Response) => void = () => undefined;
    fetchSpy.mockImplementation(() => new Promise<Response>((done) => (answer = done)));
    const id = await open({ draft: DETECTION }, feedSender());
    const { body } = await bodyFor(id);
    const both = Promise.all([send(id, body), send(id, body)]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    answer(accepted());
    expect(await both).toEqual([
      { ok: true, ref: REF },
      { ok: true, ref: REF },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('test_body_must_equal_the_draft_plus_answers', async () => {
    const id = await open({ draft: DETECTION }, feedSender());
    const { report, body } = await bodyFor(id);
    const refused = { ok: false, code: 'refused' };
    const variants: unknown[] = [
      { ...report, page: { ...report.page, preset: 'calm' } },
      { ...report, detection: { counts: { items: 1 } } },
      { ...report, health: { ...report.health, issues: [] } },
      { ...report, env: { ...report.env, browserMajor: 140 } },
      { ...report, id: '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e' },
      { ...report, kind: 'other', choices: ['ai'] },
      // Something the schema would drop: never sent along.
      { ...report, note: 'Morgan Ellis' },
      { ...report, page: { ...report.page, url: 'https://www.linkedin.com/in/morgan-ellis/' } },
      // Answers the kind doesn't take.
      { ...report, choices: ['verdict-wrong'] },
      { ...report, choices: [] },
      {
        ...report,
        post: {
          reason: 'sponsored',
          source: 'rule',
          evidence: [],
          authorKind: 'person',
          relationship: 'unknown',
          media: 'none',
          text: 'none',
        },
      },
    ];
    for (const v of variants) expect(await send(id, JSON.stringify(v)), JSON.stringify(v)).toEqual(refused);
    expect(await send(id, 'not json')).toEqual(refused);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The very body the page made: sent, byte for byte.
    expect(await send(id, body)).toEqual({ ok: true, ref: REF });
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(body);
  });

  it('test_correction_words_must_be_clean', async () => {
    const id = await open({ draft: CORRECTION }, pageSender('sidepanel.html'));
    const { report } = await bodyFor(id, { choices: ['verdict-wrong'], words: 'The date is 1931, not 1932.' });
    // Words the page would have cleaned (an email, a link) are refused as they are.
    const dirty = { ...report, correction: { ...report.correction, message: 'Write to ada@example.org' } };
    expect(await send(id, JSON.stringify(dirty))).toEqual({ ok: false, code: 'refused' });
    const { body } = await bodyFor(id, {
      choices: ['verdict-wrong'],
      words: 'The date is 1931, not 1932.',
      email: 'ada@example.org',
    });
    expect(await send(id, body)).toEqual({ ok: true, ref: REF });
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string).correction).toEqual({
      feature: 'factcheck',
      promptVersion: 3,
      via: 'own-key',
      message: 'The date is 1931, not 1932.',
      contact: 'ada@example.org',
    });
  });

  it('test_local_limits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sendOne = async () => {
      vi.setSystemTime(Date.now() + 61_000);
      const id = await open({ draft: DETECTION }, feedSender());
      return send(id, (await bodyFor(id)).body);
    };
    for (let i = 0; i < REPORT_LOCAL_PER_HOUR; i++) expect(await sendOne()).toMatchObject({ ok: true });
    expect(await sendOne()).toEqual({ ok: false, code: 'limit' });
    expect(fetchSpy).toHaveBeenCalledTimes(REPORT_LOCAL_PER_HOUR);
    // Timestamps only, kept locally.
    const log = await reportLogItem.getValue();
    expect(log).toHaveLength(REPORT_LOCAL_PER_HOUR);
    expect(log.every((t) => typeof t === 'number')).toBe(true);
    // The day's limit, an hour at a time.
    for (let hour = 0; hour < 3; hour++) {
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      for (let i = 0; i < REPORT_LOCAL_PER_HOUR; i++) await sendOne();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(REPORT_LOCAL_PER_DAY);
    expect(await sendOne()).toEqual({ ok: false, code: 'limit' });
    expect(overLocalLimit([], Date.now())).toBe(false);
  });

  it('test_status_mapping_and_no_retry', async () => {
    const cases: Array<[Response | Error | DOMException, BgResponses['sendReport']]> = [
      [new TypeError('Failed to fetch'), { ok: false, code: 'network' }],
      [new DOMException('The operation timed out.', 'TimeoutError'), { ok: false, code: 'network' }],
      [
        new Response(JSON.stringify(REPORT_ERRORS.rateLimit), { status: 429, headers: { 'retry-after': '1800' } }),
        { ok: false, code: 'rate-limit', retryAfterSec: 1800 },
      ],
      [
        new Response(JSON.stringify(REPORT_ERRORS.unavailable), { status: 503, headers: { 'retry-after': '120' } }),
        { ok: false, code: 'unavailable', retryAfterSec: 120 },
      ],
      [new Response(JSON.stringify(REPORT_ERRORS.unlisted), { status: 403 }), { ok: false, code: 'unlisted' }],
      [new Response(JSON.stringify(REPORT_ERRORS.origin), { status: 403 }), { ok: false, code: 'refused' }],
      [new Response(JSON.stringify(REPORT_ERRORS.invalid), { status: 400 }), { ok: false, code: 'refused' }],
      [new Response('Not found', { status: 404 }), { ok: false, code: 'refused' }],
      [new Response(JSON.stringify(REPORT_ERRORS.tooLarge), { status: 413 }), { ok: false, code: 'refused' }],
      [new Response(JSON.stringify({ ok: true, ref: 'not a ref' }), { status: 201 }), { ok: false, code: 'refused' }],
      [accepted(REF, 200), { ok: true, ref: REF }],
    ];
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const [answer, expected] of cases) {
      fetchSpy.mockReset();
      fetchSpy.mockImplementation(async () => {
        if (!(answer instanceof Response)) throw answer;
        return answer;
      });
      vi.setSystemTime(Date.now() + 61_000);
      await reportLogItem.removeValue();
      const id = await open({ draft: DETECTION }, feedSender());
      const { body } = await bodyFor(id);
      expect(await send(id, body), String(answer)).toEqual(expected);
      // One request per click, never retried by the background.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      if (!expected.ok) {
        // Try again: the same report id, one more request.
        fetchSpy.mockResolvedValueOnce(accepted());
        expect(await send(id, body)).toEqual({ ok: true, ref: REF });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(body);
      }
    }
    vi.useRealTimers();
    expect(retryAfterSeconds(null)).toBeUndefined();
    expect(retryAfterSeconds('12.5')).toBe(13);
    expect(retryAfterSeconds(new Date(Date.now() + 90_000).toUTCString())).toBeGreaterThanOrEqual(89);
    expect(retryAfterSeconds('soon')).toBeUndefined();
  });

  it('test_body_size_limit', async () => {
    const id = await open({ draft: CORRECTION }, pageSender('sidepanel.html'));
    const { report } = await bodyFor(id, { choices: ['other'], words: 'ok' });
    const padded = `${JSON.stringify(report)}${' '.repeat(MAX_REPORT_BODY_BYTES)}`;
    expect(await send(id, padded)).toEqual({ ok: false, code: 'refused' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('test_sent_detection_snoozes_its_card_and_tells_its_tab', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = await open({ draft: DETECTION, notice: 'paused' }, feedSender());
    expect(await send(id, (await bodyFor(id)).body)).toMatchObject({ ok: true });
    const device = await readDevice();
    expect(device.notices.snoozed['linkedin:paused']).toEqual({ until: Date.now() + REPORT_SNOOZE_MS, adapter: PAGE.adapter });
    expect(toTab).toHaveBeenCalledWith(feedTab.id, { type: 'reportSent', kind: 'paused' });
    // A correction tells no tab and snoozes nothing.
    toTab.mockClear();
    const correction = await open({ draft: CORRECTION }, pageSender('sidepanel.html'));
    await send(correction, (await bodyFor(correction, { choices: ['other'], words: 'Wrong year.' })).body);
    expect(toTab).not.toHaveBeenCalled();
  });

  it('test_erase_everything_clears_drafts_and_the_log', async () => {
    const id = await open({ draft: DETECTION }, feedSender());
    await send(id, (await bodyFor(id)).body);
    expect(await reportLogItem.getValue()).toHaveLength(1);
    vi.spyOn(fakeBrowser.storage.session, 'clear').mockImplementation(async () => {
      for (const key of Object.keys(await fakeBrowser.storage.session.get(null))) await fakeBrowser.storage.session.remove(key);
    });
    await call({ type: 'clearData', what: 'all' }, pageSender('options.html'));
    expect(await reportItem(id).getValue()).toBeNull();
    expect(await reportLogItem.getValue()).toEqual([]);
  });
});

describe('Firefox', () => {
  it('test_firefox_sends_only_with_technical_data_and_never_asks', async () => {
    env.kind = 'firefox';
    const request = vi.spyOn(fakeBrowser.permissions, 'request');
    const id = await open({ draft: DETECTION }, feedSender());
    const { body } = await bodyFor(id);
    granted = ['websiteContent', 'personalCommunications'];
    expect(await send(id, body)).toEqual({ ok: false, code: 'consent' });
    granted = ['technicalAndInteraction'];
    expect(await send(id, body)).toEqual({ ok: true, ref: REF });
    // A correction's words need personal communications, and its reply email personal identifiers.
    const correction = await open({ draft: CORRECTION }, pageSender('sidepanel.html'));
    const words = await bodyFor(correction, { choices: ['other'], words: 'Wrong year.' });
    expect(await send(correction, words.body)).toEqual({ ok: false, code: 'consent' });
    const withEmail = await bodyFor(correction, { choices: ['other'], words: 'Wrong year.', email: 'ada@example.org' });
    granted = ['technicalAndInteraction', 'personalCommunications'];
    expect(await send(correction, withEmail.body)).toEqual({ ok: false, code: 'consent' });
    expect(await send(correction, words.body)).toEqual({ ok: true, ref: REF });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
  });

  it('test_env_names_versions_and_firefox_build_only', () => {
    vi.spyOn(fakeBrowser.runtime, 'id', 'get').mockReturnValue(FIREFOX_ADDON_ID);
    expect(reportEnv()).toEqual({ extension: '0.4.0', channel: 'development', browser: 'chrome', browserMajor: 141 });
    env.kind = 'firefox';
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0',
    );
    expect(reportEnv()).toEqual({
      extension: '0.4.0',
      channel: 'development',
      browser: 'firefox',
      browserMajor: 147,
      client: FIREFOX_ADDON_ID,
    });
    // Where a build came from.
    expect(reportChannel('production', 'chrome', 'abcdefghijklmnopabcdefghijklmnop')).toBe('chrome-store');
    expect(reportChannel('production', 'edge', 'abcdefghijklmnopabcdefghijklmnop')).toBe('edge-store');
    expect(reportChannel('production', 'firefox', FIREFOX_ADDON_ID)).toBe('firefox-store');
    expect(reportChannel('production', 'chrome', 'aokmlebkpkeniofcnbeajmgabinicggm')).toBe('sideload');
    expect(reportChannel('production', 'firefox', 'feed-dev@unalgorithmfeed.com')).toBe('sideload');
    expect(reportChannel('e2e', 'chrome', 'x')).toBe('development');
    expect(reportChannel('development', 'firefox', 'x')).toBe('development');
  });
});

describe('the code', () => {
  it('test_reports_url_only_in_background_report', () => {
    const src = join(import.meta.dirname, '../src');
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
    const naming = files.filter((f) => /\bREPORTS_(URL|PATH)\b|\/v1\/reports/.test(readFileSync(join(src, f), 'utf8')));
    expect(naming.map((f) => f.replaceAll('\\', '/'))).toEqual(['background/report.ts']);
    // And nothing in the extension calls fetch with a report but that module's one POST.
    const report = readFileSync(join(src, 'background/report.ts'), 'utf8');
    expect(report.match(/\bfetch\(/g)).toHaveLength(1);
  });

  it('test_same_json_ignores_key_order_only', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: null }, { a: 0 })).toBe(false);
  });

  it('test_read_body_needs_one_of_the_drafts', () => {
    const draft = checkDraft({ ...DETECTION, v: 1, id: '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e', env: reportEnv() } as ReportDraft);
    expect(draft).not.toBeNull();
    const report = composeReport(draft as ReportDraft, { choices: ['ads-showing'], words: '', email: '' });
    expect(readBody(reportBody(report), [draft as ReportDraft])).toEqual(report);
    expect(readBody(reportBody(report), [])).toBeNull();
  });
});

describe('tab state', () => {
  it('test_notice_and_feed_like_clear_and_the_toolbar_says_not_running', async () => {
    const setTitle = vi.fn(async () => undefined);
    const quiet = vi.fn(async () => undefined);
    Object.assign(fakeBrowser.action, {
      setTitle,
      setBadgeText: quiet,
      setBadgeBackgroundColor: quiet,
      setBadgeTextColor: quiet,
      setIcon: quiet,
    });
    const notice = { kind: 'not-running' as const, issues: ['feed-not-started'] };
    // The watchdog found a feed unAlgorithm isn't running on.
    await mergeTabState(7, {
      platform: 'linkedin',
      onFeed: false,
      paused: false,
      feedLike: true,
      notice,
      health: { status: 'not-started', issues: ['feed-not-started'], degraded: [] },
    });
    expect(await tabStateItem(7).getValue()).toMatchObject({ feedLike: true, notice });
    expect(setTitle).toHaveBeenLastCalledWith({ tabId: 7, title: "unAlgorithm isn't running on this LinkedIn page" });
    // The controller took over: its state carries health without a notice (JSON drops `notice: undefined`).
    await mergeTabState(7, JSON.parse(JSON.stringify({ onFeed: true, health: HEALTHY, notice: undefined, routeNew: true })));
    const after = await tabStateItem(7).getValue();
    expect(after).not.toHaveProperty('notice');
    expect(after).not.toHaveProperty('feedLike');
    expect(after.routeNew).toBe(true);
    expect(setTitle).toHaveBeenLastCalledWith({ tabId: 7, title: 'unAlgorithm: 0 posts hidden on this page' });
    // A patch without health (hidden counts) leaves a notice alone.
    await mergeTabState(7, { notice: { kind: 'paused', issues: ['over-filtering'] }, health: { ...HEALTHY, status: 'broken' } });
    await mergeTabState(7, { counts: { items: 1, posts: 1, classified: 0, hidden: {}, hiddenTotal: 0, highlighted: 0 } });
    expect((await tabStateItem(7).getValue()).notice?.kind).toBe('paused');
  });
});
