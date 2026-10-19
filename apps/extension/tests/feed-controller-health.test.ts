/**
 * The controller's breakage checks (ADR 0009 §3, §9): adapter exceptions caught and counted, offscreen slots,
 * visible time, cautious mode, the notice card's debounce and snoozes, and what a report can read from the page.
 *
 * A small fake adapter reads items from data attributes, so each case sets up exactly the page it needs.
 */
import { defaultDevice, defaultSettings, EMPTY_LEARNED, NO_SIGNALS, type PostData } from '@unalgorithm/core';
import type { InspectResult, PlatformAdapter } from '@unalgorithm/platforms';
import type { PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';

const ADAPTER = 'linkedin@2026.10.2';
const DAY = 24 * 60 * 60 * 1000;

interface Item {
  key: string;
  /** post (default), pending, offscreen, module, ignore, or throw (inspect throws). */
  kind?: 'post' | 'pending' | 'offscreen' | 'module' | 'ignore' | 'throw';
  ad?: boolean;
  /** Strength of the ad evidence (default strong). */
  strength?: 'strong' | 'medium' | 'weak';
  rel?: 'followed' | 'not-followed' | 'unknown';
  nearMiss?: string;
  obs?: string;
}

function itemHtml(i: Item): string {
  const attrs = Object.entries(i)
    .filter(([k]) => k !== 'key')
    .map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${v}"`)
    .join('');
  return `<div data-item="${i.key}"${attrs}><p>Card ${i.key}</p></div>`;
}

const feed = (items: Item[]) => `<nav id="global-nav"></nav><main id="feed">${items.map(itemHtml).join('')}</main>`;

function inspectFake(el: HTMLElement): InspectResult {
  const d = el.dataset;
  switch (d.kind) {
    case 'pending':
      return { kind: 'pending' };
    case 'offscreen':
      return { kind: 'pending', offscreen: true };
    case 'module':
      return { kind: 'module', module: { kind: 'people-you-may-know' } };
    case 'ignore':
      return { kind: 'ignore', ...(d.obs ? { observations: d.obs.split(',') } : {}) };
    case 'throw':
      throw new Error(`Cannot read the card of Jane Doe at ${d.item}`);
  }
  const ad = d.ad === 'true';
  const post: PostData = {
    id: `li:ck:${d.item}` as PostKey,
    platform: 'linkedin',
    author: {
      name: `Jane Doe ${d.item}`,
      kind: 'person',
      relationship: (d.rel as PostData['author']['relationship']) ?? 'followed',
    },
    signals: { ...NO_SIGNALS, sponsored: ad },
    evidence: ad
      ? [{ signal: 'sponsored', detector: 'li.promoted.age-slot', strength: (d.strength as 'strong') ?? 'strong' }]
      : [{ signal: 'relationship', detector: 'li.follow-button', strength: 'medium' }],
    text: `What Jane Doe wrote in post ${d.item}.`,
    textComplete: true,
    media: 'none',
    quality: { authorFound: true, textFound: true, ...(d.nearMiss ? { adNearMiss: d.nearMiss } : {}) },
  };
  return { kind: 'post', post, ...(d.obs ? { observations: d.obs.split(',') } : {}) };
}

function fakeAdapter(over: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id: 'linkedin',
    version: ADAPTER,
    isFeedPage: () => true,
    feedScope: (doc) => doc.querySelector<HTMLElement>('#feed'),
    findItems: (scope) => Array.from(scope.querySelectorAll<HTMLElement>(':scope > [data-item]')),
    itemRootOf: (node, scope) => {
      const el = node instanceof Element ? node : node.parentElement;
      const root = el?.closest<HTMLElement>('[data-item]');
      return root && scope.contains(root) ? root : null;
    },
    inspect: (el) => inspectFake(el),
    signedIn: (doc) => !!doc.getElementById('global-nav'),
    probe: (doc, scope) => ({ main: doc.querySelectorAll('main').length, postRoots: scope ? scope.children.length : 0 }),
    theme: () => 'light',
    markersFor: () => ({}),
    ...over,
  };
}

function runtime(over: Partial<Runtime> = {}): Runtime {
  return {
    settings: defaultSettings(),
    device: defaultDevice('dev1'),
    learned: EMPTY_LEARNED,
    votes: {},
    serverOffer: null,
    officialList: { list: null, checkedAt: 0 },
    ...over,
  };
}

