/**
 * The public source list page at `/outlets` (P3-67, decision D97): read-only, no sign-in, built from the server's
 * `/outlets.json` and `/outlets/changes.json`, with the balance warnings and the change history without who made each
 * change. `fetch` is the shared fake server, answering the two GETs as given. Fictional `.example` outlets only: the
 * outlets package's fixture, plus one without a lean.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import {
  BUCKET_LABELS,
  FEATURE_NAMES,
  type OfficialList,
  type OfficialOutlet,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  type OutletChange,
  SERVER_INFO_PATH,
  WEBSITE_ORIGIN,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeList, SourceList } from '../src/SourceList.tsx';
import { EMPTY_SOURCE_LIST, fakeServer, INFO, NO_OUTLET_CHANGES, type Reply, TOM } from './support/fake-server.ts';

const UNREACHABLE = "Couldn't load the source list.";
const NOT_BALANCED = "This list isn't balanced";

/** A fictional outlet with no lean, and two web addresses. */
const UNLABELLED: OfficialOutlet = {
  id: 'fx-unlabelled',
  name: 'Fixture Unlabelled',
  domains: ['unlabelled.example', 'unlabelled-news.example'],
  country: 'CA',
  lean: null,
  changedOn: '2026-02-03',
};
/** The fixture (two outlets per bucket) and one outlet without a lean, sent out of id order. */
const LIST: OfficialList = {
  ...FIXTURE_OFFICIAL_LIST,
  version: '12',
  updatedAt: '2026-02-03T10:00:00.000Z',
  outlets: [...FIXTURE_OFFICIAL_LIST.outlets, UNLABELLED].reverse(),
};
const SORTED_IDS = LIST.outlets.map((o) => o.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const fx = (id: string): OfficialOutlet => {
  const found = FIXTURE_OFFICIAL_LIST.outlets.find((o) => o.id === id);
  if (!found) throw new Error(`No fixture outlet ${id}.`);
  return found;
};
const CENTER = fx('fx-center-a');
const AS_LEANS_LEFT: OfficialOutlet = {
  ...CENTER,
  lean: { bucket: 'lean-left', evidence: [...(CENTER.lean?.evidence ?? [])] },
  changedOn: '2026-02-02',
};

/** One change of each kind, newest first, as the server sends them. */
const CHANGES: OutletChange[] = [
  { seq: 12, at: '2026-02-03T10:00:00.000Z', action: 'add', outletId: UNLABELLED.id, before: null, after: UNLABELLED },
  { seq: 11, at: '2026-02-02T09:00:00.000Z', action: 'edit', outletId: CENTER.id, before: CENTER, after: AS_LEANS_LEFT },
  {
    seq: 10,
    at: '2026-02-01T08:00:00.000Z',
    action: 'remove',
    outletId: 'fx-gone',
    before: { ...UNLABELLED, id: 'fx-gone', name: 'Fixture Gone' },
    after: null,
  },
  {
    seq: 9,
    at: '2026-01-15T00:00:00.000Z',
    action: 'import',
    outletId: 'fx-imported',
    before: null,
    after: { ...UNLABELLED, id: 'fx-imported', name: 'Fixture Imported' },
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

function openPage(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({ sourceList: LIST, outletChanges: { v: 1, changes: CHANGES }, ...options });
  const user = setupUser();
  const view = render(<SourceList />);
  return { server, user, view };
}

/** The list with only these outlets. */
const listOf = (outlets: OfficialOutlet[]): OfficialList => ({ ...LIST, outlets });

describe('page', () => {
  it('test_source_list_page_shows_list', async () => {
    const { server, view } = openPage({ session: TOM });
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(`Source list · ${INFO.name}`);
    expect(document.title).toBe(`Source list · ${INFO.name}`);
    expect(
      screen.getByText(
        `The news outlets ${FEATURE_NAMES.perspectives} compares coverage across, and the lean bucket of each. Leans are ` +
          "set by this server's admins, each with evidence, and every change is listed below. Never by AI.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Version 12 ·/).textContent).toBe(
      'Version 12 · Updated Feb 3, 2026 · Data CC BY 4.0 · Download JSON',
    );
    expect(screen.getByRole('link', { name: 'Download JSON' }).getAttribute('href')).toBe(OUTLETS_JSON_PATH);
    expect(screen.getByRole('link', { name: 'CC BY 4.0' }).getAttribute('href')).toBe(
      'https://creativecommons.org/licenses/by/4.0/',
    );
    expect(screen.getByText(/^To appeal a listing or a lean/).textContent).toBe(
      'To appeal a listing or a lean, see Corrections and appeals.',
    );
    expect(screen.getByRole('link', { name: 'Corrections and appeals' }).getAttribute('href')).toBe(
      `${WEBSITE_ORIGIN}/corrections`,
    );

    // Balanced: no warning, and the counts per bucket in order.
    expect(screen.queryByText(NOT_BALANCED)).toBeNull();
    expect(screen.getByText('Left 2 · Leans left 2 · Center 2 · Leans right 2 · Right 2')).toBeTruthy();

    const table = screen.getByRole('table');
    const [head, ...rows] = within(table).getAllByRole('row');
    expect(
      within(head as HTMLElement)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Outlet', 'Web addresses', 'Country', 'Lean', 'Evidence', 'Changed']);
    // One row per outlet, sorted by id, each linkable as /outlets#<id>.
    expect(rows.map((r) => r.id)).toEqual(SORTED_IDS);
    for (const row of rows) {
      const outlet = LIST.outlets.find((o) => o.id === row.id);
      if (!outlet) throw new Error(`No outlet ${row.id}.`);
      const cells = within(row).getAllByRole('cell');
      expect(within(row).getByRole('rowheader').textContent).toBe(`${outlet.name}${outlet.id}`);
      expect(cells.map((c) => c.textContent)).toEqual([
        outlet.domains.join(', '),
        outlet.country === 'US' ? 'US' : 'Canada',
        outlet.lean ? BUCKET_LABELS[outlet.lean.bucket] : 'Not labelled',
        (outlet.lean?.evidence ?? []).map((e) => e.note).join(''),
        outlet.changedOn === '2026-01-15' ? 'Jan 15, 2026' : 'Feb 3, 2026',
      ]);
      const links = within(row).queryAllByRole('link');
      expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual(
        (outlet.lean?.evidence ?? []).map((e) => [e.note, e.url]),
      );
      for (const a of links) {
        expect(a.getAttribute('href')).toMatch(/^https:\/\//);
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
        expect(a.getAttribute('target')).toBe('_blank');
      }
    }
    expect(within(table).getByText('Not labelled')).toBeTruthy();

    // Public: the page asks for nothing that needs a session.
    expect(server.calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(
      [SERVER_INFO_PATH, OUTLETS_JSON_PATH, OUTLET_CHANGES_JSON_PATH].map((path) => `GET ${path}`).sort(),
    );
    expect(document.body.innerHTML).not.toContain(TOM);
  });

  it('test_source_list_page_balance_warnings', async () => {
    const noRight = LIST.outlets.filter((o) => o.lean?.bucket !== 'right');
    openPage({ sourceList: listOf(noRight) });
    const notice = await screen.findByText(NOT_BALANCED);
    const banner = notice.closest('.ua-banner') as HTMLElement;
    expect(within(banner).getByText('No outlets in Right.')).toBeTruthy();
    expect(screen.getByText('Left 2 · Leans left 2 · Center 2 · Leans right 2 · Right 0')).toBeTruthy();
    cleanup();

    // No lean at all: the list can't be used.
    openPage({ sourceList: listOf([UNLABELLED]) });
    expect(
      await screen.findByText(`This list has no outlets with a lean, so ${FEATURE_NAMES.perspectives} can't use it.`),
    ).toBeTruthy();
    expect(screen.queryByText(NOT_BALANCED)).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('test_source_list_page_error_and_empty', async () => {
    // Unreachable first, then answered: "Try again" loads the list again.
    let tries = 0;
    const flaky: Reply = () => {
      if (++tries === 1) throw new TypeError('Failed to fetch');
      return { status: 200, body: LIST };
    };
    const { server, user } = openPage({ routes: { [`GET ${OUTLETS_JSON_PATH}`]: flaky } });
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(server.count('GET', OUTLETS_JSON_PATH)).toBe(2);
    cleanup();

    // A server error is the same.
    openPage({ routes: { [`GET ${OUTLETS_JSON_PATH}`]: { status: 500, body: { code: 'unknown', message: 'Oops.' } } } });
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    cleanup();

    // A list never changed: no outlets, no changes.
    openPage({ sourceList: EMPTY_SOURCE_LIST, outletChanges: NO_OUTLET_CHANGES });
    expect(await screen.findByText('No outlets yet.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/^Version 0 ·/).textContent).toBe('Version 0 · Data CC BY 4.0 · Download JSON');
    expect(screen.getByText('No changes yet.')).toBeTruthy();
  });

  it('test_source_list_page_history_without_identities', async () => {
    // Even a history that carried who (the admin page's shape) shows no one: the page passes no `showBy`.
    const withBy = CHANGES.map((c) => ({ ...c, by: TOM }));
    openPage({ outletChanges: { v: 1, changes: withBy } });
    const history = await screen.findByRole('list', { name: 'Changes' });
    const lines = [
      'Feb 3, 2026 · Added Fixture Unlabelled (fx-unlabelled)',
      'Feb 2, 2026 · Edited Fixture Center A (fx-center-a) · lean: Center → Leans left',
      'Feb 1, 2026 · Removed Fixture Gone (fx-gone)',
      'Jan 15, 2026 · Imported Fixture Imported (fx-imported)',
    ];
    expect(
      within(history)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(lines);
    expect(document.body.textContent).not.toContain(TOM);
    expect(document.body.textContent).not.toContain('@');
    cleanup();

    // The admin page's (P3-74) passes `showBy`; every other field an edit changes is named in plain words.
    const renamed: OfficialOutlet = { ...UNLABELLED, name: 'Fixture Renamed', domains: ['renamed.example'], country: 'US' };
    const edit: OutletChange = {
      seq: 13,
      at: '2026-02-04T10:00:00.000Z',
      action: 'edit',
      outletId: UNLABELLED.id,
      before: UNLABELLED,
      after: renamed,
    };
    render(<ChangeList changes={[{ ...edit, by: null }, ...withBy]} showBy />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Feb 4, 2026 · Edited Fixture Renamed (fx-unlabelled) · web addresses, name, country',
      ...lines.map((line) => `${line} · by ${TOM}`),
    ]);
  });
});
