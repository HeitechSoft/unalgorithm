import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fbFeed, fbFeed2026, ORGANIC_LINK_SHARE, PHOTO_POST_2026 } from '../../fixtures/facebook/synthetic.ts';
import { facebookAdapter } from '../../src/facebook/adapter.ts';
import { FACEBOOK_EN } from '../../src/facebook/markers/en.ts';

/**
 * Firefox runs the content script against the page's `URL` through an Xray wrapper, and there the iterators of
 * `URLSearchParams` (`keys()`, `values()`, `entries()`, the object itself) are not iterable: spreading one threw, the
 * shared link and the permalink came out empty, and UnEcho Chamber was never offered on Facebook in Firefox (found by
 * `apps/extension/e2e/firefox/perspectives-server.spec.ts`). These tests make the iterators behave that way.
 */
const ctx = { markers: FACEBOOK_EN, now: new Date(2026, 9, 10) };

function inspect(html: string) {
  document.body.innerHTML = html;
  const scope = facebookAdapter.feedScope(document) as HTMLElement;
  const [item] = facebookAdapter.findItems(scope);
  const r = facebookAdapter.inspect(item as HTMLElement, ctx);
  if (r.kind !== 'post') throw new Error(`expected a post, got ${r.kind}`);
  return r.post;
}

describe('Facebook extraction with Firefox content-script URLs', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    const notIterable = () => ({ next: () => ({ done: true, value: undefined }) }) as never;
    for (const name of ['keys', 'values', 'entries', Symbol.iterator] as const) {
      vi.spyOn(URLSearchParams.prototype, name).mockImplementation(notIterable);
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_shared_link_read_without_iterable_search_params', () => {
    expect(() => [...new URLSearchParams('a=1').keys()]).toThrow(TypeError);
    expect(inspect(fbFeed(ORGANIC_LINK_SHARE)).sharedLink).toEqual({
      url: 'https://news.example.com/transit',
      domain: 'news.example.com',
      title: 'City approves new transit budget',
    });
  });

  it('test_permalink_read_without_iterable_search_params', () => {
    expect(inspect(fbFeed2026(PHOTO_POST_2026)).permalink).toBe(
      'https://www.facebook.com/photo/?fbid=2026101601&set=a.20261016010',
    );
  });
});
