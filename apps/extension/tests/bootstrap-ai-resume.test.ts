// @vitest-environment-options {"url":"https://www.linkedin.com/feed/"}
/**
 * "Sign in again" (R26, CL1-18). Signing in again to the server that is already the source writes an identical device,
 * which the content script's storage watch never reports, so the background sends `aiResume` and a feed tab paused on
 * auth-required picks up where it stopped. The background is a stubbed `runtime.sendMessage`.
 */
import { defaultDevice } from '@unalgorithm/core';
import { linkedinAdapter } from '@unalgorithm/platforms';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { FIRST_DEGREE_POST, feed2026 } from '../../../packages/platforms/fixtures/linkedin/y2026.ts';
import { bootContentScript } from '../src/content/bootstrap.ts';
import { FeedController } from '../src/content/feed-controller.ts';
import type { BgRequest, BgResponses, ClassifyItem } from '../src/lib/messages.ts';
import { deviceItem } from '../src/lib/storage.ts';

const AUTH_REQUIRED = { code: 'auth-required', message: 'Sign in to ai.example.org again.' } as const;

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

/** The background: refuses every post until `signedIn`, then classifies it. */
function background() {
  const state = { signedIn: false };
  const classify = vi.fn((items: ClassifyItem[]): BgResponses['classify'] =>
    state.signedIn
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
          results: items.map((i) => ({ key: i.key, status: 'failed', retryable: false, ...AUTH_REQUIRED })),
          pause: AUTH_REQUIRED,
        },
  );
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation((async (msg: BgRequest) =>
    msg.type === 'classify' ? classify(msg.items) : { ok: true }) as never);
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
  expect(bg.classify.mock.calls[1]?.[0].map((i) => i.key)).toStrictEqual(['li:ck:EEEkeyFirstDegree5']);
  await vi.waitFor(() => expect(controller.buildState().ai).toStrictEqual({ state: 'ready' }));
});
