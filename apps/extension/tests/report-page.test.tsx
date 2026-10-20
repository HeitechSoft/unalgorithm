/**
 * The report page (ADR 0009 §2): what the person sees is what is sent (the preview's lines and the exact body, byte for
 * byte), a missing answer is said next to its question with the focus moved there, every result has its words and
 * actions, *Try again* sends the same report once more, and Firefox without technical data offers email and never asks
 * for the permission. The background is a stubbed `sendToBackground`; Vitest builds for Chrome, so `browserKind()` is
 * switched for Firefox.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { cleanReportMessage, defaultDevice, describeReport, emptyTabState, REPORT_LINE_COPY } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import { REPORT_CHOICES, type ReportEnv, SUPPORT_EMAIL } from '@unalgorithm/protocol';
import { NOTICE_COPY, OVER_FILTERING_COPY } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App as Options } from '../src/entrypoints/options/App.tsx';
import { ABOUT_REPORT_COPY, NOTICES_COPY } from '../src/entrypoints/options/panes.tsx';
import { PING_WAIT_MS, POPUP_COPY, App as Popup } from '../src/entrypoints/popup/App.tsx';
import { App, composeReport, reportBody } from '../src/entrypoints/report/App.tsx';
import { REPORT_COPY, type ResultCopy } from '../src/entrypoints/report/copy.ts';
import { App as SidePanel } from '../src/entrypoints/sidepanel/App.tsx';
import type { BrowserKind } from '../src/lib/browser-kind.ts';
import {
  type BgRequest,
  type ContentRequest,
  type ReportPageData,
  type ReportSendResult,
  sendToBackground,
} from '../src/lib/messages.ts';
import { deviceItem, type ReportDraft, readDevice, tabStateItem } from '../src/lib/storage.ts';

const env = vi.hoisted(() => ({ kind: 'chrome' as BrowserKind }));
vi.mock('../src/lib/browser-kind.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/browser-kind.ts')>()),
  browserKind: () => env.kind,
}));
vi.mock('../src/lib/messages.ts', async (importOriginal) => {
  const sendToBackground = vi.fn();
  return {
    ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
    sendToBackground,
    // Through the stub too, as the real one goes through the real `sendToBackground`.
    sendQuietly: (msg: unknown) => void Promise.resolve(sendToBackground(msg)).catch(() => undefined),
  };
});

const ID = '0199d6a5-7a20-7d41-8c3e-5f9a0b1c2d4e';
const REF = '7KQ3-M2PA';
const ENV: ReportEnv = { extension: '0.4.0', channel: 'chrome-store', browser: 'chrome', browserMajor: 141 };
const PAGE = {
  platform: 'linkedin' as const,
  adapter: linkedinAdapter.version,
  route: 'feed-candidate' as const,
  feedWord: 'foryou',
  lang: 'en',
  preset: 'balanced' as const,
  ai: 'off' as const,
  paused: false,
};
const DETECTION: ReportDraft = {
  v: 1,
  id: ID,
  kind: 'detection',
  from: 'popup',
  env: ENV,
  page: PAGE,
  health: { status: 'ok', issues: ['route-new'], degraded: [] },
  detection: { counts: { posts: 22, modules: 2, hidden: 15 }, hiddenBy: { sponsored: 5 }, detectors: { 'li.follow-button': 12 } },
};
const WRONG_CALL: ReportDraft = {
  ...DETECTION,
  kind: 'wrong-call',
  from: 'why',
  post: {
    reason: 'suggested',
    source: 'rule',
    evidence: [{ detector: 'li.header.suggested', strength: 'strong' }],
    authorKind: 'person',
    relationship: 'not-followed',
    media: 'none',
    text: 'long',
  },
};
const CORRECTION: ReportDraft = {
  v: 1,
  id: ID,
  kind: 'correction',
  from: 'sidepanel',
  env: ENV,
  correction: { feature: 'factcheck', promptVersion: 3, via: 'own-key' },
};

let data: ReportPageData | null;
let sendReplies: ReportSendResult[];
let granted: string[] | undefined;
/** Firefox's `permissions.onAdded` listeners (the fake browser has no in-memory one). */
let onAdded: Array<() => void>;

