/**
 * What each batch of posts cost, shown to the person (CL6-04, R35): the Why? popover of a post the AI hid has a line
 * with its batch's charge, and Settings → AI shows today's charged total and the day's batches. The figures are the
 * ones CL6-03 stored (the server's `chargedMicros`); the UI only formats them. Extension storage is the WXT fake browser.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  type BatchCharge,
  type DayUsage,
  dateKey,
  defaultDevice,
  defaultSettings,
  EMPTY_LEARNED,
  type FilterDecision,
  formatCharge,
} from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import type { Classification, PostKey } from '@unalgorithm/protocol';
import { FeedItem, type FeedItemHandlers, type FeedItemModel, whyCopy } from '@unalgorithm/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import { AiPane } from '../src/entrypoints/options/panes.tsx';
import type { ClassifyItem, ClassifyItemResult } from '../src/lib/messages.ts';
import { usageItem } from '../src/lib/storage.ts';

vi.mock('../src/lib/messages.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/messages.ts')>()),
  sendToBackground: vi.fn(async () => undefined),
  sendQuietly: vi.fn(),
}));

const NOISE: FilterDecision = { reason: 'noise', source: 'ai', noise: ['engagement-bait'] };
const OFF_TOPIC: FilterDecision = { reason: 'low-relevance', source: 'ai' };
const SPONSORED: FilterDecision = { reason: 'sponsored', source: 'rule' };

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
});

describe('Why? copy', () => {
  it('test_why_cost_line_for_ai_decisions', () => {
    for (const d of [NOISE, OFF_TOPIC]) {
      expect(whyCopy(d, undefined, 'linkedin', 'calm', { batchPosts: 12, chargedMicros: 1_752 }).cost).toBe(
        'This batch of 12 posts cost $0.0018 of your credit.',
      );
      expect(whyCopy(d, undefined, 'linkedin', 'calm', { batchPosts: 1, chargedMicros: 146 }).cost).toBe(
        'This batch of 1 post cost $0.0001 of your credit.',
      );
    }
  });

  it('test_why_no_cost_without_charge_or_for_rules', () => {
    const charge = { batchPosts: 12, chargedMicros: 1_752 };
    expect(whyCopy(SPONSORED, undefined, 'linkedin', 'calm', charge)).not.toHaveProperty('cost');
    expect(whyCopy(NOISE, undefined, 'linkedin', 'calm')).not.toHaveProperty('cost');
    // Four-argument callers get the same objects as before.
    expect(whyCopy(NOISE, undefined, 'linkedin', 'calm', undefined)).toStrictEqual(whyCopy(NOISE, undefined, 'linkedin', 'calm'));
    expect(whyCopy(SPONSORED, undefined, 'linkedin', 'calm', charge)).toStrictEqual(
      whyCopy(SPONSORED, undefined, 'linkedin', 'calm'),
    );
  });

  it('test_feed_item_popover_shows_cost', () => {
    const on: FeedItemHandlers = {
      onShow: vi.fn(),
      onHide: vi.fn(),
      onShowAll: vi.fn(),
      onWhyAction: vi.fn(),
      onVote: vi.fn(),
      onCoachDone: vi.fn(),
      onFactcheck: vi.fn(),
      onPerspectives: vi.fn(),
    };
    const model = (charge?: { batchPosts: number; chargedMicros: number }): FeedItemModel => ({
      key: 'k',
      platform: 'linkedin',
      state: 'collapsed',
      reason: 'noise',
      reasonLabel: 'Engagement bait',
      ai: true,
      showReason: true,
      why: whyCopy(NOISE, undefined, 'linkedin', 'calm', charge),
      forYouStyle: 'label',
    });
    const paragraphs = (c: HTMLElement) =>
      [...(c.querySelector('.ua-popover')?.querySelectorAll('p') ?? [])].map((p) => p.textContent);

    const plain = render(<FeedItem model={model()} on={on} />);
    const before = paragraphs(plain.container);
    expect(before).toStrictEqual(['It asks people to react or comment so it spreads further.', 'What we saw: AI · can be wrong']);
    plain.unmount();

    const charged = render(<FeedItem model={model({ batchPosts: 12, chargedMicros: 1_752 })} on={on} />);
    const pop = charged.container.querySelector('.ua-popover') as HTMLElement;
    expect(within(pop).getByText('This batch of 12 posts cost $0.0018 of your credit.').className).toBe('ua-pop-note');
    expect(paragraphs(charged.container)).toStrictEqual([...before, 'This batch of 12 posts cost $0.0018 of your credit.']);
  });
});

describe('feed controller', () => {
  const CHARGED = 'CCCkeyChargedPost1';
  const CACHED = 'DDDkeyCachedPost02';
  const id = (key: string) => `li:ck:${key}` as PostKey;
  const postCard = (key: string) => FIRST_DEGREE_POST.replaceAll('EEEkeyFirstDegree5', key);
  const BAIT: Classification = {
    relevance: 10,
    noise: ['engagement-bait'],
    topics: ['x'],
    reason: 'r',
    isNews: false,
    hasCheckableClaims: false,
  };

  // Every item is near (so it is queued) and off screen (so an AI verdict applies at once).
  class OffScreenIO {
    root = null;
    constructor(
      private cb: IntersectionObserverCallback,
      private opts: IntersectionObserverInit = {},
    ) {}
    observe(el: Element) {
      const isIntersecting = !!this.opts.rootMargin;
      queueMicrotask(() => this.cb([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    document.documentElement.lang = 'en';
    vi.stubGlobal('IntersectionObserver', OffScreenIO);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('test_controller_why_cost_follows_result', async () => {
    // The billing server's batch: CHARGED was classified now; CACHED came from the saved results, at no cost.
    let calls = 0;
    const classify = vi.fn(async (items: ClassifyItem[]) => {
      calls++;
      return {
        results: items.map(
          (i): ClassifyItemResult =>
            calls === 1 && i.key === id(CHARGED)
              ? {
                  key: i.key,
                  status: 'ok',
                  classification: BAIT,
                  model: 'm',
                  cached: false,
                  charge: { batchPosts: 3, chargedMicros: 438 },
                }
              : { key: i.key, status: 'ok', classification: BAIT, model: 'm', cached: i.key === id(CACHED) },
        ),
      };
    });
    const b: Bridge = {
      classify,
      pushTabState: vi.fn(),
      vote: vi.fn(async () => undefined),
      settingsAction: vi.fn(async () => null),
      coachMarkShown: vi.fn(),
      openSettings: vi.fn(),
      report: vi.fn(),
      factcheck: vi.fn(),
      openFactcheck: vi.fn(async () => true),
      perspectives: vi.fn(),
    };
    document.body.innerHTML = feed2026(postCard(CHARGED), postCard(CACHED));
    const mountUi = (e: Entry) => {
      const host = document.createElement('unalgo-post');
      const container = document.createElement('div');
      host.attachShadow({ mode: 'open' }).append(container);
      e.el.appendChild(host);
      return { host, container };
    };
    const c = new FeedController(linkedinAdapter, b, mountUi);
    const rt: Runtime = {
      settings: defaultSettings(),
      device: { ...defaultDevice('d'), aiSource: { kind: 'server', baseUrl: 'https://ai.example.org' } },
      learned: EMPTY_LEARNED,
      votes: {},
      serverOffer: null,
      officialList: { list: null, checkedAt: 0 },
    };
    c.start(rt);
    await vi.advanceTimersByTimeAsync(1000);
    expect(classify).toHaveBeenCalledTimes(1);
    const why = (key: string) => {
      const e = c.mounted().find((m) => m.id === id(key));
      expect(e).toBeDefined();
      return c.modelFor(e as Entry).why;
    };
    expect(why(CHARGED)).toMatchObject({
      title: 'Looks like engagement bait',
      cost: 'This batch of 3 posts cost $0.0004 of your credit.',
    });
    // From the cache: it cost nothing now.
    expect(why(CACHED)).toMatchObject({ title: 'Looks like engagement bait' });
    expect(why(CHARGED)?.cost).toBe('This batch of 3 posts cost $0.0004 of your credit.');
    expect(why(CACHED)).not.toHaveProperty('cost');

    // A new AI source: the old charge goes with the old classification, and the new (own-key) result has none.
    c.update({ ...rt, device: { ...rt.device, aiSource: { kind: 'anthropic', model: null } } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(why(CHARGED)).toMatchObject({ title: 'Looks like engagement bait' });
    expect(why(CHARGED)).not.toHaveProperty('cost');
    c.stop();
  });
});

describe('usage view', () => {
  const settings = defaultSettings();
  const device = { ...defaultDevice('dev1'), aiSource: { kind: 'server', baseUrl: 'https://ai.example.org' } } as const;
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

  async function showUsage(day: DayUsage) {
    await usageItem.setValue({ [dateKey()]: day });
    render(<AiPane settings={settings} save={vi.fn(async () => {})} device={device} saveDevice={vi.fn(async () => {})} />);
  }
  const groupOf = (header: string) => screen.getByRole('heading', { name: header }).closest('section') as HTMLElement;

  it('test_ai_pane_shows_charged_today_and_batches', async () => {
    // Twelve batches, newest first, as CL6-03 stores them.
    const batches: BatchCharge[] = Array.from({ length: 12 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 16, 15, 59 - i * 3)).toISOString(),
      posts: i === 0 ? 1 : 6,
      chargedMicros: i === 0 ? 146 : 4_500 + i,
    }));
    await showUsage({ posts: 340, calls: 12, failedCalls: 0, byModel: {}, chargedMicros: 49_640, batches });
    await screen.findByText('Today: 340 posts · $0.05 charged');
    const group = groupOf('Batches today');
    const rows = group.querySelectorAll('.ua-row');
    expect(rows).toHaveLength(10);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('1 post')).toBeTruthy();
    expect(first.getByText(time.format(new Date(batches[0]?.at ?? '')))).toBeTruthy();
    expect(first.getByText(formatCharge(146))).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('6 posts')).toBeTruthy();
    expect(within(rows[9] as HTMLElement).getByText(formatCharge(4_509))).toBeTruthy();
    expect(
      within(group).getByText(
        'What the server charged your credit for each batch from this browser, newest first. Your account page adds up the charges of all your devices per day (UTC).',
      ),
    ).toBeTruthy();
  });

  it('test_ai_pane_charged_total_is_the_stored_sum', async () => {
    // AC 7: the subtitle formats the day's stored `chargedMicros`, which is the sum of its batches.
    const batches: BatchCharge[] = [438, 1_752, 146].map((chargedMicros, i) => ({
      at: new Date(Date.UTC(2026, 9, 16, 12, 30 - i)).toISOString(),
      posts: 3,
      chargedMicros,
    }));
    const total = batches.reduce((s, b) => s + b.chargedMicros, 0);
    expect(total).toBe(2_336);
    await showUsage({ posts: 9, calls: 3, failedCalls: 0, byModel: {}, chargedMicros: total, batches });
    await screen.findByText('Today: 9 posts · $0.0023 charged');
    expect(formatCharge(2_336)).toBe('$0.0023');
    expect(groupOf('Batches today').querySelectorAll('.ua-row')).toHaveLength(3);
  });

  it('test_ai_pane_without_charges_unchanged', async () => {
    // An own-key day: estimated cost, no charges.
    await showUsage({
      posts: 40,
      calls: 7,
      failedCalls: 0,
      byModel: {
        'claude-haiku-5-5': {
          calls: 7,
          usage: { uncachedInput: 100_000, cacheRead: 0, cacheWrite: 0, output: 10_000, webSearches: 0, estimated: false },
        },
      },
    });
    await waitFor(() => expect(screen.getByText(/^Today: 40 posts · /)).toBeTruthy());
    expect(screen.getByText(/^Today: 40 posts · /).textContent).not.toContain('charged');
    expect(screen.queryByRole('heading', { name: 'Batches today' })).toBeNull();
  });
});
