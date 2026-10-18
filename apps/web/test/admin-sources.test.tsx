/**
 * The source control page at `/admin/sources` (P3-74, decisions D93–D95, D101): an admin adds, edits and removes the
 * server's outlets and imports the candidate list into an empty list, through P3-73's routes; each change is published
 * at once and listed with who made it. `fetch` is the shared fake server, whose source control routes keep a list and a
 * history and check a change as the server does (the version shown, an id already listed or gone, the list rules).
 * Fictional `.example` outlets only: the outlets package's fixture, the fake server's candidates and "FX News".
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import {
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  type AdminOutletChange,
  EMAIL_OTP_METHOD,
  FEATURE_NAMES,
  GOOGLE_METHOD,
  MAX_OUTLET_EVIDENCE,
  type OfficialList,
  type OfficialOutlet,
  OUTLETS_PAGE_PATH,
} from '@unalgorithm/protocol';
import { setupUser } from '@unalgorithm/ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Admin } from '../src/Admin.tsx';
import { AdminSources } from '../src/AdminSources.tsx';
import { SIGN_OUT_PATH, SOCIAL_SIGN_IN_PATH } from '../src/api.ts';
import {
  EMPTY_SOURCE_LIST,
  fakeServer,
  GOOGLE_URL,
  INFO,
  LIST_CHANGED,
  NO_OUTLET_CHANGES,
  OUTLET_GONE,
  SESSION_GONE,
  TOM,
} from './support/fake-server.ts';

const SIGN_IN_INTRO = 'Sign in to manage this server.';
const NOT_ADMIN = "This account isn't an admin of this server.";
const SIGNED_OUT = 'You were signed out. Sign in again.';
const INTRO =
  'Changes are published as soon as you save them. A lean needs at least one piece of evidence. Every change is ' +
  'listed below and on the public page.';
const IMPORT = 'Import the candidate list';
const IMPORT_LINE = 'Adds the candidate outlets with their names, web addresses and country, and no leans.';
const EVIDENCE_REASON = 'A lean needs at least one piece of evidence with an https link.';
const CHANGED = 'The list changed since you opened it.';
const GONE = 'That outlet is no longer on the list.';
const NOT_BALANCED = "This list isn't balanced";
const TODAY = 'Oct 16, 2026';

/** The fixture (two outlets per bucket) as a server publishes it at version 12. */
const LIST: OfficialList = { ...FIXTURE_OFFICIAL_LIST, version: '12', updatedAt: '2026-02-03T10:00:00.000Z' };

const fx = (id: string): OfficialOutlet => {
  const found = LIST.outlets.find((o) => o.id === id);
  if (!found) throw new Error(`No fixture outlet ${id}.`);
  return found;
};
const CENTER = fx('fx-center-a');

/** "FX News" as AC 4 adds it: a fictional outlet with one piece of evidence. */
const FX_EVIDENCE = { url: 'https://evidence.example/fx-news', note: 'Fictional evidence for this test.' };
const FX_NEWS = {
  id: 'fx-news',
  name: 'FX News',
  domains: ['fx-news.example'],
  country: 'US',
  lean: { bucket: 'center', evidence: [FX_EVIDENCE] },
};

/** Two changes by TOM and one by an admin whose account was deleted since, newest first. */
const HISTORY: AdminOutletChange[] = [
  {
    seq: 12,
    at: '2026-02-03T10:00:00.000Z',
    action: 'edit',
    outletId: CENTER.id,
    before: { ...CENTER, lean: null },
    after: CENTER,
    by: TOM,
  },
  {
    seq: 11,
    at: '2026-02-02T09:00:00.000Z',
    action: 'add',
    outletId: 'fx-left-a',
    before: null,
    after: fx('fx-left-a'),
    by: TOM,
  },
  {
    seq: 10,
    at: '2026-02-01T08:00:00.000Z',
    action: 'add',
    outletId: 'fx-left-b',
    before: null,
    after: fx('fx-left-b'),
    by: null,
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.title = '';
});

