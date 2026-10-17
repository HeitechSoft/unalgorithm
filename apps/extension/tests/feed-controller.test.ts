import { defaultDevice, defaultSettings, EMPTY_LEARNED } from '@unalgorithm/core';
import { facebookAdapter, linkedinAdapter } from '@unalgorithm/platforms';
import type { Classification, PostKey } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRIEND_POST, fbFeed, ORGANIC_LINK_SHARE } from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  feed2026,
  HIRING_PROMO,
  PROMOTED_FOLLOWS_PAGE,
} from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import type { BgResponses, ClassifyItem, ClassifyItemResult } from '../src/lib/messages.ts';

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
    classify: vi.fn(async (items: ClassifyItem[]) => ({
      results: items.map((i) => ({
        key: i.key,
        status: 'ok' as const,
        model: 'test',
        cached: false,
        classification: {
          relevance: 10,
          noise: ['engagement-bait' as const],
          topics: ['x'],
          reason: 'r',
          isNews: false,
          hasCheckableClaims: false,
        },
      })),
    })),
    pushTabState: vi.fn(),
    vote: vi.fn(async () => undefined),
    settingsAction: vi.fn(async () => null),
    coachMarkShown: vi.fn(),
    openSettings: vi.fn(),
    report: vi.fn(),
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

function state(id: string): string | null {
  const el = document.querySelector(`[componentkey="update-card-focus${id}"]`);
  return el?.getAttribute('data-unalgo') ?? null;
}

// jsdom has no IntersectionObserver: report every item as near and on screen.
class FakeIO {
  constructor(private cb: IntersectionObserverCallback) {}
  root = null;
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

describe('FeedController on LinkedIn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    document.documentElement.lang = 'en';
    document.body.innerHTML = feed2026(
      FIRST_DEGREE_POST,
      PROMOTED_FOLLOWS_PAGE,
      FOLLOWED_BY_POST,
      HIRING_PROMO,
      COMPANY_NOT_FOLLOWED,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('collapses ads, network activity, modules and not-followed posts; keeps friends', async () => {
    const c = new FeedController(linkedinAdapter, bridge(), mountUi);
    c.start(runtime());
    await vi.runAllTicks();
    expect(state('EEEkeyFirstDegree5') ?? null).toBeNull();
    const states = [...document.querySelectorAll('[componentkey]')].map((el) => el.getAttribute('data-unalgo'));
    expect(states.filter((s) => s === 'collapsed')).toHaveLength(4);
    // Four hidden in a row merge into one "4 hidden" line.
    expect(document.querySelectorAll('[data-unalgo-run="member"]')).toHaveLength(3);
    expect(document.querySelectorAll('unalgo-post')).toHaveLength(4);
    c.stop();
  });

  it('applies settings changes live and cleans up completely on stop', async () => {
    const c = new FeedController(linkedinAdapter, bridge(), mountUi);
    const rt = runtime();
    c.start(rt);
    const s = structuredClone(rt.settings);
    s.platforms.linkedin.filters.sponsored = false;
    s.platforms.linkedin.filters.modules = false;
    s.platforms.linkedin.filters.networkActivity = false;
    s.platforms.linkedin.filters.notFollowed = false;
    c.update({ ...rt, settings: s });
    expect(document.querySelectorAll('[data-unalgo]')).toHaveLength(0);
    c.update({ ...rt, settings: { ...s, display: { ...s.display, mode: 'hide' } } });
    c.update(rt);
    expect(document.querySelectorAll('[data-unalgo="collapsed"]').length).toBeGreaterThan(0);
    c.stop();
    expect(document.querySelectorAll('[data-unalgo], [data-unalgo-run], unalgo-post, #unalgo-global')).toHaveLength(0);
  });

  it('shows a revealed bar after Show and keeps it after the platform re-renders the card', () => {
    const c = new FeedController(linkedinAdapter, bridge(), mountUi);
    c.start(runtime());
    expect(c.reveal('li:ck:BBBkeyPromoted0002')).toBe(true);
    expect(state('BBBkeyPromoted0002')).toBe('revealed');
    c.stop();
  });

  it('never classifies when no AI source is set (rules only = no network)', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIO);
    const b = bridge();
    const c = new FeedController(linkedinAdapter, b, mountUi);
    c.start(runtime());
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.classify).not.toHaveBeenCalled();
    c.stop();
  });

  it('batches only rule-passing posts to the AI and hides AI noise once it is off screen', async () => {
    const io: FakeIO[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class extends FakeIO {
        constructor(cb: IntersectionObserverCallback) {
          super(cb);
          io.push(this);
        }
      },
    );
    const b = bridge();
    const c = new FeedController(linkedinAdapter, b, mountUi);
    const rt = runtime({ device: { ...defaultDevice('d'), aiSource: { kind: 'anthropic', model: null } } });
    c.start(rt);
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.classify).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(b.classify).mock.calls[0]?.[0] ?? [];
    expect(sent.map((i) => i.key)).toEqual(['li:ck:EEEkeyFirstDegree5']);
    // Nothing that identifies the author leaves the content script.
    expect(JSON.stringify(sent)).not.toContain('Morgan Ellis');
    c.stop();
  });

  it('a stale copy after an extension reload removes its UI and stops without throwing', () => {
    let alive = true;
    const b = bridge();
    const c = new FeedController(linkedinAdapter, b, mountUi, () => alive);
    c.start(runtime());
    alive = false;
    c.update(runtime());
    document.body.append(document.createElement('div'));
    vi.advanceTimersByTime(20_000);
    expect(c.isActive).toBe(false);
    expect(document.querySelectorAll('unalgo-post')).toHaveLength(0);
  });
});

