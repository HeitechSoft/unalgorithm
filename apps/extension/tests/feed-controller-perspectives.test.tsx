/**
 * "Other perspectives" in the feed (P3-40): offered only by the P3-36 rule with a usable registry, never automatic, the
 * price shown before a comparison runs, only the shared link sent, and its own row beside fact-check's.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import {
  type AISourceConfig,
  type Device,
  defaultDevice,
  defaultSettings,
  EMPTY_LEARNED,
  type ServerOffer,
} from '@unalgorithm/core';
import { facebookAdapter, linkedinAdapter, type PlatformAdapter } from '@unalgorithm/platforms';
import type { Classification, FactcheckResult, PerspectivesResult, PostKey } from '@unalgorithm/protocol';
import { FeedItem } from '@unalgorithm/ui';
import { setupUser } from '@unalgorithm/ui/testing';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fbFeed, ORGANIC_LINK_SHARE } from '../../../packages/platforms/fixtures/facebook/synthetic.ts';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { type Bridge, type Entry, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import type { BgResponses, ClassifyItem } from '../src/lib/messages.ts';

/** Whether this build has a usable registry: the fictional fixture, or none. */
const registry = vi.hoisted(() => ({ ready: true }));
vi.mock('../src/lib/outlets.ts', async (importOriginal) => {
  const { FIXTURE_REGISTRY } = await import('@unalgorithm/outlets/testing');
  return {
    ...(await importOriginal<typeof import('../src/lib/outlets.ts')>()),
    perspectivesRegistry: () => (registry.ready ? FIXTURE_REGISTRY : null),
  };
});

const ANTHROPIC: AISourceConfig = { kind: 'anthropic', model: null };
const PRICE = 'About $0.14 on your Anthropic account';
const FC_PRICE = 'About $0.12 on your Anthropic account';
const NEWS_LINK = 'NNNkeyNewsLinkShr1';
const NEWS_NO_LINK = 'NNNkeyNewsNoLink02';
const PLAIN_LINK = 'PPPkeyPlainLink003';
const BOTH = 'BBBkeyBothJobsLnk4';
const id = (key: string) => `li:ck:${key}` as PostKey;
const URL_ = 'https://news.example.com/transit-budget';
const TITLE = 'City approves new transit budget';
const LINK = `<a href="${URL_}"><span>${TITLE}</span></a>`;
/** A fictional first-degree LinkedIn post, optionally sharing a news link. */
const postCard = (key: string, link = true) =>
  FIRST_DEGREE_POST.replaceAll('EEEkeyFirstDegree5', key).replace(
    '<div class="e0sbar">',
    `${link ? LINK : ''}<div class="e0sbar">`,
  );
const POST_TEXT = 'Which HR task would you automate first';

const BASE: Classification = { relevance: 50, noise: [], topics: ['x'], reason: 'r', isNews: false, hasCheckableClaims: false };
/** What the classifier says about each test post (anything else is news). */
const FLAGS: Record<string, Partial<Classification>> = {
  [id(PLAIN_LINK)]: {},
  [id(BOTH)]: { isNews: true, hasCheckableClaims: true },
};

const device = (perspectives: boolean, factcheck = false, aiSource: AISourceConfig = ANTHROPIC): Device => ({
  ...defaultDevice('d'),
  aiSource,
  labs: { factcheck, perspectives },
});

function runtime(d: Device, serverOffer: ServerOffer | null = null): Runtime {
  return { settings: defaultSettings(), device: d, learned: EMPTY_LEARNED, votes: {}, serverOffer };
}

