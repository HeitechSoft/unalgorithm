import { FeedItem, type NoticeModel, NoticeRegion, ToastRegion } from '@unalgorithm/ui';
import feedCss from '@unalgorithm/ui/feed.css?inline';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { browserKind } from '../lib/browser-kind.ts';
import type { Entry, FeedController, UiHost } from './feed-controller.ts';

let sheet: CSSStyleSheet | null = null;

/**
 * One constructed stylesheet shared by every shadow root, or a <style> where that is unsupported. Firefox always gets
 * a <style> (ADR 0008), as WXT's own shadow-root UI does there, so no constructed sheet has to cross the content
 * script's Xray wrappers.
 */
function attachStyles(shadow: ShadowRoot): void {
  if (browserKind() !== 'firefox' && adoptSheet(shadow)) return;
  const style = document.createElement('style');
  style.textContent = feedCss;
  shadow.prepend(style);
}

function adoptSheet(shadow: ShadowRoot): boolean {
  try {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(feedCss);
    }
    shadow.adoptedStyleSheets = [sheet];
    return true;
  } catch {
    return false;
  }
}

const STOP = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'focusin', 'input'];

/** Our UI's events stay ours: the platform's shortcuts and card click handlers never see them. */
function isolate(host: HTMLElement): void {
  for (const type of STOP) host.addEventListener(type, (e) => e.stopPropagation());
}

/**
 * The notice card acts only on clicks and key presses the person made (ADR 0009 §2). Our layer is an open shadow root,
 * so the platform's own scripts could dispatch events into it: opening report tabs, or snoozing the card. An object,
 * so tests can stand in for a trusted event (jsdom can't make one).
 */
export const eventGuard = {
  trusted: (event: Event): boolean => event.isTrusted === true,
};

function whenTrusted(fn: () => void): (event: Event) => void {
  return (event) => {
    if (eventGuard.trusted(event)) fn();
  };
}

/** Create the per-item host: `<unalgo-post>` with an open shadow root, appended as the item's last child. */
export function mountUiHost(e: Entry): UiHost {
  const host = document.createElement('unalgo-post');
  host.setAttribute('lang', 'en');
  const shadow = host.attachShadow({ mode: 'open' });
  attachStyles(shadow);
  const container = document.createElement('div');
  shadow.append(container);
  isolate(host);
  e.el.appendChild(host);
  return { host, container };
}

function FeedLayer({ controller }: { controller: FeedController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  return (
    <>
      {controller
        .mounted()
        .map((e) =>
          e.ui && e.handlers
            ? createPortal(<FeedItem model={controller.modelFor(e)} on={e.handlers} />, e.ui.container, e.id)
            : null,
        )}
      <div className="ua-dock">
        <NoticeRegion
          notice={controller.notice()}
          onReport={whenTrusted(controller.noticeReport)}
          onNotNow={whenTrusted(controller.noticeNotNow)}
        />
        <ToastRegion toasts={controller.toasts} onDismiss={controller.dismissToast} />
      </div>
    </>
  );
}

/** The page layer's host: `<unalgo-layer>` with an open shadow root on the body, holding one React root. */
function mountLayerHost(doc: Document): { host: HTMLElement; root: Root } {
  for (const old of doc.querySelectorAll('unalgo-layer')) old.remove(); // left by an older copy of the script
  const host = doc.createElement('unalgo-layer');
  host.setAttribute('lang', 'en');
  const shadow = host.attachShadow({ mode: 'open' });
  attachStyles(shadow);
  const container = doc.createElement('div');
  shadow.append(container);
  isolate(host);
  doc.body.appendChild(host);
  return { host, root: createRoot(container) };
}

/** A single React root renders every post's UI through portals, plus page-level toasts and the breakage notice. */
export class UiLayer {
  private host: HTMLElement | undefined;
  private root: Root | undefined;

  mount(controller: FeedController): void {
    if (this.host?.isConnected) return;
    const { host, root } = mountLayerHost(document);
    this.host = host;
    this.root = root;
    this.root.render(<FeedLayer controller={controller} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.host?.remove();
    this.root = undefined;
    this.host = undefined;
  }
}

export interface NoticeLayerProps extends NoticeModel {
  /** The page's theme as the adapter reads it: with no controller here, nothing else sets it. */
  scheme?: 'light' | 'dark';
  /** *Let us know*. Called only for the person's own click. */
  onReport(): void;
  /** *Not now*, ✕ or Escape. Called only for the person's own click or key press. */
  onNotNow(): void;
}

export interface NoticeLayer {
  update(props: NoticeLayerProps): void;
  unmount(): void;
}

/**
 * A notice-only layer, for a page whose watchdog found a feed that unAlgorithm didn't start on (ADR 0009 §3): the same
 * card in the same corner, with nothing else. The caller decides when it shows (`noticeVisible`) and what its buttons
 * do.
 */
export function mountNoticeLayer(doc: Document, props: NoticeLayerProps): NoticeLayer {
  const { host, root } = mountLayerHost(doc);
  const render = (p: NoticeLayerProps) => {
    if (p.scheme) host.style.setProperty('--ua-scheme', p.scheme);
    root.render(
      <div className="ua-dock">
        <NoticeRegion
          notice={{ kind: p.kind, platform: p.platform }}
          onReport={whenTrusted(p.onReport)}
          onNotNow={whenTrusted(p.onNotNow)}
        />
      </div>,
    );
  };
  render(props);
  return {
    update: render,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