function bridge(over: Partial<Bridge> = {}): Bridge {
  return {
    classify: vi.fn(async () => ({ results: [] })),
    pushTabState: vi.fn(),
    vote: vi.fn(async () => undefined),
    settingsAction: vi.fn(async () => null),
    coachMarkShown: vi.fn(),
    openSettings: vi.fn(),
    report: vi.fn(),
    snoozeNotice: vi.fn(),
    factcheck: vi.fn(),
    openFactcheck: vi.fn(async () => true),
    perspectives: vi.fn(),
    ...over,
  };
}

const mountUi = (e: Entry) => {
  const host = document.createElement('unalgo-post');
  const container = document.createElement('div');
  host.attachShadow({ mode: 'open' }).append(container);
  e.el.appendChild(host);
  return { host, container };
};

const el = (key: string) => document.querySelector<HTMLElement>(`[data-item="${key}"]`) as HTMLElement;
const state = (key: string) => el(key).getAttribute('data-unalgo');
const hostOf = (key: string) => el(key).querySelector('unalgo-post');

/** n posts by people the viewer doesn't follow: Balanced on LinkedIn folds them all. */
const strangers = (n: number, prefix = 's'): Item[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, rel: 'not-followed' }));

/** Every item near the viewport and on screen (jsdom has no IntersectionObserver). */
class NearIO {
  root = null;
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.cb([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Health checks run every 10 s: advance through `n` of them. */
const checks = (n: number) => vi.advanceTimersByTimeAsync(n * 10_000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Back to jsdom's own (visible) value.
  delete (document as { visibilityState?: unknown }).visibilityState;
  document.body.innerHTML = '';
});

describe('adapter exceptions', () => {
  it('test_three_adapter_exceptions_pause_filtering', async () => {
    document.body.innerHTML = feed([
      { key: 'ad1', ad: true },
      ...strangers(3),
      { key: 't1', kind: 'throw' },
      { key: 't2', kind: 'throw' },
      { key: 't3', kind: 'throw' },
    ]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    // Until the first check, everything that can be read is decided; the throwing items are left alone.
    expect(state('ad1')).toBe('collapsed');
    expect(state('t1')).toBeNull();
    await checks(1);
    const health = c.getHealth();
    expect(health.issues).toContain('adapter-error');
    expect(health.status).toBe('broken');
    expect(health.notice).toBe('paused');
    // Fail open: nothing is hidden on a page we can't read.
    expect(document.querySelectorAll('[data-unalgo]')).toHaveLength(0);
    expect(c.buildState().counts?.hiddenTotal).toBe(0);
    // Counted per operation, never the message.
    const d = c.diagnostics();
    expect(d.errors).toStrictEqual({ inspect: 3 });
    expect(JSON.stringify(d)).not.toContain('Jane');
    c.stop();
  });

  it('test_find_items_failure_keeps_the_previous_items_and_mutation_errors_are_caught', async () => {
    document.body.innerHTML = feed([{ key: 'ad1', ad: true }, { key: 'p1' }]);
    let failFind = false;
    let failRoot = false;
    const real = fakeAdapter();
    const adapter = fakeAdapter({
      findItems: (scope) => {
        if (failFind) throw new Error('layout changed');
        return real.findItems(scope);
      },
      itemRootOf: (node, scope) => {
        if (failRoot) throw new Error('layout changed');
        return real.itemRootOf(node, scope);
      },
    });
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(state('ad1')).toBe('collapsed');
    failFind = true;
    failRoot = true;
    // The page changes: the observer callback and the rescan both meet exceptions, and detection carries on.
    el('p1').append(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(500);
    expect(state('ad1')).toBe('collapsed');
    expect(c.mounted().map((e) => e.id)).toContain('li:ck:ad1');
    expect(c.diagnostics().errors).toStrictEqual({ findItems: 1, itemRootOf: 1 });
    expect(c.isActive).toBe(true);
    c.stop();
  });
});

describe('offscreen slots', () => {
  it('test_offscreen_slot_keeps_its_decision_and_drops_our_host', async () => {
    document.body.innerHTML = feed([{ key: 'ad1', ad: true }, { key: 'p1' }]);
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(2000);
    expect(state('ad1')).toBe('collapsed');
    expect(hostOf('ad1')).not.toBeNull();
    // Facebook empties the slot after it scrolls away.
    el('ad1').dataset.kind = 'offscreen';
    el('ad1').replaceChildren(el('ad1').querySelector('unalgo-post') as Node);
    el('ad1').append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(500);
    // No stale fold line on the empty slot...
    expect(state('ad1')).toBeNull();
    expect(hostOf('ad1')).toBeNull();
    // ...but the decision is kept: the popup still counts it, and a report counts the slot apart.
    const s = c.buildState();
    expect(s.counts?.hiddenTotal).toBe(1);
    expect(s.hiddenItems?.map((h) => h.id)).toEqual(['li:ck:ad1']);
    expect(c.diagnostics().counts).toMatchObject({ offscreen: 1, pending: 0, hidden: 1 });
    // Scrolled back: the platform fills it in and the fold comes back at once.
    delete el('ad1').dataset.kind;
    el('ad1').append(document.createElement('p'));
    await vi.advanceTimersByTimeAsync(500);
    expect(state('ad1')).toBe('collapsed');
    expect(hostOf('ad1')).not.toBeNull();
    expect(c.diagnostics().counts.offscreen).toBe(0);
    c.stop();
  });

  it('test_offscreen_slots_are_left_out_of_health', async () => {
    vi.stubGlobal('IntersectionObserver', NearIO);
    const run = async (kind: 'pending' | 'offscreen') => {
      document.body.innerHTML = feed([
        { key: 'p1' },
        ...Array.from({ length: 3 }, (_, i) => ({ key: `slot${i}`, kind }) satisfies Item),
      ]);
      const c = new FeedController(fakeAdapter(), bridge(), mountUi);
      c.start(runtime());
      await checks(3);
      const issues = c.getHealth().issues;
      c.stop();
      return issues;
    };
    // Three skeletons near the viewport for 30 s are stuck; three virtualised slots are not.
    expect(await run('pending')).toContain('stuck-skeletons');
    expect(await run('offscreen')).not.toContain('stuck-skeletons');
  });
});

describe('visible time', () => {
  it('test_hidden_tab_time_never_counts', async () => {
    // A signed-in page whose feed never appears.
    document.body.innerHTML = '<nav id="global-nav"></nav><main id="other"></main>';
    setVisibility('hidden');
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(runtime());
    await checks(6);
    expect(c.getHealth().issues).toEqual([]);
    setVisibility('visible');
    await checks(1);
    expect(c.getHealth().issues).toEqual(['no-feed']);
    c.stop();
  });

  it('test_no_feed_needs_a_signed_in_shell', async () => {
    document.body.innerHTML = '<main id="login"></main>';
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(runtime());
    await checks(3);
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: [] });
    c.stop();
  });
});

describe('the notice card', () => {
  const throwing = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, kind: 'throw' }));

