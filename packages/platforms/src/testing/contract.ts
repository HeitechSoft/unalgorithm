import {
  DETECTOR_IDS,
  LANDMARK_KEYS,
  OBSERVATION_IDS,
  PLATFORM_PREFIX,
  PLATFORMS,
  type PlatformId,
  STRATEGY_IDS,
} from '@unalgorithm/protocol';
import type { AdapterIds, InspectResult, PlatformAdapter, RouteClass } from '../types.ts';

/** Each shipped platform's home feed, which `classifyRoute` must call `feed`. */
export const HOME_URLS: Readonly<Record<PlatformId, string>> = {
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
};

/** Addresses that are never the feed, on any platform: another site, and a search on the platform. */
const NOT_FEED_URLS: Readonly<Record<PlatformId, readonly string[]>> = {
  linkedin: ['https://example.com/feed/', 'https://www.linkedin.com/search/results/all/?keywords=feed'],
  facebook: ['https://example.com/', 'https://www.facebook.com/search/top/?q=feed'],
};

const ROUTE_CLASSES: readonly RouteClass[] = ['feed', 'feed-candidate', 'not-feed'];
const SIGNATURES: readonly unknown[] = ['strong', 'weak', null];

/** The protocol registry each kind of adapter id must come from. */
const REGISTRY: Record<keyof AdapterIds, readonly string[]> = {
  detectors: DETECTOR_IDS,
  observations: OBSERVATION_IDS,
  strategies: STRATEGY_IDS,
  landmarks: LANDMARK_KEYS,
};

export interface ContractOptions {
  /**
   * The adapter ships in the extension, so it must have the hooks ADR 0009 requires (`classifyRoute`, `homeSignature`,
   * `signedIn`, `ids`). Default: true for every platform in `PLATFORMS`.
   */
  shipped?: boolean;
}

/**
 * Checks every adapter must pass, whatever the platform. Call from a test with real or synthetic fixture HTML.
 * Returns a list of failures (empty when the adapter conforms) so the caller can assert with its own framework.
 *
 * Read-only is enforced while the adapter runs (`feedScope`, `findItems` with its discovery, `inspect`,
 * `itemRootOf`, `siblingModules`, `extraRegions`, `loadMoreMarker`, `probe`, and the route hooks `classifyRoute`,
 * `homeSignature`, `signedIn`, `discovery` and `rediscover`): any DOM mutation, click, focus, scroll or network
 * request (fetch / XMLHttpRequest) is reported, with the call that did it.
 *
 * Every detector and observation id the adapter emits on the fixture must be in `adapter.ids`, and `adapter.ids` must
 * be in the protocol registry (`report-codes.ts`), so a report never carries an id the Cloud doesn't know.
 */
