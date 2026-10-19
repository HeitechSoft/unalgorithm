/**
 * The watchdog (ADR 0009 §3): on an address that may be the feed but has no strong home signature, it probes the page
 * at 5 s, 12 s and 19 s of visible time, read-only, and two passing probes raise `feed-not-started`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linkedinAdapter, type PlatformAdapter } from '@unalgorithm/platforms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_DEGREE_POST, FOLLOWING_POST } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { startWatchdog, WATCHDOG_STOP_MS, type WatchdogFinding } from '../src/content/watchdog.ts';

/** The first `keep` children of the capture's feed list: the probes read 10 items at most, and the rest only costs time. */
function firstOf(html: string, keep: number): string {
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const extra of Array.from(t.content.querySelector('main > [role="list"]')?.children ?? []).slice(keep)) extra.remove();
  return t.innerHTML;
}

/**
 * The For you capture without what makes a strong home signature (`mainFeed`, `FeedType_MAIN_FEED` card keys): the
 * case where the controller doesn't start and the watchdog watches.
 */
const FOR_YOU = firstOf(
  readFileSync(join(import.meta.dirname, '../../../packages/platforms/fixtures/linkedin/2026-10-foryou-1.html'), 'utf8')
    .replaceAll('data-testid="mainFeed"', '')
    .replaceAll('FeedType_MAIN_FEED', 'FeedType_X'),
  14,
);

/** A profile page: the person's header, About, and two posts in their activity. Not a feed. */
const PROFILE = `<main>
  <section><h1>Riley Quinn</h1><p>Product designer</p></section>
  <section><h2>About</h2><p>Designs forms people finish.</p></section>
  <section><h2>Activity</h2>${FIRST_DEGREE_POST}${FOLLOWING_POST}</section>
</main>`;

/** The adapter, with every read counted: the watchdog only reads. */
function spied(): { adapter: PlatformAdapter; inspect: ReturnType<typeof vi.fn> } {
  const inspect = vi.fn(linkedinAdapter.inspect.bind(linkedinAdapter));
  return { adapter: { ...linkedinAdapter, inspect } as PlatformAdapter, inspect };
}

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
  history.replaceState(null, '', '/feed/newname/');
});
afterEach(() => {
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

// A real capture, read by the real adapter several times per case: generous room when the machine is busy.
describe('watchdog', { timeout: 30_000 }, () => {
  it('test_for_you_feed_under_a_candidate_address_is_feed_like_after_12s_visible', () => {
    document.body.innerHTML = FOR_YOU;
    const before = document.body.innerHTML;
    const onFeedLike = vi.fn<(f: WatchdogFinding) => void>();
    const w = startWatchdog({ adapter: linkedinAdapter, onFeedLike });
    expect(w.getHealth()).toStrictEqual({ status: 'not-started', issues: [], degraded: [] });
    vi.advanceTimersByTime(11_999);
    expect(onFeedLike).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFeedLike).toHaveBeenCalledTimes(1);
    const finding = onFeedLike.mock.calls[0]?.[0];
    expect(finding?.issues).toEqual(['feed-not-started']);
    expect(finding?.counts.items).toBeGreaterThanOrEqual(3);
    expect(finding?.counts.posts).toBeGreaterThanOrEqual(2);
    expect(finding?.landmarks).toMatchObject({ main: 1 });
    expect(w.feedLike).toBe(true);
    expect(w.getHealth()).toStrictEqual({
      status: 'not-started',
      issues: ['feed-not-started'],
      degraded: [],
      notice: 'not-running',
    });
    // Read-only: nothing hidden, no UI, the page exactly as it was.
    expect(document.body.innerHTML).toBe(before);
    vi.advanceTimersByTime(60_000);
    expect(onFeedLike).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('test_report_source_has_counts_and_landmarks_only', () => {
    document.body.innerHTML = FOR_YOU;
    const w = startWatchdog({ adapter: linkedinAdapter, onFeedLike: () => undefined });
    const d = w.diagnostics();
    expect(Object.keys(d).sort()).toEqual(['counts', 'landmarks']);
    expect(Object.keys(d.counts).sort()).toEqual(['items', 'modules', 'pending', 'posts']);
    // Numbers, never content: no name, link or card key from the page.
    expect(JSON.stringify(d)).not.toMatch(/linkedin\.com|componentkey|k1000|Xxxx/);
    w.stop();
  });

  it('test_hidden_tab_raises_nothing', () => {
    document.body.innerHTML = FOR_YOU;
    setVisibility('hidden');
    const { adapter, inspect } = spied();
    const onFeedLike = vi.fn();
    const w = startWatchdog({ adapter, onFeedLike });
    vi.advanceTimersByTime(120_000);
    expect(onFeedLike).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    // Visible time starts when the person looks at the tab.
    setVisibility('visible');
    vi.advanceTimersByTime(12_000);
    expect(onFeedLike).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('test_profile_page_raises_nothing', () => {
    history.replaceState(null, '', '/in/riley-quinn/');
    document.body.innerHTML = PROFILE;
    const { adapter, inspect } = spied();
    const onFeedLike = vi.fn();
    const w = startWatchdog({ adapter, onFeedLike });
    vi.advanceTimersByTime(WATCHDOG_STOP_MS);
    expect(onFeedLike).not.toHaveBeenCalled();
    expect(w.feedLike).toBe(false);
    // It stopped: no more reads, however long the page stays open.
    const reads = inspect.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    expect(inspect.mock.calls.length).toBe(reads);
    w.stop();
  });

  it('test_slow_feed_passes_on_the_later_probes', () => {
    document.body.innerHTML = '<main></main>';
    const onFeedLike = vi.fn();
    const w = startWatchdog({ adapter: linkedinAdapter, onFeedLike });
    vi.advanceTimersByTime(8_000);
    // The feed arrives after the first probe failed.
    document.body.innerHTML = FOR_YOU;
    vi.advanceTimersByTime(10_000);
    expect(onFeedLike).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onFeedLike).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('test_adapter_exceptions_only_fail_the_probe', () => {
    document.body.innerHTML = FOR_YOU;
    const onFeedLike = vi.fn();
    const broken = {
      ...linkedinAdapter,
      findItems: () => {
        throw new Error('layout changed');
      },
    } as PlatformAdapter;
    const w = startWatchdog({ adapter: broken, onFeedLike });
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(onFeedLike).not.toHaveBeenCalled();
    expect(w.diagnostics().counts.items).toBe(0);
    w.stop();
  });

  it('test_stop_ends_probing', () => {
    document.body.innerHTML = FOR_YOU;
    const { adapter, inspect } = spied();
    const onFeedLike = vi.fn();
    const w = startWatchdog({ adapter, onFeedLike });
    vi.advanceTimersByTime(6_000);
    const reads = inspect.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    // Navigated away, or the controller started.
    w.stop();
    vi.advanceTimersByTime(30_000);
    expect(inspect.mock.calls.length).toBe(reads);
    expect(onFeedLike).not.toHaveBeenCalled();
  });
});
