/**
 * The side-panel UnEcho Chamber sheet (P3-39, P3-77): coverage by lean bucket with every gap named, agreed facts,
 * differences and one-side claims with their quoted sources, the AI label, which source list the leans came from and its
 * balance warnings, all as plain text; the side panel picks it for a `task: 'perspectives'` entry. Outlets are
 * fictional fixtures.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { emptyTabState } from '@unalgorithm/core';
import { type FactcheckResult, type LeanBucket, type PerspectivesResult, SOURCE_LIST_PAGE_URL } from '@unalgorithm/protocol';
import { PerspectivesSheet, type PerspectivesSheetProps } from '@unalgorithm/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { App as SidePanel } from '../src/entrypoints/sidepanel/App.tsx';
import { type FactcheckEntry, factcheckItem, tabStateItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendToTab: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

const CHECKED_AT = '2026-10-14T09:30:00.000Z';

const source = (id: string, bucket: LeanBucket, outlet: string, title: string) => ({
  id,
  url: `https://${outlet.toLowerCase().replace(/\s+/g, '')}.example/${id}`,
  domain: `${outlet.toLowerCase().replace(/\s+/g, '')}.example`,
  title,
  pageAge: '2026-10-12T08:00:00.000Z',
  outletId: outlet.toLowerCase().replace(/\s+/g, '-'),
  outlet,
  bucket,
});

function result(overrides: Partial<PerspectivesResult> = {}): PerspectivesResult {
  return {
    v: 1,
    checkedAt: CHECKED_AT,
    model: 'claude-sonnet-5-5',
    promptVersion: 1,
    registryVersion: 'fixture-1',
    list: 'cloud',
    story: {
      url: 'https://story.example/harbour-bridge',
      query: 'Harbour bridge reopens after repairs',
      from: '2026-10-09T00:00:00.000Z',
      to: '2026-10-15T00:00:00.000Z',
    },
    coverage: [
      { bucket: 'left', sourceIds: ['s1'] },
      { bucket: 'lean-left', sourceIds: [] },
      { bucket: 'center', sourceIds: ['s2'] },
      { bucket: 'lean-right', sourceIds: [] },
      { bucket: 'right', sourceIds: ['s3'] },
    ],
    agreed: [
      {
        text: 'The bridge reopened on Monday.',
        citations: [
          { sourceId: 's1', quote: 'Traffic returned to the bridge on Monday.' },
          { sourceId: 's3', quote: 'The span reopened Monday morning.' },
        ],
      },
    ],
    differences: [
      {
        kind: 'framing',
        text: 'One side frames the repairs as overdue.',
        citations: [{ sourceId: 's1', quote: 'Years of delay finally ended.' }],
      },
    ],
    unique: [
      {
        text: 'Tolls will rise next year.',
        citations: [{ sourceId: 's3', quote: 'Tolls are set to rise in January.' }],
      },
    ],
    sources: [
      source('s1', 'left', 'Northwind Daily', 'Bridge back in service'),
      source('s2', 'center', 'Meridian Wire', 'Harbour bridge reopens'),
      source('s3', 'right', 'Summit Courier', 'Repairs done, tolls next'),
    ],
    ...overrides,
  };
}

function sheet(props: Partial<PerspectivesSheetProps> = {}) {
  return render(
    <PerspectivesSheet label="Harbour bridge reopens" status="done" result={result()} onBack={() => {}} {...props} />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PerspectivesSheet', () => {
  it('test_perspectives_sheet_running_and_failed', () => {
    sheet({ status: 'running', result: undefined });
    const running = screen.getByText('Comparing coverage… This can take up to a minute.');
    expect(running.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByText('AI can be wrong, so open the sources.')).toBeNull();
    cleanup();

    sheet({ status: 'failed', result: undefined, errorMessage: 'The search service was unavailable.' });
    const banner = screen.getByRole('status');
    expect(banner.className).toContain('ua-banner--warning');
    expect(within(banner).getByText("The comparison didn't finish")).toBeTruthy();
    expect(within(banner).getByText('The search service was unavailable.')).toBeTruthy();
  });

  it('test_perspectives_sheet_coverage_and_gaps', () => {
    sheet();
    expect(screen.getByText('Harbour bridge reopens after repairs')).toBeTruthy();
    const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
    expect(
      screen.getByText(`Coverage from ${day('2026-10-09T00:00:00.000Z')} to ${day('2026-10-15T00:00:00.000Z')}`),
    ).toBeTruthy();

    const rows = [...screen.getByRole('list', { name: 'Coverage by lean' }).children] as HTMLElement[];
    expect(rows.map((r) => r.querySelector('.ua-perspectives-bucket-label')?.textContent)).toEqual([
      'Left',
      'Leans left',
      'Center',
      'Leans right',
      'Right',
    ]);
    expect(within(rows[1]!).getByText('No coverage found')).toBeTruthy();
    expect(within(rows[3]!).getByText('No coverage found')).toBeTruthy();
    expect(within(rows[0]!).queryByText('No coverage found')).toBeNull();
    expect(within(rows[0]!).getByText('Northwind Daily')).toBeTruthy();
    const link = within(rows[0]!).getByRole('link', { name: /Bridge back in service/ });
    expect(link.getAttribute('href')).toBe('https://northwinddaily.example/s1');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(rows[0]!).getByText(day('2026-10-12T08:00:00.000Z'))).toBeTruthy();
    expect(screen.getByText('No coverage found from: Leans left, Leans right.')).toBeTruthy();
  });

  it('test_perspectives_sheet_all_gaps_empty_state', () => {
    const r = result({
      coverage: result().coverage.map((c) => ({ ...c, sourceIds: [] })),
      agreed: [],
      differences: [],
      unique: [],
      sources: [],
    });
    sheet({ result: r });
    expect(screen.getByText('No coverage found')).toBeTruthy();
    expect(screen.getByText('None of the outlets in our list covered this story in these dates.')).toBeTruthy();
    for (const title of ['Agreed across sides', 'Differences', 'Only one side reported']) {
      expect(screen.queryByRole('heading', { name: title })).toBeNull();
    }
  });

  it('test_perspectives_sheet_agreed_citations', () => {
    sheet();
    const section = screen.getByRole('region', { name: 'Agreed across sides' });
    const s = within(section);
    expect(s.getByText('The bridge reopened on Monday.')).toBeTruthy();
    expect(s.getByText('Traffic returned to the bridge on Monday.').tagName).toBe('BLOCKQUOTE');
    expect(s.getByText('The span reopened Monday morning.').tagName).toBe('BLOCKQUOTE');
    expect(s.getByText('Northwind Daily')).toBeTruthy();
    expect(s.getByText('Summit Courier')).toBeTruthy();
    const link = s.getByRole('link', { name: /Bridge back in service/ });
    expect(link.getAttribute('href')).toBe('https://northwinddaily.example/s1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(s.getByRole('link', { name: /Repairs done, tolls next/ }).getAttribute('href')).toBe(
      'https://summitcourier.example/s3',
    );
  });

  it('test_perspectives_sheet_differences_and_unique_labels', () => {
    sheet();
    const diff = within(screen.getByRole('region', { name: 'Differences' }));
    expect(diff.getByText('Framing')).toBeTruthy();
    expect(diff.getByText('One side frames the repairs as overdue.')).toBeTruthy();
    const unique = within(screen.getByRole('region', { name: 'Only one side reported' }));
    expect(unique.getByText('Tolls will rise next year.')).toBeTruthy();
    expect(unique.getByText('Right')).toBeTruthy();
  });

  it('test_perspectives_sheet_footer_labels', () => {
    sheet();
    const region = screen.getByRole('region', { name: 'UnEcho Chamber' });
    expect(within(region).getByRole('heading', { level: 2 }).textContent).toBe('UnEcho Chamber');
    expect(screen.getByText('AI-generated')).toBeTruthy();
    const when = new Date(CHECKED_AT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect(screen.getByText(`Compared ${when}`)).toBeTruthy();
    expect(screen.getByText('AI can be wrong, so open the sources.')).toBeTruthy();
  });

  it('test_perspectives_sheet_footer_by_list', async () => {
    // UnAlgorithm Cloud's list: its version, set by people with evidence. Balanced: no notice.
    sheet({ result: result({ registryVersion: '57' }), listWarnings: [] });
    expect(
      screen.getByText("Leans come from UnAlgorithm Cloud's source list (version 57), set by people with evidence, never by AI."),
    ).toBeTruthy();
    expect(screen.queryByText(/your own source list/)).toBeNull();
    expect(screen.queryByText(/isn't balanced/)).toBeNull();
    cleanup();

    // Your own list: unreviewed, and its warnings as they were when the run started, above the footer.
    sheet({ result: result({ list: 'own', registryVersion: '' }), listWarnings: ['No outlets in Right.'] });
    const footer = screen.getByText('Leans come from your own source list, which no one has reviewed. Never from AI.');
    expect(screen.queryByText(/UnAlgorithm Cloud's source list/)).toBeNull();
    const notice = screen.getByRole('status');
    expect(within(notice).getByText("Your list isn't balanced")).toBeTruthy();
    expect(within(notice).getByText('No outlets in Right.')).toBeTruthy();
    expect(notice.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();

    // The Cloud's list with warnings: named as the Cloud's.
    sheet({ result: result(), listWarnings: ['Only 1 outlet in Center.'] });
    expect(within(screen.getByRole('status')).getByText("UnAlgorithm Cloud's list isn't balanced")).toBeTruthy();
    cleanup();

    // The side panel passes the entry's warnings.
    fakeBrowser.reset();
    const TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 1 };
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ ...TAB, active: true }]) as never);
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '9.8.7' } as never);
    await tabStateItem(TAB.id).setValue({ ...emptyTabState(), onFeed: true });
    const entry: FactcheckEntry = {
      key: 'li:1' as FactcheckEntry['key'],
      task: 'perspectives',
      label: 'Harbour bridge reopens',
      startedAt: Date.now(),
      status: 'done',
      perspectives: result({ list: 'own', registryVersion: '' }),
      listWarnings: ['No outlets in Right.'],
    };
    await factcheckItem(TAB.id).setValue({ entries: [entry] });
    render(<SidePanel />);
    expect(await screen.findByText("Your list isn't balanced")).toBeTruthy();
    expect(screen.getByText('No outlets in Right.')).toBeTruthy();
    expect(screen.getByText('Leans come from your own source list, which no one has reviewed. Never from AI.')).toBeTruthy();
  });

  it('test_perspectives_sheet_source_list_link_for_cloud_only', async () => {
    const CLOUD_LINE = "Leans come from UnAlgorithm Cloud's source list (version 57), set by people with evidence, never by AI.";
    const OWN_LINE = 'Leans come from your own source list, which no one has reviewed. Never from AI.';
    const leansLine = (container: HTMLElement) =>
      [...(container.querySelector('.ua-factcheck-foot') as HTMLElement).children].find((c) =>
        c.textContent?.startsWith('Leans come from'),
      ) as HTMLElement;

    // A Cloud result with `listHref`: the list's name in the footer sentence is the link, the sentence unchanged.
    const cloud = sheet({ result: result({ registryVersion: '57' }), listHref: SOURCE_LIST_PAGE_URL });
    const link = screen.getByRole('link', { name: "UnAlgorithm Cloud's source list" });
    expect(link.getAttribute('href')).toBe('https://cloud.unalgorithm.app/outlets');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const line = leansLine(cloud.container);
    expect(link.parentElement).toBe(line);
    expect(line.textContent).toBe(CLOUD_LINE);
    cleanup();

    // An own-list result never links: it is the person's list.
    const own = sheet({ result: result({ list: 'own', registryVersion: '' }), listHref: SOURCE_LIST_PAGE_URL });
    expect(leansLine(own.container).textContent).toBe(OWN_LINE);
    expect(leansLine(own.container).querySelector('a')).toBeNull();
    expect(screen.queryByRole('link', { name: /source list/ })).toBeNull();
    cleanup();

    // Without `listHref` the Cloud's sentence is plain text.
    const plain = sheet({ result: result({ registryVersion: '57' }) });
    expect(screen.getByText(CLOUD_LINE)).toBe(leansLine(plain.container));
    expect(screen.queryByRole('link', { name: /source list/ })).toBeNull();
    cleanup();

    // The footer's links follow the existing lines, in one line of their own.
    const links = [
      { text: 'How UnEcho Chamber works', href: 'https://unalgorithmfeed.com/methodology' },
      { text: 'Report a mistake', href: 'https://github.com/HeitechSoft/unalgorithm/issues/new?template=correction.yml' },
    ];
    const linked = sheet({ links });
    const foot = linked.container.querySelector('.ua-factcheck-foot') as HTMLElement;
    expect(foot.lastElementChild?.textContent).toBe('How UnEcho Chamber works · Report a mistake');
    for (const { text, href } of links) {
      const a = within(foot).getByRole('link', { name: text });
      expect(a.getAttribute('href')).toBe(href);
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    cleanup();

    // The side panel passes the Cloud list's page and the links for a Cloud comparison.
    fakeBrowser.reset();
    const TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 1 };
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ ...TAB, active: true }]) as never);
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '9.8.7' } as never);
    await tabStateItem(TAB.id).setValue({ ...emptyTabState(), onFeed: true });
    await factcheckItem(TAB.id).setValue({
      entries: [
        {
          key: 'li:1' as FactcheckEntry['key'],
          task: 'perspectives',
          label: 'Harbour bridge reopens',
          startedAt: Date.now(),
          status: 'done',
          perspectives: result({ registryVersion: '57' }),
          listWarnings: [],
        },
      ],
    });
    render(<SidePanel />);
    const panelLink = await screen.findByRole('link', { name: "UnAlgorithm Cloud's source list" });
    expect(panelLink.getAttribute('href')).toBe(SOURCE_LIST_PAGE_URL);
    const report = new URL(screen.getByRole('link', { name: 'Report a mistake' }).getAttribute('href') as string);
    expect(report.searchParams.get('feature')).toBe('UnEcho Chamber');
    expect(report.searchParams.get('list')).toBe("UnAlgorithm Cloud's list");
    expect(report.searchParams.get('version')).toBe('9.8.7');
    expect(screen.getByRole('link', { name: 'How UnEcho Chamber works' })).toBeTruthy();
  });

  it('test_perspectives_sheet_text_only', () => {
    const html = '<img src=x onerror=alert(1)>';
    const r = result();
    r.agreed = [{ text: html, citations: [{ sourceId: 's1', quote: html }] }];
    r.differences = [{ ...r.differences[0]!, text: html }];
    r.unique = [{ ...r.unique[0]!, text: html }];
    r.story = { ...r.story, query: html };
    r.sources = r.sources.map((s) => ({ ...s, title: html, outlet: html }));
    const { container } = sheet({ label: html, result: r });
    expect(screen.getAllByText(html).length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('side panel', () => {
  const TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 1 };
  const factcheck: FactcheckResult = {
    v: 1,
    checkedAt: CHECKED_AT,
    model: 'claude-sonnet-5-5',
    promptVersion: 1,
    claims: [
      { id: 'c1', claim: 'The bridge opened in 1932.', verdict: 'supported', explanation: 'Archives agree.', citations: [] },
    ],
    sources: [],
  };
  const entry = (overrides: Partial<FactcheckEntry> = {}): FactcheckEntry => ({
    key: 'li:1' as FactcheckEntry['key'],
    label: 'A post about a bridge',
    startedAt: Date.now() - 60_000,
    status: 'done',
    result: factcheck,
    ...overrides,
  });

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ ...TAB, active: true }]) as never);
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ version: '9.8.7' } as never);
    await tabStateItem(TAB.id).setValue({ ...emptyTabState(), onFeed: true });
  });

  it('test_side_panel_picks_sheet_by_task', async () => {
    const older = entry({ startedAt: Date.now() - 120_000 });
    const comparison = entry({
      task: 'perspectives',
      label: 'Harbour bridge reopens',
      result: undefined,
      perspectives: result(),
    });
    await factcheckItem(TAB.id).setValue({ entries: [comparison, older] });
    render(<SidePanel />);
    expect(await screen.findByRole('heading', { name: 'UnEcho Chamber' })).toBeTruthy();
    expect(screen.getByText('The bridge reopened on Monday.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fact-check' })).toBeNull();
    cleanup();

    await factcheckItem(TAB.id).setValue({ entries: [entry({ startedAt: Date.now() }), comparison] });
    render(<SidePanel />);
    expect(await screen.findByRole('heading', { name: 'Fact-check' })).toBeTruthy();
    expect(screen.getByText('The bridge opened in 1932.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'UnEcho Chamber: Harbour bridge reopens' })).toBeTruthy();
  });
});
