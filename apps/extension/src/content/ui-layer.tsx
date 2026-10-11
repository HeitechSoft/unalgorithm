import { FeedItem, ToastRegion } from '@unalgorithm/ui';
import feedCss from '@unalgorithm/ui/feed.css?inline';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { Entry, FeedController, UiHost } from './feed-controller.ts';

let sheet: CSSStyleSheet | null = null;

/** One constructed stylesheet shared by every shadow root (falls back to a <style> where that is unsupported). */
function attachStyles(shadow: ShadowRoot): void {
  try {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(feedCss);
    }
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = feedCss;
    shadow.prepend(style);
  }
}

const STOP = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'focusin', 'input'];

/** Our UI's events stay ours: the platform's shortcuts and card click handlers never see them. */
function isolate(host: HTMLElement): void {
  for (const type of STOP) host.addEventListener(type, (e) => e.stopPropagation());
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
      <ToastRegion toasts={controller.toasts} onDismiss={controller.dismissToast} />
    </>
  );
}

/** A single React root renders every post's UI through portals, plus page-level toasts. */
export class UiLayer {
  private host: HTMLElement | undefined;
  private root: Root | undefined;

  mount(controller: FeedController): void {
    if (this.host?.isConnected) return;
    for (const old of document.querySelectorAll('unalgo-layer')) old.remove(); // left by an older copy of the script
    const host = document.createElement('unalgo-layer');
    const shadow = host.attachShadow({ mode: 'open' });
    attachStyles(shadow);
    const container = document.createElement('div');
    shadow.append(container);
    isolate(host);
    document.body.appendChild(host);
    this.host = host;
    this.root = createRoot(container);
    this.root.render(<FeedLayer controller={controller} />);
  }

  unmount(): void {
    this.root?.unmount();
    this.host?.remove();
    this.root = undefined;
    this.host = undefined;
  }
}