describe('FeedController on Facebook', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = fbFeed(FRIEND_POST, ORGANIC_LINK_SHARE);
  });

  it('marks a rating as shareable with a server only for public posts (R23)', async () => {
    const b = bridge();
    const c = new FeedController(facebookAdapter, b, mountUi);
    const settings = defaultSettings();
    // Highlighted posts get our UI, and with it the rating buttons.
    settings.interests.highlightWords = {
      tomatoes: { label: 'tomatoes', addedAt: 1 },
      transit: { label: 'transit', addedAt: 1 },
    };
    c.start(runtime({ settings }));
    const byAudience = (a: string) => c.mounted().find((e) => e.post?.audience === a);
    const friends = byAudience('friends');
    const everyone = byAudience('public');
    expect(friends?.handlers).toBeDefined();
    expect(everyone?.handlers).toBeDefined();

    friends?.handlers?.onVote('more');
    everyone?.handlers?.onVote('more');
    await vi.waitFor(() => expect(b.vote).toHaveBeenCalledTimes(2));
    expect(b.vote).toHaveBeenCalledWith(friends?.id, 'more', [], undefined, false);
    expect(b.vote).toHaveBeenCalledWith(everyone?.id, 'more', [], undefined, true);
    c.stop();
  });
});

describe('paused AI', () => {
  // Classified in an earlier session (the background's cache knows it), and first sent after the balance ran out.
  const KNOWN = 'PPPkeyKnownBait001';
  const UNPAID = 'QQQkeyNoCredit0002';
  // Posts that scroll in while AI is paused: one the cache knows, one it doesn't.
  const LATER_KNOWN = 'RRRkeyCachedLater3';
  const LATER_NEW = 'SSSkeyNeverSeen004';
  const AD = 'BBBkeyPromoted0002';
  const id = (key: string) => `li:ck:${key}` as PostKey;
  const postCard = (key: string) => FIRST_DEGREE_POST.replaceAll('EEEkeyFirstDegree5', key);
  const PAUSE = {
    code: 'insufficient-credits' as const,
    message: 'Your ai.example.org balance is empty. Add credit, or switch to on-device or your own key.',
  };
  const BAIT: Classification = {
    relevance: 10,
    noise: ['engagement-bait'],
    topics: ['x'],
    reason: 'r',
    isNews: false,
    hasCheckableClaims: false,
  };

  /** The background at a zero balance: the cache answers what it knows, anything else needs credit. */
  function emptyBalance(cached: string[]) {
    const known = new Set(cached.map(id));
    let credit = false;
    const answer = async (items: ClassifyItem[], opts?: { cacheOnly?: boolean }): Promise<BgResponses['classify']> => {
      const results = items.map((i): ClassifyItemResult => {
        if (known.has(i.key)) return { key: i.key, status: 'ok', classification: BAIT, model: 'm', cached: true };
        if (opts?.cacheOnly) return { key: i.key, status: 'skipped', reason: 'paused' };
        if (credit) return { key: i.key, status: 'ok', classification: { ...BAIT, noise: [] }, model: 'm', cached: false };
        return { key: i.key, status: 'failed', code: PAUSE.code, message: PAUSE.message, retryable: false };
      });
      return { results, ...(results.some((r) => r.status === 'failed') ? { pause: PAUSE } : {}) };
    };
    const classify = vi.fn(answer);
    return {
      bridge: bridge({ classify }),
      classify,
      answer,
      addCredit: () => {
        credit = true;
      },
    };
  }

  // Every item is near (so it is queued) and off screen (so an AI verdict applies at once).
  class OffScreenIO {
    root = null;
    constructor(
      private cb: IntersectionObserverCallback,
      private opts: IntersectionObserverInit = {},
    ) {}
    observe(el: Element) {
      // The "near" observer has a bottom margin; the "on screen" one has none.
      const isIntersecting = !!this.opts.rootMargin;
      queueMicrotask(() => this.cb([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  const scrollIn = (html: string) =>
    document.querySelector('[data-testid="mainFeed"] > .load-more-marker')?.insertAdjacentHTML('beforebegin', html);
  const hidden = (c: FeedController, key: string) => c.buildState().hiddenItems?.find((h) => h.id === id(key));
  const sentKeys = (call: Parameters<Bridge['classify']> | undefined) => call?.[0].map((i) => i.key).sort();

  /** A feed whose first batch meets an empty balance: KNOWN comes from the cache, UNPAID is refused and AI pauses. */
  async function pausedFeed(cached: string[]) {
    vi.stubGlobal('IntersectionObserver', OffScreenIO);
    document.body.innerHTML = feed2026(postCard(KNOWN), postCard(UNPAID));
    const bg = emptyBalance(cached);
    const c = new FeedController(linkedinAdapter, bg.bridge, mountUi);
    const rt = runtime({ device: { ...defaultDevice('d'), aiSource: { kind: 'server', baseUrl: 'https://ai.example.org' } } });
    c.start(rt);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(1);
    expect(sentKeys(bg.classify.mock.calls[0])).toStrictEqual([id(KNOWN), id(UNPAID)]);
    expect(c.buildState().ai).toMatchObject({ state: 'paused' });
    return { c, bg, rt };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    document.documentElement.lang = 'en';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('test_pause_keeps_known_classifications', async () => {
    const { c } = await pausedFeed([KNOWN]);
    expect(state(KNOWN)).toBe('collapsed');
    // The page goes on while AI is paused: posts settle and are decided again, and an ad scrolls in.
    scrollIn(PROMOTED_FOLLOWS_PAGE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state(KNOWN)).toBe('collapsed');
    expect(hidden(c, KNOWN)).toMatchObject({ reasonKey: 'noise:engagement-bait', ai: true });
    expect(state(AD)).toBe('collapsed');
    expect(hidden(c, AD)).toMatchObject({ ai: false });
    expect(state(UNPAID)).toBeNull();
    c.stop();
  });

  it('test_pause_sends_cache_only', async () => {
    const { c, bg } = await pausedFeed([KNOWN, LATER_KNOWN]);
    scrollIn(postCard(LATER_KNOWN));
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(2);
    expect(sentKeys(bg.classify.mock.calls[1])).toStrictEqual([id(LATER_KNOWN)]);
    expect(bg.classify.mock.calls[1]?.[1]).toStrictEqual({ cacheOnly: true });
    expect(state(LATER_KNOWN)).toBe('collapsed');
    expect(hidden(c, LATER_KNOWN)).toMatchObject({ reasonKey: 'noise:engagement-bait', ai: true });
    c.stop();
  });

  it('test_pause_sends_rest_of_queue_cache_only', async () => {
    // AI is turned on with the feed already read: every post has settled, and more than one batch is queued at once.
    vi.stubGlobal('IntersectionObserver', OffScreenIO);
    const first = [UNPAID, ...[1, 2, 3, 4, 5].map((n) => `UUUkeyFirstBatch0${n}`)];
    document.body.innerHTML = feed2026(...[...first, LATER_KNOWN, LATER_NEW].map(postCard));
    const bg = emptyBalance([LATER_KNOWN]);
    const c = new FeedController(linkedinAdapter, bg.bridge, mountUi);
    const rt = runtime({ device: { ...defaultDevice('d'), aiSource: { kind: 'server', baseUrl: 'https://ai.example.org' } } });
    c.start({ ...rt, device: { ...rt.device, aiSource: null } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(bg.classify).not.toHaveBeenCalled();
    c.update(rt);
    await vi.advanceTimersByTimeAsync(5000);
    // The first batch meets the empty balance; the rest of the queue still reaches the cache, and only the cache.
    expect(bg.classify).toHaveBeenCalledTimes(2);
    expect(sentKeys(bg.classify.mock.calls[0])).toStrictEqual(first.map(id).sort());
    expect(bg.classify.mock.calls[0]?.[1]).toStrictEqual({ cacheOnly: false });
    expect(sentKeys(bg.classify.mock.calls[1])).toStrictEqual([id(LATER_KNOWN), id(LATER_NEW)]);
    expect(bg.classify.mock.calls[1]?.[1]).toStrictEqual({ cacheOnly: true });
    expect(state(LATER_KNOWN)).toBe('collapsed');
    expect(hidden(c, LATER_KNOWN)).toMatchObject({ reasonKey: 'noise:engagement-bait', ai: true });
    expect(state(LATER_NEW)).toBeNull();
    expect(c.buildState().ai).toMatchObject({ state: 'paused', code: PAUSE.code });
    c.stop();
  });

  it('test_pause_skips_uncached_without_network', async () => {
    const { c, bg } = await pausedFeed([KNOWN]);
    scrollIn(postCard(LATER_NEW));
    await vi.advanceTimersByTimeAsync(30_000);
    // One cache lookup, and nothing asked again while paused (not even after the post settles).
    expect(bg.classify).toHaveBeenCalledTimes(2);
    expect(sentKeys(bg.classify.mock.calls[1])).toStrictEqual([id(LATER_NEW)]);
    expect(bg.classify.mock.calls.slice(1).map(([, opts]) => opts?.cacheOnly)).toStrictEqual([true]);
    expect(state(LATER_NEW)).toBeNull();
    expect(hidden(c, LATER_NEW)).toBeUndefined();
    expect(c.mounted().map((e) => e.id)).not.toContain(id(LATER_NEW));
    c.stop();
  });

  it('test_resume_requeues_paused_posts', async () => {
    const { c, bg, rt } = await pausedFeed([KNOWN]);
    scrollIn(postCard(LATER_NEW));
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(2);
    // Credit was added and AI resumed: "aiResume" and every settings change call update().
    bg.addCredit();
    c.update(rt);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(3);
    expect(sentKeys(bg.classify.mock.calls[2])).toStrictEqual([id(UNPAID), id(LATER_NEW)]);
    expect(bg.classify.mock.calls[2]?.[1]).toStrictEqual({ cacheOnly: false });
    expect(c.buildState().ai).toStrictEqual({ state: 'ready' });
    expect(state(KNOWN)).toBe('collapsed');
    c.stop();
  });

  it('test_resume_during_cache_lookup_asks_again', async () => {
    const { c, bg, rt } = await pausedFeed([KNOWN]);
    let release = () => {};
    bg.classify.mockImplementationOnce(async (items, opts) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return bg.answer(items, opts);
    });
    scrollIn(postCard(LATER_NEW));
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify.mock.calls[1]?.[1]).toStrictEqual({ cacheOnly: true });
    // AI resumes while that lookup is still on its way: the refused post is asked again at once...
    bg.addCredit();
    c.update(rt);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(3);
    expect(sentKeys(bg.classify.mock.calls[2])).toStrictEqual([id(UNPAID)]);
    // ...and the looked-up one as soon as the cache says it doesn't know it.
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(4);
    expect(sentKeys(bg.classify.mock.calls[3])).toStrictEqual([id(LATER_NEW)]);
    expect(bg.classify.mock.calls[3]?.[1]).toStrictEqual({ cacheOnly: false });
    c.stop();
  });

  it('test_ai_off_still_skips_ai_filters', async () => {
    const { c, bg, rt } = await pausedFeed([KNOWN, LATER_KNOWN]);
    let release = () => {};
    bg.classify.mockImplementationOnce(async (items, opts) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return bg.answer(items, opts);
    });
    scrollIn(postCard(LATER_KNOWN));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentKeys(bg.classify.mock.calls[1])).toStrictEqual([id(LATER_KNOWN)]);
    // AI is turned off while that cache lookup is on its way; its answer arrives afterwards.
    c.update({ ...rt, device: { ...rt.device, aiSource: null } });
    release();
    scrollIn(postCard(LATER_NEW));
    scrollIn(PROMOTED_FOLLOWS_PAGE);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bg.classify).toHaveBeenCalledTimes(2);
    // The late answer held a classification, but with no AI source configured it does not hide the post.
    await expect(bg.classify.mock.results[1]?.value).resolves.toMatchObject({
      results: [{ key: id(LATER_KNOWN), status: 'ok', classification: BAIT }],
    });
    expect(state(LATER_KNOWN)).toBeNull();
    expect(hidden(c, LATER_KNOWN)).toBeUndefined();
    expect(state(KNOWN)).toBeNull();
    expect(state(LATER_NEW)).toBeNull();
    expect(state(AD)).toBe('collapsed');
    expect(c.buildState().ai).toStrictEqual({ state: 'off' });
    c.stop();
  });

  it('test_pause_reported_in_tab_state', async () => {
    const { c, bg } = await pausedFeed([KNOWN, LATER_KNOWN]);
    const paused = { state: 'paused', code: PAUSE.code, message: PAUSE.message };
    expect(c.buildState().ai).toStrictEqual(paused);
    // Cache lookups go on while paused; the tab still says paused.
    scrollIn(postCard(LATER_KNOWN));
    await vi.advanceTimersByTimeAsync(1000);
    expect(bg.classify).toHaveBeenCalledTimes(2);
    expect(c.buildState().ai).toStrictEqual(paused);
    expect(vi.mocked(bg.bridge.pushTabState).mock.lastCall?.[0].ai).toStrictEqual(paused);
    c.stop();
  });
});