  it('test_card_shows_after_two_checks_in_a_row', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }, ...throwing(3)]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await checks(1);
    expect(c.getHealth().notice).toBe('paused');
    // One check isn't enough for the card; the popup already knows.
    expect(c.notice()).toBeNull();
    expect(c.buildState().notice).toStrictEqual({ kind: 'paused', issues: ['adapter-error'] });
    await checks(1);
    expect(c.notice()).toStrictEqual({ kind: 'paused', platform: 'linkedin' });
    c.stop();
  });

  it('test_an_issue_that_clears_after_one_check_raises_no_card', async () => {
    // Every post by a stranger: Balanced would fold all of them, past its 90%.
    document.body.innerHTML = feed(strangers(20));
    const rt = runtime();
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(rt);
    await checks(1);
    expect(c.getHealth().issues).toEqual(['over-filtering']);
    // The person turns "not followed" off before the next check: the issue clears.
    const relaxed = structuredClone(rt.settings);
    relaxed.platforms.linkedin.filters.notFollowed = false;
    c.update({ ...rt, settings: relaxed });
    await checks(1);
    expect(c.getHealth().issues).toEqual([]);
    expect(c.notice()).toBeNull();
    // On again: raised at one check, shown at the next.
    c.update(rt);
    await checks(1);
    expect(c.notice()).toBeNull();
    await checks(1);
    expect(c.notice()?.kind).toBe('paused');
    // And it goes away silently when the issue clears, never to come back on this page load.
    c.update({ ...rt, settings: relaxed });
    await checks(1);
    expect(c.notice()).toBeNull();
    c.update(rt);
    await checks(3);
    expect(c.getHealth().notice).toBe('paused');
    expect(c.notice()).toBeNull();
    c.stop();
  });

  it('test_two_equal_near_miss_labels_raise_ads_through', async () => {
    document.body.innerHTML = feed([
      { key: 'a1', nearMiss: 'h:brand-content' },
      { key: 'a2', nearMiss: 'h:brand-content' },
      { key: 'p1' },
    ]);
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(runtime());
    await checks(2);
    expect(c.getHealth().issues).toEqual(['ad-label-near-miss']);
    expect(c.notice()?.kind).toBe('ads-through');
    c.stop();

    document.body.innerHTML = feed([{ key: 'a1', nearMiss: 'h:one' }, { key: 'a2', nearMiss: 'h:two' }, { key: 'p1' }]);
    const other = new FeedController(fakeAdapter(), bridge(), mountUi);
    other.start(runtime());
    await checks(2);
    expect(other.getHealth().issues).toEqual([]);
    expect(other.notice()).toBeNull();
    other.stop();
  });

  it('test_not_now_writes_the_snooze', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }, ...throwing(3)]);
    const b = bridge();
    const rt = runtime();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(rt);
    await checks(2);
    expect(c.notice()?.kind).toBe('paused');
    c.noticeNotNow();
    expect(c.notice()).toBeNull();
    expect(b.snoozeNotice).toHaveBeenCalledWith('paused', DAY);
    // The issue holds, but the card had its one showing on this page load.
    await checks(3);
    expect(c.notice()).toBeNull();
    expect(c.buildState().notice?.kind).toBe('paused');
    c.stop();

    // The next page load reads the snooze the background stored, under this adapter version.
    const device = {
      ...rt.device,
      notices: { enabled: true, snoozed: { 'linkedin:paused': { until: Date.now() + DAY, adapter: ADAPTER } } },
    };
    const next = new FeedController(fakeAdapter(), bridge(), mountUi);
    next.start({ ...rt, device });
    await checks(2);
    expect(next.notice()).toBeNull();
    next.stop();
    // A new detection version may have fixed it: the snooze no longer holds.
    const updated = new FeedController(fakeAdapter({ version: 'linkedin@2026.11.0' }), bridge(), mountUi);
    updated.start({ ...rt, device });
    await checks(2);
    expect(updated.notice()?.kind).toBe('paused');
    updated.stop();
  });

  it('test_notices_switched_off_in_settings', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }, ...throwing(3)]);
    const rt = runtime();
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start({ ...rt, device: { ...rt.device, notices: { enabled: false, snoozed: {} } } });
    await checks(2);
    expect(c.notice()).toBeNull();
    // The popup still says it.
    expect(c.buildState().notice?.kind).toBe('paused');
    c.stop();
  });

  it('test_report_sent_snoozes_for_a_week_and_hides_the_card', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }, ...throwing(3)]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await checks(2);
    c.noticeReport();
    expect(b.report).toHaveBeenCalledWith({ kind: 'detection', from: 'notice', notice: 'paused' });
    // Let us know alone doesn't put the card away: the person may come back without sending.
    expect(c.notice()?.kind).toBe('paused');
    c.onReportSent('paused');
    expect(b.snoozeNotice).toHaveBeenCalledWith('paused', 7 * DAY);
    expect(c.notice()).toBeNull();
    await checks(2);
    expect(c.notice()).toBeNull();
    c.stop();
  });

  it('test_report_sent_without_a_kind_snoozes_the_card_showing', async () => {
    document.body.innerHTML = feed([
      { key: 'a1', nearMiss: 'h:x' },
      { key: 'a2', nearMiss: 'h:x' },
    ]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await checks(2);
    expect(c.notice()?.kind).toBe('ads-through');
    c.onReportSent();
    expect(b.snoozeNotice).toHaveBeenCalledWith('ads-through', 7 * DAY);
    expect(c.notice()).toBeNull();
    c.stop();
  });

  it('test_report_sent_with_nothing_raised_snoozes_nothing', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await checks(2);
    c.onReportSent();
    expect(b.snoozeNotice).not.toHaveBeenCalled();
    c.stop();
  });
});