const sent = () =>
  vi
    .mocked(sendToBackground)
    .mock.calls.map(([m]) => m as BgRequest)
    .filter((m): m is Extract<BgRequest, { type: 'sendReport' }> => m.type === 'sendReport');

beforeEach(() => {
  fakeBrowser.reset();
  env.kind = 'chrome';
  granted = undefined;
  location.hash = `#${ID}`;
  data = { drafts: [DETECTION], state: 'open', opener: { tabId: 7, site: 'linkedin' } };
  sendReplies = [];
  vi.mocked(sendToBackground).mockReset();
  vi.mocked(sendToBackground).mockImplementation((async (msg: BgRequest) => {
    if (msg.type === 'reportDraft') return { report: data };
    if (msg.type === 'sendReport') return sendReplies.shift() ?? { ok: true, ref: REF };
    if (msg.type === 'openReport') return { ok: true };
    if (msg.type === 'aiStatus')
      return { configured: false, kind: null, label: 'Off', state: 'off', postsToday: 0, dailyCap: 300, capApplies: false };
    throw new Error(`No reply to ${msg.type}`);
  }) as never);
  vi.spyOn(fakeBrowser.permissions, 'getAll').mockImplementation((async () => ({
    origins: [],
    permissions: [],
    ...(granted ? { data_collection: granted } : {}),
  })) as never);
  onAdded = [];
  vi.spyOn(fakeBrowser.permissions.onAdded, 'addListener').mockImplementation(
    ((fn: () => void) => void onAdded.push(fn)) as never,
  );
  vi.spyOn(fakeBrowser.permissions.onAdded, 'removeListener').mockImplementation(() => undefined);
  vi.spyOn(fakeBrowser.permissions.onRemoved, 'addListener').mockImplementation(() => undefined);
  vi.spyOn(fakeBrowser.permissions.onRemoved, 'removeListener').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPage() {
  const user = setupUser();
  render(<App />);
  await screen.findByRole('button', { name: REPORT_COPY.buttons.cancel });
  return user;
}

const pre = () => document.querySelector('pre') as HTMLPreElement;
const previewLines = () =>
  within(screen.getByRole('region', { name: REPORT_COPY.preview.heading }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);
const choice = (code: string) => REPORT_LINE_COPY.choices[code] as string;

describe('what is sent', () => {
  it('test_preview_and_exact_body_are_what_is_sent', async () => {
    const user = await openPage();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: REPORT_COPY.title }));
    expect(document.title).toBe(REPORT_COPY.pageTitle);
    await user.click(screen.getByRole('checkbox', { name: choice('ads-showing') }));
    await user.click(screen.getByRole('checkbox', { name: choice('not-working') }));
    const report = composeReport(DETECTION, { choices: ['ads-showing', 'not-working'], words: '', email: '' });
    // The lines, the ADR's example among them, and the body byte for byte.
    expect(previewLines()).toEqual(describeReport(report));
    expect(previewLines()).toContain('Page: LinkedIn home feed (a new address: foryou), in English');
    expect(previewLines()).toContain("Your answer: Ads are still showing; unAlgorithm isn't doing anything on this page");
    expect(pre().textContent).toBe(reportBody(report));
    expect(pre().tabIndex).toBe(0);
    expect(screen.getByText(REPORT_COPY.preview.neverSent)).toBeTruthy();
    expect(screen.getByText(REPORT_COPY.preview.destination, { exact: false })).toBeTruthy();
    expect(screen.getByRole('link', { name: REPORT_COPY.preview.privacy }).getAttribute('href')).toBe(
      REPORT_COPY.preview.privacyHref,
    );

    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(sent()).toEqual([{ type: 'sendReport', id: ID, body: pre()?.textContent ?? reportBody(report) }]);
    expect(sent()[0]?.body).toBe(reportBody(report));
  });

  it('test_wrong_call_shows_the_post_facts', async () => {
    data = { drafts: [WRONG_CALL], state: 'open' };
    await openPage();
    expect(previewLines()).toContain(
      "The post: hidden as Suggested by a rule; seen: suggested header (strong); author: a person you don't follow; long text.",
    );
    // One answer: radio buttons.
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(
      REPORT_CHOICES['wrong-call'].map(choice),
    );
  });

  it('test_private_window_says_so', async () => {
    data = { drafts: [{ v: 1, id: ID, kind: 'detection', from: 'popup', env: ENV, private: true }], state: 'open' };
    await openPage();
    expect(screen.getByText(REPORT_COPY.privateWindow)).toBeTruthy();
    expect(previewLines()).toContain(REPORT_LINE_COPY.privateWindow);
    expect(JSON.parse(pre().textContent ?? '{}')).not.toHaveProperty('page');
  });
});

