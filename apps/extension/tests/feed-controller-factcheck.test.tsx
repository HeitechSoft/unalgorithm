/**
 * "Check facts" in the feed (P3-07): offered only by the P3-05 rule on a post that isn't folded away, never automatic,
 * the price shown before a check runs, then progress and the outcome.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  defaultSettings,
  EMPTY_LEARNED,
  jobPriceLabel,
  type ServerOffer,
  toPostForAI,
} from '@unalgorithm/core';
import { facebookAdapter, linkedinAdapter, type PlatformAdapter } from '@unalgorithm/platforms';
import type { Classification, FactcheckResult, PostKey } from '@unalgorithm/protocol';
import { FeedItem } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRIEND_POST, fbFeed, ORGANIC_LINK_SHARE } from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import type { BgResponses, ClassifyItem } from '../src/lib/messages.ts';

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const PRICE = 'About $0.12 on your Anthropic account';
const CLAIMS = 'CCCkeyCheckClaims1';
const NEWS = 'NNNkeyNewsOnly0002';
const PLAIN = 'PPPkeyPlainPost003';
const BAIT = 'BBBkeyBaitClaims04';
const id = (key: string) => `li:ck:${key}` as PostKey;
const postCard = (key: string) => FIRST_DEGREE_POST.replaceAll('EEEkeyFirstDegree5', key);

const BASE: Classification = { relevance: 50, noise: [], topics: ['x'], reason: 'r', isNews: false, hasCheckableClaims: false };
/** What the classifier says about each test post (anything else is checkable). */
const FLAGS: Record<string, Partial<Classification>> = {
  [id(CLAIMS)]: { hasCheckableClaims: true },
  [id(NEWS)]: { isNews: true },
  [id(PLAIN)]: {},
  [id(BAIT)]: { hasCheckableClaims: true, relevance: 10, noise: ['engagement-bait'] },
};

const device = (labs: boolean, aiSource: AISourceConfig = ANTHROPIC): Device => ({
  ...defaultDevice('d'),
  aiSource,
  labs: { factcheck: labs, perspectives: false },
});

function runtime(d: Device, serverOffer: ServerOffer | null = null): Runtime {
  return {
    settings: defaultSettings(),
    device: d,
    learned: EMPTY_LEARNED,
    votes: {},
    serverOffer,
    officialList: { list: null, checkedAt: 0 },
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
        classification: { ...BASE, ...(FLAGS[i.key] ?? { hasCheckableClaims: true }) },
      })),
    })),
    pushTabState: vi.fn(),
    vote: vi.fn(async () => undefined),
    settingsAction: vi.fn(async () => null),
    coachMarkShown: vi.fn(),
    openSettings: vi.fn(),
    report: vi.fn(),
    factcheck: vi.fn(async (): Promise<BgResponses['factcheck']> => ({ ok: true, result: {} as FactcheckResult })),
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