describe('cautious mode and discovery', () => {
  it('test_fallback_strategy_hides_only_strong_signals', async () => {
    document.body.innerHTML = feed([
      { key: 'strong', ad: true },
      { key: 'medium', ad: true, strength: 'medium' },
      { key: 'stranger', rel: 'not-followed' },
    ]);
    let fallback = false;
    const rediscover = vi.fn();
    const adapter = fakeAdapter({
      discovery: () => ({ strategy: fallback ? 'li.items.anatomy' : 'li.items.card-key', fallback }),
      rediscover,
    });
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await checks(1);
    expect(rediscover).toHaveBeenCalledTimes(1);
    expect([state('strong'), state('medium'), state('stranger')]).toEqual(['collapsed', 'collapsed', 'collapsed']);
    expect(c.diagnostics().strategy).toBe('li.items.card-key');
    // A fallback strategy wins: items may not be whole posts.
    fallback = true;
    await checks(1);
    expect(rediscover).toHaveBeenCalledTimes(2);
    expect(c.getHealth()).toMatchObject({ status: 'degraded', issues: ['fallback-discovery'] });
    expect([state('strong'), state('medium'), state('stranger')]).toEqual(['collapsed', null, null]);
    expect(c.diagnostics().strategy).toBe('li.items.anatomy');
    c.stop();
  });
});