function bridge(over: Partial<Bridge> = {}): Bridge {
  return {
    classify: vi.fn(async (items: ClassifyItem[]) => ({
      results: items.map((i) => ({
        key: i.key,
        status: 'ok' as const,
        model: 'test',
        cached: false,
        classification: { ...BASE, ...(FLAGS[i.key] ?? { isNews: true }) },
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
    perspectives: vi.fn(async (): Promise<BgResponses['perspectives']> => ({ ok: true, result: {} as PerspectivesResult })),
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

// jsdom has no IntersectionObserver: every item is near and on screen.
class IO {
  root = null;
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    queueMicrotask(() => this.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

async function feed(html: string, d: Device, b = bridge(), adapter: PlatformAdapter = linkedinAdapter) {
  vi.stubGlobal('IntersectionObserver', IO);
  document.body.innerHTML = html;
  const c = new FeedController(adapter, b, mountUi);
  c.start(runtime(d));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(b.classify).toHaveBeenCalled();
  return { c, b };
}

const offered = (c: FeedController) => c.mounted().filter((e) => c.modelFor(e).perspectives);
const entryOf = (c: FeedController, key: string) => c.mounted().find((e) => e.id === id(key)) as Entry;

function Item({ c, e }: { c: FeedController; e: Entry }) {
  useSyncExternalStore(c.subscribe, c.getVersion);
  return e.handlers ? <FeedItem model={c.modelFor(e)} on={e.handlers} /> : null;
}

const flush = () => act(async () => {});

/** The start button's accessible name: its visible text, "UnEcho Chamber", then what it does (D74). */
const START = 'UnEcho Chamber: see how outlets across the spectrum covered this story';

/** One offered post rendered, with its UnEcho Chamber button clicked (the price is showing). */
async function started(
  b = bridge(),
  d = device(true),
  html = feed2026(postCard(NEWS_LINK)),
  adapter: PlatformAdapter = linkedinAdapter,
) {
  const f = await feed(html, d, b, adapter);
  vi.useRealTimers();
  const e = offered(f.c)[0] as Entry;
  const { container } = render(<Item c={f.c} e={e} />);
  await flush();
  const user = setupUser();
  const start = screen.getByRole('button', { name: START });
  expect(start.textContent).toBe('UnEcho Chamber');
  await user.click(start);
  await flush();
  return { ...f, e, user, item: within(container) };
}

beforeEach(() => {
  registry.ready = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Other perspectives: where it is offered', () => {
  it('test_feed_perspectives_offered_with_price', async () => {
    const { c, b } = await started();
    expect(screen.getByRole('group', { name: 'UnEcho Chamber' })).toBeTruthy();
    expect(screen.getByText(PRICE)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.queryByRole('group', { name: 'Fact-check' })).toBeNull();
    expect(b.perspectives).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_feed_perspectives_each_gate', async () => {
    const ok = await feed(feed2026(postCard(NEWS_LINK), postCard(NEWS_NO_LINK, false), postCard(PLAIN_LINK)), device(true));
    // isNews false and no shared link: no row.
    expect(offered(ok.c).map((e) => e.id)).toStrictEqual([id(NEWS_LINK)]);
    expect(ok.c.modelFor(entryOf(ok.c, NEWS_LINK)).perspectives).toStrictEqual({ state: 'offered', price: PRICE });
    expect(ok.c.mounted()).toHaveLength(1);
    ok.c.stop();

    // The UnEcho Chamber flag off.
    const off = await feed(feed2026(postCard(NEWS_LINK)), device(false));
    expect(off.c.mounted()).toHaveLength(0);
    off.c.stop();

    // No usable registry in this build.
    registry.ready = false;
    const noRegistry = await feed(feed2026(postCard(NEWS_LINK)), device(true));
    expect(noRegistry.c.mounted()).toHaveLength(0);
    noRegistry.c.stop();
    registry.ready = true;

    // A Facebook post shared with friends: never; the same post shared publicly: offered.
    const friends = ORGANIC_LINK_SHARE.replace('Shared with Public', 'Shared with Friends');
    const fbFriends = await feed(fbFeed(friends), device(true), bridge(), facebookAdapter);
    expect(offered(fbFriends.c)).toHaveLength(0);
    fbFriends.c.stop();
    const fbPublic = await feed(fbFeed(ORGANIC_LINK_SHARE), device(true), bridge(), facebookAdapter);
    expect(offered(fbPublic.c).map((e) => e.post?.audience)).toStrictEqual(['public']);
    fbPublic.c.stop();
  });

  it('test_feed_perspectives_never_automatic', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `NN${String(i).padStart(2, '0')}keyManyNewsPo`);
    const b = bridge();
    const f = await feed(feed2026(...keys.map((k) => postCard(k))), device(true), b);
    expect(offered(f.c)).toHaveLength(20);
    expect(b.perspectives).not.toHaveBeenCalled();
    vi.useRealTimers();
    // Every offered item rendered: twenty rows, and still no call.
    render(keys.map((k) => <Item key={k} c={f.c} e={entryOf(f.c, k)} />));
    await flush();
    const starts = screen.getAllByRole('button', { name: START });
    expect(starts).toHaveLength(20);
    expect(b.perspectives).not.toHaveBeenCalled();
    const user = setupUser();
    await user.click(starts[7] as HTMLElement);
    await flush();
    expect(b.perspectives).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(b.perspectives).toHaveBeenCalledTimes(1);
    expect(vi.mocked(b.perspectives).mock.calls[0]?.[0]).toBe(id(keys[7] as string));
    expect(b.factcheck).not.toHaveBeenCalled();
    f.c.stop();
  });
});

describe('Other perspectives: the comparison', () => {
  it('test_feed_perspectives_sends_link_only', async () => {
    const li = await started();
    await li.user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(vi.mocked(li.b.perspectives).mock.calls).toStrictEqual([
      [id(NEWS_LINK), { link: { url: URL_, title: TITLE }, platform: 'linkedin' }],
    ]);
    const sent = JSON.stringify(vi.mocked(li.b.perspectives).mock.calls[0]?.[1]);
    expect(sent).not.toContain(POST_TEXT);
    expect(sent).not.toContain('Morgan Ellis');
    li.c.stop();
    cleanup();

    // Facebook adds the audience; the post's text stays behind.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const fb = await started(bridge(), device(true), fbFeed(ORGANIC_LINK_SHARE), facebookAdapter);
    await fb.user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    const [key, req] = vi.mocked(fb.b.perspectives).mock.calls[0] ?? [];
    expect(key).toBe(fb.e.post?.id);
    expect(req).toStrictEqual({
      link: { url: 'https://news.example.com/transit', title: TITLE },
      platform: 'facebook',
      audience: 'public',
    });
    expect(JSON.stringify(req)).not.toContain('Interesting read on city transit funding');
    fb.c.stop();
  });

  it('test_feed_perspectives_states', async () => {
    let finish: (r: BgResponses['perspectives']) => void = () => {};
    const perspectives = vi.fn(
      () =>
        new Promise<BgResponses['perspectives']>((resolve) => {
          finish = resolve;
        }),
    );
    const { c, b, user, item } = await started(bridge({ perspectives }));
    // Cancel from confirming returns to offered.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(screen.getByRole('button', { name: START })).toBeTruthy();
    expect(screen.queryByText(PRICE)).toBeNull();
    await user.click(screen.getByRole('button', { name: START }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    const status = screen.getByText('Comparing coverage…');
    expect(status.closest('[aria-live="polite"]')).toBeTruthy();
    expect(item.queryAllByRole('button')).toHaveLength(0);
    finish({ ok: true, result: {} as PerspectivesResult });
    await flush();
    expect(screen.getByText('Compared.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See result' }));
    await flush();
    expect(b.openFactcheck).toHaveBeenCalledTimes(1);
    // Chrome refused to open the panel: point to the toolbar popup instead.
    vi.mocked(b.openFactcheck).mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'See result' }));
    await flush();
    expect(screen.getByText('Compared. Open UnAlgorithm from the toolbar to see it.')).toBeTruthy();

    // A failed answer shows its message; Try again asks for the price again.
    const message = 'Anthropic is busy right now. Try again in a minute.';
    perspectives.mockResolvedValueOnce({ ok: false, error: { code: 'overloaded', message } });
    c.mounted()[0]?.handlers?.onPerspectives('retry');
    await flush();
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(screen.getByText(message)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByText(PRICE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeTruthy();
    // A stale extension context reads as an error too.
    perspectives.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(screen.getByText("Couldn't reach UnAlgorithm. Reload the page.")).toBeTruthy();
    expect(perspectives).toHaveBeenCalledTimes(3);
    expect(b.factcheck).not.toHaveBeenCalled();
    c.stop();
  });

  it('test_feed_both_rows_independent', async () => {
    let finish: (r: BgResponses['perspectives']) => void = () => {};
    const perspectives = vi.fn(
      () =>
        new Promise<BgResponses['perspectives']>((resolve) => {
          finish = resolve;
        }),
    );
    const b = bridge({ perspectives });
    const f = await feed(feed2026(postCard(BOTH)), device(true, true), b);
    vi.useRealTimers();
    const e = entryOf(f.c, BOTH);
    render(<Item c={f.c} e={e} />);
    await flush();
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toStrictEqual(['Fact-check', 'UnEcho Chamber']);
    const user = setupUser();
    await user.click(screen.getByRole('button', { name: START }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await flush();
    expect(f.c.modelFor(e)).toMatchObject({
      factcheck: { state: 'offered', price: FC_PRICE },
      perspectives: { state: 'running', price: PRICE },
    });
    expect(screen.getByRole('button', { name: 'Check facts' })).toBeTruthy();
    // Fact-check runs while perspectives is still running; neither touches the other.
    await user.click(screen.getByRole('button', { name: 'Check facts' }));
    await flush();
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await flush();
    expect(f.c.modelFor(e).factcheck?.state).toBe('done');
    expect(f.c.modelFor(e).perspectives?.state).toBe('running');
    finish({ ok: false, error: { code: 'overloaded', message: 'Busy.' } });
    await flush();
    expect(f.c.modelFor(e).perspectives).toMatchObject({ state: 'failed', message: 'Busy.' });
    expect(f.c.modelFor(e).factcheck?.state).toBe('done');
    expect(b.factcheck).toHaveBeenCalledTimes(1);
    expect(perspectives).toHaveBeenCalledTimes(1);
    f.c.stop();
  });
});
