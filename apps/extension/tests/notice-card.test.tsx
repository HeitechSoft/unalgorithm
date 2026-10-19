/**
 * The breakage notice in the page layer (ADR 0009 §3): the card in our shadow-root layer, above the toasts, acting
 * only on the person's own clicks and key presses, and accessible in both themes. Also the notice-only layer a
 * watchdog page gets.
 */
import { act, fireEvent, within } from '@testing-library/react';
import { defaultDevice, defaultSettings, EMPTY_LEARNED, NO_SIGNALS } from '@unalgorithm/core';
import type { InspectResult, PlatformAdapter } from '@unalgorithm/platforms';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Bridge, FeedController, type Runtime } from '../src/content/feed-controller.ts';
import { eventGuard, mountNoticeLayer, mountUiHost, UiLayer } from '../src/content/ui-layer.tsx';

// React's act() outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A feed whose adapter throws on three items: `adapter-error`, so filtering pauses and the `paused` card comes up. */
const BROKEN_FEED = `<main id="feed">${['p1', 't1', 't2', 't3'].map((k) => `<div data-item="${k}"><p>Card</p></div>`).join('')}</main>`;

const adapter: PlatformAdapter = {
  id: 'linkedin',
  version: 'linkedin@2026.10.2',
  isFeedPage: () => true,
  feedScope: (doc) => doc.querySelector<HTMLElement>('#feed'),
  findItems: (scope) => Array.from(scope.querySelectorAll<HTMLElement>(':scope > [data-item]')),
  itemRootOf: (node, scope) => {
    const el = node instanceof Element ? node : node.parentElement;
    const root = el?.closest<HTMLElement>('[data-item]');
    return root && scope.contains(root) ? root : null;
  },
  inspect: (el): InspectResult => {
    const key = el.dataset.item ?? '';
    if (key.startsWith('t')) throw new Error('layout changed');
    return {
      kind: 'post',
      post: {
        id: `li:ck:${key}`,
        platform: 'linkedin',
        author: { kind: 'person', relationship: 'followed' },
        signals: { ...NO_SIGNALS },
        evidence: [],
        text: 'Text.',
        textComplete: true,
        media: 'none',
        quality: { authorFound: true, textFound: true },
      },
    };
  },
  probe: () => ({}),
  theme: () => 'light',
  markersFor: () => ({}),
};

const runtime = (): Runtime => ({
  settings: defaultSettings(),
  device: defaultDevice('dev1'),
  learned: EMPTY_LEARNED,
  votes: {},
  serverOffer: null,
  officialList: { list: null, checkedAt: 0 },
});

function bridge(): Bridge {
  return {
    classify: vi.fn(async () => ({ results: [] })),
    pushTabState: vi.fn(),
    vote: vi.fn(async () => undefined),
    settingsAction: vi.fn(async () => null),
    coachMarkShown: vi.fn(),
    openSettings: vi.fn(),
    report: vi.fn(),
    snoozeNotice: vi.fn(),
    factcheck: vi.fn(),
    openFactcheck: vi.fn(async () => true),
    perspectives: vi.fn(),
  };
}

/** The layer's shadow root, as a testing-library container. */
function layer(): ShadowRoot {
  const root = document.querySelector('unalgo-layer')?.shadowRoot;
  if (!root) throw new Error('no layer');
  return root;
}
const inLayer = () => within(layer() as unknown as HTMLElement);

/** A controller showing the `paused` card in a mounted layer. */
async function pausedCard() {
  document.body.innerHTML = BROKEN_FEED;
  const b = bridge();
  const c = new FeedController(adapter, b, mountUiHost);
  const ui = new UiLayer();
  ui.mount(c);
  c.start(runtime());
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  return { b, c, ui };
}

/**
 * axe on the layer, its shadow root included. Color contrast needs a real renderer (jsdom has no canvas): the e2e
 * notice spec checks it on the open shadow root in both themes.
 */