// jsdom has no IntersectionObserver. Every item is near (so it is classified); `onScreen` says whether it is in view
// (an AI verdict folds a post only once it is off screen).
function io(onScreen: boolean) {
  return class {
    root = null;
    constructor(
      private cb: IntersectionObserverCallback,
      private opts: IntersectionObserverInit = {},
    ) {}
    observe(el: Element) {
      const isIntersecting = onScreen || !!this.opts.rootMargin;
      queueMicrotask(() => this.cb([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry], this as never));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}

async function feed(
  html: string,
  d: Device,
  b = bridge(),
  opts: { adapter?: PlatformAdapter; onScreen?: boolean; serverOffer?: ServerOffer | null } = {},
) {
  vi.stubGlobal('IntersectionObserver', io(opts.onScreen ?? true));
  document.body.innerHTML = html;
  const c = new FeedController(opts.adapter ?? linkedinAdapter, b, mountUi);
  const rt = runtime(d, opts.serverOffer ?? null);
  c.start(rt);
  await vi.advanceTimersByTimeAsync(5000);
  expect(b.classify).toHaveBeenCalled();
  return { c, b, rt };
}

const offered = (c: FeedController) => c.mounted().filter((e) => c.modelFor(e).factcheck);
const entryOf = (c: FeedController, key: string) => c.mounted().find((e) => e.id === id(key)) as Entry;

/** Renders one item's UI the way the content script's UI layer does. */
function Item({ c, e }: { c: FeedController; e: Entry }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  return e.handlers ? <FeedItem model={c.modelFor(e)} on={e.handlers} /> : null;
}

/** Lets the controller's microtask-batched update reach React. */
const flush = () => act(async () => {});

/** One checkable LinkedIn post with its "Check facts" action on screen. */
async function offeredPost(b = bridge(), d = device(true), serverOffer: ServerOffer | null = null) {
  const f = await feed(feed2026(postCard(CLAIMS)), d, b, { serverOffer });
  // React's act waits on real timers.
  vi.useRealTimers();
  const e = entryOf(f.c, CLAIMS);
  const { container } = render(<Item c={f.c} e={e} />);
  await flush();
  const user = setupUser();
  await user.click(screen.getByRole('button', { name: 'Check facts' }));
  await flush();
  return { ...f, e, user, item: within(container) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Check facts: where it is offered', () => {
  it('test_no_action_when_labs_off', async () => {
    const { c } = await feed(feed2026(postCard(CLAIMS), postCard(NEWS)), device(false));
    expect(c.mounted()).toHaveLength(0);
    expect(document.querySelectorAll('unalgo-post')).toHaveLength(0);
    c.stop();
  });

  it('test_action_on_checkable_claims_and_news_posts_only', async () => {
    const { c, b } = await feed(feed2026(postCard(CLAIMS), postCard(NEWS), postCard(PLAIN)), device(true));
    expect(offered(c).map((e) => e.id)).toStrictEqual([id(CLAIMS), id(NEWS)]);
    expect(c.mounted().map((e) => e.id)).not.toContain(id(PLAIN));
    expect(c.modelFor(entryOf(c, CLAIMS)).factcheck).toStrictEqual({ state: 'offered', price: PRICE });
    // Never automatic.
    expect(b.factcheck).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_no_action_on_facebook_friends_post_or_compat_source_without_search_key', async () => {
    const fb = await feed(fbFeed(FRIEND_POST, ORGANIC_LINK_SHARE), device(true), bridge(), { adapter: facebookAdapter });
    expect(fb.b.classify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fb.b.classify).mock.calls[0]?.[0]).toHaveLength(2);
    expect(offered(fb.c).map((e) => e.post?.audience)).toStrictEqual(['public']);
    fb.c.stop();

    // An OpenAI-compatible source can't fact-check until this device has a web search key (P3-44).
    const compat: AISourceConfig = {
      kind: 'openai-compatible',
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      auth: 'none',
      model: null,
    };
    const noKey = await feed(feed2026(postCard(CLAIMS)), device(true, compat));
    expect(noKey.c.mounted()).toHaveLength(0);
    noKey.c.stop();
  });

  it('test_feed_price_line_passes_web_search', async () => {
    // P3-45: the feed passes this device's web search key, so the price is P3-44's compat line.
    const compat: AISourceConfig = {
      kind: 'openai-compatible',
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      auth: 'none',
      model: null,
    };
    const d: Device = { ...device(true, compat), webSearch: { provider: 'brave' } };
    const { c } = await feed(feed2026(postCard(CLAIMS)), d);
    const price = c.modelFor(entryOf(c, CLAIMS)).factcheck;
    expect(price).toStrictEqual({ state: 'offered', price: jobPriceLabel('factcheck', compat, null, { provider: 'brave' }) });
    expect(price).toMatchObject({
      price: expect.stringMatching(/^Free on this computer, plus up to \d+ searches on your Brave key$/),
    });
    c.stop();
  });

  it('test_no_action_on_collapsed_post_until_revealed', async () => {
    const { c } = await feed(feed2026(postCard(BAIT)), device(true), bridge(), { onScreen: false });
    const e = entryOf(c, BAIT);
    expect(e.el.getAttribute('data-unalgo')).toBe('collapsed');
    expect(c.modelFor(e).factcheck).toBeUndefined();
    expect(c.reveal(id(BAIT))).toBe(true);
    expect(c.modelFor(e)).toMatchObject({ state: 'revealed', factcheck: { state: 'offered', price: PRICE } });
    c.stop();
  });

  it('test_action_appears_when_labs_turned_on_live', async () => {
    const { c, b, rt } = await feed(feed2026(postCard(CLAIMS)), device(false));
    expect(c.mounted()).toHaveLength(0);
    c.update({ ...rt, device: device(true) });
    expect(offered(c).map((e) => e.id)).toStrictEqual([id(CLAIMS)]);
    // ...and goes away again when Fact-check is switched off.
    c.update({ ...rt, device: device(false) });
    expect(c.mounted()).toHaveLength(0);
    expect(b.classify).toHaveBeenCalledTimes(1);
    c.stop();
  });
});

describe('Check facts: price first, then the check', () => {
  it('test_start_shows_price_and_sends_nothing', async () => {
    const { c, b } = await offeredPost();
    expect(screen.getByText(PRICE)).toBeTruthy();
    const check = screen.getByRole('button', { name: 'Check' });
    expect(document.activeElement).toBe(check);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(b.factcheck).not.toHaveBeenCalled();
    expect(b.openFactcheck).not.toHaveBeenCalled();
    expect(b.classify).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('test_cancel_returns_to_offered_without_request', async () => {
    const { c, b, user } = await offeredPost();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    const start = screen.getByRole('button', { name: 'Check facts' });
    // Its visible text is its whole name: no aria-label (only UnEcho Chamber's button adds what it does).
    expect(start.hasAttribute('aria-label')).toBe(false);
    expect(screen.queryByText('Labs')).toBeNull();
    expect(screen.queryByText(PRICE)).toBeNull();
    expect(b.factcheck).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_confirm_sends_one_request_with_post_for_ai_input', async () => {
    const { c, b, e, rt, user } = await offeredPost();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    expect(b.factcheck).toHaveBeenCalledTimes(1);
    const [key, input] = vi.mocked(b.factcheck).mock.calls[0] ?? [];
    expect(key).toBe(id(CLAIMS));
    const { ref: _ref, ...expected } = toPostForAI(e.post as NonNullable<Entry['post']>, {
      ref: 'x',
      redactMentions: rt.settings.ai.redactMentions,
    });
    expect(input).toStrictEqual(expected);
    expect(input).not.toHaveProperty('ref');
    expect(input).not.toHaveProperty('permalink');
    expect(JSON.stringify(input)).not.toContain('Morgan Ellis');
    expect(JSON.stringify(input)).not.toContain('linkedin.com');
    c.stop();
  });

  it('test_running_state_live_region_without_buttons', async () => {
    let finish: (r: BgResponses['factcheck']) => void = () => {};
    const factcheck = vi.fn(
      () =>
        new Promise<BgResponses['factcheck']>((resolve) => {
          finish = resolve;
        }),
    );
    const { c, user, item } = await offeredPost(bridge({ factcheck }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    const status = screen.getByText('Checking facts…');
    expect(status.closest('[aria-live="polite"]')).toBeTruthy();
    expect(item.queryAllByRole('button')).toHaveLength(0);
    finish({ ok: true, result: {} as FactcheckResult });
    await flush();
    expect(screen.getByText('Checked.')).toBeTruthy();
    expect(factcheck).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('test_success_see_result_opens_panel_or_points_to_toolbar', async () => {
    const { c, b, user } = await offeredPost();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'See result' }));
    await flush();
    expect(b.openFactcheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/from the toolbar/)).toBeNull();
    // Chrome refused to open the panel from the relayed click: point to the toolbar popup instead.
    vi.mocked(b.openFactcheck).mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'See result' }));
    await flush();
    expect(b.openFactcheck).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Checked. Open UnAlgorithm from the toolbar to see it.')).toBeTruthy();
    expect(b.factcheck).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('test_failure_shows_message_and_retry_asks_price_again', async () => {
    const message = 'Anthropic is busy right now. Try again in a minute.';
    const factcheck = vi.fn(
      async (): Promise<BgResponses['factcheck']> => ({ ok: false, error: { code: 'overloaded', message } }),
    );
    const { c, user } = await offeredPost(bridge({ factcheck }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    expect(screen.getByText(message)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByText(PRICE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(factcheck).toHaveBeenCalledTimes(1);
    // A stale extension context (the message never reached the background) reads as an error too.
    factcheck.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    expect(screen.getByText("Couldn't reach UnAlgorithm. Reload the page.")).toBeTruthy();
    c.stop();
  });
});

const ORIGIN = 'https://unalgo.example';
const SERVER: AISourceConfig = { kind: 'server', baseUrl: ORIGIN };
const FREE_OFFER: ServerOffer = {
  origin: ORIGIN,
  billing: false,
  factcheck: true,
  factcheckPrice: null,
  perspectives: false,
  perspectivesPrice: null,
};
const BILLING_OFFER: ServerOffer = {
  origin: ORIGIN,
  billing: true,
  factcheck: true,
  factcheckPrice: { typicalMicros: 240_000, maxMicros: 400_000 },
  perspectives: false,
  perspectivesPrice: null,
};

describe('Check facts: a server source follows its offer (P3-22)', () => {
  it('test_feed_server_offer_shows_free_price', async () => {
    const { c, b } = await offeredPost(bridge(), device(true, SERVER), FREE_OFFER);
    expect(screen.getByText('Free on this server')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(b.factcheck).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_feed_billing_server_shows_price_and_cap', async () => {
    const { c, b } = await offeredPost(bridge(), device(true, SERVER), BILLING_OFFER);
    expect(screen.getByText('About $0.24, at most $0.40')).toBeTruthy();
    expect(b.factcheck).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_feed_no_offer_no_button', async () => {
    for (const serverOffer of [null, { ...FREE_OFFER, factcheck: false }]) {
      const { c } = await feed(feed2026(postCard(CLAIMS)), device(true, SERVER), bridge(), { serverOffer });
      expect(c.mounted()).toHaveLength(0);
      expect(offered(c)).toHaveLength(0);
      c.stop();
    }
  });

  it('test_feed_follows_server_offer_changes', async () => {
    const { c, b, rt } = await feed(feed2026(postCard(CLAIMS)), device(true, SERVER), bridge());
    expect(c.mounted()).toHaveLength(0);
    // What bootstrap's `serverOfferItem.watch` does: set `rt.serverOffer`, then `controller.update(rt)`.
    rt.serverOffer = FREE_OFFER;
    c.update(rt);
    expect(offered(c).map((e) => e.id)).toStrictEqual([id(CLAIMS)]);
    const e = entryOf(c, CLAIMS);
    expect(c.modelFor(e).factcheck).toStrictEqual({ state: 'offered', price: 'Free on this server' });
    // An offer the user opened but did not confirm goes away with the server's offer.
    e.handlers?.onFactcheck?.('start');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.modelFor(e).factcheck?.state).toBe('confirming');
    rt.serverOffer = null;
    c.update(rt);
    expect(c.mounted()).toHaveLength(0);
    expect(e.factcheck).toBeUndefined();
    expect(b.factcheck).not.toHaveBeenCalled();
    expect(b.classify).toHaveBeenCalledTimes(1);
    c.stop();
  });
});
