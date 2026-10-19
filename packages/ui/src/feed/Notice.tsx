import { type NoticeKind, PLATFORM_NAMES, type PlatformId } from '@unalgorithm/protocol';
import type { KeyboardEvent, MouseEvent } from 'react';
import { CircleAlert, type LucideIcon, Megaphone, Pause, X } from '../icons.ts';

/**
 * The in-feed breakage notice (ADR 0009 §3). It shows only on positive evidence that detection has stopped working,
 * says what we're doing about it, and offers to tell us. Nothing is sent from here: *Let us know* opens the report
 * page, where the person sees the report before choosing to send it.
 */
export const NOTICE_COPY: Record<NoticeKind, { title: string; body: (site: string) => string }> = {
  'not-running': {
    title: "unAlgorithm isn't running on this feed",
    body: (site) => `${site} seems to have changed this page, so your feed shows as usual.`,
  },
  paused: {
    title: 'Filtering is paused on this page',
    body: (site) => `${site} looks different today, so we're showing every post rather than hide the wrong ones.`,
  },
  'ads-through': {
    title: 'Some ads may be getting through',
    body: (site) => `${site} may have changed how it labels ads.`,
  },
};

export const NOTICE_FOOTNOTE = 'Nothing is sent unless you choose to.';

export const NOTICE_ACTIONS = { report: 'Let us know', notNow: 'Not now', dismiss: 'Dismiss' } as const;

/** The landmark around the card: the person can find it, and tell it apart from the platform's own messages. */
export const NOTICE_REGION_LABEL = 'unAlgorithm';

const GLYPH: Record<NoticeKind, LucideIcon> = { 'not-running': CircleAlert, paused: Pause, 'ads-through': Megaphone };

export interface NoticeModel {
  kind: NoticeKind;
  platform: PlatformId;
}

/**
 * The card's actions get the browser's own event, so the page layer can act only on clicks and key presses the person
 * made (`event.isTrusted`): the card lives in an open shadow root that the platform's scripts can reach.
 */
export interface NoticeHandlers {
  /** *Let us know*. */
  onReport(event: Event): void;
  /** *Not now*, ✕ and Escape. */
  onNotNow(event: Event): void;
}

/** One card. It never takes focus; Escape while focus is inside it means *Not now*. */
export function NoticeCard({ kind, platform, onReport, onNotNow }: NoticeModel & NoticeHandlers) {
  const copy = NOTICE_COPY[kind];
  const Glyph = GLYPH[kind];
  const site = PLATFORM_NAMES[platform];
  const click = (fn: (event: Event) => void) => (e: MouseEvent) => fn(e.nativeEvent);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onNotNow(e.nativeEvent);
  };
  return (
    <div className="ua-notice" data-kind={kind} onKeyDown={onKeyDown}>
      <Glyph className="ua-notice-glyph" aria-hidden="true" />
      <div className="ua-notice-main">
        <p className="ua-notice-title">{copy.title}</p>
        <p className="ua-notice-body">{copy.body(site)}</p>
        <div className="ua-notice-actions">
          <button type="button" className="ua-primary" onClick={click(onReport)}>
            {NOTICE_ACTIONS.report}
          </button>
          <button type="button" className="ua-btn" onClick={click(onNotNow)}>
            {NOTICE_ACTIONS.notNow}
          </button>
        </div>
        <p className="ua-notice-foot">{NOTICE_FOOTNOTE}</p>
      </div>
      <button type="button" className="ua-btn ua-notice-close" aria-label={NOTICE_ACTIONS.dismiss} onClick={click(onNotNow)}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Where the card appears: a polite status that is always on the page, so a card that comes in is announced, inside a
 * region named "unAlgorithm" while there is one to show (an empty landmark would only be noise). One card at a time.
 */
export function NoticeRegion({ notice, ...on }: { notice: NoticeModel | null } & NoticeHandlers) {
  return (
    <section className="ua-notice-region" aria-label={notice ? NOTICE_REGION_LABEL : undefined}>
      <div role="status" aria-live="polite">
        {notice ? <NoticeCard key={notice.kind} {...notice} {...on} /> : null}
      </div>
    </section>
  );
}
