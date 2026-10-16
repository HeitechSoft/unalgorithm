// @vitest-environment-options {"url":"https://www.linkedin.com/feed/"}
/**
 * "Sign in again" (R26, CL1-18). Signing in again to the server that is already the source writes an identical device,
 * which the content script's storage watch never reports, so the background sends `aiResume` and a feed tab paused on
 * auth-required picks up where it stopped. While paused, the tab asks the background's cache only (R27). The background
 * is a stubbed `runtime.sendMessage`.
 */
import { defaultDevice } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { bootContentScript } from '../src/content/bootstrap.ts';
import { FeedController } from '../src/content/feed-controller.ts';
import type { BgRequest, BgResponses } from '../src/lib/messages.ts';
import { deviceItem } from '../src/lib/storage.ts';

const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to ai.example.org again.' } as const;
const NO_CREDIT = { code: 'insufficient-credits', message: 'ai.example.org has no credit left.' } as const;
const CAP_REACHED = { code: 'cap-reached', message: "Today's AI limit is reached." } as const;
type Pause = typeof AUTH_REQUIRED | typeof NO_CREDIT | typeof CAP_REACHED;

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

type ClassifyRequest = Extract<BgRequest, { type: 'classify' }>;

/** The background: refuses every post with `pause` until `signedIn`, then classifies it. Its cache knows no post. */
function background(pause: Pause = AUTH_REQUIRED) {
  const state = { signedIn: false };
  const classify = vi.fn(({ items, cacheOnly }: ClassifyRequest): BgResponses['classify'] => {
    if (cacheOnly) return { results: items.map((i) => ({ key: i.key, status: 'skipped', reason: 'paused' })) };
    return state.signedIn
      ? {
          results: items.map((i) => ({
            key: i.key,
            status: 'ok',
            model: 'mock-model',
            cached: false,
            classification: { relevance: 60, noise: [], topics: ['x'], reason: 'r', isNews: false, hasCheckableClaims: false },
          })),
        }
      : {
          results: items.map((i) => ({ key: i.key, status: 'failed', retryable: false, ...pause })),
          pause,
        };
  });
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((async (msg: BgRequest) =>
    msg.type === 'classify' ? classify(msg) : { ok: true }) as never);
  return { state, classify };
}

let ctx: ContentScriptContext;

