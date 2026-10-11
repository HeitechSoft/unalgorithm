import { describe, expect, it } from 'vitest';
import { FIRST_DEGREE_POST, feed2026 } from '../fixtures/linkedin/y2026.ts';
import { linkedinAdapter } from '../src/linkedin/adapter.ts';
import { checkAdapterContract } from '../src/testing/contract.ts';
import type { PlatformAdapter } from '../src/types.ts';

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
