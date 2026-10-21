/**
 * The admin page's other sections (R38, R43): the invites (CL4-06's routes and the sentence the admin passes on, with
 * no line about store builds now that every store version offers servers); today's tiles, the server's content-free
 * status and its last 30 days, all from one read of the overview (CL4-05's overview, CL4-14's `ops`); and the problem
 * reports page, which the sidebar always links and whose tile the overview's `reports` decides (ADR 0009 §7). `fetch`
 * is the shared fake server: its invite routes change the next accounts list as the server's do, and every request is
 * recorded.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { formatApproxCost, formatPrice } from '@unalgorithm/core';
import {
  ACCOUNT_PAGE_PATH,
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  ADMIN_USERS_PATH,
  type AdminOverview,
  type AdminUsers,
  type BackupStatus,
  type OpsStatus,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/Admin.tsx';
import { backupLine } from '../src/AdminUsage.tsx';
import { fakeServer, OVERVIEW, type Reply, SESSION_GONE, TOM } from './support/fake-server.ts';

const HAS_ACCOUNT = 'This address already has an account.';
const STORE_LINE =
  'Until the store versions of unAlgorithm Feed offer servers, they need a build that does, with its id in EXTENSION_IDS.';
const BREAKER = "Today's AI spending limit is reached. AI resumes for everyone at 00:00 UTC.";
const LOAD_FAILED = "Couldn't load usage.";
const NOT_WATCHED = "Backups aren't watched on this server.";
const NO_BACKUP = 'No backup has finished yet.';
const SIGN_IN_INTRO = 'Sign in to manage this server.';
const SIGNED_OUT = 'You were signed out. Sign in again.';

const ANA = 'ana@example.com';
const KIM = 'kim@example.org';
const LEO = 'leo@example.org';
const INVITE = { email: KIM, createdAt: '2026-10-12T08:00:00.000Z' };

/** TOM is the signed-in admin; Ana has an account; nobody is invited. */
const USERS: AdminUsers = {
  users: [
    {
      id: 'u1',
      email: TOM,
      role: 'admin',
      access: 'active',
      createdAt: '2026-09-01T12:00:00.000Z',
      lastActiveAt: null,
      activeDevices: 1,
      postsToday: 0,
      posts30Days: 0,
      costMicros30Days: 0,
      dailyPostCap: null,
    },
    {
      id: 'u2',
      email: ANA,
      role: 'user',
      access: 'active',
      createdAt: '2026-09-02T12:00:00.000Z',
      lastActiveAt: null,
      activeDevices: 1,
      postsToday: 0,
      posts30Days: 0,
      costMicros30Days: 0,
      dailyPostCap: null,
    },
  ],
  truncated: false,
  invites: [],
  defaultDailyPostCap: 1000,
};

/** Today, with the days before it oldest first, as the server sends them. */
const BUSY_DAY: AdminOverview = {
  ...OVERVIEW,
  today: { day: '2026-10-15', posts: 1234, requests: 56, costMicros: 1_230_000 },
  last30Days: [
    { day: '2026-10-13', posts: 300, requests: 30, costMicros: 120_000 },
    { day: '2026-10-14', posts: 4500, requests: 410, costMicros: 2_340_000 },
    { day: '2026-10-15', posts: 1234, requests: 56, costMicros: 1_230_000 },
  ],
  spendLimitMicros: 5_000_000,
};

const LOCAL_OK: BackupStatus = {
  kind: 'local',
  ok: true,
  finishedAt: '2026-10-15T03:00:00.000Z',
  lastSuccessAt: '2026-10-15T03:00:00.000Z',
  bytes: 1_200_000_000,
  error: null,
};
const OFFSITE_FAILED: BackupStatus = {
  kind: 'offsite',
  ok: false,
  finishedAt: '2026-10-15T03:10:00.000Z',
  lastSuccessAt: '2026-10-13T03:10:00.000Z',
  bytes: null,
  error: 'copy',
};
const OPS: OpsStatus = {
  diskFreeBytes: 5_250_000_000,
  diskTotalBytes: 40_000_000_000,
  databaseBytes: 48_000_000,
  errors15m: 3,
  backups: [LOCAL_OK, OFFSITE_FAILED],
  openAlerts: [{ key: 'backup-offsite', level: 'critical', openedAt: '2026-10-15T03:15:00.000Z' }],
};