export function checkAdapterContract<M>(
  adapter: PlatformAdapter<M>,
  html: string,
  doc: Document = document,
  options: ContractOptions = {},
): string[] {
  const failures: string[] = [];
  const shipped = options.shipped ?? (PLATFORMS as readonly string[]).includes(adapter.id);
  const ids = adapter.ids;
  if (shipped) {
    for (const hook of ['classifyRoute', 'homeSignature', 'signedIn', 'discovery', 'rediscover'] as const) {
      if (typeof adapter[hook] !== 'function') failures.push(`${hook}() is missing`);
    }
    if (!ids) failures.push('ids is missing');
  }
  failures.push(...checkIds(adapter.id, ids));
  doc.body.innerHTML = html;

  const markers = adapter.markersFor('en');
  const ctx = { markers, now: new Date(2026, 9, 10, 12) };
  const prefix = `${PLATFORM_PREFIX[adapter.id]}:`;

  const observer = new MutationObserver(() => undefined);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
  let current = 'feedScope';
  const touched = new Set<string>();
  const touch = (what: string) => touched.add(`${current}() ${what}`);
  const restore = [
    stub(HTMLElement.prototype, 'click', () => touch('clicked something')),
    stub(HTMLElement.prototype, 'focus', () => touch('focused something')),
    stub(Element.prototype, 'scrollIntoView', () => touch('scrolled something')),
    stub(Element.prototype, 'scrollTo', () => touch('scrolled something')),
    stub(Element.prototype, 'scrollBy', () => touch('scrolled something')),
    stub(globalThis, 'scrollTo', () => touch('scrolled something')),
    stub(globalThis, 'scrollBy', () => touch('scrolled something')),
    stub(globalThis, 'fetch', () => {
      touch('fetched something');
      return Promise.reject(new Error('blocked by the adapter contract'));
    }),
    ...(typeof XMLHttpRequest === 'undefined' ? [] : [stub(XMLHttpRequest.prototype, 'open', () => touch('fetched something'))]),
  ];
  /** Run one adapter call as `op`: a throw or a change to the page is a failure named after it. */
  const run = <T>(op: string, fn: () => T, fallback: T): T => {
    current = op;
    try {
      return fn();
    } catch (e) {
      failures.push(`${op}() threw: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    } finally {
      // Read pending records now, so a change is blamed on the call that made it.
      if (observer.takeRecords().length) failures.push(`${op}() changed the page`);
    }
  };
  const emitted = { detectors: new Set<string>(), observations: new Set<string>() };
  const collect = (r: InspectResult) => {
    if (r.kind === 'post') for (const e of r.post.evidence) emitted.detectors.add(e.detector);
    if (r.kind !== 'pending') for (const o of r.observations ?? []) emitted.observations.add(o);
  };

  try {
    const scope = run('feedScope', () => adapter.feedScope(doc), null);
    if (!scope) return [...failures, 'feedScope() found no feed in the fixture'];
    const items = run('findItems', () => adapter.findItems(scope), []);
    if (!items.length) failures.push('findItems() found nothing');
    for (const el of items) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (items.includes(p)) failures.push('findItems() returned a nested item');
      }
    }
    for (const el of items) {
      const a = run<InspectResult>('inspect', () => adapter.inspect(el, ctx), { kind: 'ignore' });
      const b = run<InspectResult>('inspect', () => adapter.inspect(el, ctx), { kind: 'ignore' });
      collect(a);
      if (a.kind === 'post') {
        if (!a.post.id.startsWith(prefix)) failures.push(`id without ${prefix} prefix: ${a.post.id}`);
        if (b.kind !== 'post' || b.post.id !== a.post.id) failures.push(`unstable id for ${a.post.id}`);
        if (a.post.platform !== adapter.id) failures.push('post.platform does not match the adapter');
      }
      const root = run('itemRootOf', () => adapter.itemRootOf(el.firstElementChild ?? el, scope), null);
      if (root !== el) failures.push('itemRootOf() did not map a child back to its item');
    }
    run('siblingModules', () => adapter.siblingModules?.(items, ctx), undefined);
    run('extraRegions', () => adapter.extraRegions?.(doc, ctx), undefined);
    run('loadMoreMarker', () => adapter.loadMoreMarker?.(scope, doc), undefined);
    const landmarks = run('probe', () => adapter.probe(doc, scope), {});
    for (const [key, n] of Object.entries(landmarks)) {
      if (ids && !ids.landmarks.includes(key)) failures.push(`probe() returned a landmark not in ids.landmarks: ${key}`);
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) failures.push(`probe() returned a non-count for ${key}`);
    }
    failures.push(...checkRoutes(adapter, run));
    if (adapter.homeSignature) {
      const signature = run('homeSignature', () => adapter.homeSignature?.(doc), null);
      if (!SIGNATURES.includes(signature)) failures.push(`homeSignature() returned ${String(signature)}`);
    }
    if (adapter.signedIn) {
      const signedIn = run('signedIn', () => adapter.signedIn?.(doc), false);
      if (typeof signedIn !== 'boolean') failures.push('signedIn() did not return a boolean');
    }
    const strategies = [run('discovery', () => adapter.discovery?.() ?? null, null)];
    run('rediscover', () => adapter.rediscover?.(doc), undefined);
    strategies.push(run('discovery', () => adapter.discovery?.() ?? null, null));
    for (const state of strategies) {
      if (state && ids && !ids.strategies.includes(state.strategy))
        failures.push(`discovery() names a strategy not in ids.strategies: ${state.strategy}`);
    }
  } finally {
    // Read pending records before disconnect(), which discards them.
    if (observer.takeRecords().length) failures.push(`${current}() changed the page`);
    observer.disconnect();
    for (const undo of restore) undo();
  }
  failures.push(...touched);
  if (ids) {
    for (const d of emitted.detectors)
      if (!ids.detectors.includes(d)) failures.push(`inspect() emitted a detector not in ids.detectors: ${d}`);
    for (const o of emitted.observations)
      if (!ids.observations.includes(o)) failures.push(`inspect() emitted an observation not in ids.observations: ${o}`);
  }
  if (adapter.markersFor('xx') !== null) failures.push('markersFor() should return null for unsupported languages');
  return failures;
}

/** `adapter.ids` against the protocol registry: every id listed there, and carrying the platform's prefix. */
function checkIds(platform: PlatformId, ids: AdapterIds | undefined): string[] {
  if (!ids) return [];
  const failures: string[] = [];
  const prefix = `${PLATFORM_PREFIX[platform]}.`;
  for (const kind of Object.keys(REGISTRY) as Array<keyof AdapterIds>) {
    for (const id of ids[kind]) {
      if (!REGISTRY[kind].includes(id)) failures.push(`ids.${kind} has ${id}, which the protocol registry doesn't list`);
      else if (kind !== 'landmarks' && !id.startsWith(prefix))
        failures.push(`ids.${kind} has ${id}, without the ${prefix} prefix`);
    }
  }
  return failures;
}

/** `classifyRoute` on the home feed and on addresses that are never the feed, and `isFeedPage` agreeing with it. */
function checkRoutes(adapter: PlatformAdapter<unknown>, run: <T>(op: string, fn: () => T, fallback: T) => T): string[] {
  const classify = adapter.classifyRoute;
  if (!classify) return [];
  const failures: string[] = [];
  const platform = adapter.id;
  for (const href of [HOME_URLS[platform], ...NOT_FEED_URLS[platform]]) {
    const url = new URL(href);
    const route = run('classifyRoute', () => classify.call(adapter, url), null);
    if (!route || !ROUTE_CLASSES.includes(route)) failures.push(`classifyRoute(${href}) returned ${String(route)}`);
    else if (href === HOME_URLS[platform] && route !== 'feed') failures.push(`classifyRoute(${href}) is ${route}, not feed`);
    else if (href !== HOME_URLS[platform] && route !== 'not-feed')
      failures.push(`classifyRoute(${href}) is ${route}, not not-feed`);
    const isFeed = run('isFeedPage', () => adapter.isFeedPage(url), false);
    if (route && isFeed !== (route === 'feed')) failures.push(`isFeedPage(${href}) disagrees with classifyRoute()`);
  }
  return failures;
}

/** Replaces `target[key]` with `fn` and returns a function that puts the original back. */
function stub(target: object, key: string, fn: (...args: unknown[]) => unknown): () => void {
  const had = Object.hasOwn(target, key);
  const original = (target as Record<string, unknown>)[key];
  Object.defineProperty(target, key, { value: fn, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(target, key, { value: original, configurable: true, writable: true });
    else delete (target as Record<string, unknown>)[key];
  };
}
