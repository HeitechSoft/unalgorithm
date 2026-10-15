/**
 * The side-panel fact-check sheet (P3-08): the presentational `FactcheckSheet` renders claims, verdicts in words,
 * quoted sources and the AI caveat as plain text, and the side panel shows it from the tab's session entries (P3-06),
 * with Back, a "Fact-checks · N" row and live updates. Storage is the WXT fake browser with a stubbed active tab.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { emptyTabState } from '@unalgorithm/core';
import type { FactcheckResult } from '@unalgorithm/protocol';
import { FactcheckSheet, type FactcheckSheetProps } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
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

function result(overrides: Partial<FactcheckResult> = {}): FactcheckResult {
  return {
    v: 1,
    checkedAt: CHECKED_AT,
    model: 'claude-sonnet-5-5',
    promptVersion: 1,
    claims: [
      {
        id: 'c1',
        claim: 'The bridge opened in 1932.',
        verdict: 'supported',
        explanation: 'Two archives date the opening to March 1932.',
        citations: [
          { sourceId: 's1', quote: 'The bridge was opened on 19 March 1932.' },
          { sourceId: 's2', quote: 'Opened to traffic in March 1932.' },
        ],
      },
      {
        id: 'c2',
        claim: 'It is the longest bridge in the world.',
        verdict: 'disputed',
        explanation: 'Several bridges are longer.',
        citations: [],
      },
      {
        id: 'c3',
        claim: 'It cost nothing to build.',
        verdict: 'needs-context',
        explanation: 'Construction was paid off by tolls.',
        citations: [],
      },
    ],
    sources: [
      {
        id: 's1',
        url: 'https://archive.example.org/bridge',
        domain: 'archive.example.org',
        title: 'Bridge history',
        pageAge: null,
      },
      { id: 's2', url: 'https://news.example.com/1932', domain: 'news.example.com', title: 'Opening day', pageAge: null },
    ],
    ...overrides,
  };
}

function sheet(props: Partial<FactcheckSheetProps> = {}) {
  const onBack = vi.fn();
  render(<FactcheckSheet label="A post about a bridge" status="done" result={result()} onBack={onBack} {...props} />);
  return { onBack };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FactcheckSheet', () => {
  it('test_sheet_renders_claims_labels_and_explanations', () => {
    sheet();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const expected = [
      ['The bridge opened in 1932.', 'Supported', 'Two archives date the opening to March 1932.'],
      ['It is the longest bridge in the world.', 'Disputed', 'Several bridges are longer.'],
      ['It cost nothing to build.', 'Needs context', 'Construction was paid off by tolls.'],
    ];
    expected.forEach(([claim, label, explanation], i) => {
      const item = within(items[i] as HTMLElement);
      expect(item.getByText(claim as string)).toBeTruthy();
      expect(item.getByText(label as string)).toBeTruthy();
      expect(item.getByText(explanation as string)).toBeTruthy();
    });
  });

  it('test_sheet_citation_link_is_safe_and_complete', () => {
    sheet();
    expect(screen.getByText('The bridge was opened on 19 March 1932.').tagName).toBe('BLOCKQUOTE');
    expect(screen.getByText('Opened to traffic in March 1932.').tagName).toBe('BLOCKQUOTE');
    const link = screen.getByRole('link', { name: /Bridge history/ });
    expect(link.getAttribute('href')).toBe('https://archive.example.org/bridge');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(link).getByText('archive.example.org')).toBeTruthy();
    const second = screen.getByRole('link', { name: /Opening day/ });
    expect(second.getAttribute('href')).toBe('https://news.example.com/1932');
    expect(within(second).getByText('news.example.com')).toBeTruthy();
  });

  it('test_sheet_shows_ai_label_caveat_and_checked_time', () => {
    sheet();
    expect(screen.getByText('AI-generated')).toBeTruthy();
    expect(screen.getByText('AI can be wrong, so open the sources.')).toBeTruthy();
    const when = new Date(CHECKED_AT).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect(screen.getByText(`Checked ${when}`)).toBeTruthy();
  });

  it('test_sheet_shows_downgrade_note', () => {
    const r = result();
    r.claims = [
      {
        id: 'c1',
        claim: 'The bridge opened in 1932.',
        verdict: 'unverifiable',
        explanation: 'Only one site reports this.',
        citations: [{ sourceId: 's1', quote: 'The bridge was opened on 19 March 1932.' }],
        downgraded: 'too-few-domains',
      },
    ];
    sheet({ result: r });
    expect(screen.getByText("Can't verify")).toBeTruthy();
    expect(screen.getByText('Fewer than two independent sources.')).toBeTruthy();
  });

  it('test_sheet_empty_claims_state', () => {
    sheet({ result: result({ claims: [], sources: [] }) });
    expect(screen.getByText('No checkable claims found')).toBeTruthy();
    expect(screen.getByText("This post doesn't make a factual claim we can check.")).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('test_sheet_running_and_failed_states', () => {
    sheet({ status: 'running', result: undefined });
    const running = screen.getByText(/Checking facts…/);
    expect(running.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByText('AI can be wrong, so open the sources.')).toBeNull();
    cleanup();

    sheet({ status: 'failed', result: undefined, errorMessage: 'Your Anthropic key was refused.' });
    const banner = screen.getByRole('status');
    expect(banner.className).toContain('ua-banner--warning');
    expect(within(banner).getByText('Your Anthropic key was refused.')).toBeTruthy();
  });

  it('test_sheet_renders_html_in_quotes_as_text', () => {
    const html = '<img src=x onerror=alert(1)>';
    const r = result();
    r.claims = [{ ...r.claims[0]!, claim: html, explanation: html, citations: [{ sourceId: 's1', quote: html }] }];
    r.sources = [{ ...r.sources[0]!, title: html }];
    const { container } = render(<FactcheckSheet label={html} status="done" result={r} onBack={() => {}} />);
    expect(screen.getAllByText(html).length).toBeGreaterThanOrEqual(4);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('side panel', () => {
  const TAB = { id: 7, url: 'https://www.linkedin.com/feed/', windowId: 1 };

  const entry = (overrides: Partial<FactcheckEntry> = {}): FactcheckEntry => ({
    key: 'li:1' as FactcheckEntry['key'],
    label: 'A post about a bridge',
    startedAt: Date.now() - 60_000,
    status: 'done',
    result: result(),
    ...overrides,
  });

  beforeEach(async () => {
    fakeBrowser.reset();
    // `as never`: spyOn picks the callback overloads. The fake browser has no focused window to answer `query` from.
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async () => [{ ...TAB, active: true }]) as never);
    await tabStateItem(TAB.id).setValue({ ...emptyTabState(), onFeed: true });
  });

  it('test_sidepanel_shows_sheet_back_and_reopen_row', async () => {
    const user = setupUser();
    await factcheckItem(TAB.id).setValue({ entries: [entry()] });
    render(<SidePanel />);
    expect(await screen.findByRole('heading', { name: 'Fact-check' })).toBeTruthy();
    expect(screen.getByText('The bridge opened in 1932.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Highlights' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fact-check' })).toBeNull();
    const row = screen.getByRole('button', { name: 'Fact-checks · 1' });

    await user.click(row);
    expect(screen.getByRole('heading', { name: 'Fact-check' })).toBeTruthy();
    expect(screen.getByText('The bridge opened in 1932.')).toBeTruthy();
  });

  it('test_sidepanel_updates_running_to_done', async () => {
    const running = entry({ status: 'running', result: undefined });
    await factcheckItem(TAB.id).setValue({ entries: [running] });
    render(<SidePanel />);
    expect(await screen.findByText(/Checking facts…/)).toBeTruthy();

    await act(async () => {
      await factcheckItem(TAB.id).setValue({ entries: [{ ...running, status: 'done', result: result() }] });
    });
    await waitFor(() => expect(screen.getByText('The bridge opened in 1932.')).toBeTruthy());
    expect(screen.queryByText(/Checking facts…/)).toBeNull();
    expect(screen.getByText('AI can be wrong, so open the sources.')).toBeTruthy();
  });
});