beforeEach(async () => {
  fakeBrowser.reset();
  vi.stubGlobal('IntersectionObserver', FakeIO);
  document.documentElement.lang = 'en';
  document.body.innerHTML = feed2026(FIRST_DEGREE_POST);
  await deviceItem.setValue({ ...defaultDevice('dev1'), aiSource: { kind: 'server', baseUrl: 'https://ai.example.org' } });
  ctx = new ContentScriptContext('linkedin');
});
afterEach(() => {
  ctx.notifyInvalidated();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('test_ai_resume_clears_pause', async () => {
  const bg = background();
  const start = vi.spyOn(FeedController.prototype, 'start');
  await bootContentScript(linkedinAdapter, ctx);
  const controller = start.mock.contexts[0] as FeedController;
  expect(controller).toBeInstanceOf(FeedController);

  // The server refused the device: the feed tab stops sending posts and says why.
  await vi.waitFor(() => expect(controller.buildState().ai).toStrictEqual({ state: 'paused', ...AUTH_REQUIRED }));
  expect(bg.classify).toHaveBeenCalledOnce();

  // The person signed in again on the Settings page; the background tells open feed tabs.
  bg.state.signedIn = true;
  const sendResponse = vi.fn();
  const returned = await fakeBrowser.runtime.onMessage.trigger({ type: 'aiResume' }, {}, sendResponse);
  expect(sendResponse).toHaveBeenCalledExactlyOnceWith({ ok: true });
  expect(returned).toStrictEqual([false]);
  expect(controller.buildState().ai?.state).not.toBe('paused');

  // The post that failed goes to the server again.
  await vi.waitFor(() => expect(bg.classify).toHaveBeenCalledTimes(2));
  expect(bg.classify.mock.calls[1]?.[0].items.map((i) => i.key)).toStrictEqual(['li:ck:EEEkeyFirstDegree5']);
  await vi.waitFor(() => expect(controller.buildState().ai).toStrictEqual({ state: 'ready' }));
});

it('test_paused_tab_asks_the_cache_only', async () => {
  const bg = background();
  const start = vi.spyOn(FeedController.prototype, 'start');
  await bootContentScript(linkedinAdapter, ctx);
  const controller = start.mock.contexts[0] as FeedController;
  await vi.waitFor(() => expect(controller.buildState().ai).toStrictEqual({ state: 'paused', ...AUTH_REQUIRED }));
  expect(bg.classify.mock.calls[0]?.[0]).toMatchObject({ type: 'classify', platform: 'linkedin', cacheOnly: false });

  // A post scrolls in while paused: the message asks the background's cache only (no server request, R27).
  document
    .querySelector('[data-testid="mainFeed"] > .load-more-marker')
    ?.insertAdjacentHTML('beforebegin', FIRST_DEGREE_POST.replaceAll('EEEkeyFirstDegree5', 'SSSkeyNeverSeen004'));
  await vi.waitFor(() => expect(bg.classify).toHaveBeenCalledTimes(2), { timeout: 5000 });
  expect(bg.classify.mock.calls[1]?.[0]).toMatchObject({
    items: [{ key: 'li:ck:SSSkeyNeverSeen004' }],
    cacheOnly: true,
  });

  // Signed in again: both posts go to the server as normal requests.
  bg.state.signedIn = true;
  await fakeBrowser.runtime.onMessage.trigger({ type: 'aiResume' }, {}, vi.fn());
  await vi.waitFor(() => expect(bg.classify).toHaveBeenCalledTimes(3), { timeout: 5000 });
  const resumed = bg.classify.mock.calls[2]?.[0];
  expect(resumed?.cacheOnly).toBe(false);
  expect(resumed?.items.map((i) => i.key).sort()).toStrictEqual(['li:ck:EEEkeyFirstDegree5', 'li:ck:SSSkeyNeverSeen004']);
  await vi.waitFor(() => expect(controller.buildState().ai).toStrictEqual({ state: 'ready' }));
}, 15_000);

let visibility: DocumentVisibilityState = 'visible';
/** The person switches to another tab ('hidden') or back ('visible'). */
function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}
const balanceChecks = () =>
  vi.mocked(fakeBrowser.runtime.sendMessage).mock.calls.filter(([msg]) => (msg as unknown as BgRequest).type === 'balanceCheck');

async function bootPausedOn(pause: Pause | undefined) {
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const bg = background(pause);
  bg.state.signedIn = pause === undefined;
  const start = vi.spyOn(FeedController.prototype, 'start');
  await bootContentScript(linkedinAdapter, ctx);
  const controller = start.mock.contexts[0] as FeedController;
  await vi.waitFor(() =>
    expect(controller.buildState().ai).toStrictEqual(pause ? { state: 'paused', ...pause } : { state: 'ready' }),
  );
  return controller;
}

it('test_visible_tab_paused_for_credit_asks_once_per_30s', async () => {
  const controller = await bootPausedOn(NO_CREDIT);
  expect(controller.pausedFor()).toBe('insufficient-credits');
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 9, 15, 9) });

  // Back from the tab where credit was added: one check, which carries nothing.
  show('hidden');
  show('visible');
  expect(balanceChecks()).toStrictEqual([[{ type: 'balanceCheck' }]]);

  // Back and forth within 30 s: no second check.
  vi.advanceTimersByTime(29_000);
  show('hidden');
  show('visible');
  expect(balanceChecks()).toHaveLength(1);

  // 30 s on: another.
  vi.advanceTimersByTime(1_000);
  show('hidden');
  show('visible');
  expect(balanceChecks()).toHaveLength(2);

  // Gone with the content script: nothing more.
  ctx.notifyInvalidated();
  vi.advanceTimersByTime(60_000);
  show('visible');
  expect(balanceChecks()).toHaveLength(2);
});

it('test_other_pauses_and_hidden_tabs_do_not_ask', async () => {
  // Credit lifts no daily cap.
  const capped = await bootPausedOn(CAP_REACHED);
  expect(capped.pausedFor()).toBe('cap-reached');
  show('hidden');
  show('visible');
  expect(balanceChecks()).toHaveLength(0);
  ctx.notifyInvalidated();
  vi.restoreAllMocks();

  // Not paused.
  ctx = new ContentScriptContext('linkedin');
  const running = await bootPausedOn(undefined);
  expect(running.pausedFor()).toBeUndefined();
  show('hidden');
  show('visible');
  expect(balanceChecks()).toHaveLength(0);
  ctx.notifyInvalidated();
  vi.restoreAllMocks();

  // Paused for credit, but the tab is going to the background.
  ctx = new ContentScriptContext('linkedin');
  await bootPausedOn(NO_CREDIT);
  show('hidden');
  expect(balanceChecks()).toHaveLength(0);
});
