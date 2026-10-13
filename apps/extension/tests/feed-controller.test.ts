import { defaultDevice, defaultSettings, EMPTY_LEARNED } from '@unalgorithm/core';
import { facebookAdapter, linkedinAdapter } from '@unalgorithm/platforms';
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
import type { ClassifyItem } from '../src/lib/messages.ts';

function runtime(over: Partial<Runtime> = {}): Runtime {
  return { settings: defaultSettings(), device: defaultDevice('dev1'), learned: EMPTY_LEARNED, votes: {}, ...over };
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