async function axeOn(context: Element): Promise<{ violations: string[]; buttonsChecked: number }> {
  const result = await axe.run(context, { rules: { 'color-contrast': { enabled: false } } });
  return {
    violations: result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    buttonsChecked: result.passes.find((p) => p.id === 'button-name')?.nodes.length ?? 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  document.documentElement.lang = 'en';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the card in the feed layer', () => {
  it('test_card_renders_in_the_layer_above_the_toasts', async () => {
    const { c, ui } = await pausedCard();
    const region = inLayer().getByRole('region', { name: 'unAlgorithm' });
    expect(within(region).getByText('Filtering is paused on this page')).toBeTruthy();
    expect(
      within(region).getByText("LinkedIn looks different today, so we're showing every post rather than hide the wrong ones."),
    ).toBeTruthy();
    // Bottom left in one dock: the card first, then the toasts. Never inside the platform's feed.
    const dock = layer().querySelector('.ua-dock');
    expect([...(dock?.children ?? [])].map((el) => el.className)).toEqual(['ua-notice-region', 'ua-toasts']);
    expect(document.querySelector('#feed')?.querySelector('.ua-notice, unalgo-layer')).toBeNull();
    act(() => ui.unmount());
    c.stop();
  });

  it('test_untrusted_events_do_nothing', async () => {
    const { b, c, ui } = await pausedCard();
    // jsdom's events, like a page script's, are not trusted.
    fireEvent.click(inLayer().getByRole('button', { name: 'Let us know' }));
    fireEvent.click(inLayer().getByRole('button', { name: 'Not now' }));
    fireEvent.click(inLayer().getByRole('button', { name: 'Dismiss' }));
    fireEvent.keyDown(inLayer().getByRole('button', { name: 'Let us know' }), { key: 'Escape' });
    expect(b.report).not.toHaveBeenCalled();
    expect(b.snoozeNotice).not.toHaveBeenCalled();
    expect(c.notice()?.kind).toBe('paused');
    act(() => ui.unmount());
    c.stop();
  });

  it('test_trusted_let_us_know_and_not_now', async () => {
    const trusted = vi.spyOn(eventGuard, 'trusted').mockReturnValue(true);
    const { b, c, ui } = await pausedCard();
    fireEvent.click(inLayer().getByRole('button', { name: 'Let us know' }));
    expect(trusted).toHaveBeenCalled();
    expect(b.report).toHaveBeenCalledWith({ kind: 'detection', from: 'notice', notice: 'paused' });
    await act(async () => {
      fireEvent.click(inLayer().getByRole('button', { name: 'Not now' }));
    });
    expect(b.snoozeNotice).toHaveBeenCalledWith('paused', 24 * 60 * 60 * 1000);
    expect(inLayer().queryByRole('region')).toBeNull();
    act(() => ui.unmount());
    c.stop();
  });

  it('test_trusted_escape_is_not_now', async () => {
    vi.spyOn(eventGuard, 'trusted').mockReturnValue(true);
    const { b, c, ui } = await pausedCard();
    await act(async () => {
      fireEvent.keyDown(inLayer().getByRole('button', { name: 'Let us know' }), { key: 'Escape' });
    });
    expect(b.snoozeNotice).toHaveBeenCalledWith('paused', 24 * 60 * 60 * 1000);
    expect(b.report).not.toHaveBeenCalled();
    expect(c.notice()).toBeNull();
    act(() => ui.unmount());
    c.stop();
  });

  it('test_the_guard_reads_is_trusted', () => {
    expect(eventGuard.trusted(new MouseEvent('click'))).toBe(false);
    expect(eventGuard.trusted({ isTrusted: true } as Event)).toBe(true);
  });
});

describe('the notice-only layer', () => {
  it('test_notice_layer_for_a_watchdog_page', async () => {
    document.body.innerHTML = '<main></main>';
    const onReport = vi.fn();
    const onNotNow = vi.fn();
    let notice!: ReturnType<typeof mountNoticeLayer>;
    await act(async () => {
      notice = mountNoticeLayer(document, { kind: 'not-running', platform: 'facebook', scheme: 'dark', onReport, onNotNow });
    });
    const host = document.querySelector('unalgo-layer') as HTMLElement;
    expect(host.style.getPropertyValue('--ua-scheme')).toBe('dark');
    const region = inLayer().getByRole('region', { name: 'unAlgorithm' });
    expect(within(region).getByText("unAlgorithm isn't running on this feed")).toBeTruthy();
    expect(within(region).getByText('Facebook seems to have changed this page, so your feed shows as usual.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Let us know' }));
    expect(onReport).not.toHaveBeenCalled();
    vi.spyOn(eventGuard, 'trusted').mockReturnValue(true);
    fireEvent.click(within(region).getByRole('button', { name: 'Let us know' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    act(() => notice.unmount());
    expect(document.querySelector('unalgo-layer')).toBeNull();
  });

  it('test_notice_card_passes_axe_in_both_themes', async () => {
    vi.useRealTimers();
    for (const scheme of ['light', 'dark'] as const) {
      document.body.innerHTML = '<main><h1>Feed</h1></main>';
      let notice!: ReturnType<typeof mountNoticeLayer>;
      await act(async () => {
        notice = mountNoticeLayer(document, {
          kind: 'ads-through',
          platform: 'linkedin',
          scheme,
          onReport: () => undefined,
          onNotNow: () => undefined,
        });
      });
      const host = document.querySelector('unalgo-layer') as HTMLElement;
      const { violations, buttonsChecked } = await axeOn(host);
      expect(violations, scheme).toEqual([]);
      // It looked inside the shadow root: the card's three buttons.
      expect(buttonsChecked).toBe(3);
      act(() => notice.unmount());
    }
  });
});