/** Opens the page; by default TOM is signed in as an admin of a server whose list is `LIST`, with `HISTORY`. */
function openSources(options: Parameters<typeof fakeServer>[0] = {}) {
  const server = fakeServer({
    session: TOM,
    role: 'admin',
    sourceList: LIST,
    outletChanges: { v: 1, changes: HISTORY },
    ...options,
  });
  const user = setupUser();
  render(<AdminSources />);
  return { server, user };
}

/** The changes the page sent to the source list's admin routes, in order. */
function changes(server: ReturnType<typeof fakeServer>) {
  return server.posts().filter((c) => c.path === ADMIN_OUTLETS_PATH || c.path === ADMIN_OUTLETS_IMPORT_PATH);
}

/** A form control by its label. */
function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function save(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
}

/** The table row of the outlet with this id, or null. */
function row(id: string): HTMLElement | null {
  const found = document.getElementById(id);
  return found?.tagName === 'TR' ? found : null;
}

/** A row's cells as text: web addresses, country, lean, evidence, changed, actions. */
function cells(id: string): string[] {
  const found = row(id);
  if (!found) throw new Error(`No row ${id}.`);
  return within(found)
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');
}

/** The change history's lines, newest first. */
function historyLines(): string[] {
  return within(screen.getByRole('list', { name: 'Changes' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent ?? '');
}

/** Lets pending effects and answers settle, for a test that checks something did not happen. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Signs in on the page's `SignIn` with an emailed code, as TOM. */
async function signIn(user: ReturnType<typeof setupUser>) {
  await user.type(await screen.findByLabelText('Email'), TOM);
  await user.click(screen.getByRole('button', { name: 'Send code' }));
  await user.type(await screen.findByLabelText('6-digit code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** Waits for the list, then opens the empty form. */
async function openAddForm(user: ReturnType<typeof setupUser>) {
  await user.click(await screen.findByRole('button', { name: 'Add an outlet' }));
  expect(field('Name').value).toBe('');
}

describe('access', () => {
  it('test_admin_sources_signed_out_and_not_admin', async () => {
    // Signed out: the sign-in, which brings the person back to this page (Google included); the list isn't asked for.
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/elsewhere', search: '', assign });
    const info = { ...INFO, auth: { ...INFO.auth, methods: [EMAIL_OTP_METHOD, GOOGLE_METHOD] } };
    let { server, user } = openSources({ session: null, info });
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Source list · ${INFO.name}`);
    expect(document.title).toBe(`Source list · ${INFO.name}`);
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(GOOGLE_URL));
    expect(server.posts()).toEqual([
      {
        method: 'POST',
        path: SOCIAL_SIGN_IN_PATH,
        body: {
          provider: 'google',
          callbackURL: ADMIN_SOURCES_PAGE_PATH,
          errorCallbackURL: ADMIN_SOURCES_PAGE_PATH,
          disableRedirect: true,
        },
      },
    ]);
    cleanup();
    vi.unstubAllGlobals();

    // Signing in with a code loads the list.
    ({ server, user } = openSources({ session: null }));
    await signIn(user);
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByText(SIGN_IN_INTRO)).toBeNull();
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(1);
    cleanup();

    // Signed in, not an admin: said, with no list and nothing to change; "Sign out" goes back to the sign-in.
    ({ server, user } = openSources({ role: 'user' }));
    expect(await screen.findByText(NOT_ADMIN)).toBeTruthy();
    expect(screen.getByText(`Signed in as ${TOM}`)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(LIST.outlets[0]?.name ?? '')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add an outlet' })).toBeNull();
    expect(screen.queryByRole('button', { name: IMPORT })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(server.count('POST', SIGN_OUT_PATH)).toBe(1);
    expect(changes(server)).toEqual([]);
  });

  it('test_admin_page_links_source_list', async () => {
    fakeServer({ session: TOM, role: 'admin' });
    render(<Admin />);
    const link = await screen.findByRole('link', { name: 'Source list' });
    expect(link.getAttribute('href')).toBe(ADMIN_SOURCES_PAGE_PATH);
    // Below the intro, before the sections.
    const intro = screen.getByText('Who uses this server, and what each person may do.');
    expect(intro.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(screen.getByText('Accounts')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('editing', () => {
  it('test_admin_sources_import_into_empty_list', async () => {
    const { server, user } = openSources({ sourceList: EMPTY_SOURCE_LIST, outletChanges: NO_OUTLET_CHANGES });
    const button = await screen.findByRole('button', { name: IMPORT });
    expect(screen.getByText(IMPORT_LINE)).toBeTruthy();
    expect(screen.getByText('No outlets yet.')).toBeTruthy();
    expect(screen.getByText('No changes yet.')).toBeTruthy();

    await user.click(button);
    await waitFor(() => expect(row('fx-candidate-a')).not.toBeNull());
    expect(changes(server)).toEqual([{ method: 'POST', path: ADMIN_OUTLETS_IMPORT_PATH, body: {} }]);
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(2);

    // The reloaded list: the candidates with no lean, no import button, and one history line each, by the admin.
    expect(screen.queryByRole('button', { name: IMPORT })).toBeNull();
    expect(screen.queryByText(IMPORT_LINE)).toBeNull();
    expect(cells('fx-candidate-a').slice(0, 3)).toEqual(['candidate-a.example, candidate-a-news.example', 'US', 'Not labelled']);
    expect(cells('fx-candidate-b').slice(0, 3)).toEqual(['candidate-b.example', 'Canada', 'Not labelled']);
    expect(screen.getByText(`This list has no outlets with a lean, so ${FEATURE_NAMES.perspectives} can't use it.`)).toBeTruthy();
    expect(screen.getByText(/^Version 2/)).toBeTruthy();
    expect(historyLines()).toEqual([
      `${TODAY} · Imported Fixture Candidate B (fx-candidate-b) · by ${TOM}`,
      `${TODAY} · Imported Fixture Candidate A (fx-candidate-a) · by ${TOM}`,
    ]);
    // A list with outlets never offers the import.
    cleanup();
    openSources();
    expect(await screen.findByRole('table')).toBeTruthy();
    expect(screen.queryByRole('button', { name: IMPORT })).toBeNull();
  });

  it('test_admin_sources_add_outlet', async () => {
    const { server, user } = openSources();
    expect(await screen.findByText(INTRO)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Source list · ${INFO.name}`);
    expect(document.title).toBe(`Source list · ${INFO.name}`);
    expect(screen.getByRole('link', { name: 'Public page' }).getAttribute('href')).toBe(OUTLETS_PAGE_PATH);
    expect(screen.getByText(/^Version 12/)).toBeTruthy();

    await openAddForm(user);
    await user.type(field('Name'), 'FX News');
    // The id follows the name while adding.
    expect(field('Id').value).toBe('fx-news');
    expect(field('Id').readOnly).toBe(false);
    await user.type(field('Web addresses'), 'fx-news.example');
    await user.selectOptions(field('Country'), 'US');
    await user.selectOptions(field('Lean'), 'Center');
    await user.type(field('Evidence 1 link'), FX_EVIDENCE.url);
    await user.type(field('Evidence 1 note'), FX_EVIDENCE.note);
    expect(save().disabled).toBe(false);
    await user.click(save());

    await waitFor(() => expect(row('fx-news')).not.toBeNull());
    expect(changes(server)).toEqual([
      { method: 'POST', path: ADMIN_OUTLETS_PATH, body: { action: 'add', baseVersion: '12', outlet: FX_NEWS } },
    ]);
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(2);
    // The form closes; the reloaded table, counts and history show the outlet.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(within(row('fx-news') as HTMLElement).getByRole('rowheader').textContent).toBe('FX Newsfx-news');
    expect(cells('fx-news').slice(0, 5)).toEqual(['fx-news.example', 'US', 'Center', FX_EVIDENCE.note, TODAY]);
    expect(screen.getByText('Left 2 · Leans left 2 · Center 3 · Leans right 2 · Right 2')).toBeTruthy();
    expect(screen.getByText(/^Version 13/)).toBeTruthy();
    expect(historyLines()[0]).toBe(`${TODAY} · Added FX News (fx-news) · by ${TOM}`);

    // A name edited after the id was typed by hand keeps the typed id.
    await openAddForm(user);
    await user.type(field('Id'), 'fx-daily');
    await user.type(field('Name'), 'FX Daily News');
    expect(field('Id').value).toBe('fx-daily');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(changes(server)).toHaveLength(1);
  });

  it('test_admin_sources_form_blocks_invalid', async () => {
    const { server, user } = openSources();
    await openAddForm(user);
    expect(save().disabled).toBe(true);
    await user.type(field('Name'), 'FX News');
    await user.type(field('Web addresses'), 'fx-news.example');
    // No lean needs no evidence.
    expect(save().disabled).toBe(false);
    expect(screen.queryByLabelText('Evidence 1 link')).toBeNull();

    // A lean with no evidence.
    await user.selectOptions(field('Lean'), 'Center');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(EVIDENCE_REASON)).toBeTruthy();
    await user.click(save());

    // An http link.
    await user.type(field('Evidence 1 link'), 'http://evidence.example');
    await user.type(field('Evidence 1 note'), 'A note.');
    expect(save().disabled).toBe(true);
    expect(screen.getByText(EVIDENCE_REASON)).toBeTruthy();
    await user.click(save());
    await user.clear(field('Evidence 1 link'));
    await user.type(field('Evidence 1 link'), FX_EVIDENCE.url);
    expect(save().disabled).toBe(false);
    expect(screen.queryByText(EVIDENCE_REASON)).toBeNull();

    // Evidence rows up to the cap.
    for (let i = 1; i < MAX_OUTLET_EVIDENCE; i++) await user.click(screen.getByRole('button', { name: 'Add evidence' }));
    expect(screen.getByLabelText(`Evidence ${MAX_OUTLET_EVIDENCE} link`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add evidence' })).toBeNull();
    // Empty rows are not evidence: still valid.
    expect(save().disabled).toBe(false);

    // A web address that isn't one is named once the field is left.
    await user.clear(field('Web addresses'));
    await user.type(field('Web addresses'), 'not a site');
    await user.tab();
    expect(screen.getByText('Not a web address: not a site')).toBeTruthy();
    expect(save().disabled).toBe(true);
    await user.click(save());

    // Comma- or newline-separated, each read as a web address.
    await user.clear(field('Web addresses'));
    await user.type(field('Web addresses'), 'https://www.FX-News.example/today, fx-news.example{Enter}fxnews.example');
    expect(screen.queryByText(/^Not a web address/)).toBeNull();
    expect(save().disabled).toBe(false);

    await settle();
    expect(changes(server)).toEqual([]);
  });

  it('test_admin_sources_edit_and_remove', async () => {
    const { server, user } = openSources();

    // Edit: the form filled, the id read-only.
    await user.click(await screen.findByRole('button', { name: `Edit ${CENTER.name}` }));
    expect(field('Name').value).toBe(CENTER.name);
    expect(field('Id').value).toBe(CENTER.id);
    expect(field('Id').readOnly).toBe(true);
    await user.type(field('Id'), 'x');
    expect(field('Id').value).toBe(CENTER.id);
    expect(field('Web addresses').value).toBe(CENTER.domains.join('\n'));
    expect(field('Country').value).toBe(CENTER.country);
    expect(field('Lean').value).toBe('center');
    expect(field('Evidence 1 link').value).toBe(CENTER.lean?.evidence[0]?.url);
    expect(field('Evidence 1 note').value).toBe(CENTER.lean?.evidence[0]?.note);

    await user.selectOptions(field('Lean'), 'Leans left');
    await user.click(save());
    await waitFor(() => expect(cells(CENTER.id)[2]).toBe('Leans left'));
    const { changedOn: _, ...input } = CENTER;
    expect(changes(server)).toEqual([
      {
        method: 'POST',
        path: ADMIN_OUTLETS_PATH,
        body: {
          action: 'edit',
          baseVersion: '12',
          outlet: { ...input, lean: { bucket: 'lean-left', evidence: CENTER.lean?.evidence } },
        },
      },
    ]);
    expect(historyLines()[0]).toBe(`${TODAY} · Edited ${CENTER.name} (${CENTER.id}) · lean: Center → Leans left · by ${TOM}`);

    // Remove: asked first, and "Cancel" sends nothing.
    const question = 'Remove Fixture Right B? It leaves the published list now.';
    await user.click(screen.getByRole('button', { name: 'Remove Fixture Right B' }));
    expect(screen.getByText(question)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(question)).toBeNull();
    await settle();
    expect(changes(server)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Remove Fixture Right B' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(row('fx-right-b')).toBeNull());
    expect(changes(server)[1]).toEqual({
      method: 'POST',
      path: ADMIN_OUTLETS_PATH,
      body: { action: 'remove', baseVersion: '13', id: 'fx-right-b' },
    });
    expect(screen.queryByText(question)).toBeNull();
    expect(screen.getByText('Only 1 outlet in Right.')).toBeTruthy();
    expect(historyLines()[0]).toBe(`${TODAY} · Removed Fixture Right B (fx-right-b) · by ${TOM}`);
  });

  it('test_admin_sources_refusals', async () => {
    // 400: the server's message, which names the rule and the outlet; the form stays as typed.
    let { server, user } = openSources();
    await openAddForm(user);
    await user.type(field('Name'), 'FX News');
    await user.type(field('Web addresses'), CENTER.domains[0] ?? '');
    await user.click(save());
    const refused = await screen.findByText('fx-news: another outlet already lists one of its web addresses.');
    expect(refused.closest('.ua-banner')?.className).toContain('ua-banner--danger');
    expect(field('Name').value).toBe('FX News');
    expect(row('fx-news')).toBeNull();
    cleanup();

    // 409: said, with "Reload", which asks for the list again.
    ({ server, user } = openSources({ routes: { [`POST ${ADMIN_OUTLETS_PATH}`]: LIST_CHANGED } }));
    await user.click(await screen.findByRole('button', { name: 'Remove Fixture Right B' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(CHANGED)).toBeTruthy();
    expect(screen.queryByText(LIST_CHANGED.body.message)).toBeNull();
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByText(CHANGED)).toBeNull());
    expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(2);
    cleanup();

    // 404: said, and the list is asked for again at once.
    ({ server, user } = openSources({ routes: { [`POST ${ADMIN_OUTLETS_PATH}`]: OUTLET_GONE } }));
    await user.click(await screen.findByRole('button', { name: `Edit ${CENTER.name}` }));
    await user.selectOptions(field('Lean'), 'Leans left');
    await user.click(save());
    expect(await screen.findByText(GONE)).toBeTruthy();
    await waitFor(() => expect(server.count('GET', ADMIN_OUTLETS_PATH)).toBe(2));
    expect(screen.queryByLabelText('Name')).toBeNull();
    cleanup();

    // 401: back to the sign-in, saying so.
    ({ server, user } = openSources({ routes: { [`POST ${ADMIN_OUTLETS_PATH}`]: SESSION_GONE } }));
    await user.click(await screen.findByRole('button', { name: 'Remove Fixture Right B' }));
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(SIGNED_OUT)).toBeTruthy();
    expect(screen.getByText(SIGN_IN_INTRO)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('test_admin_sources_warnings_and_history', async () => {
    const noRight = LIST.outlets.filter((o) => o.lean?.bucket !== 'right');
    openSources({ sourceList: { ...LIST, outlets: noRight } });
    const notice = await screen.findByText(NOT_BALANCED);
    const banner = notice.closest('.ua-banner') as HTMLElement;
    expect(within(banner).getByText('No outlets in Right.')).toBeTruthy();
    expect(screen.getByText('Left 2 · Leans left 2 · Center 2 · Leans right 2 · Right 0')).toBeTruthy();

    // Every row has its buttons.
    const table = screen.getByRole('table');
    expect(
      within(within(table).getAllByRole('row')[0] as HTMLElement)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Outlet', 'Web addresses', 'Country', 'Lean', 'Evidence', 'Changed', 'Actions']);
    for (const outlet of noRight) {
      expect(screen.getByRole('button', { name: `Edit ${outlet.name}` })).toBeTruthy();
      expect(screen.getByRole('button', { name: `Remove ${outlet.name}` })).toBeTruthy();
    }

    // The history names who made each change; a deleted admin's change names no one.
    expect(historyLines()).toEqual([
      `Feb 3, 2026 · Edited ${CENTER.name} (${CENTER.id}) · lean: Not labelled → Center, evidence · by ${TOM}`,
      `Feb 2, 2026 · Added Fixture Left A (fx-left-a) · by ${TOM}`,
      'Feb 1, 2026 · Added Fixture Left B (fx-left-b)',
    ]);
  });
});