describe('route-new and the tab state', () => {
  it('test_started_on_a_new_address', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime(), { routeNew: true });
    // Starting again on a settings change keeps it.
    c.start(runtime());
    await checks(1);
    expect(c.getHealth()).toMatchObject({ status: 'ok', issues: ['route-new'] });
    expect(c.buildState()).toMatchObject({ routeNew: true, notice: undefined });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(b.pushTabState).mock.lastCall?.[0]).toMatchObject({ routeNew: true });
    c.stop();
    c.start(runtime());
    expect(c.buildState().routeNew).toBe(false);
    c.stop();
  });
});

describe('what a report reads', () => {
  it('test_diagnostics_count_each_item_once', async () => {
    document.body.innerHTML = feed([
      { key: 'ad1', ad: true, obs: 'li.slot.actor.structure' },
      { key: 'ad2', ad: true },
      { key: 'p1', obs: 'li.slot.actor.structure,li.header.unknown' },
      { key: 'm1', kind: 'module' },
      { key: 'x1', kind: 'ignore', obs: 'li.item.multi-post' },
      { key: 'sk', kind: 'pending' },
    ]);
    const c = new FeedController(fakeAdapter(), bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(1000);
    // The page changes many times: each post is read again, and still counted once.
    for (let i = 0; i < 5; i++) {
      el('p1').append(document.createElement('span'));
      await vi.advanceTimersByTimeAsync(300);
    }
    const d = c.diagnostics();
    expect(d.counts).toStrictEqual({
      items: 6,
      posts: 3,
      modules: 1,
      pending: 1,
      offscreen: 0,
      hidden: 3,
      classified: 0,
      unknownAuthor: 0,
    });
    expect(d.hiddenBy).toStrictEqual({ sponsored: 2, module: 1 });
    expect(d.detectors).toStrictEqual({ 'li.promoted.age-slot': 2, 'li.follow-button': 1 });
    expect(d.observations).toStrictEqual({ 'li.slot.actor.structure': 2, 'li.header.unknown': 1, 'li.item.multi-post': 1 });
    expect(d.landmarks).toStrictEqual({ main: 1, postRoots: 6 });
    expect(d.errors).toStrictEqual({});
    expect(d.strategy).toBeUndefined();
    await checks(1);
    expect(c.getHealth().issues).toContain('multi-post-items');
    c.stop();
  });

  it('test_wrong_call_reports_the_post_summary_only', async () => {
    document.body.innerHTML = feed([{ key: 'ad1', ad: true }, { key: 'p1' }]);
    const b = bridge();
    const c = new FeedController(fakeAdapter(), b, mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    const entry = c.mounted().find((e) => e.id === 'li:ck:ad1');
    entry?.handlers?.onWhyAction('report');
    await vi.advanceTimersByTimeAsync(0);
    expect(b.report).toHaveBeenCalledWith({ kind: 'wrong-call', from: 'why', key: 'li:ck:ad1' });
    const summary = c.postReportSummary('li:ck:ad1');
    expect(summary).toStrictEqual({
      reason: 'sponsored',
      source: 'rule',
      evidence: [{ detector: 'li.promoted.age-slot', strength: 'strong' }],
      authorKind: 'person',
      relationship: 'followed',
      media: 'none',
      text: 'short',
    });
    // A shown post or an unknown key has nothing to report.
    expect(c.postReportSummary('li:ck:p1')).toBeNull();
    expect(c.postReportSummary('li:ck:nope')).toBeNull();
    c.stop();
  });

  it('test_hooks_that_throw_fail_quiet', async () => {
    document.body.innerHTML = feed([{ key: 'p1' }]);
    const boom = () => {
      throw new Error('boom');
    };
    const c = new FeedController(
      fakeAdapter({ discovery: boom, rediscover: boom, signedIn: boom, probe: boom, theme: boom }),
      bridge(),
      mountUi,
    );
    c.start(runtime());
    await checks(1);
    const d = c.diagnostics();
    expect(d.landmarks).toStrictEqual({});
    expect(d.strategy).toBeUndefined();
    expect(c.isActive).toBe(true);
    // Every exception counts toward adapter-error: the adapter is out of step with the page.
    expect(c.getHealth().issues).toContain('adapter-error');
    c.stop();
  });
});
