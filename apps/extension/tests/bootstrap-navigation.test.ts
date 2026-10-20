// @vitest-environment-options {"url":"https://www.linkedin.com/feed/"}
/**
 * Client-side navigation into and out of the feed, and what runs where (ADR 0009 §3). Every browser the extension
 * supports has the Navigation API, so WXT reports a navigation from its `navigate` event, which comes before the address
 * changes: the content script goes by the address the event names, never by `location`, which still holds the page
 * being left. A fake `navigation` stands in for the browser's and keeps that order: `navigate` first, the address
 * after, at once (`pushState`) or later (a traversal, which Firefox commits after a timeout). The feed route starts the
 * controller; a candidate route starts it on a strong home signature and is otherwise watched; any other page gets
 * nothing. Reports start here as drafts for the report page. The background is a stubbed `runtime.sendMessage`.
 */
import { defaultDevice, HEALTHY, NOT_NOW_SNOOZE_MS } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  COMPANY_NOT_FOLLOWED,
  FIRST_DEGREE_POST,
  FOLLOWED_BY_POST,
  FOLLOWING_POST,
  feed2026,
  PROMOTED_FOLLOWS_PAGE,
} from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { bootContentScript } from '../src/content/bootstrap.ts';
import { FeedController } from '../src/content/feed-controller.ts';
import { eventGuard } from '../src/content/ui-layer.tsx';
import type { BgRequest, ContentRequest } from '../src/lib/messages.ts';
import { deviceItem } from '../src/lib/storage.ts';

// Before WXT's location watcher loads: it picks the Navigation API when `navigation` exists, as in every browser.
const navigation = vi.hoisted(() => {
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'navigation', { value: target, configurable: true });
  return target;
});

const FEED = 'https://www.linkedin.com/feed/';
const PROFILE = 'https://www.linkedin.com/in/someone/';

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

/** A same-document navigation as the browser runs it: `navigate` names the destination, then `commit` changes the address. */
function navigate(url: string, commit: () => void = () => history.pushState({}, '', url)): void {
  navigation.dispatchEvent(Object.assign(new Event('navigate'), { destination: { url } }));
  commit();
}

const layers = () => document.querySelectorAll('unalgo-layer').length;
/** What the background was told about this tab when the feed UI stopped. */
const stoppedStates = () =>
  vi
    .mocked(fakeBrowser.runtime.sendMessage)
    .mock.calls.map(([msg]) => msg as unknown as BgRequest)
    .flatMap((msg) => (msg.type === 'tabState' && msg.patch.onFeed === false ? [msg.patch] : []));

let ctx: ContentScriptContext;

beforeEach(async () => {
  fakeBrowser.reset();
  vi.stubGlobal('IntersectionObserver', FakeIO);
  history.replaceState({}, '', FEED);
  document.documentElement.lang = 'en';
  document.body.innerHTML = feed2026(FIRST_DEGREE_POST);
  await deviceItem.setValue(defaultDevice('dev1'));
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
  ctx = new ContentScriptContext('linkedin');
});
afterEach(() => {
  ctx.notifyInvalidated();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('test_spa_navigation_follows_the_destination', async () => {
  const start = vi.spyOn(FeedController.prototype, 'start');
  const stop = vi.spyOn(FeedController.prototype, 'stop');
  await bootContentScript(linkedinAdapter, ctx);
  expect(layers()).toBe(1);
  expect(start).toHaveBeenCalledOnce();

  // Feed to a profile: the feed UI stops on the event, while `location` still says /feed/.
  navigation.dispatchEvent(Object.assign(new Event('navigate'), { destination: { url: PROFILE } }));
  expect(location.href).toBe(FEED);
  expect(layers()).toBe(0);
  expect(stop).toHaveBeenCalled();
  // Not the feed: no watchdog either, and the popup's state says so (no notice, nothing feed-like).
  expect(stoppedStates()).toStrictEqual([
    { platform: 'linkedin', url: PROFILE, onFeed: false, paused: false, feedLike: false, routeNew: false, health: HEALTHY },
  ]);
  history.pushState({}, '', PROFILE);
  expect(layers()).toBe(0);

  // Back to the feed: it starts again, while `location` still says the profile.
  navigate(FEED);
  expect(layers()).toBe(1);
  expect(start).toHaveBeenCalledTimes(2);

  // Back and forward (traversals), committed after a timeout as Firefox does: the state follows each event at once.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    navigate(PROFILE, () => setTimeout(() => history.replaceState({}, '', PROFILE), 0));
    expect(layers()).toBe(0);
    vi.runAllTimers();
    navigate(FEED, () => setTimeout(() => history.replaceState({}, '', FEED), 0));
    expect(layers()).toBe(1);
    vi.runAllTimers();
  } finally {
    vi.useRealTimers();
  }
  expect(start).toHaveBeenCalledTimes(3);
  expect(stoppedStates().map((s) => s.url)).toStrictEqual([PROFILE, PROFILE]);

  // A settings change once the address has changed reads `location`: still the feed, still running.
  await deviceItem.setValue(defaultDevice('dev2'));
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(4));
  expect(layers()).toBe(1);
});

