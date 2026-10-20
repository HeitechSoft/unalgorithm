import {
  HEALTHY,
  isPaused,
  migrateDevice,
  migrateSettings,
  NOT_NOW_SNOOZE_MS,
  noticeVisible,
  type TabState,
} from '@unalgorithm/core';
import { type PlatformAdapter, routeOf } from '@unalgorithm/platforms';
import { type NoticeKind, uuid } from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { browserKind, browserVersion } from '../lib/browser-kind.ts';
import { CONTENT_STARTED } from '../lib/feed-hosts.ts';
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
import {
  type Bridge,
  FeedController,
  panelHint,
  type ReportOptions,
  type ReportSource,
  type Runtime,
} from './feed-controller.ts';
import { buildReportDraft } from './report.ts';
import { mountNoticeLayer, mountUiHost, type NoticeLayer, UiLayer } from './ui-layer.tsx';
import { startWatchdog, WATCHDOG_STOP_MS, type Watchdog } from './watchdog.ts';

/** A paused tab asks the background about the balance at most this often (the background's own limit is the same). */
const BALANCE_CHECK_INTERVAL_MS = 30_000;
/** While the watchdog watches a candidate route, the page is checked for a strong home signature this often. */
const SIGNATURE_CHECK_MS = 1000;

/** Shared startup for every platform's content script: same controller, different adapter. */
export async function bootContentScript(adapter: PlatformAdapter, ctx: ContentScriptContext): Promise<void> {
  // Before the first await: the background checks this when it puts the script on tabs open at install.
  (globalThis as Record<string, unknown>)[CONTENT_STARTED] = true;
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
  /** The watchdog on a candidate route where unAlgorithm didn't start (ADR 0009 §3), and its notice-only layer. */
  let watchdog: Watchdog | undefined;
  let watchedUrl: string | undefined;
  let signatureTimer: number | undefined;
  let noticeLayer: NoticeLayer | undefined;
  /** Watchdog cards put away on this page load: each shows at most once. */
  const shownThisLoad = new Set<NoticeKind>();

  /**
   * Builds a draft of this page as it is now and opens the report page (ADR 0009 §2): from the controller where it
   * runs, the watchdog where it watches, or neither. Resolves false when the background refused or didn't answer.
   */
  const openReport = async (opts: ReportOptions): Promise<boolean> => {
    if (!ctx.isValid) return false;
    const source: ReportSource | null = controller.isActive ? controller : (watchdog ?? null);
    const draft = buildReportDraft(source, opts, {
      adapter,
      url: new URL(location.href),
      lang: document.documentElement.lang,
      settings: rt.settings,
      device: rt.device,
      incognito: browser.extension?.inIncognitoContext === true,
    });
    const res = await sendToBackground({ type: 'openReport', draft, ...(opts.notice ? { notice: opts.notice } : {}) }).catch(
      () => ({ ok: false }),
    );
    return res.ok;
  };

  const snoozeNotice = (kind: NoticeKind, ms: number) =>
    sendQuietly({ type: 'snoozeNotice', platform: adapter.id, kind, ms, adapter: adapter.version });

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
    report: (opts = { kind: 'detection', from: 'popup' }) => void openReport(opts),
    snoozeNotice,
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

  const sitePaused = () => isPaused(rt.device, adapter.id) || !rt.settings.platforms[adapter.id].enabled;

  /** The page carries the feed's strong home signature (LinkedIn's main feed list, Facebook's current Home tab). */
  const strongSignature = (): boolean => {
    try {
      return adapter.homeSignature?.(document) === 'strong';
    } catch {
      return false;
    }
  };

  const hideWatchdogNotice = () => {
    noticeLayer?.unmount();
    noticeLayer = undefined;
  };

  /**
   * The watchdog's card, "unAlgorithm isn't running on this feed": shown once two probes found a feed, unless the
   * notices are off, the site is paused, it was put away on this load or a snooze runs; hidden when that changes.
   */
  const refreshWatchdogNotice = () => {
    if (!watchdog?.feedLike) return hideWatchdogNotice();
    const visible = noticeVisible({
      kind: 'not-running',
      platform: adapter.id,
      adapter: adapter.version,
      now: Date.now(),
      prefs: rt.device.notices,
      shownThisLoad,
      paused: sitePaused(),
    });
    if (!visible) return hideWatchdogNotice();
    if (noticeLayer) return;
    let scheme: 'light' | 'dark' = 'light';
    try {
      scheme = adapter.theme(document);
    } catch {
      // The page's theme is a nicety; the card's own light theme is fine.
    }
    noticeLayer = mountNoticeLayer(document, {
      kind: 'not-running',
      platform: adapter.id,
      scheme,
      onReport: () => void openReport({ kind: 'detection', from: 'notice', notice: 'not-running' }),
      onNotNow: () => {
        shownThisLoad.add('not-running');
        snoozeNotice('not-running', NOT_NOW_SNOOZE_MS);
        hideWatchdogNotice();
      },
    });
  };

  /** What the popup and side panel know about a page where the controller isn't running. */
  const idleState = (url: URL, onFeed: boolean): Partial<TabState> => {
    const feedLike = watchdog?.feedLike === true;
    return {
      platform: adapter.id,
      url: url.href,
      onFeed,
      paused: sitePaused(),
      feedLike,
      routeNew: false,
      health: watchdog?.getHealth() ?? HEALTHY,
      ...(feedLike ? { notice: { kind: 'not-running' as const, issues: ['feed-not-started'] } } : {}),
    };
  };

  const stopWatching = () => {
    watchdog?.stop();
    watchdog = undefined;
    watchedUrl = undefined;
    window.clearInterval(signatureTimer);
    hideWatchdogNotice();
  };

  /**
   * Watches a candidate route read-only (ADR 0009 §3): two passing probes mean the feed is here and unAlgorithm isn't
   * running on it. Meanwhile, a strong home signature that turns up as the page renders starts the controller.
   */
  const startWatching = (url: URL) => {
    if (watchdog && watchedUrl === url.href) return;
    stopWatching();
    watchedUrl = url.href;
    watchdog = startWatchdog({
      adapter,
      onFeedLike: () => {
        bridge.pushTabState(idleState(new URL(location.href), false));
        refreshWatchdogNotice();
      },
    });
    const started = Date.now();
    signatureTimer = window.setInterval(() => {
      if (Date.now() - started > WATCHDOG_STOP_MS) window.clearInterval(signatureTimer);
      else if (strongSignature()) sync();
    }, SIGNATURE_CHECK_MS);
  };

  /**
   * Runs the feed UI where the page is the feed, watches where it may be, and stops it elsewhere (ADR 0009 §3): the
   * feed route starts the controller; a candidate route starts it when the page has a strong home signature (`route-new`),
   * and otherwise the watchdog watches; any other page gets nothing. `next`: the address a client-side navigation goes
   * to. WXT reports one from the Navigation API's `navigate` event, which comes before the address changes, so
   * `location` still holds the page being left; every other caller reads `location`.
   */
  const sync = (next?: URL) => {
    if (!ctx.isValid) return;
    const url = next ?? new URL(location.href);
    const route = routeOf(adapter, url);
    const paused = sitePaused();
    window.clearTimeout(resumeTimer);
    const until = rt.device.pausedUntil[adapter.id];
    if (typeof until === 'number' && until > Date.now()) resumeTimer = window.setTimeout(() => sync(), until - Date.now() + 50);
    const routeNew = route === 'feed-candidate' && strongSignature();
    if ((route === 'feed' || routeNew) && !paused) {
      stopWatching();
      layer.mount(controller);
      controller.start(rt, { routeNew });
      return;
    }
    controller.stop();
    layer.unmount();
    if (route === 'feed-candidate' && !paused) {
      startWatching(url);
      refreshWatchdogNotice();
    } else stopWatching();
    bridge.pushTabState(idleState(url, route === 'feed'));
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
      case 'ping': {
        // The feed, or a candidate route unAlgorithm started on.
        const onFeed = routeOf(adapter, new URL(location.href)) === 'feed' || controller.isActive;
        reply<'ping'>({ ok: true, onFeed, platform: adapter.id });
        return false;
      }
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
          pageKind: routeOf(adapter, new URL(location.href)),
          health: controller.getHealth(),
          ...d,
        });
        return false;
      }
      // The popup's Report a problem, or a banner's Let us know: the page as it is now, from here, where its facts are.
      case 'reportSnapshot':
        void openReport({
          kind: 'detection',
          from: msg.from === 'popup-banner' || msg.from === 'sidepanel' ? msg.from : 'popup',
        }).then((ok) => reply<'reportSnapshot'>({ ok }));
        return true;
      // A report about this page went out: its card goes away (the background has snoozed it for every tab).
      case 'reportSent':
        if (controller.isActive) controller.onReportSent(msg.kind);
        else if (watchdog?.feedLike && (!msg.kind || msg.kind === 'not-running')) {
          shownThisLoad.add('not-running');
          hideWatchdogNotice();
        }
        reply<'reportSent'>({ ok: true });
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
    stopWatching();
    controller.stop();
    layer.unmount();
  });

  sync();
}
