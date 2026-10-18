import { isPaused, migrateDevice, migrateSettings } from '@unalgorithm/core';
import type { PlatformAdapter } from '@unalgorithm/platforms';
import { uuid } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { browserKind, browserVersion } from '../lib/browser-kind.ts';
import { type ContentRequest, type ContentResponses, sendQuietly, sendToBackground } from '../lib/messages.ts';
import {
  deviceItem,
  learnedItem,
  officialListItem,
  readDevice,
  readSettings,
  serverOfferItem,
  settingsItem,
  votesItem,
} from '../lib/storage.ts';
import { type Bridge, FeedController, panelHint, type Runtime } from './feed-controller.ts';
import { reportProblemUrl } from './report.ts';
import { mountUiHost, UiLayer } from './ui-layer.tsx';

/** A paused tab asks the background about the balance at most this often (the background's own limit is the same). */
const BALANCE_CHECK_INTERVAL_MS = 30_000;

/** Shared startup for every platform's content script: same controller, different adapter. */
export async function bootContentScript(adapter: PlatformAdapter, ctx: ContentScriptContext): Promise<void> {
  const rt: Runtime = {
    settings: await readSettings(),
    device: await readDevice(),
    learned: await learnedItem.getValue(),
    votes: await votesItem.getValue(),
    serverOffer: await serverOfferItem.getValue(),
    officialList: await officialListItem.getValue(),
  };

  /** Firefox's sidebar shortcut, as the background last reported it. */
  let shortcut: string | undefined;
  const bridge: Bridge = {
    classify: (items, opts) =>
      sendToBackground({ type: 'classify', platform: adapter.id, items, cacheOnly: opts?.cacheOnly === true }),
    pushTabState: (patch) => {
      if (ctx.isValid) void sendToBackground({ type: 'tabState', patch }).catch(() => undefined);
    },
    vote: async (key, verdict, topics, summary, shareable) => {
      await sendToBackground({ type: 'vote', key, verdict, topics, ...(summary ? { summary, shareable } : {}) });
    },
    settingsAction: async (action) => (await sendToBackground({ type: 'settingsAction', action })).undo,
    coachMarkShown: () => void sendToBackground({ type: 'coachMarkShown', platform: adapter.id }).catch(() => undefined),
    openSettings: (hash) => sendQuietly({ type: 'openPage', page: 'options', ...(hash ? { hash } : {}) }),
    report: () => {
      window.open(reportProblemUrl(adapter, controller), '_blank', 'noopener');
    },
    factcheck: (key, input) => sendToBackground({ type: 'factcheck', key, input }),
    perspectives: (key, req) => sendToBackground({ type: 'perspectives', key, ...req }),
    openFactcheck: async () => {
      if (!ctx.isValid) return false;
      const res: { ok: boolean; shortcut?: string } = await sendToBackground({ type: 'openFactcheck' }).catch(() => ({
        ok: false,
      }));
      shortcut = res.shortcut;
      return res.ok;
    },
    panelHint: () => panelHint(browserKind() === 'firefox', shortcut),
  };

  const controller = new FeedController(adapter, bridge, mountUiHost, () => ctx.isValid);
  const layer = new UiLayer();
  let resumeTimer: number | undefined;

  /**
   * Runs the feed UI where the page is the feed, and stops it elsewhere. `next`: the address a client-side navigation
   * goes to. WXT reports one from the Navigation API's `navigate` event, which comes before the address changes, so
   * `location` still holds the page being left; every other caller reads `location`.
   */
  const sync = (next?: URL) => {
    if (!ctx.isValid) return;
    const url = next ?? new URL(location.href);
    const onFeed = adapter.isFeedPage(url);
    const enabled = rt.settings.platforms[adapter.id].enabled;
    const paused = isPaused(rt.device, adapter.id);
    window.clearTimeout(resumeTimer);
    const until = rt.device.pausedUntil[adapter.id];
    if (typeof until === 'number' && until > Date.now()) resumeTimer = window.setTimeout(() => sync(), until - Date.now() + 50);
    if (onFeed && enabled && !paused) {
      layer.mount(controller);
      controller.start(rt);
    } else {
      controller.stop();
      layer.unmount();
      bridge.pushTabState({ platform: adapter.id, url: url.href, onFeed, paused: paused || !enabled });
    }
  };

  const refresh = () => {
    controller.update(rt);
    sync();
  };
  const unwatch = [
    settingsItem.watch((raw) => {
      rt.settings = migrateSettings(raw);
      refresh();
    }),
    deviceItem.watch((raw) => {
      rt.device = migrateDevice(raw, uuid);
      refresh();
    }),
    learnedItem.watch((v) => {
      rt.learned = v;
      refresh();
    }),
    votesItem.watch((v) => {
      rt.votes = v;
      refresh();
    }),
    serverOfferItem.watch((v) => {
      rt.serverOffer = v;
      refresh();
    }),
    // unAlgorithm Cloud's source list, as the background stores a new copy: UnEcho Chamber follows the chosen list.
    officialListItem.watch((v) => {
      rt.officialList = v;
      refresh();
    }),
  ];

  // Single-page apps: follow client-side navigation, to the address it goes to.
  ctx.addEventListener(window, 'wxt:locationchange', (e) => sync(e.newUrl));

  const onMessage = (msg: ContentRequest, _sender: unknown, sendResponse: (r: unknown) => void) => {
    const reply = <T extends ContentRequest['type']>(r: ContentResponses[T]) => sendResponse(r);
    switch (msg.type) {
      case 'ping':
        reply<'ping'>({ ok: true, onFeed: adapter.isFeedPage(new URL(location.href)), platform: adapter.id });
        return false;
      case 'scrollTo':
        reply<'scrollTo'>({ ok: controller.scrollTo(msg.key) });
        return false;
      case 'peek':
        controller.setPeek(msg.on);
        reply<'peek'>({ ok: true });
        return false;
      case 'reveal':
        reply<'reveal'>({ ok: controller.reveal(msg.key) });
        return false;
      case 'diagnostics': {
        const d = controller.diagnostics();
        reply<'diagnostics'>({
          adapter: adapter.version,
          extension: browser.runtime.getManifest().version,
          browser: browserVersion(navigator.userAgent),
          lang: document.documentElement.lang || 'unknown',
          pageKind: adapter.isFeedPage(new URL(location.href)) ? 'feed' : 'other',
          health: controller.getHealth(),
          ...d,
        });
        return false;
      }
      case 'reportUrl':
        reply<'reportUrl'>({ url: reportProblemUrl(adapter, controller) });
        return false;
      // Signed in to the server again: the device may not have changed, so no watch above fires. Clears the AI pause.
      case 'aiResume':
        refresh();
        reply<'aiResume'>({ ok: true });
        return false;
    }
  };
  browser.runtime.onMessage.addListener(onMessage);

  // Paused at $0 (R27): credit may have been added in another tab. Back on this one, the background checks the balance
  // (at most every 30 s) and resumes every feed tab through `aiResume` once it is above 0. Credit lifts no other pause.
  let lastBalanceCheck = Number.NEGATIVE_INFINITY;
  const onVisibility = () => {
    if (!ctx.isValid || document.visibilityState !== 'visible') return;
    if (controller.pausedFor() !== 'insufficient-credits') return;
    if (Date.now() - lastBalanceCheck < BALANCE_CHECK_INTERVAL_MS) return;
    lastBalanceCheck = Date.now();
    sendQuietly({ type: 'balanceCheck' });
  };
  document.addEventListener('visibilitychange', onVisibility);

  ctx.onInvalidated(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    for (const u of unwatch) {
      try {
        u();
      } catch {
        // the extension context is gone; the listener died with it
      }
    }
    controller.stop();
    layer.unmount();
  });

  sync();
}