describe('answers', () => {
  it('test_required_choice_errors_move_focus', async () => {
    const user = await openPage();
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(screen.getByText(REPORT_COPY.errors.chooseMany)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: choice('ads-showing') }));
    expect(screen.getByRole('checkbox', { name: choice('ads-showing') }).getAttribute('aria-describedby')).toBeTruthy();
    expect(sent()).toEqual([]);
    // Send is never disabled.
    expect((screen.getByRole('button', { name: REPORT_COPY.buttons.send }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    data = { drafts: [WRONG_CALL], state: 'open' };
    const again = await openPage();
    await again.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(screen.getByText(REPORT_COPY.errors.chooseOne)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: choice('should-show') }));
    expect(sent()).toEqual([]);
  });

  it('test_notice_and_no_script_reports_need_no_answer', async () => {
    for (const from of ['notice', 'popup-no-script']) {
      data = { drafts: [{ ...DETECTION, from }], state: 'open' };
      const user = await openPage();
      await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
      await screen.findByText(REPORT_COPY.sent.title);
      expect(JSON.parse(sent().at(-1)?.body ?? '{}').choices).toEqual([]);
      cleanup();
    }
  });

  it('test_settings_asks_what_its_about_first', async () => {
    const other: ReportDraft = { v: 1, id: ID, kind: 'other', from: 'settings', env: ENV };
    const li = { ...DETECTION, from: 'settings', page: { ...PAGE, route: 'unknown' as const, lang: 'unknown' } };
    data = {
      drafts: [li, { ...li, page: { ...li.page, platform: 'facebook', adapter: 'facebook@2026.11.0' } }, other],
      state: 'open',
    };
    const user = await openPage();
    expect(screen.queryByRole('region', { name: REPORT_COPY.preview.heading })).toBeNull();
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(screen.getByText(REPORT_COPY.errors.chooseOne)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: REPORT_COPY.about.linkedin }));

    await user.click(screen.getByRole('radio', { name: REPORT_COPY.about.facebook }));
    expect(previewLines()).toContain('Page: Facebook, page not checked');
    await user.click(screen.getByRole('radio', { name: REPORT_COPY.about.other }));
    expect(screen.getByRole('group', { name: REPORT_COPY.questions.otherAfterSettings })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: choice('credits') }));
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(JSON.parse(sent()[0]?.body ?? '{}')).toMatchObject({ kind: 'other', from: 'settings', choices: ['credits'] });
  });
});

