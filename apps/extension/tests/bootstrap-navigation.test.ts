// @vitest-environment-options {"url":"https://www.linkedin.com/feed/"}
/**
 * Client-side navigation into and out of the feed. Every browser the extension supports has the Navigation API, so WXT
 * reports a navigation from its `navigate` event, which comes before the address changes: the content script goes by
 * the address the event names, never by `location`, which still holds the page being left. A fake `navigation` stands
 * in for the browser's and keeps that order: `navigate` first, the address after, at once (`pushState`) or later (a
 * traversal, which Firefox commits after a timeout). The background is a stubbed `runtime.sendMessage`.
 */
import { defaultDevice } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { bootContentScript } from '../src/content/bootstrap.ts';
import { FeedController } from '../src/content/feed-controller.ts';
import type { BgRequest } from '../src/lib/messages.ts';
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
  expect(stoppedStates()).toStrictEqual([{ platform: 'linkedin', url: PROFILE, onFeed: false, paused: false }]);
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
