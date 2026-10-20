/**
 * The in-feed breakage notice (ADR 0009 §3): the card table's copy for each kind, its landmark and live region, its
 * buttons, Escape, and that it never takes focus. axe runs on the card in the extension's layer test
 * (apps/extension/tests/notice-card.test.tsx), where axe-core is installed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { NoticeKind } from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FeedItem,
  type FeedItemHandlers,
  type FeedItemModel,
  NOTICE_ACTIONS,
  NOTICE_COPY,
  NOTICE_FOOTNOTE,
  NoticeCard,
  NoticeRegion,
  noticeCopy,
  OVER_FILTERING_COPY,
} from '../src/index.ts';

afterEach(cleanup);

const handlers = () => ({ onReport: vi.fn(), onNotNow: vi.fn() });

describe('notice copy', () => {
  it('test_notice_copy_is_the_adr_card_table', () => {
    expect(NOTICE_COPY['not-running'].title).toBe("unAlgorithm isn't running on this feed");
    expect(NOTICE_COPY['not-running'].body('LinkedIn')).toBe(
      'LinkedIn seems to have changed this page, so your feed shows as usual.',
    );
    expect(NOTICE_COPY.paused.title).toBe('Filtering is paused on this page');
    expect(NOTICE_COPY.paused.body('Facebook')).toBe(
      "Facebook looks different today, so we're showing every post rather than hide the wrong ones.",
    );
    expect(NOTICE_COPY['ads-through'].title).toBe('Some ads may be getting through');
    expect(NOTICE_COPY['ads-through'].body('LinkedIn')).toBe('LinkedIn may have changed how it labels ads.');
    // Paused because nearly everything would have been hidden: that holds until the page reloads, so it says how to
    // try again.
    expect(OVER_FILTERING_COPY.title).toBe('Filtering is paused on this page');
    expect(OVER_FILTERING_COPY.body('Facebook')).toBe(
      "unAlgorithm would have hidden too many posts, so it's showing every post. Reload the page to try again.",
    );
    expect(NOTICE_FOOTNOTE).toBe('Nothing is sent unless you choose to.');
    expect(NOTICE_ACTIONS).toStrictEqual({ report: 'Let us know', notNow: 'Not now', dismiss: 'Dismiss' });
  });

  it('test_notice_card_renders_each_kind_for_each_site', () => {
    const kinds: NoticeKind[] = ['not-running', 'paused', 'ads-through'];
    for (const kind of kinds) {
      for (const [platform, site] of [
        ['linkedin', 'LinkedIn'],
        ['facebook', 'Facebook'],
      ] as const) {
        const { unmount } = render(<NoticeCard kind={kind} platform={platform} {...handlers()} />);
        expect(screen.getByText(NOTICE_COPY[kind].title)).toBeTruthy();
        expect(screen.getByText(NOTICE_COPY[kind].body(site))).toBeTruthy();
        expect(screen.getByText(NOTICE_FOOTNOTE)).toBeTruthy();
        expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
          'Let us know',
          'Not now',
          'Dismiss',
        ]);
        unmount();
      }
    }
  });
});

describe('notice copy by cause', () => {
  it('test_notice_copy_follows_the_issues', () => {
    expect(noticeCopy('paused')).toBe(NOTICE_COPY.paused);
    expect(noticeCopy('paused', ['adapter-error'])).toBe(NOTICE_COPY.paused);
    expect(noticeCopy('paused', ['over-filtering'])).toBe(OVER_FILTERING_COPY);
    expect(noticeCopy('paused', ['adapter-error', 'over-filtering'])).toBe(OVER_FILTERING_COPY);
    expect(noticeCopy('ads-through', ['over-filtering'])).toBe(NOTICE_COPY['ads-through']);
  });

  it('test_over_filtering_card_says_reload', () => {
    render(<NoticeCard kind="paused" platform="facebook" issues={['over-filtering']} {...handlers()} />);
    expect(screen.getByText('Filtering is paused on this page')).toBeTruthy();
    expect(screen.getByText(OVER_FILTERING_COPY.body('Facebook'))).toBeTruthy();
    expect(screen.queryByText(NOTICE_COPY.paused.body('Facebook'))).toBeNull();
    // Report a problem, as on every card.
    expect(screen.getByRole('button', { name: 'Let us know' })).toBeTruthy();
  });
});

describe('notice region', () => {
  it('test_notice_region_is_a_named_landmark_around_a_polite_status', () => {
    const { rerender } = render(<NoticeRegion notice={null} {...handlers()} />);
    // Nothing to show: the live region waits on the page, and there is no empty landmark.
    expect(screen.queryByRole('region')).toBeNull();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    rerender(<NoticeRegion notice={{ kind: 'paused', platform: 'linkedin' }} {...handlers()} />);
    const region = screen.getByRole('region', { name: 'unAlgorithm' });
    // The same status element, now holding the card, so it is announced.
    expect(within(region).getByRole('status')).toBe(status);
    expect(within(status).getByText('Filtering is paused on this page')).toBeTruthy();
  });

  it('test_notice_buttons_call_back_with_the_browser_event', () => {
    const on = handlers();
    render(<NoticeRegion notice={{ kind: 'ads-through', platform: 'facebook' }} {...on} />);
    fireEvent.click(screen.getByRole('button', { name: 'Let us know' }));
    expect(on.onReport).toHaveBeenCalledTimes(1);
    // The native event, so the page layer can check `isTrusted`.
    expect(on.onReport.mock.calls[0]?.[0]).toBeInstanceOf(Event);
    expect(on.onNotNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(on.onNotNow).toHaveBeenCalledTimes(2);
    for (const button of screen.getAllByRole('button')) expect(button.getAttribute('type')).toBe('button');
  });

  it('test_escape_means_not_now', () => {
    const on = handlers();
    const outside = vi.fn();
    render(
      <div onKeyDown={outside}>
        <NoticeRegion notice={{ kind: 'paused', platform: 'linkedin' }} {...on} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'Let us know' }), { key: 'Enter' });
    expect(on.onNotNow).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Let us know' }), { key: 'Escape' });
    expect(on.onNotNow).toHaveBeenCalledTimes(1);
    expect(on.onReport).not.toHaveBeenCalled();
    // Escape is ours while focus is in the card: the page's own Escape handling doesn't also see it.
    expect(outside.mock.calls.filter(([e]) => e.key === 'Escape')).toHaveLength(0);
  });

  it('test_notice_never_takes_focus', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const { rerender } = render(<NoticeRegion notice={null} {...handlers()} />);
    rerender(<NoticeRegion notice={{ kind: 'not-running', platform: 'linkedin' }} {...handlers()} />);
    expect(document.activeElement).toBe(input);
    rerender(<NoticeRegion notice={{ kind: 'paused', platform: 'linkedin' }} {...handlers()} />);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[autofocus], [tabindex]')).toBeNull();
    input.remove();
  });
});

describe('notice styles', () => {
  const css = readFileSync(join(import.meta.dirname, '../src/styles/feed.css'), 'utf8');

  it('test_notice_sits_bottom_left_above_the_toasts', () => {
    // One fixed corner holds the card first, then the toasts.
    expect(css).toMatch(/\.ua-dock \{[^}]*position: fixed;[^}]*left: 24px;[^}]*bottom: 24px;[^}]*flex-direction: column;/);
    expect(css).toMatch(/\.ua-dock > \.ua-toasts \{\s*position: static;/);
    expect(css).toMatch(/\.ua-notice \{[^}]*width: min\(360px, calc\(100vw - 48px\)\);/);
    expect(css).toMatch(/\.ua-notice \{[^}]*color-scheme: var\(--ua-scheme, light\);/);
  });

  it('test_notice_motion_is_reduced_on_request', () => {
    expect(css).toMatch(/\.ua-notice \{[^}]*animation: ua-toast-in/);
    // The layer-wide rule that cuts every animation short covers the card.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,/);
    expect(css).toMatch(/@media \(forced-colors: active\) \{[\s\S]*\.ua-notice \{/);
  });
});

describe('Why? → Wrong call?', () => {
  it('test_wrong_call_icon_is_message_square_warning', () => {
    const model: FeedItemModel = {
      key: 'li:ck:1',
      platform: 'linkedin',
      state: 'collapsed',
      reason: 'suggested',
      reasonLabel: 'Suggested',
      showReason: true,
      forYouStyle: 'ring',
      why: { title: 'Suggested', body: 'b', footnote: 'f', actions: [{ id: 'report', label: 'Wrong call?' }] },
    };
    const on: FeedItemHandlers = {
      onShow: vi.fn(),
      onHide: vi.fn(),
      onShowAll: vi.fn(),
      onWhyAction: vi.fn(),
      onVote: vi.fn(),
      onCoachDone: vi.fn(),
      onFactcheck: vi.fn(),
      onPerspectives: vi.fn(),
    };
    // jsdom has no popover API; the Why? popover closes before it acts.
    const proto = HTMLElement.prototype as { hidePopover?: () => void };
    const hadHide = 'hidePopover' in proto;
    if (!hadHide) proto.hidePopover = () => undefined;
    render(<FeedItem model={model} on={on} />);
    const action = screen.getAllByRole('button', { name: 'Wrong call?', hidden: true })[0];
    expect(action?.querySelector('svg')?.getAttribute('class')).toContain('lucide-message-square-warning');
    fireEvent.click(action as HTMLElement);
    expect(on.onWhyAction).toHaveBeenCalledWith('report');
    if (!hadHide) delete proto.hidePopover;
  });
});
