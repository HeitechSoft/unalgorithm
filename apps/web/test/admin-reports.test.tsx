/**
 * The problem reports page at `/admin/reports` (ADR 0009 §7): the groups, open first, with corrections in their own
 * list against the answer promise; the last 30 days as bars and a table; "Fixed in"; a group's reports, 50 a page; one
 * report in full; the lookup by reference; and the four changes an admin makes. `fetch` is the shared fake server
 * (session, discovery document), with the report routes added here: they answer from fixtures and change the next
 * answers as the server's do, and every request is recorded with its exact address.
 *
 * The clock is faked (Date only) at `NOW`, a Monday, so "2 h ago" and business days are fixed. Every report, address
 * and word here is made up.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  ADMIN_REPORTS_DELETE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_FORGET_CONTACT_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  type AdminReportRow,
  type AdminReportsSummary,
  adminReportPath,
  HandleReportsRequestSchema,
  type ReportDay,
  type ReportGroup,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminReports,
  ago,
  businessDaysWaiting,
  groupStats,
  groupTitle,
  replyLink,
  rowLine,
  waitingLine,
} from '../src/AdminReports.tsx';
import type { ReportDetail } from '../src/api.ts';
import { type Answer, type Call, fakeServer, INFO, NOT_ADMIN, type Reply, SESSION_GONE, TOM } from './support/fake-server.ts';

const INTRO =
  'Problem reports people sent from unAlgorithm. They hold versions, counts, the rules that matched and, for ' +
  'corrections, what people wrote; never posts or names.';
const OFF = 'Problem reports are off on this server (REPORTS=off).';
const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN_TEXT = "This account isn't an admin of this server.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const LOAD_FAILED = "Couldn't load the reports.";
const GONE = 'That report no longer exists.';

/** Monday, 2026-10-19, half past three in the afternoon (UTC). */
const NOW = new Date('2026-10-19T15:30:00.000Z');
const HOUR = 3_600_000;
/** `hours` before NOW, on the hour as the server stores report times. */
const hoursAgo = (hours: number) => new Date(Math.floor((NOW.getTime() - hours * HOUR) / HOUR) * HOUR).toISOString();

const LI_KEY = 'linkedin|linkedin@2026.10.2|detection|feed-not-started';
const FB_KEY = 'facebook|facebook@2026.10.1|wrong-call|sponsored';
const OTHER_KEY = '||other|credits';
const FACTCHECK_KEY = '||correction|factcheck';
const PERSPECTIVES_KEY = '||correction|perspectives';

const perDay = (...last: number[]) => [...Array(14 - last.length).fill(0), ...last];

const LI_GROUP: ReportGroup = {
  key: LI_KEY,
  platform: 'linkedin',
  adapter: 'linkedin@2026.10.2',
  kind: 'detection',
  topic: 'feed-not-started',
  total: 7,
  open: 7,
  networks: 5,
  lastAt: hoursAgo(2),
  perDay: perDay(3, 4),
};
const OTHER_GROUP: ReportGroup = {
  key: OTHER_KEY,
  platform: null,
  adapter: null,
  kind: 'other',
  topic: 'credits',
  total: 1,
  open: 1,
  networks: 1,
  lastAt: hoursAgo(30),
  perDay: perDay(1, 0),
};
const FB_GROUP: ReportGroup = {
  key: FB_KEY,
  platform: 'facebook',
  adapter: 'facebook@2026.10.1',
  kind: 'wrong-call',
  topic: 'sponsored',
  total: 2,
  open: 0,
  networks: 2,
  lastAt: hoursAgo(80),
  perDay: perDay(2, 0, 0, 0),
};
const FACTCHECK_GROUP: ReportGroup = {
  key: FACTCHECK_KEY,
  platform: null,
  adapter: null,
  kind: 'correction',
  topic: 'factcheck',
  total: 3,
  open: 2,
  networks: 2,
  lastAt: hoursAgo(80),
  perDay: perDay(1, 0, 0, 0),
};
const PERSPECTIVES_GROUP: ReportGroup = {
  key: PERSPECTIVES_KEY,
  platform: null,
  adapter: null,
  kind: 'correction',
  topic: 'perspectives',
  total: 1,
  open: 0,
  networks: 1,
  lastAt: hoursAgo(200),
  perDay: perDay(),
};

/** 30 days ending today: three days with reports. */
function lastDays(): ReportDay[] {
  const days: ReportDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, linkedin: 0, facebook: 0, other: 0 });
  }
  Object.assign(days[29] as ReportDay, { linkedin: 4 });
  Object.assign(days[28] as ReportDay, { linkedin: 3, other: 1 });
  Object.assign(days[26] as ReportDay, { facebook: 2, other: 1 });
  return days;
}

/** The server's summary: open groups first, then the latest; LinkedIn has a floor. */
const SUMMARY: AdminReportsSummary = {
  enabled: true,
  today: 12,
  dailyMax: 1000,
  unlisted7d: 3,
  days: lastDays(),
  groups: [LI_GROUP, OTHER_GROUP, FACTCHECK_GROUP, FB_GROUP, PERSPECTIVES_GROUP],
  floors: [{ platform: 'linkedin', adapter: 'linkedin@2026.10.1', setAt: '2026-10-12T09:00:00.000Z' }],
};

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function row(n: number, change: Partial<AdminReportRow> = {}): AdminReportRow {
  return {
    id: id(n),
    ref: `7KQ3-M2P${'ABCDEFGHJK'[n % 10]}`,
    receivedAt: hoursAgo(2 + n),
    kind: 'detection',
    from: 'notice',
    channel: 'chrome-store',
    listed: true,
    extension: '0.4.1',
    browser: 'chrome',
    browserMajor: 141,
    platform: 'linkedin',
    adapter: 'linkedin@2026.10.2',
    topic: 'feed-not-started',
    choices: [],
    firstFromNetwork: true,
    handledAt: null,
    resolution: null,
    hasMessage: false,
    hasContact: false,
    ...change,
  };
}