describe('corrections', () => {
  it('test_words_are_cleaned_in_the_preview_only', async () => {
    data = { drafts: [CORRECTION], state: 'open' };
    const user = await openPage();
    await user.click(screen.getByRole('radio', { name: choice('verdict-wrong') }));
    const words = screen.getByRole('textbox', { name: REPORT_COPY.words.label }) as HTMLTextAreaElement;
    const typed = 'The year is 1931. Write to ada@example.org ';
    await user.type(words, typed);
    // The field keeps what was typed (the trailing space too); the preview and the body have the cleaned words.
    expect(words.value).toBe(typed);
    expect(screen.getByText(REPORT_COPY.words.counter(typed.length))).toBeTruthy();
    expect(previewLines()).toContain(`In your own words: ${cleanReportMessage(typed)}`);
    expect(cleanReportMessage(typed)).toContain('[email]');
    expect(JSON.parse(pre().textContent ?? '{}').correction.message).toBe(cleanReportMessage(typed));
    expect(screen.getByText(REPORT_COPY.words.hint)).toBeTruthy();
    // A correction sends the person's words (and maybe their email), so it never claims to send no names or links.
    expect(screen.getByText(REPORT_COPY.preview.neverSentCorrection)).toBeTruthy();
    expect(screen.queryByText(REPORT_COPY.preview.neverSent)).toBeNull();
  });

  it('test_links_typed_without_a_scheme_are_masked', async () => {
    data = { drafts: [CORRECTION], state: 'open' };
    const user = await openPage();
    await user.click(screen.getByRole('radio', { name: choice('verdict-wrong') }));
    await user.type(screen.getByRole('textbox', { name: REPORT_COPY.words.label }), 'Ask her at linkedin.com/in/janedoe');
    expect(previewLines()).toContain('In your own words: Ask her at [link: linkedin.com]');
    expect(pre().textContent).not.toContain('janedoe');
  });

  it('test_words_required_and_email_checked', async () => {
    data = { drafts: [CORRECTION], state: 'open' };
    const user = await openPage();
    await user.click(screen.getByRole('radio', { name: choice('source-wrong') }));
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(screen.getByText(REPORT_COPY.errors.words)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: REPORT_COPY.words.label }));
    await user.type(screen.getByRole('textbox', { name: REPORT_COPY.words.label }), 'The source says 1931.');
    // Without an email: how it goes, and that it still counts.
    expect(screen.getByText(`${REPORT_COPY.email.hint} ${REPORT_COPY.email.without}`)).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: REPORT_COPY.email.label }), 'not an email');
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(screen.getByText(REPORT_COPY.errors.email)).toBeTruthy();
    expect(sent()).toEqual([]);
    await user.clear(screen.getByRole('textbox', { name: REPORT_COPY.email.label }));
    await user.type(screen.getByRole('textbox', { name: REPORT_COPY.email.label }), 'ada@example.org');
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    expect(JSON.parse(sent()[0]?.body ?? '{}').correction).toEqual({
      feature: 'factcheck',
      promptVersion: 3,
      via: 'own-key',
      message: 'The source says 1931.',
      contact: 'ada@example.org',
    });
    expect(await screen.findByText(REPORT_COPY.sent.correctionBody)).toBeTruthy();
  });

  it('test_email_field_hidden_without_firefox_consent', async () => {
    data = { drafts: [CORRECTION], state: 'open' };
    env.kind = 'firefox';
    granted = ['technicalAndInteraction', 'personalCommunications', 'websiteContent'];
    await openPage();
    await screen.findByText(REPORT_COPY.email.noField);
    expect(screen.queryByRole('textbox', { name: REPORT_COPY.email.label })).toBeNull();
    cleanup();
    granted = [...granted, 'personallyIdentifyingInfo'];
    await openPage();
    expect(await screen.findByRole('textbox', { name: REPORT_COPY.email.label })).toBeTruthy();
  });
});

describe('results', () => {
  it('test_sent_shows_the_reference_and_goes_back', async () => {
    const update = vi.spyOn(fakeBrowser.tabs, 'update').mockResolvedValue({} as never);
    const remove = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined as never);
    vi.spyOn(fakeBrowser.tabs, 'getCurrent').mockResolvedValue({ id: 42 } as never);
    const user = await openPage();
    await user.click(screen.getByRole('checkbox', { name: choice('ads-showing') }));
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    const title = await screen.findByRole('heading', { name: REPORT_COPY.sent.title });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(screen.getByText(REF)).toBeTruthy();
    expect(screen.getByText(REPORT_COPY.sent.body)).toBeTruthy();
    const mail = screen.getByRole('link', { name: SUPPORT_EMAIL });
    expect(mail.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}?subject=unAlgorithm%20report%20${REF}`);
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.back('LinkedIn') }));
    expect(update).toHaveBeenCalledWith(7, { active: true });
    await waitFor(() => expect(remove).toHaveBeenCalledWith(42));
  });

  it('test_an_already_sent_draft_shows_its_reference', async () => {
    data = { drafts: [DETECTION], state: 'sent', ref: REF };
    render(<App />);
    expect(await screen.findByText(REF)).toBeTruthy();
    expect(screen.queryByRole('button', { name: REPORT_COPY.buttons.send })).toBeNull();
  });

  it('test_each_failure_state', async () => {
    for (const [code, copy] of Object.entries(REPORT_COPY.results) as [string, ResultCopy][]) {
      sendReplies = [{ ok: false, code: code as never }];
      const user = await openPage();
      await user.click(screen.getByRole('checkbox', { name: choice('page-broken') }));
      await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
      const title = await screen.findByRole('heading', { name: copy.title });
      expect(screen.getByText(copy.body)).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(title));
      const has = (name: string) => !!screen.queryByRole('button', { name }) || !!screen.queryByRole('link', { name });
      expect(has(REPORT_COPY.buttons.tryAgain), code).toBe(copy.actions.includes('retry'));
      const email = code === 'consent' ? REPORT_COPY.buttons.emailThis : REPORT_COPY.buttons.emailInstead;
      expect(has(email), code).toBe(copy.actions.includes('email'));
      expect(has(REPORT_COPY.buttons.close), code).toBe(copy.actions.includes('close'));
      if (copy.actions.includes('email')) {
        const href = screen.getByRole('link', { name: email }).getAttribute('href') ?? '';
        expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?subject=unAlgorithm%20report&body=`)).toBe(true);
        expect(decodeURIComponent(href.split('&body=')[1] ?? '')).toContain('Your answer: The page looks broken or slow');
      }
      cleanup();
      vi.mocked(sendToBackground).mockClear();
    }
  });

  it('test_try_again_sends_once_with_the_same_id', async () => {
    sendReplies = [{ ok: false, code: 'network' }];
    const user = await openPage();
    await user.click(screen.getByRole('checkbox', { name: choice('ads-showing') }));
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.send }));
    await screen.findByRole('heading', { name: REPORT_COPY.results.network.title });
    expect(sent()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: REPORT_COPY.buttons.tryAgain }));
    await screen.findByRole('heading', { name: REPORT_COPY.sent.title });
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toEqual(sent()[0]);
  });

  it('test_expired_draft', async () => {
    data = null;
    render(<App />);
    expect(await screen.findByText(REPORT_COPY.expired)).toBeTruthy();
    expect(screen.queryByRole('button', { name: REPORT_COPY.buttons.send })).toBeNull();
  });
});