/** Opens the admin page as TOM, an admin of a server with `USERS` and `OVERVIEW` unless the test passes its own. */
function openAdmin(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({ session: TOM, role: 'admin', adminUsers: USERS, ...options });
  const user = setupUser();
  render(<Admin />);
  return { server, user };
}

/** A section of the page, by its heading. */
function section(name: 'People' | 'Invites' | 'Server' | 'Usage'): HTMLElement {
  return screen.getByRole('region', { name });
}

/** Today's tile with this label, if the page shows it. */
function queryTile(label: string): HTMLElement | null {
  const found = [...document.querySelectorAll('.web-stat')].find(
    (el) => el.querySelector('.web-stat-label')?.textContent === label,
  );
  return found instanceof HTMLElement ? found : null;
}

/** Today's tile with this label: its figure and its line of context. */
function tile(label: string): { element: HTMLElement; value: string; detail: string } {
  const element = queryTile(label);
  if (!element) throw new Error(`No tile ${label}`);
  return {
    element,
    value: element.querySelector('.web-stat-value')?.textContent ?? '',
    detail: element.querySelector('.web-stat-detail')?.textContent ?? '',
  };
}

/** The admin sidebar's links, as their names and where they go. */
function sidebarLinks(): [string, string | null][] {
  const nav = screen.getByRole('navigation', { name: 'Pages' });
  return within(nav)
    .getAllByRole('link')
    .map((a) => [a.textContent ?? '', a.getAttribute('href')]);
}

/** The list row whose title is `title` (the usage table's headers repeat some titles). */
function row(title: string): HTMLElement {
  const found = screen
    .getAllByText(title)
    .map((el) => el.closest('.ua-row'))
    .find((el) => el !== null);
  if (!(found instanceof HTMLElement)) throw new Error(`No row for ${title}`);
  return found;
}

function inviteButton(): HTMLButtonElement {
  return within(section('Invites')).getByRole('button', { name: 'Invite' }) as HTMLButtonElement;
}

async function invite(user: ReturnType<typeof setupUser>, email: string) {
  const field = await screen.findByLabelText('Email address');
  await user.clear(field);
  await user.type(field, email);
  await user.click(inviteButton());
}

/** The invite requests the page sent, in order. */
function inviteCalls(server: ReturnType<typeof fakeServer>) {
  return server.posts().filter((c) => c.path === ADMIN_INVITES_PATH || c.path === ADMIN_INVITE_REMOVE_PATH);
}

/** Waits for the usage table: the Usage section is drawn anew once the overview has loaded. */
function usageTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: 'Last 30 days (UTC)' });
}

/** The usage table's body rows, as their cells' text. */
function tableRows(): string[][] {
  const table = within(section('Usage')).getByRole('table', { name: 'Last 30 days (UTC)' });
  return [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? ''));
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