/** Every message the content script sent the background, of one type. */
function sentOf<T extends BgRequest['type']>(type: T): Extract<BgRequest, { type: T }>[] {
  return vi
    .mocked(fakeBrowser.runtime.sendMessage)
    .mock.calls.map(([msg]) => msg as unknown as BgRequest)
    .filter((msg): msg is Extract<BgRequest, { type: T }> => msg.type === type);
}

/** A message from the popup or the background to the content script, answered as `runtime.onMessage` does. */
async function ask(msg: ContentRequest): Promise<unknown> {
  const [listener] = vi.mocked(fakeBrowser.runtime.onMessage.addListener).mock.calls.at(-1) ?? [];
  if (!listener) throw new Error('no message listener');
  return new Promise((done) => {
    const sync = (listener as (m: unknown, s: unknown, r: (v: unknown) => void) => boolean)(msg, {}, done);
    if (!sync) return;
  });
}

const CARDS = [FIRST_DEGREE_POST, PROMOTED_FOLLOWS_PAGE, FOLLOWED_BY_POST, FOLLOWING_POST, COMPANY_NOT_FOLLOWED];
/** The feed's markup without its strong home signature (`mainFeed`): a candidate address is then only watched. */
const WEAK_FEED = feed2026(...CARDS)
  .replace('data-testid="mainFeed"', '')
  .replaceAll('FeedType_MAIN_FEED', 'FeedType_X');

