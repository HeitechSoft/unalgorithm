import { type HealthReport, VisibleClock } from '@unalgorithm/core';
import type { InspectResult, PlatformAdapter } from '@unalgorithm/platforms';
import type { PageDiagnostics, ReportSource } from './feed-controller.ts';

/** Probes at these points of visible time; two that pass mean the page is a feed unAlgorithm didn't start on. */
export const WATCHDOG_PROBES_MS = [5_000, 12_000, 19_000] as const;
/** The watchdog stops probing after this much visible time: a page that isn't a feed by then isn't one. */
export const WATCHDOG_STOP_MS = 25_000;
const PASSES_NEEDED = 2;
const MIN_ITEMS = 3;
const MIN_AUTHORED = 2;
/** Only the first items are read: enough to tell, and cheap. */
const SAMPLE = 10;
const TICK_MS = 1000;

/** What the watchdog found: the issue, and what a report may say about the page (counts and landmarks only). */
export interface WatchdogFinding {
  issues: ['feed-not-started'];
  counts: Record<string, number>;
  landmarks: Record<string, number>;
}

export interface WatchdogOptions {
  adapter: PlatformAdapter;
  doc?: Document;
  /** Called once, after two passing probes. */
  onFeedLike(finding: WatchdogFinding): void;
}

/** A running watchdog, and the page facts a report draft may read from it. */
export interface Watchdog extends ReportSource {
  /** Two probes passed: this page is a feed. */
  readonly feedLike: boolean;
  stop(): void;
}

interface Probe {
  pass: boolean;
  counts: Record<string, number>;
  scope: HTMLElement | null;
}

/**
 * Read the page the way the controller would, without changing anything (ADR 0002): the feed scope, its items, and
 * the first few inspected. It passes with a scope, at least 3 items, and at least 2 posts with an author among the
 * first 10. Adapter exceptions only fail the probe.
 */
function probe(adapter: PlatformAdapter, doc: Document): Probe {
  const counts = { items: 0, posts: 0, modules: 0, pending: 0 };
  const quiet = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const scope = quiet(() => adapter.feedScope(doc), null);
  if (!scope) return { pass: false, counts, scope };
  const items = quiet(() => adapter.findItems(scope), [] as HTMLElement[]);
  counts.items = items.length;
  const lang = doc.documentElement.lang || 'en';
  const ctx = { markers: quiet(() => adapter.markersFor(lang), null), now: new Date() };
  let authored = 0;
  for (const el of items.slice(0, SAMPLE)) {
    const res = quiet<InspectResult>(() => adapter.inspect(el, ctx), { kind: 'ignore' });
    if (res.kind === 'post') {
      counts.posts++;
      if (res.post.quality.authorFound) authored++;
    } else if (res.kind === 'module') counts.modules++;
    else if (res.kind === 'pending') counts.pending++;
  }
  return { pass: items.length >= MIN_ITEMS && authored >= MIN_AUTHORED, counts, scope };
}

/**
 * The watchdog for a page that may be the feed at an address unAlgorithm doesn't know, without a strong home signature
 * (ADR 0009 §3). It probes at 5 s, 12 s and 19 s of *visible* time and stops at 25 s; two passing probes raise
 * `feed-not-started`. It only reads the page: nothing is hidden, nothing goes to AI, and no statistics are kept. The
 * caller decides what to show (the popup's state, the notice-only layer).
 */
export function startWatchdog({ adapter, doc = document, onFeedLike }: WatchdogOptions): Watchdog {
  const clock = new VisibleClock(doc.visibilityState === 'visible');
  let next = 0;
  let passes = 0;
  let feedLike = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const onVisibility = () => clock.setVisible(doc.visibilityState === 'visible');
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
  const tick = () => {
    const visible = clock.ms();
    while (!stopped && next < WATCHDOG_PROBES_MS.length && visible >= (WATCHDOG_PROBES_MS[next] ?? Number.POSITIVE_INFINITY)) {
      next++;
      const p = probe(adapter, doc);
      if (p.pass) passes++;
      if (passes >= PASSES_NEEDED) {
        feedLike = true;
        stop();
        onFeedLike({ issues: ['feed-not-started'], counts: p.counts, landmarks: landmarksOf(p.scope) });
        return;
      }
    }
    if (visible >= WATCHDOG_STOP_MS || next >= WATCHDOG_PROBES_MS.length) stop();
  };
  const landmarksOf = (scope: HTMLElement | null): Record<string, number> => {
    try {
      return adapter.probe(doc, scope);
    } catch {
      return {};
    }
  };

  doc.addEventListener('visibilitychange', onVisibility);
  timer = setInterval(tick, TICK_MS);

  return {
    get feedLike() {
      return feedLike;
    },
    stop,
    getHealth(): HealthReport {
      return feedLike
        ? { status: 'not-started', issues: ['feed-not-started'], degraded: [], notice: 'not-running' }
        : { status: 'not-started', issues: [], degraded: [] };
    },
    /** Read at the moment of the click, like the controller's: counts and landmarks only. */
    diagnostics(): PageDiagnostics {
      const p = probe(adapter, doc);
      return { counts: p.counts, landmarks: landmarksOf(p.scope) };
    },
  };
}