describe('invites', () => {
  it('test_admin_invites_add_and_list', async () => {
    const { server, user } = openAdmin();
    await invite(user, 'New@Example.org');

    expect(await screen.findByText('new@example.org')).toBeTruthy();
    expect(row('new@example.org').textContent).toContain('Invited Oct 15, 2026');
    expect(inviteCalls(server)).toEqual([{ method: 'POST', path: ADMIN_INVITES_PATH, body: { email: 'New@Example.org' } }]);
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(2);
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe('');
  });

  it('test_admin_invites_pass_on_sentence', async () => {
    const { user } = openAdmin();
    await screen.findByLabelText('Email address');
    // Nobody invited: nothing but the form.
    expect(screen.queryByText(/^Tell /)).toBeNull();
    expect(screen.queryByText(STORE_LINE)).toBeNull();

    await invite(user, 'New@Example.org');
    const sentence = await screen.findByText(
      `Tell new@example.org: install unAlgorithm Feed, open Settings, then AI, choose a server, enter ${window.location.origin}, and sign in with this address.`,
    );
    // In a callout, with a button that copies it.
    const callout = sentence.closest('.web-callout');
    if (!(callout instanceof HTMLElement)) throw new Error('No callout');
    expect(within(callout).getByRole('button', { name: 'Copy' })).toBeTruthy();
    // Every store version offers servers (docs/release.md): no note about builds under the sentence.
    expect(screen.queryByText(STORE_LINE)).toBeNull();

    // The last address invited is the one to pass on.
    await invite(user, LEO);
    expect(await screen.findByText(new RegExp(`^Tell ${LEO}:`))).toBeTruthy();
    expect(screen.queryByText(/^Tell new@example.org:/)).toBeNull();
  });

  it('test_admin_invites_invalid_and_existing', async () => {
    const { server, user } = openAdmin();
    const field = await screen.findByLabelText('Email address');
    expect(inviteButton().disabled).toBe(true);
    for (const typed of ['not-an-address', 'kim@', 'kim@localhost']) {
      await user.clear(field);
      await user.type(field, typed);
      expect(inviteButton().disabled).toBe(true);
    }
    await user.click(inviteButton());
    await user.type(field, '{Enter}');
    await settle();
    expect(inviteCalls(server)).toEqual([]);

    await invite(user, ANA);
    expect(await within(section('Invites')).findByText(HAS_ACCOUNT)).toBeTruthy();
    expect(inviteCalls(server)).toEqual([{ method: 'POST', path: ADMIN_INVITES_PATH, body: { email: ANA } }]);
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(1);
    expect(screen.queryByText(/^Tell /)).toBeNull();
    // The address stays, to correct.
    expect((field as HTMLInputElement).value).toBe(ANA);

    // A 401 returns the page to the sign-in.
    cleanup();
    const ended = openAdmin({ routes: { [`POST ${ADMIN_INVITES_PATH}`]: SESSION_GONE } });
    await invite(ended.user, KIM);
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT)).toBeTruthy();
  });

  it('test_admin_invites_remove', async () => {
    const invites = [
      { email: KIM, createdAt: '2026-10-12T08:00:00.000Z' },
      { email: LEO, createdAt: '2026-10-10T08:00:00.000Z' },
    ];
    const { server, user } = openAdmin({ adminUsers: { ...USERS, invites } });
    expect(await screen.findByText(KIM)).toBeTruthy();
    const pending = screen.getByRole('heading', { name: 'Pending invites' }).closest('.ua-group');
    if (!(pending instanceof HTMLElement)) throw new Error('No Pending invites group');
    expect(pending.contains(row(KIM))).toBe(true);
    expect(pending.contains(row(LEO))).toBe(true);
    expect(row(KIM).textContent).toContain('Invited Oct 12, 2026');
    expect(row(LEO).textContent).toContain('Invited Oct 10, 2026');

    await user.click(screen.getByRole('button', { name: `Remove ${KIM}` }));
    await waitFor(() => expect(screen.queryByText(KIM)).toBeNull());
    expect(screen.getByText(LEO)).toBeTruthy();
    expect(inviteCalls(server)).toEqual([{ method: 'POST', path: ADMIN_INVITE_REMOVE_PATH, body: { email: KIM } }]);
    expect(server.count('GET', ADMIN_USERS_PATH)).toBe(2);
  });
});

