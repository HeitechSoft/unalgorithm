/**
 * The side-panel "Other perspectives" sheet (P3-39): coverage by lean bucket with every gap named, agreed facts,
 * differences and one-side claims with their quoted sources, the AI and registry labels, all as plain text; the side
 * panel picks it for a `task: 'perspectives'` entry. Outlets are fictional fixtures.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { emptyTabState } from '@unalgorithm/core';
import type { FactcheckResult, LeanBucket, PerspectivesResult } from '@unalgorithm/protocol';
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
    expect(
      screen.getByText('Leans come from the UnAlgorithm outlet registry (fixture-1), reviewed by people, never from AI.'),
    ).toBeTruthy();
    expect(screen.getByText('AI can be wrong, so open the sources.')).toBeTruthy();
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
