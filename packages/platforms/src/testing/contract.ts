import { PLATFORM_PREFIX } from '@unalgorithm/protocol';
import type { PlatformAdapter } from '../types.ts';

/**
 * Checks every adapter must pass, whatever the platform. Call from a test with real or synthetic fixture HTML.
 * Returns a list of failures (empty when the adapter conforms) so the caller can assert with its own framework.
 *
 * Read-only is enforced while `inspect()` and `itemRootOf()` run: any DOM mutation, click, focus, scroll or network
 * request (fetch / XMLHttpRequest) is reported.
 */
export function checkAdapterContract<M>(adapter: PlatformAdapter<M>, html: string, doc: Document = document): string[] {
  const failures: string[] = [];
  doc.body.innerHTML = html;
  const scope = adapter.feedScope(doc);
  if (!scope) return ['feedScope() found no feed in the fixture'];
  const items = adapter.findItems(scope);
  if (!items.length) failures.push('findItems() found nothing');
  for (const el of items) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (items.includes(p)) failures.push('findItems() returned a nested item');
    }
  }

  const markers = adapter.markersFor('en');
  const ctx = { markers, now: new Date(2026, 9, 10, 12) };
  const prefix = `${PLATFORM_PREFIX[adapter.id]}:`;

  const observer = new MutationObserver(() => undefined);
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const touched = new Set<string>();
  const restore = [
    stub(HTMLElement.prototype, 'click', () => touched.add('clicked')),
    stub(HTMLElement.prototype, 'focus', () => touched.add('focused')),
    stub(Element.prototype, 'scrollIntoView', () => touched.add('scrolled')),
    stub(Element.prototype, 'scrollTo', () => touched.add('scrolled')),
    stub(Element.prototype, 'scrollBy', () => touched.add('scrolled')),
    stub(globalThis, 'scrollTo', () => touched.add('scrolled')),
    stub(globalThis, 'scrollBy', () => touched.add('scrolled')),
    stub(globalThis, 'fetch', () => {
      touched.add('fetched');
      return Promise.reject(new Error('blocked by the adapter contract'));
    }),
    ...(typeof XMLHttpRequest === 'undefined' ? [] : [stub(XMLHttpRequest.prototype, 'open', () => touched.add('fetched'))]),
  ];
  let mutated = false;
  try {
    for (const el of items) {
      const a = adapter.inspect(el, ctx);
      const b = adapter.inspect(el, ctx);
      if (a.kind === 'post') {
        if (!a.post.id.startsWith(prefix)) failures.push(`id without ${prefix} prefix: ${a.post.id}`);
        if (b.kind !== 'post' || b.post.id !== a.post.id) failures.push(`unstable id for ${a.post.id}`);
        if (a.post.platform !== adapter.id) failures.push('post.platform does not match the adapter');
      }
      const root = adapter.itemRootOf(el.firstElementChild ?? el, scope);
      if (root !== el) failures.push('itemRootOf() did not map a child back to its item');
    }
  } finally {
    // Read pending records before disconnect(), which discards them.
    mutated = observer.takeRecords().length > 0;
    observer.disconnect();
    for (const undo of restore) undo();
  }
  if (mutated) failures.push('inspect() changed the page');
  for (const what of touched) failures.push(`inspect() ${what} something`);
  if (adapter.markersFor('xx') !== null) failures.push('markersFor() should return null for unsupported languages');
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