describe('usage', () => {
  it('test_admin_usage_today_and_days', async () => {
    openAdmin({ adminOverview: BUSY_DAY });
    expect(await usageTable()).toBeTruthy();
    // Today as tiles; the old list rows are gone.
    expect(tile('Posts today')).toMatchObject({ value: '1,234', detail: '56 requests' });
    expect(tile('AI cost today')).toMatchObject({
      value: formatPrice(1_230_000),
      detail: `of ${formatPrice(5_000_000)} daily spend limit`,
    });
    expect(tile('AI cost today').detail).toBe('of $5.00 daily spend limit');
    expect(tile('People')).toMatchObject({ value: '2', detail: 'No invites pending' });
    expect(queryTile('Open problem reports')).toBeNull();
    for (const old of ['Requests', 'AI cost', 'Daily spend limit']) {
      expect(screen.queryAllByText(old).filter((el) => el.closest('.ua-row'))).toEqual([]);
    }
    // The 30 days, as a chart and the same figures in a table behind "Show as a table".
    const table = within(section('Usage')).getByRole('table', { name: 'Last 30 days (UTC)' });
    expect(table.closest('details')?.querySelector('summary')?.textContent).toBe('Show as a table');
    expect(tableRows()).toEqual([
      ['Oct 15', '1,234', '56', formatApproxCost(1_230_000)],
      ['Oct 14', '4,500', '410', formatApproxCost(2_340_000)],
      ['Oct 13', '300', '30', formatApproxCost(120_000)],
    ]);
    expect(screen.queryByText(BREAKER)).toBeNull();
    cleanup();

    openAdmin({ adminOverview: { ...BUSY_DAY, breakerTripped: true }, adminUsers: { ...USERS, invites: [INVITE] } });
    const banner = await screen.findByText(BREAKER);
    expect(banner.closest('.ua-banner')?.className).toContain('ua-banner--warning');
    // Under the tiles.
    expect(tile('People').detail).toBe('1 invite pending');
    expect(tile('People').element.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // A page of lists and tables gets the wide frame, accounts and invites in one column and usage in the other, with the
  // server's status (backups, alerts) above the 30 days.
  it('test_admin_page_layout', async () => {
    openAdmin({ adminOverview: { ...BUSY_DAY, ops: OPS } });
    const server = await screen.findByRole('heading', { name: 'Server' });
    expect(document.querySelector('.web-page')?.className).toContain('web-page-wide');
    const columns = [...document.querySelectorAll('.web-admin > .web-admin-column')];
    expect(columns).toHaveLength(2);
    expect(columns[0]?.contains(section('People'))).toBe(true);
    expect(columns[0]?.contains(section('Invites'))).toBe(true);
    expect(columns[1]?.contains(section('Server'))).toBe(true);
    expect(columns[1]?.contains(section('Usage'))).toBe(true);
    const table = within(section('Usage')).getByRole('table');
    expect(server.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('test_admin_usage_ops_block', async () => {
    openAdmin({ adminOverview: { ...BUSY_DAY, ops: OPS } });
    await screen.findByRole('heading', { name: 'Server' });
    const group = section('Server');
    expect(within(group).getByText('Needs attention')).toBeTruthy();
    expect(group.contains(row('Disk free'))).toBe(true);
    expect(row('Disk free').textContent).toContain('5.3 GB of 40.0 GB');
    expect(row('Database size').textContent).toContain('48 MB');
    expect(row('3 errors in the last 15 minutes').textContent).toContain('Errors');
    expect(row('Local backup').textContent).toContain('Last Oct 15, 2026, 03:00 UTC · 1.2 GB');
    expect(row('Local backup').textContent).toContain('OK');
    expect(row('Offsite backup').textContent).toContain('The copy failed');
    expect(row('Offsite backup').textContent).toContain('Failed');
    expect(row('backup-offsite').textContent).toContain('critical · since Oct 15, 2026, 03:15 UTC');
    expect(within(group).queryByText(NOT_WATCHED)).toBeNull();
    cleanup();

    openAdmin({ adminOverview: { ...BUSY_DAY, ops: { ...OPS, backups: null, errors15m: 1 } } });
    expect(await screen.findByText(NOT_WATCHED)).toBeTruthy();
    expect(row('1 error in the last 15 minutes').textContent).toContain('Errors');
    expect(screen.queryByText(/^(Local|Offsite) backup$/)).toBeNull();
    cleanup();

    openAdmin({ adminOverview: { ...BUSY_DAY, ops: { ...OPS, backups: [], diskTotalBytes: null, databaseBytes: null } } });
    expect(await screen.findByText(NO_BACKUP)).toBeTruthy();
    expect(screen.queryByText(/^(Local|Offsite) backup$/)).toBeNull();
    expect(screen.queryByText(NOT_WATCHED)).toBeNull();
    expect(row('Disk free').textContent).toContain('5.3 GB');
    expect(row('Disk free').textContent).not.toContain(' of ');
    expect(row('Database size').textContent).toContain('unknown');
    cleanup();

    // No errors, no alerts and every backup fine: healthy.
    openAdmin({ adminOverview: { ...BUSY_DAY, ops: { ...OPS, errors15m: 0, backups: [LOCAL_OK], openAlerts: [] } } });
    await screen.findByRole('heading', { name: 'Server' });
    expect(within(section('Server')).getByText('Healthy')).toBeTruthy();
    expect(within(section('Server')).queryByText('Needs attention')).toBeNull();
    expect(row('0 errors in the last 15 minutes').textContent).toContain('None');
    cleanup();

    openAdmin({ adminOverview: { ...BUSY_DAY, ops: null } });
    expect(await usageTable()).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Server' })).toBeNull();
    expect(screen.queryByText('Disk free')).toBeNull();
  });

  it('test_backup_line', () => {
    const failed = (error: BackupStatus['error']) => backupLine({ ...OFFSITE_FAILED, error });
    expect(failed('no-key')).toBe('No backup key');
    expect(failed('dump')).toBe('The database dump failed');
    expect(failed('encrypt')).toBe('Encryption failed');
    expect(failed('write')).toBe("The file couldn't be written");
    expect(failed('copy')).toBe('The copy failed');
    expect(failed('verify')).toBe("The copy didn't match");
    expect(failed('unreadable')).toBe("Its status file can't be read");
    expect(failed(null)).toBe('The last run failed');
    expect(backupLine(LOCAL_OK)).toBe('Last Oct 15, 2026, 03:00 UTC · 1.2 GB');
  });

  it('test_admin_usage_errors', async () => {
    // The page opens with one read of the overview, which fails.
    let tries = 0;
    const flaky: Reply = () =>
      ++tries === 1
        ? { status: 500, body: { code: 'internal', message: 'Oops.' } }
        : { status: 200, body: { ...BUSY_DAY, reports: { enabled: true, open: 2, last24h: 2 } } };
    const { server, user } = openAdmin({ routes: { [`GET ${ADMIN_OVERVIEW_PATH}`]: flaky } });
    const failed = await screen.findByText(LOAD_FAILED);
    expect(section('Usage').contains(failed)).toBe(true);
    expect(server.count('GET', ADMIN_OVERVIEW_PATH)).toBe(1);
    // The rest of the page still works; the overview's tiles are simply left out.
    expect(screen.getByLabelText('Email address')).toBeTruthy();
    expect(tile('People').value).toBe('2');
    expect(queryTile('Posts today')).toBeNull();
    expect(queryTile('AI cost today')).toBeNull();
    expect(queryTile('Open problem reports')).toBeNull();
    // "Try again" reads it once more, and everything that comes from it shows.
    await user.click(within(section('Usage')).getByRole('button', { name: 'Try again' }));
    expect(await usageTable()).toBeTruthy();
    expect(screen.queryByText(LOAD_FAILED)).toBeNull();
    expect(tile('Posts today').value).toBe('1,234');
    expect(tile('Open problem reports').value).toBe('2');
    expect(server.count('GET', ADMIN_OVERVIEW_PATH)).toBe(2);
    cleanup();

    openAdmin({ routes: { [`GET ${ADMIN_OVERVIEW_PATH}`]: SESSION_GONE } });
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByText(SIGNED_OUT)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Usage' })).toBeNull();
  });
});

describe('problem reports tile and sidebar', () => {
  /** The sidebar's links: always every admin page, the problem reports page without a count. */
  const SIDEBAR: [string, string][] = [
    ['Account', ACCOUNT_PAGE_PATH],
    ['Overview', ADMIN_PAGE_PATH],
    ['Source list', ADMIN_SOURCES_PAGE_PATH],
    ['Pricing', ADMIN_PRICES_PAGE_PATH],
    ['Problem reports', ADMIN_REPORTS_PAGE_PATH],
  ];

  it('test_admin_problem_reports_tile_with_open_count', async () => {
    const { server } = openAdmin({ adminOverview: { ...BUSY_DAY, reports: { enabled: true, open: 1234, last24h: 40 } } });
    await usageTable();
    const reports = tile('Open problem reports');
    expect(reports).toMatchObject({ value: '1,234', detail: '40 in the last 24 hours' });
    // The tile leads to the problem reports page.
    expect(reports.element.tagName).toBe('A');
    expect(reports.element.getAttribute('href')).toBe(ADMIN_REPORTS_PAGE_PATH);
    // The sidebar lists every admin page, this one marked; the old line of links under the intro is gone.
    expect(sidebarLinks()).toEqual(SIDEBAR);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText(/Source list · Pricing/)).toBeNull();
    expect(screen.queryByText(/\(1,234 open\)/)).toBeNull();
    // The page reads the overview once.
    await settle();
    expect(server.count('GET', ADMIN_OVERVIEW_PATH)).toBe(1);
  });

  it('test_admin_hides_problem_reports_tile_when_off', async () => {
    // REPORTS=off: no tile, even with reports kept from before; the sidebar still links the page.
    let { server } = openAdmin({ adminOverview: { ...BUSY_DAY, reports: { enabled: false, open: 3, last24h: 0 } } });
    await usageTable();
    await settle();
    expect(server.count('GET', ADMIN_OVERVIEW_PATH)).toBe(1);
    expect(tile('Posts today').value).toBe('1,234');
    expect(queryTile('Open problem reports')).toBeNull();
    expect(sidebarLinks()).toEqual(SIDEBAR);
    cleanup();

    // A server older than reports says nothing about them.
    ({ server } = openAdmin({ adminOverview: BUSY_DAY }));
    await usageTable();
    await settle();
    expect(server.count('GET', ADMIN_OVERVIEW_PATH)).toBe(1);
    expect(tile('Posts today').value).toBe('1,234');
    expect(queryTile('Open problem reports')).toBeNull();
    expect(sidebarLinks()).toEqual(SIDEBAR);
  });
});
