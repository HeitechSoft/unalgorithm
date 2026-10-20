import { ADAPTER_VERSION_PATTERN, adapterOrder, latestAdapterOrder } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { feed, post, svgText } from '../fixtures/facebook/live2026.ts';
import { AD_2026, FRIEND_POST, FRIEND_POST_2026, fbFeed, fbFeed2026, SPONSORED_ARIA } from '../fixtures/facebook/synthetic.ts';
import { feedHtml, NORMAL_POST, PROMOTED_POST } from '../fixtures/linkedin/legacy.ts';
import { FIRST_DEGREE_POST, feed2026, PARTNERSHIP_AD } from '../fixtures/linkedin/y2026.ts';
import { facebookAdapter } from '../src/facebook/adapter.ts';
import { linkedinAdapter } from '../src/linkedin/adapter.ts';
import { checkAdapterContract } from '../src/testing/contract.ts';
import type { InspectResult, PlatformAdapter } from '../src/types.ts';

const html = feed2026(FIRST_DEGREE_POST);

/** The LinkedIn adapter with `inspect()` doing one forbidden thing first. */
function misbehaving(sideEffect: (el: HTMLElement) => void): PlatformAdapter {
  return {
    ...linkedinAdapter,
    inspect(el, ctx) {
      sideEffect(el);
      return linkedinAdapter.inspect(el, ctx as never);
    },
  } as PlatformAdapter;
}

/** The LinkedIn adapter with some members replaced. */
const changed = (members: Partial<PlatformAdapter>): PlatformAdapter => ({ ...linkedinAdapter, ...members }) as PlatformAdapter;

/** The LinkedIn adapter with `inspect()` adding to what it emits. */
function emitting(extra: (r: InspectResult) => InspectResult): PlatformAdapter {
  return changed({ inspect: (el, ctx) => extra(linkedinAdapter.inspect(el, ctx as never)) });
}

describe('checkAdapterContract', () => {
  it('passes a read-only adapter', () => {
    expect(checkAdapterContract(linkedinAdapter, html)).toEqual([]);
  });

  it.each([
    ['changed the page', (el: HTMLElement) => el.setAttribute('data-x', '1')],
    ['clicked something', (el: HTMLElement) => el.click()],
    ['focused something', (el: HTMLElement) => el.focus()],
    ['scrolled something', (el: HTMLElement) => el.scrollIntoView()],
    ['scrolled something', () => window.scrollTo(0, 100)],
    ['fetched something', () => void fetch('https://example.com/').catch(() => undefined)],
  ])('reports an adapter that %s', (what, effect) => {
    expect(checkAdapterContract(misbehaving(effect), html)).toContain(`inspect() ${what}`);
  });

  it('restores the patched browser APIs afterwards', () => {
    const before = [HTMLElement.prototype.click, Element.prototype.scrollIntoView, globalThis.fetch];
    checkAdapterContract(linkedinAdapter, html);
    expect([HTMLElement.prototype.click, Element.prototype.scrollIntoView, globalThis.fetch]).toEqual(before);
  });
});