describe('Firefox', () => {
  it('test_without_technical_data_email_this_report_and_never_ask', async () => {
    env.kind = 'firefox';
    granted = ['websiteContent', 'personalCommunications'];
    const request = vi.spyOn(fakeBrowser.permissions, 'request');
    const user = await openPage();
    const email = await screen.findByRole('link', { name: REPORT_COPY.buttons.emailThis });
    expect(screen.getByText(REPORT_COPY.firefoxTechnical.title)).toBeTruthy();
    expect(screen.getByText(REPORT_COPY.firefoxTechnical.body)).toBeTruthy();
    expect(screen.queryByRole('button', { name: REPORT_COPY.buttons.send })).toBeNull();
    // Answers are still needed, then the person's own email program gets the same lines.
    await user.click(screen.getByRole('checkbox', { name: choice('ads-showing') }));
    const href = email.getAttribute('href') ?? '';
    expect(href.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    const report = composeReport(DETECTION, { choices: ['ads-showing'], words: '', email: '' });
    expect(decodeURIComponent(href.split('&body=')[1] ?? '').split('\r\n')).toEqual(describeReport(report));
    expect(sent()).toEqual([]);
    expect(request).not.toHaveBeenCalled();

    // Allowed in Firefox's add-on settings while the page is open: Send comes back.
    granted = ['technicalAndInteraction'];
    expect(onAdded.length).toBeGreaterThan(0);
    await act(async () => {
      for (const listener of onAdded) listener();
    });
    expect(await screen.findByRole('button', { name: REPORT_COPY.buttons.send })).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it('test_correction_without_personal_communications_offers_email', async () => {
    env.kind = 'firefox';
    granted = ['technicalAndInteraction'];
    data = { drafts: [CORRECTION], state: 'open' };
    await openPage();
    await screen.findByText(REPORT_COPY.firefoxWords.title);
    expect(screen.getByText(REPORT_COPY.firefoxWords.body)).toBeTruthy();
    // Send becomes "Email it instead", with the person's words in the email.
    const user = setupUser();
    await user.click(screen.getByRole('radio', { name: choice('verdict-wrong') }));
    await user.type(screen.getByRole('textbox', { name: REPORT_COPY.words.label }), 'The year is 1931.');
    const href = screen.getByRole('link', { name: REPORT_COPY.buttons.emailInstead }).getAttribute('href') ?? '';
    expect(decodeURIComponent(href.split('&body=')[1] ?? '')).toContain('In your own words: The year is 1931.');
    expect(screen.queryByRole('button', { name: REPORT_COPY.buttons.send })).toBeNull();
  });
});

describe('entry points', () => {
  const FEED_TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 0, status: 'complete' };
  let tab: typeof FEED_TAB;
  /** What the tab's content script answers, by message type; absent: no content script there. */
  let script: Partial<Record<ContentRequest['type'], unknown>> | null;
  let closed: ReturnType<typeof vi.spyOn>;

  const toTab = () =>
    vi
      .mocked(fakeBrowser.tabs.sendMessage)
      .mock.calls.map(([, msg]) => msg as ContentRequest)
      .filter((m) => m.type !== 'ping');
  const opened = () =>
    vi
      .mocked(sendToBackground)
      .mock.calls.map(([m]) => m as BgRequest)
      .filter((m) => m.type === 'openReport');

  beforeEach(async () => {
    tab = FEED_TAB;
    script = { ping: { ok: true, onFeed: true, platform: 'linkedin' }, reportSnapshot: { ok: true } };
    await deviceItem.setValue(defaultDevice('dev1'));
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ ...tab, active: true }]) as never);
    vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation((async () => tab) as never);
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (_id: number, msg: ContentRequest) => {
      if (!script || !(msg.type in script)) throw new Error('Could not establish connection.');
      return script[msg.type];
    }) as never);
    closed = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  });

  async function popup() {
    const user = setupUser();
    render(<Popup />);
    await screen.findByRole('button', { name: POPUP_COPY.report });
    return user;
  }

  it('test_popup_report_builds_its_draft_in_the_tab', async () => {
    const user = await popup();
    await user.click(screen.getByRole('button', { name: POPUP_COPY.report }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(toTab()).toEqual([{ type: 'reportSnapshot', from: 'popup' }]);
    expect(opened()).toEqual([]);
    // Nothing about the popup links to GitHub.
    expect(document.body.innerHTML.includes('github.com')).toBe(false);
  });

  it('test_popup_report_without_an_answering_tab', async () => {
    script = { ping: { ok: true, onFeed: true, platform: 'linkedin' } };
    const user = await popup();
    await user.click(screen.getByRole('button', { name: POPUP_COPY.report }));
    await waitFor(() =>
      expect(opened()).toEqual([{ type: 'openReport', about: { from: 'popup', platform: 'linkedin', tabId: 7 } }]),
    );
    cleanup();
    vi.mocked(sendToBackground).mockClear();
    // Off LinkedIn and Facebook: what's it about.
    tab = { ...FEED_TAB, url: 'https://example.org/' };
    const again = await popup();
    await again.click(screen.getByRole('button', { name: POPUP_COPY.report }));
    await waitFor(() => expect(opened()).toEqual([{ type: 'openReport', about: { from: 'popup', platform: null, tabId: 7 } }]));
  });

  it('test_popup_says_when_the_content_script_isnt_running', async () => {
    script = null;
    const user = await popup();
    const banner = await screen.findByText(POPUP_COPY.noScript.title, {}, { timeout: PING_WAIT_MS + 1500 });
    expect(screen.getByText(POPUP_COPY.noScript.body)).toBeTruthy();
    expect(banner).toBeTruthy();
    const reload = vi.spyOn(fakeBrowser.tabs, 'reload').mockResolvedValue(undefined as never);
    await user.click(screen.getByRole('button', { name: POPUP_COPY.noScript.reload }));
    expect(reload).toHaveBeenCalledWith(7);
    await user.click(screen.getByRole('button', { name: POPUP_COPY.noScript.report }));
    await waitFor(() =>
      expect(opened()).toEqual([{ type: 'openReport', about: { from: 'popup-no-script', platform: 'linkedin', tabId: 7 } }]),
    );
  });

  it('test_popup_quiet_while_the_tab_loads_or_has_state', async () => {
    script = null;
    tab = { ...FEED_TAB, status: 'loading' };
    await popup();
    await new Promise((done) => setTimeout(done, PING_WAIT_MS + 300));
    expect(screen.queryByText(POPUP_COPY.noScript.title)).toBeNull();
    cleanup();
    tab = FEED_TAB;
    await tabStateItem(7).setValue({ ...emptyTabState(), platform: 'linkedin', onFeed: true, updatedAt: Date.now() });
    await popup();
    await new Promise((done) => setTimeout(done, PING_WAIT_MS + 300));
    expect(screen.queryByText(POPUP_COPY.noScript.title)).toBeNull();
  });

  it('test_popup_notice_banners_and_feed_like', async () => {
    await tabStateItem(7).setValue({
      ...emptyTabState(),
      platform: 'linkedin',
      onFeed: true,
      updatedAt: Date.now(),
      health: { status: 'ok', issues: ['ad-label-near-miss', 'no-ads-seen'], degraded: [] },
      notice: { kind: 'ads-through', issues: ['ad-label-near-miss'] },
    });
    const user = await popup();
    expect(await screen.findByText(NOTICE_COPY['ads-through'].title)).toBeTruthy();
    expect(screen.getByText(NOTICE_COPY['ads-through'].body('LinkedIn'))).toBeTruthy();
    expect(screen.getByText(POPUP_COPY.noAds)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Let us know' }));
    await waitFor(() => expect(toTab()).toEqual([{ type: 'reportSnapshot', from: 'popup-banner' }]));
    cleanup();

    // A feed unAlgorithm isn't running on: never "Go to feed" there.
    await tabStateItem(7).setValue({
      ...emptyTabState(),
      platform: 'linkedin',
      onFeed: false,
      feedLike: true,
      updatedAt: Date.now(),
      health: { status: 'not-started', issues: ['feed-not-started'], degraded: [] },
      notice: { kind: 'not-running', issues: ['feed-not-started'] },
    });
    tab = { ...FEED_TAB, url: 'https://www.linkedin.com/feed/newname/' };
    await popup();
    expect(await screen.findByText(NOTICE_COPY['not-running'].title)).toBeTruthy();
    expect(screen.queryByText('Go to feed')).toBeNull();
    cleanup();

    // Paused because nearly everything would have been hidden: that holds until a reload, and the banner says so.
    await tabStateItem(7).setValue({
      ...emptyTabState(),
      platform: 'linkedin',
      onFeed: true,
      updatedAt: Date.now(),
      health: { status: 'broken', issues: ['over-filtering'], degraded: [] },
      notice: { kind: 'paused', issues: ['over-filtering'] },
    });
    tab = FEED_TAB;
    await popup();
    expect(await screen.findByText(NOTICE_COPY.paused.title)).toBeTruthy();
    expect(screen.getByText(OVER_FILTERING_COPY.body('LinkedIn'))).toBeTruthy();
    expect(screen.queryByText(NOTICE_COPY.paused.body('LinkedIn'))).toBeNull();
  });

  it('test_settings_report_and_notice_switch', async () => {
    const user = setupUser();
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '0.4.0' } as never);
    location.hash = '#/about';
    render(<Options />);
    await user.click(await screen.findByRole('button', { name: ABOUT_REPORT_COPY.row }));
    await waitFor(() => expect(opened()).toEqual([{ type: 'openReport', about: { from: 'settings' } }]));
    expect(screen.getByText(ABOUT_REPORT_COPY.banner)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Report a problem/ })).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/issues\/new/);
    cleanup();

    location.hash = '#/display';
    render(<Options />);
    const toggle = await screen.findByRole('switch', { name: NOTICES_COPY.title });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(NOTICES_COPY.footer)).toBeTruthy();
    await user.click(toggle);
    await waitFor(async () => expect((await readDevice()).notices.enabled).toBe(false));
  });

  it('test_side_panel_banner_reports_from_the_tab', async () => {
    const user = setupUser();
    await tabStateItem(7).setValue({
      ...emptyTabState(),
      platform: 'linkedin',
      onFeed: true,
      updatedAt: Date.now(),
      health: { status: 'broken', issues: ['over-filtering'], degraded: [] },
      notice: { kind: 'paused', issues: ['over-filtering'] },
    });
    render(<SidePanel />);
    expect(await screen.findByText(NOTICE_COPY.paused.title)).toBeTruthy();
    expect(
      screen.getByText("unAlgorithm would have hidden too many posts, so it's showing every post. Reload the page to try again."),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Let us know' }));
    await waitFor(() => expect(toTab()).toEqual([{ type: 'reportSnapshot', from: 'sidepanel' }]));
  });
});