/** A correction row of the Fact-check group. */
function correctionRow(n: number, receivedAt: string, hasContact: boolean): AdminReportRow {
  return row(n, {
    receivedAt,
    kind: 'correction',
    from: 'sidepanel',
    platform: null,
    adapter: null,
    topic: 'factcheck',
    choices: ['verdict-wrong'],
    hasMessage: true,
    hasContact,
  });
}

const LI_ROWS = [row(1, { choices: ['ads-showing'] }), row(2, { listed: false, channel: 'edge-store', browser: 'edge' })];
/** Friday the 9th (6 business days by Monday the 19th: late) and Friday the 16th (1). */
const CORRECTIONS = [correctionRow(11, '2026-10-16T09:00:00.000Z', false), correctionRow(12, '2026-10-09T10:00:00.000Z', true)];

/** The Fact-check correction from Friday the 9th, in full: its words hold a right-to-left override. */
const CORRECTION: ReportDetail = {
  ...(CORRECTIONS[1] as AdminReportRow),
  details: { correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud' } },
  unknownCodes: 0,
  message: 'The claim was about 2025\u202E, not 2024.\nThe source says so.',
  contact: 'ana+news@example.com',
  lines: [
    'unAlgorithm 0.4.1 from the Chrome Web Store',
    'Chrome 141',
    'Reported from the side panel',
    'About: a Fact-check result (prompt version 3), made with unAlgorithm Cloud',
    'Your answer: The verdict is wrong',
  ],
  handledBy: null,
};

/** The first LinkedIn report in full. */
const DETECTION: ReportDetail = {
  ...(LI_ROWS[0] as AdminReportRow),
  details: {
    page: {
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.2',
      route: 'feed-candidate',
      feedWord: 'foryou',
      lang: 'en',
      preset: 'balanced',
      ai: 'off',
      paused: false,
    },
    health: { status: 'broken', issues: ['feed-not-started'], degraded: [] },
    detection: { counts: { items: 0 } },
  },
  unknownCodes: 2,
  message: null,
  contact: null,
  lines: [
    'unAlgorithm 0.4.1 from the Chrome Web Store · LinkedIn detection 2026.10.2',
    'Chrome 141',
    "unAlgorithm noticed: LinkedIn's feed is on a page unAlgorithm doesn't recognise",
  ],
  handledBy: null,
};

const summaryPath = (dev: boolean) => `${ADMIN_REPORTS_SUMMARY_PATH}?days=30&dev=${dev ? 1 : 0}`;
const listPath = (query: Record<string, string>) => `${ADMIN_REPORTS_PATH}?${new URLSearchParams(query)}`;
const ok: Answer = { status: 200, body: { ok: true } };

/**
 * Opens the page as TOM, an admin (unless `role` says otherwise). The report routes answer `summary` (and `devSummary`
 * with development builds), each group's open rows, and the reports in `details` (404 for any other id); `pages` adds
 * list answers by exact address. Handling, forgetting and deleting change the next answers; `routes` replaces any.
 */
function openReports({
  summary = SUMMARY,
  devSummary = summary,
  details = [CORRECTION, DETECTION],
  pages = {},
  role = 'admin',
  session = TOM,
  routes = {},
}: {
  summary?: AdminReportsSummary;
  devSummary?: AdminReportsSummary;
  details?: ReportDetail[];
  pages?: Record<string, unknown>;
  role?: string | null;
  session?: string | null;
  routes?: Record<string, Reply>;
} = {}) {
  let stored = structuredClone(details);
  const admin =
    (answer: (call: Call) => Answer): Reply =>
    (call) =>
      role === 'admin' ? answer(call) : NOT_ADMIN;
  const byId = (call: Call) => (call.body as { id: string }).id;
  const reportRoutes: Record<string, Reply> = {
    [`GET ${summaryPath(false)}`]: admin(() => ({ status: 200, body: summary })),
    [`GET ${summaryPath(true)}`]: admin(() => ({ status: 200, body: devSummary })),
    [`GET ${listPath({ group: LI_KEY, status: 'open' })}`]: admin(() => ({
      status: 200,
      body: { rows: LI_ROWS, nextBefore: null },
    })),
    [`GET ${listPath({ group: FACTCHECK_KEY, status: 'open' })}`]: admin(() => ({
      status: 200,
      body: { rows: CORRECTIONS, nextBefore: null },
    })),
    ...Object.fromEntries(Object.entries(pages).map(([path, body]) => [`GET ${path}`, admin(() => ({ status: 200, body }))])),
    [`POST ${ADMIN_REPORTS_HANDLE_PATH}`]: admin((call) => {
      const req = HandleReportsRequestSchema.parse(call.body);
      stored = stored.map((r) =>
        req.ids?.includes(r.id)
          ? {
              ...r,
              handledAt: req.handled ? NOW.toISOString() : null,
              resolution: req.resolution ?? null,
              handledBy: req.handled ? { id: 'u1', email: TOM } : null,
            }
          : r,
      );
      return ok;
    }),
    [`POST ${ADMIN_REPORTS_FLOOR_PATH}`]: admin(() => ok),
    [`POST ${ADMIN_REPORTS_FORGET_CONTACT_PATH}`]: admin((call) => {
      if (!stored.some((r) => r.id === byId(call))) return { status: 404, body: { code: 'not-found', message: 'Not found.' } };
      stored = stored.map((r) => (r.id === byId(call) ? { ...r, contact: null, hasContact: false } : r));
      return ok;
    }),
    [`POST ${ADMIN_REPORTS_DELETE_PATH}`]: admin((call) => {
      const ids = (call.body as { ids: string[] }).ids;
      stored = stored.filter((r) => !ids.includes(r.id));
      return ok;
    }),
  };
  for (const n of [1, 2, 11, 12, 99]) {
    reportRoutes[`GET ${adminReportPath(id(n))}`] = admin(() => {
      const found = stored.find((r) => r.id === id(n));
      return found ? { status: 200, body: found } : { status: 404, body: { code: 'not-found', message: 'Not found.' } };
    });
  }
  const server = fakeServer({ session, role, info: INFO, routes: { ...reportRoutes, ...routes } });
  const user = setupUser();
  render(<AdminReports />);
  return { server, user };
}

/** The requests the page made to the report routes, in order, with their exact addresses. */
function reportCalls(server: ReturnType<typeof fakeServer>, method?: string) {
  return server.calls.filter((c) => c.path.startsWith(ADMIN_REPORTS_PATH) && (method === undefined || c.method === method));
}

/** The groups list's items, as their title and counts. */
function groupLines(): string[][] {
  const list = screen.getByRole('list', { name: 'Groups' });
  return within(list)
    .getAllByRole('listitem')
    .map((li) => [...li.querySelectorAll('.web-group-title, .web-group-stats')].map((p) => p.textContent ?? ''));
}

/** A stat tile's figure and its line of context, by its label. */
function stat(label: string): [string, string] {
  const tile = screen.getByText(label, { selector: '.web-stat-label' }).closest('.web-stat') as HTMLElement;
  return [tile.querySelector('.web-stat-value')?.textContent ?? '', tile.querySelector('.web-stat-detail')?.textContent ?? ''];
}

/** A report's fact, by its label. */
function fact(label: string): string {
  const term = screen.getByText(label, { selector: 'dl.web-facts dt' });
  return term.parentElement?.querySelector('dd')?.textContent ?? '';
}

/** A group's item, by its title. */
function groupItem(title: string): HTMLElement {
  const item = screen.getByText(title).closest('li');
  if (!item) throw new Error(`No group ${title}.`);
  return item;
}

/** A group's item, once the summary has loaded. */
async function findGroup(title: string): Promise<HTMLElement> {
  await screen.findByText(title);
  return groupItem(title);
}

/** A button by its name, once no change is in flight (the page disables its buttons while one is). */
async function enabledButton(scope: HTMLElement, name: string): Promise<HTMLButtonElement> {
  const button = () => within(scope).getByRole('button', { name }) as HTMLButtonElement;
  await waitFor(() => expect(button().disabled).toBe(false));
  return button();
}

/** The row (`.ua-row`) whose text holds `text`. */
function rowWith(text: string): HTMLElement {
  const found = screen
    .getAllByText((_, el) => el?.classList.contains('ua-row') === true && (el.textContent ?? '').includes(text))
    .at(0);
  if (!found) throw new Error(`No row with ${text}.`);
  return found;
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('lines', () => {
  it('test_group_line_reads_as_the_adr_says', () => {
    const line = `${groupTitle(LI_GROUP)} · ${groupStats(LI_GROUP, NOW.getTime())}`;
    expect(line).toBe(
      'LinkedIn · detection 2026.10.2 · Filtering looks broken: feed-not-started · 7 reports from 5 networks · last 2 h ago · 7 open',
    );
    expect(groupTitle(OTHER_GROUP)).toBe('Something else: credits');
    expect(groupTitle(FB_GROUP)).toBe('Facebook · detection 2026.10.1 · Wrong call: sponsored');
    expect(groupTitle({ ...FACTCHECK_GROUP, topic: null })).toBe('Correction');
    expect(groupStats({ ...OTHER_GROUP, networks: 0 }, NOW.getTime())).toBe('1 report · last 30 h ago · 1 open');
    expect(groupStats({ ...FB_GROUP, networks: 1 }, NOW.getTime())).toBe(
      '2 reports from 1 network · last 3 days ago · all handled',
    );
  });

  it('test_ago_from_hour_times', () => {
    const now = NOW.getTime();
    expect(ago(hoursAgo(0), now)).toBe('within the hour');
    expect(ago(hoursAgo(1), now)).toBe('1 h ago');
    expect(ago(hoursAgo(47), now)).toBe('47 h ago');
    expect(ago(hoursAgo(48), now)).toBe('2 days ago');
    // A time ahead of the clock is never "-1 h ago".
    expect(ago(new Date(now + 2 * HOUR).toISOString(), now)).toBe('within the hour');
  });

  it('test_business_days_waiting', () => {
    const now = NOW.getTime();
    expect(businessDaysWaiting('2026-10-19T09:00:00.000Z', now)).toBe(0);
    expect(businessDaysWaiting('2026-10-16T23:00:00.000Z', now)).toBe(1);
    expect(businessDaysWaiting('2026-10-17T09:00:00.000Z', now)).toBe(1);
    expect(businessDaysWaiting('2026-10-12T09:00:00.000Z', now)).toBe(5);
    expect(businessDaysWaiting('2026-10-09T10:00:00.000Z', now)).toBe(6);
    expect(waitingLine(0)).toBe('Waiting 0 of 5 business days');
    expect(waitingLine(5)).toBe('Waiting 5 of 5 business days');
    expect(waitingLine(7)).toBe('Waiting 7 business days, 2 more than the 5 promised');
  });

  it('test_row_line_and_reply_link', () => {
    expect(rowLine(LI_ROWS[0] as AdminReportRow)).toBe(
      'unAlgorithm 0.4.1 from the Chrome Web Store · Chrome 141 · Ads are still showing',
    );
    expect(rowLine(row(3, { channel: 'other', browser: 'firefox', browserMajor: 140, choices: ['other', 'new-code'] }))).toBe(
      'unAlgorithm 0.4.1 · Firefox 140 · Something else; new-code',
    );
    // Each part URL-encoded around a literal "@", and the reference in the subject.
    expect(replyLink('ana+news@example.com', '7KQ3-M2PA')).toBe(
      'mailto:ana%2Bnews@example.com?subject=Your%20unAlgorithm%20correction%207KQ3-M2PA',
    );
  });
});

describe('access', () => {
  it('test_admin_reports_signed_out_and_not_admin', async () => {
    let { server } = openReports({ session: null });
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    // The sign-in's heading is the server's name; the tab still names the page.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(INFO.name);
    expect(document.title).toBe(`Problem reports · ${INFO.name}`);
    expect(reportCalls(server)).toEqual([]);
    cleanup();

    ({ server } = openReports({ role: 'user' }));
    expect(await screen.findByText(NOT_ADMIN_TEXT)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Groups' })).toBeNull();
    expect(reportCalls(server).map((c) => c.path)).toEqual([summaryPath(false)]);
  });

  it('test_admin_reports_off', async () => {
    // Never on: the line, and nothing else to show.
    openReports({ summary: { ...SUMMARY, enabled: false, today: 0, unlisted7d: 0, groups: [], floors: [] } });
    expect(await screen.findByText(OFF)).toBeTruthy();
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Groups' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();

    // Turned off with reports kept from before: they can still be read and handled until they are purged.
    openReports({ summary: { ...SUMMARY, enabled: false } });
    expect(await screen.findByText(OFF)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Groups' })).toBeTruthy();
    expect(screen.getByText(groupTitle(LI_GROUP))).toBeTruthy();
  });
});

describe('summary', () => {
  it('test_admin_reports_groups', async () => {
    const { server } = openReports();
    expect(await screen.findByText(groupTitle(LI_GROUP))).toBeTruthy();
    expect(screen.getByText(INTRO)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Problem reports');
    expect(document.title).toBe(`Problem reports · ${INFO.name}`);
    expect(document.querySelector('.web-page')?.className).toContain('web-page-wide');
    expect(screen.getByRole('link', { name: 'Problem reports' }).getAttribute('aria-current')).toBe('page');
    // The open reports, today's against the daily cap, and the unlisted extension ids as tiles.
    expect(stat('Open')).toEqual(['10', 'in 3 groups']);
    expect(stat('Reports today')).toEqual(['12', 'of at most 1,000 a day']);
    expect(stat('From unlisted extension ids')).toEqual(['3', 'in the last 7 days']);

    // Open groups first, as the server sends them; corrections have their own list.
    expect(groupLines()).toEqual([
      [groupTitle(LI_GROUP), '7 reports from 5 networks · last 2 h ago · 7 open'],
      ['Something else: credits', '1 report from 1 network · last 30 h ago · 1 open'],
      ['Facebook · detection 2026.10.1 · Wrong call: sponsored', '2 reports from 2 networks · last 3 days ago · all handled'],
    ]);
    const li = groupItem(groupTitle(LI_GROUP));
    expect(within(li).getByRole('img').getAttribute('aria-label')).toBe(
      'Last 14 days, oldest first: 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4',
    );
    // A detection group's resolutions; an all-handled group has nothing to mark.
    const resolutions = within(li).getByLabelText(`Resolution for ${groupTitle(LI_GROUP)}`) as HTMLSelectElement;
    expect([...resolutions.options].map((o) => o.textContent)).toEqual([
      'Fixed',
      'Duplicate',
      "Can't reproduce",
      'Not a bug',
      'Older version',
      'Spam',
    ]);
    const fb = groupItem(groupTitle(FB_GROUP));
    expect(within(fb).queryByRole('button', { name: /^Mark handled/ })).toBeNull();
    expect(within(fb).getByRole('button', { name: `View ${groupTitle(FB_GROUP)}` })).toBeTruthy();

    // The summary, then the open corrections' list; nothing else.
    expect(reportCalls(server).map((c) => c.path)).toEqual([
      summaryPath(false),
      listPath({ group: FACTCHECK_KEY, status: 'open' }),
    ]);
  });

  it('test_admin_reports_corrections_against_the_promise', async () => {
    openReports();
    const corrections = await screen.findByRole('region', { name: 'Corrections' });
    expect(
      within(corrections).getByText('We answer corrections within 5 business days. The longest waiting come first.'),
    ).toBeTruthy();
    // The longest waiting first.
    const late = await within(corrections).findByText(/^7KQ3-M2PC · Fact-check/);
    const rows = [...corrections.querySelectorAll('.ua-row')].map((r) => r.textContent ?? '');
    expect(rows).toEqual([
      '7KQ3-M2PC · Fact-check Late' +
        'Received Oct 9, 2026 · Waiting 6 business days, 1 more than the 5 promised · Wants a reply' +
        'View',
      '7KQ3-M2PB · Fact-check Received Oct 16, 2026 · Waiting 1 of 5 business days · No reply emailView',
    ]);
    expect(late.closest('.ua-row')?.querySelector('.ua-badge--danger')?.textContent).toBe('Late');
    expect(within(corrections).getByRole('button', { name: 'All Fact-check corrections' })).toBeTruthy();
    expect(within(corrections).getByRole('button', { name: 'All UnEcho Chamber corrections' })).toBeTruthy();
  });

  it('test_admin_reports_corrections_read_every_page', async () => {
    // More than 50 open: the list reads on, so the longest waiting are never left out.
    const next = '2026-10-16T09:00:00.001Z';
    const { server } = openReports({
      routes: {
        [`GET ${listPath({ group: FACTCHECK_KEY, status: 'open' })}`]: {
          status: 200,
          body: { rows: [CORRECTIONS[0]], nextBefore: next },
        },
      },
      pages: { [listPath({ group: FACTCHECK_KEY, status: 'open', before: next })]: { rows: [CORRECTIONS[1]], nextBefore: null } },
    });
    expect(await screen.findByText(/^7KQ3-M2PC · Fact-check/)).toBeTruthy();
    expect(reportCalls(server, 'GET').map((c) => c.path)).toEqual([
      summaryPath(false),
      listPath({ group: FACTCHECK_KEY, status: 'open' }),
      listPath({ group: FACTCHECK_KEY, status: 'open', before: next }),
    ]);
  });

  it('test_admin_reports_no_corrections_waiting', async () => {
    const quiet = { ...SUMMARY, groups: SUMMARY.groups.map((g) => (g.kind === 'correction' ? { ...g, open: 0 } : g)) };
    const { server } = openReports({ summary: quiet });
    expect(await screen.findByText('No corrections are waiting.')).toBeTruthy();
    expect(reportCalls(server).map((c) => c.path)).toEqual([summaryPath(false)]);
  });

  it('test_admin_reports_last_30_days', async () => {
    openReports();
    const days = await screen.findByRole('region', { name: 'Last 30 days' });
    const table = within(days).getByRole('table', { name: 'Reports a day (UTC)' });
    expect(table.closest('details')?.querySelector('summary')?.textContent).toBe('Show as a table');
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th, td')].map((c) => c.textContent),
    );
    expect(rows).toHaveLength(30);
    // Newest first.
    expect(rows.slice(0, 4)).toEqual([
      ['Oct 19', '4', '0', '0'],
      ['Oct 18', '3', '0', '1'],
      ['Oct 17', '0', '0', '0'],
      ['Oct 16', '0', '2', '1'],
    ]);
    expect(rows.at(-1)).toEqual(['Sep 20', '0', '0', '0']);
    // The bars are for the eye: hidden from screen readers, each as wide as its count against the busiest day (4).
    const bars = days.querySelector('.web-bars') as HTMLElement;
    expect(bars.getAttribute('aria-hidden')).toBe('true');
    const first = bars.querySelectorAll('.web-bar-row')[0] as HTMLElement;
    expect(first.textContent).toBe('Oct 194');
    expect((first.querySelector('.web-bar--linkedin') as HTMLElement).style.width).toBe('100%');
    const second = bars.querySelectorAll('.web-bar-row')[1] as HTMLElement;
    expect((second.querySelector('.web-bar--linkedin') as HTMLElement).style.width).toBe('75%');
    expect((second.querySelector('.web-bar--other') as HTMLElement).style.width).toBe('25%');
    expect(second.querySelector('.web-bar--facebook')).toBeNull();
  });

  it('test_admin_reports_development_builds', async () => {
    const devSummary = { ...SUMMARY, today: 20, groups: [{ ...OTHER_GROUP, key: '||other|ai', topic: 'ai' }] };
    const { server, user } = openReports({ devSummary });
    const toggle = await screen.findByRole('switch', { name: 'Show development builds' });
    // In the groups' section, beside its heading.
    expect(toggle.closest('.web-section-actions')?.closest('section')).toBe(screen.getByRole('region', { name: 'Groups' }));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(await screen.findByText('Something else: ai')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Show development builds' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(groupTitle(LI_GROUP))).toBeNull();
    expect(stat('Reports today')).toEqual(['20', 'of at most 1,000 a day']);
    expect(reportCalls(server, 'GET').map((c) => c.path)).toContain(summaryPath(true));

    // And back.
    await user.click(screen.getByRole('switch', { name: 'Show development builds' }));
    expect(await screen.findByText(groupTitle(LI_GROUP))).toBeTruthy();
    expect(reportCalls(server, 'GET').filter((c) => c.path === summaryPath(false))).toHaveLength(2);
  });

  it('test_admin_reports_fixed_in', async () => {
    const { server, user } = openReports();
    const fixedIn = await screen.findByRole('region', { name: 'Fixed in' });
    const linkedin = rowWith('Fixed in 2026.10.1 since Oct 12, 2026');
    // The versions seen, newest first, the floor's own among them.
    const versions = within(linkedin).getByLabelText('LinkedIn detection version') as HTMLSelectElement;
    expect([...versions.options].map((o) => o.textContent)).toEqual(['2026.10.2', '2026.10.1']);
    expect(versions.value).toBe('linkedin@2026.10.2');
    const facebook = rowWith('Not set');
    expect(within(fixedIn).getByText(/older detection versions count as handled/)).toBeTruthy();
    expect(within(facebook).queryByRole('button', { name: 'Clear Facebook fixed-in version' })).toBeNull();

    await user.click(await enabledButton(fixedIn, 'Set LinkedIn fixed-in version'));
    await user.click(await enabledButton(fixedIn, 'Clear LinkedIn fixed-in version'));
    await user.selectOptions(within(facebook).getByLabelText('Facebook detection version'), 'facebook@2026.10.1');
    await user.click(await enabledButton(fixedIn, 'Set Facebook fixed-in version'));
    await waitFor(() => expect(reportCalls(server, 'POST')).toHaveLength(3));
    expect(reportCalls(server, 'POST')).toEqual([
      { method: 'POST', path: ADMIN_REPORTS_FLOOR_PATH, body: { platform: 'linkedin', adapter: 'linkedin@2026.10.2' } },
      { method: 'POST', path: ADMIN_REPORTS_FLOOR_PATH, body: { platform: 'linkedin', adapter: null } },
      { method: 'POST', path: ADMIN_REPORTS_FLOOR_PATH, body: { platform: 'facebook', adapter: 'facebook@2026.10.1' } },
    ]);
    // Each change loads the summary again.
    await waitFor(() => expect(reportCalls(server, 'GET').filter((c) => c.path === summaryPath(false))).toHaveLength(4));
  });

  it('test_admin_reports_mark_group_handled', async () => {
    const handled = { ...SUMMARY, groups: SUMMARY.groups.map((g) => (g.key === LI_KEY ? { ...g, open: 0 } : g)) };
    let summaries = 0;
    const { server, user } = openReports({
      routes: { [`GET ${summaryPath(false)}`]: () => ({ status: 200, body: ++summaries === 1 ? SUMMARY : handled }) },
    });
    const li = await findGroup(groupTitle(LI_GROUP));
    await user.selectOptions(within(li).getByLabelText(`Resolution for ${groupTitle(LI_GROUP)}`), 'not-a-bug');
    await user.click(within(li).getByRole('button', { name: `Mark handled: ${groupTitle(LI_GROUP)}` }));

    await waitFor(() => expect(screen.getByText('7 reports from 5 networks · last 2 h ago · all handled')).toBeTruthy());
    expect(reportCalls(server, 'POST')).toEqual([
      { method: 'POST', path: ADMIN_REPORTS_HANDLE_PATH, body: { group: LI_KEY, handled: true, resolution: 'not-a-bug' } },
    ]);
    expect(within(groupItem(groupTitle(LI_GROUP))).queryByRole('button', { name: /^Mark handled/ })).toBeNull();
  });

  it('test_admin_reports_actions_send_the_own_page_request', async () => {
    // Every change is a same-origin JSON POST, as the other admin pages' are: the browser adds the page's Origin and
    // session cookie, which the server's ownPageOnly and session checks read.
    const { server, user } = openReports();
    const li = await findGroup(groupTitle(LI_GROUP));
    await user.click(within(li).getByRole('button', { name: `Mark handled: ${groupTitle(LI_GROUP)}` }));
    await waitFor(() => expect(reportCalls(server, 'POST')).toHaveLength(1));
    const [input, init] = server.fetch.mock.calls.find(([path]) => String(path) === ADMIN_REPORTS_HANDLE_PATH) ?? [];
    expect(input).toBe(ADMIN_REPORTS_HANDLE_PATH);
    expect(init).toEqual({
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: LI_KEY, handled: true, resolution: 'fixed' }),
    });
  });

  it('test_admin_reports_failures', async () => {
    // A change refused: said above the page, which stays.
    let { user } = openReports({
      routes: { [`POST ${ADMIN_REPORTS_HANDLE_PATH}`]: { status: 500, body: { code: 'internal', message: 'Oops.' } } },
    });
    let li = await findGroup(groupTitle(LI_GROUP));
    await user.click(within(li).getByRole('button', { name: `Mark handled: ${groupTitle(LI_GROUP)}` }));
    expect((await screen.findByRole('alert')).textContent).toContain('Something went wrong. Try again.');
    expect(screen.getByText(groupTitle(LI_GROUP))).toBeTruthy();
    cleanup();

    // The session gone: back to the sign-in, saying so.
    ({ user } = openReports({ routes: { [`POST ${ADMIN_REPORTS_HANDLE_PATH}`]: SESSION_GONE } }));
    li = await findGroup(groupTitle(LI_GROUP));
    await user.click(within(li).getByRole('button', { name: `Mark handled: ${groupTitle(LI_GROUP)}` }));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT)).toBeTruthy();
    cleanup();

    // The corrections' list unreachable: said in its section, with "Try again"; the rest of the page works.
    let tries = 0;
    ({ user } = openReports({
      routes: {
        [`GET ${listPath({ group: FACTCHECK_KEY, status: 'open' })}`]: () =>
          ++tries === 1
            ? { status: 500, body: { code: 'internal', message: 'Oops.' } }
            : { status: 200, body: { rows: CORRECTIONS, nextBefore: null } },
      },
    }));
    const corrections = await screen.findByRole('region', { name: 'Corrections' });
    expect(await within(corrections).findByText(LOAD_FAILED)).toBeTruthy();
    expect(screen.getByText(groupTitle(LI_GROUP))).toBeTruthy();
    await user.click(within(corrections).getByRole('button', { name: 'Try again' }));
    expect(await within(corrections).findByText(/^7KQ3-M2PC/)).toBeTruthy();
  });
});

describe('group', () => {
  it('test_admin_reports_group_view_and_paging', async () => {
    const next = hoursAgo(3).replace('.000Z', '.001Z');
    const older = [row(5, { receivedAt: hoursAgo(9), handledAt: hoursAgo(1), resolution: 'duplicate' })];
    const { server, user } = openReports({
      routes: {
        [`GET ${listPath({ group: LI_KEY, status: 'open' })}`]: { status: 200, body: { rows: LI_ROWS, nextBefore: next } },
      },
      pages: {
        [listPath({ group: LI_KEY, status: 'open', before: next })]: { rows: older, nextBefore: null },
        [listPath({ group: LI_KEY, status: 'handled' })]: { rows: older, nextBefore: null },
      },
    });
    await user.click(await screen.findByRole('button', { name: `View ${groupTitle(LI_GROUP)}` }));

    const heading = await screen.findByRole('heading', { name: groupTitle(LI_GROUP), level: 2 });
    // The view's heading takes the focus, so a screen reader starts there.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.getByText('7 reports from 5 networks · last 2 h ago · 7 open')).toBeTruthy();
    const first = await screen.findByText(/^7KQ3-M2PB · Oct 19, 2026, 12:00 UTC/);
    expect(first.closest('.ua-row')?.textContent).toContain(
      'unAlgorithm 0.4.1 from the Chrome Web Store · Chrome 141 · Ads are still showing · Open',
    );
    // An unlisted extension id is marked.
    const unlisted = screen.getByText(/^7KQ3-M2PC · Oct 19, 2026, 11:00 UTC/).closest('.ua-row') as HTMLElement;
    expect(within(unlisted).getByText('Unlisted id')).toBeTruthy();
    expect(unlisted.textContent).toContain('from Microsoft Edge Add-ons · Edge 141');

    // "Older" passes the cursor back exactly as it came; "Newer" returns.
    expect((screen.getByRole('button', { name: 'Newer' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText(/^7KQ3-M2PF/)).toBeTruthy();
    expect(screen.getByText(/Handled Oct 19, 2026: Duplicate$/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Older' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findByText(/^7KQ3-M2PB/)).toBeTruthy();

    // Handled reports only. The view stays, and so does the focus on the status picked.
    await user.click(screen.getByRole('radio', { name: 'Handled' }));
    expect(await screen.findByText(/^7KQ3-M2PF/)).toBeTruthy();
    expect(screen.queryByText(/^7KQ3-M2PB/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Handled' }));

    expect(reportCalls(server, 'GET').map((c) => c.path)).toEqual([
      summaryPath(false),
      listPath({ group: FACTCHECK_KEY, status: 'open' }),
      listPath({ group: LI_KEY, status: 'open' }),
      listPath({ group: LI_KEY, status: 'open', before: next }),
      listPath({ group: LI_KEY, status: 'open' }),
      listPath({ group: LI_KEY, status: 'handled' }),
    ]);

    // Back to the summary, which loads again; the groups' heading takes the focus.
    await user.click(screen.getByRole('button', { name: 'All reports' }));
    const groups = await screen.findByRole('heading', { name: 'Groups' });
    await waitFor(() => expect(document.activeElement).toBe(groups));
    expect(reportCalls(server, 'GET').filter((c) => c.path === summaryPath(false))).toHaveLength(2);
  });

  it('test_admin_reports_group_view_marks_handled', async () => {
    let listed = 0;
    const { server, user } = openReports({
      routes: {
        [`GET ${listPath({ group: LI_KEY, status: 'open' })}`]: () => ({
          status: 200,
          body: { rows: ++listed === 1 ? LI_ROWS : [], nextBefore: null },
        }),
      },
    });
    await user.click(await screen.findByRole('button', { name: `View ${groupTitle(LI_GROUP)}` }));
    expect(await screen.findByText(/^7KQ3-M2PB/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(`Resolution for ${groupTitle(LI_GROUP)}`), 'fixed');
    await user.click(screen.getByRole('button', { name: `Mark handled: ${groupTitle(LI_GROUP)}` }));
    expect(await screen.findByText('No open reports.')).toBeTruthy();
    expect(reportCalls(server, 'POST')).toEqual([
      { method: 'POST', path: ADMIN_REPORTS_HANDLE_PATH, body: { group: LI_KEY, handled: true, resolution: 'fixed' } },
    ]);
  });
});

describe('report', () => {
  /** Opens the late correction from the corrections list. */
  async function openCorrection(user: ReturnType<typeof setupUser>) {
    await user.click(await screen.findByRole('button', { name: 'View 7KQ3-M2PC' }));
    return screen.findByRole('heading', { name: 'Report 7KQ3-M2PC' });
  }

  it('test_admin_reports_detail', async () => {
    const { server, user } = openReports();
    const heading = await openCorrection(user);
    await waitFor(() => expect(document.activeElement).toBe(heading));
    // The handled line under the heading, and the facts.
    expect(heading.nextElementSibling?.textContent).toBe('Open');
    expect(fact('Received')).toBe('Oct 9, 2026, 10:00 UTC');
    expect(fact('About')).toBe('Correction: factcheck');
    expect(fact('Status')).toBe('Open');
    expect(fact('Extension id')).toBe('Listed on this server');
    // "Back" names where it goes.
    expect(screen.getByRole('button', { name: 'All reports' })).toBeTruthy();

    // describeReport's lines, as the server made them.
    const lines = within(screen.getByText('What was sent').parentElement as HTMLElement)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toEqual(CORRECTION.lines);

    // The stored details as JSON text in a <pre>, under "As stored".
    const pre = document.querySelector('pre.web-json') as HTMLElement;
    expect(pre.closest('details')?.querySelector('summary')?.textContent).toBe('As stored');
    expect(pre.textContent).toBe(JSON.stringify(CORRECTION.details, null, 2));
    expect(pre.children).toHaveLength(0);

    // The reply address as a mailto: link, built from the validated address.
    const link = screen.getByRole('link', { name: 'ana+news@example.com' });
    expect(link.getAttribute('href')).toBe(replyLink('ana+news@example.com', '7KQ3-M2PC'));
    expect(within(link.closest('.ua-row') as HTMLElement).getByRole('button', { name: 'Forget email' })).toBeTruthy();
    expect(reportCalls(server, 'GET').at(-1)?.path).toBe(adminReportPath(id(12)));
  });

  it('test_admin_reports_message_bidi_stripped', async () => {
    const { user } = openReports();
    await openCorrection(user);
    expect(CORRECTION.message).toContain('\u202E');
    const words = screen.getByText('In their own words').parentElement?.querySelector('.web-message') as HTMLElement;
    // The right-to-left override is gone; the line break is kept.
    expect(words.textContent).toBe('The claim was about 2025, not 2024.\nThe source says so.');
    expect(words.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/);
  });

  it('test_admin_reports_message_is_text', async () => {
    const markup = '<img src=x onerror="alert(1)"> and <b>bold</b>';
    const { user } = openReports({ details: [{ ...CORRECTION, message: markup }, DETECTION] });
    await openCorrection(user);
    const words = screen.getByText('In their own words').parentElement?.querySelector('.web-message') as HTMLElement;
    expect(words.textContent).toBe(markup);
    expect(words.children).toHaveLength(0);
    expect(document.querySelector('img')).toBeNull();
    // And the page never sets HTML from a string.
    const source = readFileSync(resolve(import.meta.dirname, '../src/AdminReports.tsx'), 'utf8');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toContain('innerHTML');
  });

  it('test_admin_reports_contact_not_an_email', async () => {
    const { user } = openReports({ details: [{ ...CORRECTION, contact: 'javascript:alert(1)//' }, DETECTION] });
    await openCorrection(user);
    expect(await screen.findByText('Not an email address: javascript:alert(1)//')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /alert/ })).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Forget email' })).toBeTruthy();
  });

  it('test_admin_reports_forget_email', async () => {
    const { server, user } = openReports();
    await openCorrection(user);
    await user.click(screen.getByRole('button', { name: 'Forget email' }));
    expect(await screen.findByText('No reply email.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'ana+news@example.com' })).toBeNull();
    expect(reportCalls(server, 'POST')).toEqual([
      { method: 'POST', path: ADMIN_REPORTS_FORGET_CONTACT_PATH, body: { id: id(12) } },
    ]);
    // The report is read again after the change.
    expect(reportCalls(server, 'GET').filter((c) => c.path === adminReportPath(id(12)))).toHaveLength(2);
  });

  it('test_admin_reports_handle_and_reopen', async () => {
    const { server, user } = openReports();
    await openCorrection(user);
    // A correction's resolutions.
    const resolutions = screen.getByLabelText('Resolution for report 7KQ3-M2PC') as HTMLSelectElement;
    expect([...resolutions.options].map((o) => o.textContent)).toEqual([
      'Corrected',
      'No change',
      'Out of scope',
      'Duplicate',
      'Spam',
    ]);
    await user.selectOptions(resolutions, 'no-change');
    await user.click(screen.getByRole('button', { name: 'Mark handled: report 7KQ3-M2PC' }));
    const handled = `Handled Oct 19, 2026, 15:30 UTC by ${TOM}: No change`;
    await waitFor(() => expect(fact('Status')).toBe(handled));
    expect(screen.getByRole('heading', { name: 'Report 7KQ3-M2PC' }).nextElementSibling?.textContent).toBe(handled);

    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    await waitFor(() => expect(fact('Status')).toBe('Open'));
    expect(reportCalls(server, 'POST')).toEqual([
      { method: 'POST', path: ADMIN_REPORTS_HANDLE_PATH, body: { ids: [id(12)], handled: true, resolution: 'no-change' } },
      { method: 'POST', path: ADMIN_REPORTS_HANDLE_PATH, body: { ids: [id(12)], handled: false } },
    ]);
  });

  it('test_admin_reports_delete_after_confirming', async () => {
    const { server, user } = openReports();
    await openCorrection(user);
    // Cancel sends nothing.
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    let dialog = screen.getByRole('alertdialog', { name: 'Delete report 7KQ3-M2PC?' });
    expect(within(dialog).getByText(/deleted for good/)).toBeTruthy();
    expect(within(dialog).getByText(/up to 14 more nights/)).toBeTruthy();
    // The destructive button never has the focus first.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await settle();
    expect(reportCalls(server, 'POST')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    dialog = screen.getByRole('alertdialog', { name: 'Delete report 7KQ3-M2PC?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    // Back to the summary.
    expect(await screen.findByRole('heading', { name: 'Groups' })).toBeTruthy();
    expect(reportCalls(server, 'POST')).toEqual([{ method: 'POST', path: ADMIN_REPORTS_DELETE_PATH, body: { ids: [id(12)] } }]);
  });

  it('test_admin_reports_detail_facts', async () => {
    const { user } = openReports({ pages: {} });
    await user.click(await screen.findByRole('button', { name: `View ${groupTitle(LI_GROUP)}` }));
    await user.click(await screen.findByRole('button', { name: 'View 7KQ3-M2PB' }));
    expect(await screen.findByRole('heading', { name: 'Report 7KQ3-M2PB' })).toBeTruthy();
    expect(fact('About')).toBe(groupTitle(LI_GROUP));
    expect(fact('Codes left out')).toBe("2 codes this server doesn't know yet");
    // Not a correction and no address: no reply section, no words.
    expect(screen.queryByText('Reply to')).toBeNull();
    expect(screen.queryByText('In their own words')).toBeNull();
    // "Back", named for the group, returns to it.
    await user.click(screen.getByRole('button', { name: groupTitle(LI_GROUP) }));
    expect(await screen.findByRole('heading', { name: groupTitle(LI_GROUP), level: 2 })).toBeTruthy();
  });

  it('test_admin_reports_detail_gone', async () => {
    const { user } = openReports({ details: [DETECTION] });
    await user.click(await screen.findByRole('button', { name: 'View 7KQ3-M2PC' }));
    expect(await screen.findByText(GONE)).toBeTruthy();
  });
});

describe('lookup', () => {
  it('test_admin_reports_lookup_by_reference', async () => {
    const found = listPath({ ref: '7KQ3-M2PC' });
    const missing = listPath({ ref: '7KQ3-M2PD' });
    const { server, user } = openReports({
      pages: { [found]: { rows: [CORRECTIONS[1]], nextBefore: null }, [missing]: { rows: [], nextBefore: null } },
    });
    const find = await screen.findByRole('region', { name: 'Find a report' });
    const field = within(find).getByLabelText('Reference');

    // Not a reference: said, nothing asked.
    await user.type(field, 'hello');
    await user.click(within(find).getByRole('button', { name: 'Find' }));
    expect(within(find).getByText('A reference looks like 7KQ3-M2PA.')).toBeTruthy();
    await settle();
    expect(reportCalls(server, 'GET').some((c) => c.path.includes('ref='))).toBe(false);

    // An exact reference nobody has.
    await user.clear(field);
    await user.type(field, '7KQ3-M2PD');
    await user.click(within(find).getByRole('button', { name: 'Find' }));
    expect(await within(find).findByText('No report has this reference.')).toBeTruthy();

    // Typed as read out (lowercase, a space, O for 0 would be the same): the report opens.
    await user.clear(field);
    await user.type(field, '7kq3 m2pc');
    await user.click(within(find).getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('heading', { name: 'Report 7KQ3-M2PC' })).toBeTruthy();
    expect(
      reportCalls(server, 'GET')
        .filter((c) => c.path.includes('ref='))
        .map((c) => c.path),
    ).toEqual([missing, found]);
  });
});

describe('routing', () => {
  it('test_admin_reports_page_path', () => {
    expect(ADMIN_REPORTS_PAGE_PATH).toBe('/admin/reports');
    const main = readFileSync(resolve(import.meta.dirname, '../src/main.tsx'), 'utf8');
    expect(main).toContain('pathname === ADMIN_REPORTS_PAGE_PATH ? (\n          <AdminReports />');
  });
});