describe('route gating', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  });

  it('test_candidate_route_with_strong_signature_starts_with_route_new', async () => {
    history.replaceState({}, '', 'https://www.linkedin.com/feed/newname/');
    document.body.innerHTML = feed2026(...CARDS);
    const start = vi.spyOn(FeedController.prototype, 'start');
    await bootContentScript(linkedinAdapter, ctx);
    expect(start).toHaveBeenCalledWith(expect.anything(), { routeNew: true });
    expect(layers()).toBe(1);
    expect(await ask({ type: 'ping' })).toEqual({ ok: true, onFeed: true, platform: 'linkedin' });
    // The plain feed route says it isn't new.
    navigate('https://www.linkedin.com/feed/');
    expect(start).toHaveBeenLastCalledWith(expect.anything(), { routeNew: false });
  });

  it('test_candidate_route_without_signature_is_watched_and_shows_the_card', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      history.replaceState({}, '', 'https://www.linkedin.com/feed/newname/');
      document.body.innerHTML = WEAK_FEED;
      const before = document.body.innerHTML;
      const start = vi.spyOn(FeedController.prototype, 'start');
      await bootContentScript(linkedinAdapter, ctx);
      expect(start).not.toHaveBeenCalled();
      expect(await ask({ type: 'ping' })).toEqual({ ok: true, onFeed: false, platform: 'linkedin' });
      await vi.advanceTimersByTimeAsync(12_500);
      // Two passing probes: the popup's state, and the notice-only layer with its card. Nothing was hidden or classified.
      const feedLike = sentOf('tabState')
        .map((m) => m.patch)
        .filter((p) => p.feedLike);
      expect(feedLike.at(-1)).toMatchObject({
        onFeed: false,
        feedLike: true,
        notice: { kind: 'not-running', issues: ['feed-not-started'] },
        health: { status: 'not-started', issues: ['feed-not-started'] },
      });
      expect(start).not.toHaveBeenCalled();
      expect(sentOf('classify')).toEqual([]);
      const layer = document.querySelector('unalgo-layer') as HTMLElement;
      expect(layer.shadowRoot?.textContent).toContain("unAlgorithm isn't running on this feed");
      expect(document.body.innerHTML.replace(/<unalgo-layer[\s\S]*$/, '')).toBe(before);

      // Let us know: a draft of this page, from the card; the background opens the report page.
      vi.spyOn(eventGuard, 'trusted').mockReturnValue(true);
      const buttons = [...(layer.shadowRoot?.querySelectorAll('button') ?? [])];
      buttons.find((b) => b.textContent === 'Let us know')?.click();
      await vi.advanceTimersByTimeAsync(0);
      const [opened] = sentOf('openReport');
      expect(opened).toMatchObject({
        type: 'openReport',
        notice: 'not-running',
        draft: {
          kind: 'detection',
          from: 'notice',
          page: { platform: 'linkedin', route: 'feed-candidate', feedWord: 'newname' },
          health: { status: 'not-started', issues: ['feed-not-started'], degraded: [] },
        },
      });
      // Not now: away for 24 hours on LinkedIn, in every tab.
      buttons.find((b) => b.textContent === 'Not now')?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentOf('snoozeNotice')).toEqual([
        {
          type: 'snoozeNotice',
          platform: 'linkedin',
          kind: 'not-running',
          ms: NOT_NOW_SNOOZE_MS,
          adapter: linkedinAdapter.version,
        },
      ]);
      expect(document.querySelector('unalgo-layer')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_untrusted_card_clicks_do_nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      history.replaceState({}, '', 'https://www.linkedin.com/feed/newname/');
      document.body.innerHTML = WEAK_FEED;
      await bootContentScript(linkedinAdapter, ctx);
      await vi.advanceTimersByTimeAsync(12_500);
      const layer = document.querySelector('unalgo-layer') as HTMLElement;
      // A page script's synthetic click: no report page, no snooze, the card stays.
      for (const b of layer.shadowRoot?.querySelectorAll('button') ?? []) b.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(sentOf('openReport')).toEqual([]);
      expect(sentOf('snoozeNotice')).toEqual([]);
      expect(document.querySelector('unalgo-layer')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_other_pages_get_nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      history.replaceState({}, '', 'https://www.linkedin.com/in/morgan-ellis/');
      document.body.innerHTML = WEAK_FEED;
      const start = vi.spyOn(FeedController.prototype, 'start');
      await bootContentScript(linkedinAdapter, ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(start).not.toHaveBeenCalled();
      expect(layers()).toBe(0);
      expect(sentOf('tabState').some((m) => m.patch.feedLike)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_popup_snapshot_and_report_sent', async () => {
    document.body.innerHTML = feed2026(...CARDS);
    const sentNotice = vi.spyOn(FeedController.prototype, 'onReportSent');
    await bootContentScript(linkedinAdapter, ctx);
    // The popup's Report a problem: a draft of this page, built here.
    expect(await ask({ type: 'reportSnapshot', from: 'popup' })).toEqual({ ok: true });
    const drafts = () => sentOf('openReport').flatMap((m) => ('draft' in m ? [m] : []));
    const [opened] = drafts();
    expect(opened?.draft).toMatchObject({ kind: 'detection', from: 'popup', page: { route: 'feed' } });
    expect(opened?.draft.detection?.counts.items).toBeGreaterThan(0);
    expect(opened).not.toHaveProperty('notice');
    // A banner's Let us know.
    await ask({ type: 'reportSnapshot', from: 'popup-banner' });
    expect(drafts()[1]?.draft.from).toBe('popup-banner');
    // The background says a report about this tab went out: its card goes away.
    expect(await ask({ type: 'reportSent', kind: 'paused' })).toEqual({ ok: true });
    expect(sentNotice).toHaveBeenCalledWith('paused');
  });
});
