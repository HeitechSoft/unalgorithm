/**
 * Runs of hidden posts ("5 hidden · Show all"), with Settings → Display → *Group hidden posts in a row* on, on a feed
 * that empties and refills its slots, as Facebook's does: a run opened with Show all stays open, and nothing the
 * platform does to the slots around it folds it again.
 *
 * Folding or opening a long run changes the page's height by hundreds of pixels; Facebook then empties or refills the
 * slots that crossed its distance limit, which used to merge or split the runs again, and the page redrew back and
 * forth without end (2026-10-20, live in Chrome).
 *
 * Grouping is off by default: each hidden post keeps its own fold line, and turning it on or off redraws the feed at
 * once, both ways.
 */
import { defaultDevice, defaultSettings, EMPTY_LEARNED, NO_SIGNALS, type PostData } from '@unalgorithm/core';
import type { InspectResult, PlatformAdapter } from '@unalgorithm/platforms';
import type { PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';

/** `s…` and `t…` items are strangers' posts (folded at Balanced), `p…` items followed accounts' (shown). */
const card = (key: string) => `<div data-item="${key}"><p>Card ${key}</p></div>`;
const feed = (keys: string[]) => `<nav id="global-nav"></nav><main id="feed">${keys.map(card).join('')}</main>`;
const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function inspect(el: HTMLElement): InspectResult {
  // An emptied slot (Facebook's `data-virtualized`, or no text left in a slot that was a post).
  if (el.dataset.empty) return { kind: 'pending', offscreen: true };
  // What the platform put in a slot that isn't a post, or isn't one yet (a skeleton).
  if (el.dataset.kind === 'ignore') return { kind: 'ignore' };
  if (el.dataset.kind === 'pending') return { kind: 'pending' };
  const key = el.dataset.item ?? '';
  const post: PostData = {
    id: `li:ck:${key}` as PostKey,
    platform: 'linkedin',
    author: { name: `Author ${key}`, kind: 'person', relationship: key.startsWith('p') ? 'followed' : 'not-followed' },
    signals: { ...NO_SIGNALS },
    evidence: [{ signal: 'relationship', detector: 'li.follow-button', strength: 'medium' }],
    text: `Post ${key}.`,
    textComplete: true,
    media: 'none',
    quality: { authorFound: true, textFound: true },
  };
  return { kind: 'post', post };
}

const adapter: PlatformAdapter = {
  id: 'linkedin',
  version: 'linkedin@2026.10.2',
  isFeedPage: () => true,
  feedScope: (doc) => doc.querySelector<HTMLElement>('#feed'),
  findItems: (scope) => Array.from(scope.querySelectorAll<HTMLElement>(':scope > [data-item]')),
  itemRootOf: (node, scope) => {
    const el = node instanceof Element ? node : node.parentElement;
    const root = el?.closest<HTMLElement>('[data-item]');
    return root && scope.contains(root) ? root : null;
  },
  inspect: (el) => inspect(el),
  signedIn: (doc) => !!doc.getElementById('global-nav'),
  probe: () => ({}),
  theme: () => 'light',
  markersFor: () => ({}),
};

/** Grouping on unless `group` is false (the default settings have it off). */
function runtime(group = true): Runtime {
  const settings = defaultSettings();
  settings.display.groupRuns = group;
  return {
    settings,
    device: defaultDevice('dev1'),
    learned: EMPTY_LEARNED,
    votes: {},
    serverOffer: null,
    officialList: { list: null, checkedAt: 0 },
  };
}

function bridge(): Bridge {
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
const runMark = (key: string) => el(key).getAttribute('data-unalgo-run');
const marks = (ks: string[]) => ks.map(runMark);

/** The platform empties a slot it no longer draws (Facebook keeps the slot, with a placeholder in it). */
function empty(key: string): void {
  const slot = el(key);
  slot.dataset.empty = 'true';
  slot.replaceChildren(document.createElement('div'));
}

/** ...and fills it in again when it comes back near the viewport. */
function fill(key: string): void {
  const slot = el(key);
  delete slot.dataset.empty;
  const p = document.createElement('p');
  p.textContent = `Card ${key}`;
  slot.replaceChildren(p);
}

/** Show all on the run that `key` leads, as the button in its fold line does. */
function showAll(c: FeedController, key: string): void {
  const lead = c.mounted().find((e) => e.id === `li:ck:${key}`);
  expect(lead?.run).toMatchObject({ count: expect.any(Number) });
  lead?.handlers?.onShowAll();
}

/** Every change to our attributes on the feed's items while `during` runs. */
async function flipsDuring(during: () => Promise<unknown>): Promise<number> {
  let flips = 0;
  const watch = new MutationObserver((records) => {
    flips += records.length;
  });
  watch.observe(document.getElementById('feed') as HTMLElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-unalgo', 'data-unalgo-run'],
  });
  await during();
  flips += watch.takeRecords().length;
  watch.disconnect();
  return flips;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Show all', () => {
  const S = keys('s', 4);
  const T = keys('t', 6);

  it('test_show_all_survives_an_emptied_slot_between_runs', async () => {
    // Four hidden, a shown post, six hidden: two runs.
    document.body.innerHTML = feed([...S, 'p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(marks(S)).toStrictEqual(['lead', 'member', 'member', 'member']);
    expect(marks(T)).toStrictEqual(['lead', 'member', 'member', 'member', 'member', 'member']);
    showAll(c, 't0');
    expect(marks(T)).toStrictEqual(T.map(() => null));
    expect(T.map((k) => el(k).getAttribute('data-unalgo'))).toStrictEqual(T.map(() => 'collapsed'));
    // The shown post scrolls far away and Facebook empties its slot: it no longer separates the runs.
    empty('p0');
    await vi.advanceTimersByTimeAsync(500);
    // The opened run stays open, one fold line per post, and the run above keeps its own line.
    expect(marks(T)).toStrictEqual(T.map(() => null));
    expect(marks(S)).toStrictEqual(['lead', 'member', 'member', 'member']);
    expect(T.every((k) => el(k).querySelector('unalgo-post'))).toBe(true);
    fill('p0');
    await vi.advanceTimersByTimeAsync(500);
    expect(marks(T)).toStrictEqual(T.map(() => null));
    c.stop();
  });

  it('test_show_all_survives_the_lead_going_offscreen', async () => {
    document.body.innerHTML = feed(['p0', ...T, 'p1']);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    showAll(c, 't0');
    // Scrolling down through the opened run: Facebook empties its first slot once it is far above.
    empty('t0');
    await vi.advanceTimersByTimeAsync(500);
    expect(marks(T.slice(1))).toStrictEqual(T.slice(1).map(() => null));
    expect(T.slice(1).every((k) => el(k).getAttribute('data-unalgo') === 'collapsed')).toBe(true);
    // Back up: it is filled in again and is one fold line among the others.
    fill('t0');
    await vi.advanceTimersByTimeAsync(500);
    expect(marks(T)).toStrictEqual(T.map(() => null));
    expect(el('t0').getAttribute('data-unalgo')).toBe('collapsed');
    c.stop();
  });

  it('test_show_all_does_not_fold_and_open_as_the_platform_reacts', async () => {
    // The live loop: folding the opened run shrinks the page, so Facebook fills the separating slot in again; opening
    // it grows the page, so Facebook empties that slot. Each change used to undo the other, several times a second.
    document.body.innerHTML = feed([...S, 'p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    const platform = new MutationObserver(() => {
      const folded = T.some((k) => runMark(k) === 'member');
      const emptied = !!el('p0').dataset.empty;
      if (folded && emptied) fill('p0');
      if (!folded && !emptied) empty('p0');
    });
    platform.observe(document.getElementById('feed') as HTMLElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-unalgo-run'],
    });
    showAll(c, 't0');
    await vi.advanceTimersByTimeAsync(1000);
    // Settled: from here on, nothing on the page changes.
    const flips = await flipsDuring(() => vi.advanceTimersByTimeAsync(5000));
    platform.disconnect();
    expect(flips).toBe(0);
    expect(marks(T)).toStrictEqual(T.map(() => null));
    c.stop();
  });

  it('test_posts_loaded_after_an_opened_run_fold_into_their_own', async () => {
    document.body.innerHTML = feed(['p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    showAll(c, 't0');
    // The next batch loads right after the opened run: three more hidden posts.
    const U = keys('u', 3);
    document.getElementById('feed')?.insertAdjacentHTML('beforeend', U.map(card).join(''));
    await vi.advanceTimersByTimeAsync(500);
    expect(marks(T)).toStrictEqual(T.map(() => null));
    expect(marks(U)).toStrictEqual(['lead', 'member', 'member']);
    c.stop();
  });
});

describe('run marks', () => {
  it('test_peek_leaves_no_post_folded_into_a_run', async () => {
    document.body.innerHTML = feed(['p0', ...keys('t', 4)]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll('[data-unalgo-run="member"]')).toHaveLength(3);
    // Peek shows every hidden post: none may stay folded into a run (the members' line hides them outright).
    c.setPeek(true);
    expect(document.querySelectorAll('[data-unalgo="revealed"]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    c.setPeek(false);
    expect(document.querySelectorAll('[data-unalgo-run="member"]')).toHaveLength(3);
    c.stop();
  });

  it('test_posts_shown_again_by_a_settings_change_leave_their_run', async () => {
    document.body.innerHTML = feed(['p0', ...keys('t', 4)]);
    const c = new FeedController(adapter, bridge(), mountUi);
    const rt = runtime();
    c.start(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll('[data-unalgo-run="member"]')).toHaveLength(3);
    // "Stop hiding" (or the Settings page) turns the rule off: every post shows, none stays hidden as a run member.
    const settings = structuredClone(rt.settings);
    settings.platforms.linkedin.filters.notFollowed = false;
    c.update({ ...rt, settings });
    expect(document.querySelectorAll('[data-unalgo]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    c.stop();
  });

  it('test_a_slot_that_stops_being_a_post_leaves_its_run', async () => {
    const T = keys('t', 5);
    document.body.innerHTML = feed(T);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(0);
    expect(marks(T)).toStrictEqual(['lead', 'member', 'member', 'member', 'member']);
    // The platform reuses two slots: one for something we don't read (fail open: it shows), one for a skeleton.
    for (const [key, kind] of [
      ['t2', 'ignore'],
      ['t3', 'pending'],
    ] as const) {
      el(key).dataset.kind = kind;
      el(key).append(document.createElement('span'));
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(el('t2').getAttribute('data-unalgo')).toBeNull();
    // Neither stays marked as a run member, which would keep it out of sight.
    expect(marks(T)).toStrictEqual(['lead', 'member', null, null, 'member']);
    c.stop();
  });
});

describe('grouping off, the default', () => {
  const S = keys('s', 4);
  const T = keys('t', 6);
  const lines = (ks: string[]) => ks.map((k) => !!el(k).querySelector('unalgo-post'));
  const runOf = (c: FeedController, key: string) => c.mounted().find((e) => e.id === `li:ck:${key}`)?.run;
  /** `rt` with grouping set to `group`. */
  const grouped = (rt: Runtime, group: boolean): Runtime => ({
    ...rt,
    settings: { ...rt.settings, display: { ...rt.settings.display, groupRuns: group } },
  });

  it('test_hidden_posts_in_a_row_each_keep_their_own_line', async () => {
    expect(defaultSettings().display.groupRuns).toBe(false);
    document.body.innerHTML = feed([...S, 'p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    c.start(runtime(false));
    await vi.advanceTimersByTimeAsync(0);
    // Every hidden post folds on its own line, with its own Why? and Show: no run, no Show all.
    expect([...S, ...T].map((k) => el(k).getAttribute('data-unalgo'))).toStrictEqual([...S, ...T].map(() => 'collapsed'));
    expect(lines([...S, ...T])).toStrictEqual([...S, ...T].map(() => true));
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    expect(c.mounted().map((e) => e.run)).toStrictEqual(c.mounted().map(() => undefined));
    for (const e of c.mounted()) expect(c.modelFor(e)).not.toHaveProperty('run');
    // The platform emptying and refilling slots changes nothing: there are no runs to merge or split.
    const flips = await flipsDuring(async () => {
      empty('p0');
      await vi.advanceTimersByTimeAsync(500);
      fill('p0');
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(flips).toBe(0);
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    c.stop();
  });

  it('test_turning_grouping_on_and_off_redraws_the_feed_at_once', async () => {
    document.body.innerHTML = feed([...S, 'p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    const rt = runtime(false);
    c.start(rt);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    // On, from Settings in another tab: two runs, each one line saying how many.
    c.update(grouped(rt, true));
    expect(marks(S)).toStrictEqual(['lead', 'member', 'member', 'member']);
    expect(marks(T)).toStrictEqual(['lead', 'member', 'member', 'member', 'member', 'member']);
    expect(runOf(c, 's0')).toMatchObject({ count: 4 });
    expect(runOf(c, 't0')).toMatchObject({ count: 6 });
    // Off again: every post its own line at once, the run's line included, and nothing else on the page changes.
    let flips = await flipsDuring(async () => c.update(grouped(rt, false)));
    expect(flips).toBe(S.length + T.length);
    expect(document.querySelectorAll('[data-unalgo-run]')).toHaveLength(0);
    expect([...S, ...T].map((k) => runOf(c, k))).toStrictEqual([...S, ...T].map(() => undefined));
    expect(lines([...S, ...T])).toStrictEqual([...S, ...T].map(() => true));
    expect(document.querySelectorAll('[data-unalgo="collapsed"]')).toHaveLength(S.length + T.length);
    // Show all still works once it is back on, and an opened run stays open through another off and on.
    c.update(grouped(rt, true));
    showAll(c, 't0');
    expect(marks(T)).toStrictEqual(T.map(() => null));
    c.update(grouped(rt, false));
    c.update(grouped(rt, true));
    expect(marks(T)).toStrictEqual(T.map(() => null));
    expect(marks(S)).toStrictEqual(['lead', 'member', 'member', 'member']);
    // The same settings again change nothing.
    flips = await flipsDuring(async () => c.update(grouped(rt, true)));
    expect(flips).toBe(0);
    c.stop();
  });

  it('test_grouping_needs_collapse', async () => {
    // Hide and Dim have no fold lines to group: on or off, nothing is marked as a run.
    document.body.innerHTML = feed(['p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    const rt = runtime(true);
    for (const mode of ['hide', 'dim'] as const) {
      c.start({ ...rt, settings: { ...rt.settings, display: { ...rt.settings.display, mode } } });
      await vi.advanceTimersByTimeAsync(0);
      expect([mode, document.querySelectorAll('[data-unalgo-run]').length]).toStrictEqual([mode, 0]);
      c.stop();
    }
  });

  it('test_the_coach_mark_moves_to_the_runs_line_when_grouping_turns_on', async () => {
    // jsdom has no IntersectionObserver: every item is near; `inView` are on screen, and `scroll` changes which.
    let inView = new Set<string>();
    const screens: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
    const key = (target: Element) => (target as HTMLElement).dataset.item ?? '';
    class ScreenIO {
      root = null;
      private targets: Element[] = [];
      constructor(
        private cb: IntersectionObserverCallback,
        private opts: IntersectionObserverInit = {},
      ) {
        if (!opts.rootMargin) screens.push({ cb, targets: this.targets });
      }
      observe(target: Element) {
        this.targets.push(target);
        const isIntersecting = !!this.opts.rootMargin || inView.has(key(target));
        queueMicrotask(() => this.cb([{ target, isIntersecting } as unknown as IntersectionObserverEntry], this as never));
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
    const scroll = (ks: string[]) => {
      inView = new Set(ks);
      for (const { cb, targets } of screens) {
        cb(
          targets.map((target) => ({ target, isIntersecting: inView.has(key(target)) }) as unknown as IntersectionObserverEntry),
          {} as never,
        );
      }
    };
    vi.stubGlobal('IntersectionObserver', ScreenIO);
    inView = new Set(['t1', 't2']);
    document.body.innerHTML = feed(['p0', ...T]);
    const c = new FeedController(adapter, bridge(), mountUi);
    const rt = runtime(false);
    c.start(rt);
    await vi.advanceTimersByTimeAsync(0);
    const coached = () =>
      c
        .mounted()
        .filter((e) => e.coach)
        .map((e) => e.id);
    // A first visit: the tip points at the first fold line on screen.
    expect(coached()).toStrictEqual(['li:ck:t1']);
    // Grouping on folds that post into the run: the tip goes with it, never left on a line nobody sees.
    c.update(grouped(rt, true));
    expect(runOf(c, 't1')).toBe('member');
    expect(coached()).toStrictEqual([]);
    // The run's own line comes on screen: the tip points at it.
    scroll(['t0', 't1']);
    expect(coached()).toStrictEqual(['li:ck:t0']);
    c.stop();
  });
});