describe('checkAdapterContract: the hooks ADR 0009 adds', () => {
  it.each([
    ['LinkedIn, 2026 cards', linkedinAdapter, feed2026(FIRST_DEGREE_POST, PARTNERSHIP_AD)],
    ['LinkedIn, the older markup', linkedinAdapter, feedHtml(NORMAL_POST, PROMOTED_POST)],
    ['Facebook, role="feed"', facebookAdapter, fbFeed(FRIEND_POST, SPONSORED_ARIA)],
    ['Facebook, 2026', facebookAdapter, fbFeed2026(FRIEND_POST_2026, AD_2026)],
    [
      'Facebook, 2026 as captured',
      facebookAdapter,
      feed(post({ author: 'Shop Example', slot: svgText('SvgT2'), text: 'Sale.' })),
    ],
  ] as const)('passes the shipped adapter on %s', (_name, adapter, page) => {
    expect(checkAdapterContract(adapter as PlatformAdapter, page)).toEqual([]);
  });

  it('requires the route hooks and ids of a shipped adapter, and not of one still being built', () => {
    const bare = changed({
      classifyRoute: undefined,
      homeSignature: undefined,
      signedIn: undefined,
      discovery: undefined,
      rediscover: undefined,
      ids: undefined,
    });
    expect(checkAdapterContract(bare, html)).toEqual([
      'classifyRoute() is missing',
      'homeSignature() is missing',
      'signedIn() is missing',
      'discovery() is missing',
      'rediscover() is missing',
      'ids is missing',
    ]);
    expect(checkAdapterContract(bare, html, document, { shipped: false })).toEqual([]);
  });

  it.each([
    [
      'homeSignature',
      'changed the page',
      {
        homeSignature: (doc: Document) => {
          doc.body.setAttribute('data-x', '1');
          return 'strong';
        },
      },
    ],
    [
      'signedIn',
      'focused something',
      {
        signedIn: (doc: Document) => {
          (doc.querySelector('button') as HTMLElement).focus();
          return true;
        },
      },
    ],
    [
      'rediscover',
      'scrolled something',
      {
        rediscover: () => {
          window.scrollBy(0, 10);
        },
      },
    ],
    [
      'discovery',
      'fetched something',
      {
        discovery: () => {
          void fetch('https://example.com/').catch(() => undefined);
          return null;
        },
      },
    ],
    [
      'classifyRoute',
      'clicked something',
      {
        classifyRoute: (url: URL) => {
          (document.querySelector('button') as HTMLElement).click();
          return linkedinAdapter.classifyRoute?.(url) ?? 'not-feed';
        },
      },
    ],
  ] as const)('runs %s() under the read-only checks', (hook, what, members) => {
    const failures = checkAdapterContract(changed(members as Partial<PlatformAdapter>), html);
    expect(failures).toContain(`${hook}() ${what}`);
  });

  it('checks the route classes against the home feed and addresses that are never it', () => {
    expect(checkAdapterContract(changed({ classifyRoute: () => 'feed', isFeedPage: () => true }), html)).toEqual([
      'classifyRoute(https://example.com/feed/) is feed, not not-feed',
      'classifyRoute(https://www.linkedin.com/search/results/all/?keywords=feed) is feed, not not-feed',
    ]);
    expect(checkAdapterContract(changed({ isFeedPage: () => false }), html)).toContain(
      'isFeedPage(https://www.linkedin.com/feed/) disagrees with classifyRoute()',
    );
    expect(checkAdapterContract(changed({ homeSignature: () => 'yes' as never }), html)).toContain(
      'homeSignature() returned yes',
    );
  });

  it('reports ids outside the protocol registry, or without the platform prefix', () => {
    const ids = linkedinAdapter.ids;
    if (!ids) throw new Error('the LinkedIn adapter declares its ids');
    const failures = checkAdapterContract(
      changed({
        ids: {
          ...ids,
          detectors: [...ids.detectors, 'li.promoted.everywhere', 'fb.reshare'],
          landmarks: [...ids.landmarks, 'cards'],
        },
      }),
      html,
    );
    expect(failures).toContain("ids.detectors has li.promoted.everywhere, which the protocol registry doesn't list");
    expect(failures).toContain('ids.detectors has fb.reshare, without the li. prefix');
    expect(failures).toContain("ids.landmarks has cards, which the protocol registry doesn't list");
  });

  it('reports a detector, observation, landmark or strategy the adapter emits without declaring it', () => {
    const detector = emitting((r) =>
      r.kind === 'post'
        ? {
            ...r,
            post: {
              ...r.post,
              evidence: [...r.post.evidence, { signal: 'sponsored', detector: 'li.promoted.line', strength: 'strong' }],
            },
          }
        : r,
    );
    expect(checkAdapterContract(detector, html)).toContain('inspect() emitted a detector not in ids.detectors: li.promoted.line');
    const observation = emitting((r) => (r.kind === 'post' ? { ...r, observations: ['li.slot.age.testid'] } : r));
    expect(checkAdapterContract(observation, html)).toContain(
      'inspect() emitted an observation not in ids.observations: li.slot.age.testid',
    );
    const landmark = changed({ probe: () => ({ main: 1, cards: 2 }) });
    expect(checkAdapterContract(landmark, html)).toContain('probe() returned a landmark not in ids.landmarks: cards');
    const strategy = changed({ discovery: () => ({ strategy: 'fb.items.posinset', fallback: true }) });
    expect(checkAdapterContract(strategy, html)).toContain(
      'discovery() names a strategy not in ids.strategies: fb.items.posinset',
    );
  });

  it('reports a hook that throws, by name', () => {
    const failures = checkAdapterContract(
      changed({
        signedIn: () => {
          throw new Error('no banner');
        },
      }),
      html,
    );
    expect(failures).toContain('signedIn() threw: no banner');
  });
});

describe('adapter versions', () => {
  /**
   * A version is `<platform>@<year>.<month>.<patch>`, dated in the month it is built. The Cloud's report alerts count no
   * report from a version dated after the current month (so a forged version can't page anyone): an adapter dated ahead
   * would go unheard until that month began, just after a release, when reports matter most.
   */
  it.each([linkedinAdapter, facebookAdapter])('$id is never dated in a future month', (adapter) => {
    expect(adapter.version).toMatch(ADAPTER_VERSION_PATTERN);
    expect(adapter.version.startsWith(`${adapter.id}@`)).toBe(true);
    expect(adapterOrder(adapter.version) as number).toBeLessThanOrEqual(latestAdapterOrder(Date.now()));
  });
});
