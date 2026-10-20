import { ServerInfoSchema } from '@unalgorithm/protocol';
import { type Browser, browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { z } from 'zod';
import {
  aiStatus,
  classifyItems,
  clearAiCapabilities,
  clearAiData,
  forgetKey,
  listSourceModels,
  onDeviceStatus,
  saveSource,
  testSource,
} from '../background/ai.ts';
import { openFactcheckPanel, runFactcheckForTab, runPerspectivesForTab, sidebarShortcut } from '../background/factcheck.ts';
import { recordVote } from '../background/feedback.ts';
import { clearSecrets } from '../background/idb.ts';
import { keepAwake } from '../background/keep-awake.ts';
import { startOfficialListUpdates } from '../background/official-list.ts';
import { forgetReportTab, fromReportPage, openReport, reportDraft, sendReport, snoozeNotice } from '../background/report.ts';
import { forgetSearchKey, saveSearchKey } from '../background/search-key.ts';
import {
  clientRefusal,
  discoverServer,
  type ServerAccount,
  serverAccountItem,
  signIn,
  signOut,
  syncServerOffer,
} from '../background/server-auth.ts';
import { checkBalanceSoon, onBalanceRestored } from '../background/server-balance.ts';
import { listDevices, revokeDevice } from '../background/server-devices.ts';
import { applySettingsAction } from '../background/settings-actions.ts';
import { initSync, resetSync, runSync, setSyncEnabled, syncStatus } from '../background/sync-scheduler.ts';
import { forgetTab, mergeTabState } from '../background/tabs.ts';
import { browserKind } from '../lib/browser-kind.ts';
import { CONTENT_STARTED, FEED_HOSTS, FEED_TAB_URLS } from '../lib/feed-hosts.ts';
import { type BgFailure, type BgRequest, type BgResponses, type PublicServerAccount, sendToTab } from '../lib/messages.ts';
import { isServerAt, serverLabel } from '../lib/server-label.ts';
import { updateDevice, upgradeStoredSettings } from '../lib/settings-store.ts';
import {
  learnedItem,
  readDevice,
  reportLogItem,
  settingsClocksItem,
  settingsItem,
  statsItem,
  syncStateItem,
  usageItem,
  votesItem,
} from '../lib/storage.ts';

type Sender = Browser.runtime.MessageSender;
type Handler<K extends BgRequest['type']> = (msg: Extract<BgRequest, { type: K }>, sender: Sender) => Promise<BgResponses[K]>;

function fromFeedTab(sender: Sender): boolean {
  try {
    return !!sender.tab && FEED_HOSTS.includes(new URL(sender.url ?? sender.tab.url ?? '').hostname);
  } catch {
    return false;
  }
}

function fromExtensionPage(sender: Sender): boolean {
  return !sender.tab || (sender.url ?? '').startsWith(browser.runtime.getURL('/'));
}

/** Messages the in-feed UI and the extension's own pages may both send. */
function fromOwnUi(sender: Sender): boolean {
  return fromFeedTab(sender) || fromExtensionPage(sender);
}

function deny(type: string): never {
  throw new Error(`${type} is not accepted from this sender`);
}

async function openPage(page: 'options' | 'onboarding', hash = ''): Promise<void> {
  const path = page === 'options' ? '/options.html' : '/onboarding.html';
  await browser.tabs.create({ url: browser.runtime.getURL(path) + hash });
}

/**
 * The server account as extension pages see it: no tokens, no device id. The account sits in `storage.local`, which
 * content scripts can write (ADR 0005), so its discovery document is checked before it names the server.
 */
function publicAccount(account: ServerAccount): PublicServerAccount {
  const info = ServerInfoSchema.safeParse(account.info);
  return {
    origin: account.origin,
    email: account.email,
    signedInAt: account.signedInAt,
    needsSignIn: account.needsSignIn,
    label: serverLabel(account.origin, info.success ? info.data : undefined),
    ...(info.success && info.data.billing ? { billing: true } : {}),
  };
}

/**
 * Open feed tabs try AI again after a sign-in. A new source reaches them through their device watch, but signing in
 * again to the server that is already the source writes an identical device, which the watch never reports, and those
 * tabs would stay paused on "Sign in to … again". The message carries nothing; tabs without unAlgorithm are skipped.
 */
async function resumeFeedTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: FEED_TAB_URLS }).catch(() => []);
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : sendToTab(tab.id, { type: 'aiResume' }))));
}

// Credit came back (CL5): feed tabs paused for `insufficient-credits` pick up again without a reload.
onBalanceRestored(() => void resumeFeedTabs());

/**
 * Signs this computer out of the account's server: AI turns off rather than staying on a source that can only fail with
 * "Sign in again" (rules keep working), sync is reset, and the device is ended on the server and forgotten here. AI goes
 * off first, so feed tabs stop sending posts before the device's tokens go. Sync stays off after signing in again until
 * the person turns it on.
 */
async function signOutOfServer(account: ServerAccount): Promise<void> {
  if (isServerAt((await readDevice()).aiSource, account.origin)) await saveSource(null);
  await resetSync();
  await signOut(account.origin);
}

/** Every message type must have a handler: a missing one is a compile error. Exported for tests. */
export const handlers: { [K in BgRequest['type']]: Handler<K> } = {
  classify: async (msg, sender) => {
    if (!fromFeedTab(sender)) deny('classify');
    return classifyItems(msg.items.slice(0, 8), { cacheOnly: msg.cacheOnly === true });
  },
  tabState: async (msg, sender) => {
    if (sender.tab?.id !== undefined && fromFeedTab(sender)) await mergeTabState(sender.tab.id, msg.patch);
    return { ok: true };
  },
  vote: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('vote');
    await recordVote(msg.key, msg.verdict, msg.topics.slice(0, 3), msg.summary, msg.shareable === true);
    return { ok: true };
  },
  settingsAction: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('settingsAction');
    return { ok: true, undo: await applySettingsAction(msg.action) };
  },
  pause: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('pause');
    await updateDevice((d) => {
      d.pausedUntil[msg.platform] = msg.until;
    });
    return { ok: true };
  },
  coachMarkShown: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('coachMarkShown');
    await updateDevice((d) => {
      d.onboarding.coachMarkShown[msg.platform] = true;
    });
    return { ok: true };
  },
  openPage: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('openPage');
    await openPage(msg.page, msg.hash);
    return { ok: true };
  },
  aiStatus: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('aiStatus');
    return aiStatus();
  },
  testSource: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('testSource');
    return testSource(msg.config, msg.apiKey);
  },
  listModels: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('listModels');
    return listSourceModels(msg.config);
  },
  saveSource: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('saveSource');
    return saveSource(msg.config, msg.apiKey);
  },
  clearData: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('clearData');
    const all = msg.what === 'all';
    if (all) {
      // Sync stops before anything goes, so no run writes its state back or pushes during the erase.
      await resetSync().catch((err: unknown) => console.debug('[unAlgorithm] sync reset failed', err));
      // Ending the device on the server needs its refresh token, which `clearSecrets` deletes, so this goes first. A
      // failed sign-out doesn't stop the erase: the account itself is removed below either way.
      try {
        const account = await serverAccountItem.getValue();
        if (account) await signOut(account.origin);
      } catch (err) {
        console.debug('[unAlgorithm] server sign-out failed', err);
      }
    }
    const steps: Array<() => Promise<unknown>> = [];
    if (msg.what === 'cache' || all) steps.push(clearAiData);
    if (msg.what === 'learned' || all)
      steps.push(
        () => learnedItem.removeValue(),
        () => votesItem.removeValue(),
      );
    if (msg.what === 'stats' || all) steps.push(() => statsItem.removeValue());
    if (all)
      steps.push(
        clearSecrets,
        // Who was signed in to which server (email, device id).
        () => serverAccountItem.removeValue(),
        () => usageItem.removeValue(),
        clearAiCapabilities,
        // Per-tab Highlights (author names, snippets, links) live in session storage until the tab closes, and so do
        // problem report drafts.
        () => browser.storage.session.clear(),
        // When this browser sent problem reports, for the local limits.
        () => reportLogItem.removeValue(),
        // Settings and their clocks go too: the defaults written next then stay at clock 0, so they never travel to
        // the person's other computers, and the server's values win on the next sync.
        () => settingsItem.removeValue(),
        () => settingsClocksItem.removeValue(),
        () => syncStateItem.removeValue(),
      );
    // Run every step even if one fails (API keys are erased first), then report any failure.
    const failed = (await Promise.allSettled(steps.map((step) => step()))).filter((r) => r.status === 'rejected');
    if (failed.length) throw new Error(`${failed.length} erase step(s) failed`);
    return { ok: true };
  },
  onDeviceStatus: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('onDeviceStatus');
    return { availability: await onDeviceStatus() };
  },
  forgetKey: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('forgetKey');
    await forgetKey(msg.config);
    return { ok: true };
  },
  saveSearchKey: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('saveSearchKey');
    return saveSearchKey(msg.provider, msg.apiKey);
  },
  forgetSearchKey: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('forgetSearchKey');
    await forgetSearchKey();
    return { ok: true };
  },
  serverDiscover: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverDiscover');
    const found = await discoverServer(msg.baseUrl);
    if (!found.ok) return found;
    // Said at "Continue", before the person reads what is sent: this browser can't sign in there at all.
    const refused = clientRefusal(found.origin, found.info);
    return refused ? { ok: false, error: refused } : { ...found, label: serverLabel(found.origin, found.info) };
  },
  serverSignIn: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverSignIn');
    const signedIn = await signIn(msg.baseUrl);
    if (!signedIn.ok) return signedIn;
    await saveSource({ kind: 'server', baseUrl: signedIn.account.origin });
    await resumeFeedTabs();
    return { ok: true, account: publicAccount(signedIn.account) };
  },
  serverSignOut: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverSignOut');
    const account = await serverAccountItem.getValue();
    if (account) await signOutOfServer(account);
    return { ok: true };
  },
  serverAccount: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverAccount');
    const account = await serverAccountItem.getValue();
    return { account: account ? publicAccount(account) : null };
  },
  serverDevices: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverDevices');
    return listDevices();
  },
  serverRevokeDevice: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverRevokeDevice');
    if (!z.uuid().safeParse(msg.deviceId).success) {
      return { ok: false, error: { code: 'bad-request', message: "That isn't one of this account's devices." } };
    }
    // This computer: the sign-out, not a second path.
    const account = await serverAccountItem.getValue();
    if (account?.deviceId === msg.deviceId) {
      await signOutOfServer(account);
      return { ok: true, signedOut: true };
    }
    const revoked = await revokeDevice(msg.deviceId);
    return revoked.ok ? { ok: true, signedOut: false } : revoked;
  },
  syncStatus: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('syncStatus');
    return syncStatus();
  },
  syncSetEnabled: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('syncSetEnabled');
    return setSyncEnabled(msg.enabled === true);
  },
  syncNow: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('syncNow');
    return runSync();
  },
  factcheck: async (msg, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !fromFeedTab(sender)) deny('factcheck');
    // Before any `await`, so Chrome and Edge still see the click's user gesture (relayed from the content script).
    // Firefox can't open its sidebar from here at all (`openFactcheckPanel`).
    void openFactcheckPanel({ id: tabId, windowId: sender.tab?.windowId });
    return runFactcheckForTab(tabId, msg.key, msg.input);
  },
  openFactcheck: async (_msg, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !fromFeedTab(sender)) deny('openFactcheck');
    // When the panel doesn't open, the in-feed item says how to open it: the toolbar button, whose popup opens the
    // side panel, or in Firefox also the sidebar's keyboard shortcut.
    if (await openFactcheckPanel({ id: tabId, windowId: sender.tab?.windowId })) return { ok: true };
    const shortcut = await sidebarShortcut();
    return { ok: false, ...(shortcut ? { shortcut } : {}) };
  },
  balanceCheck: async (_msg, sender) => {
    if (!fromFeedTab(sender)) deny('balanceCheck');
    // A restored balance resumes the tabs through `onBalanceRestored` above; the reply tells the tab nothing.
    const [device, account] = await Promise.all([readDevice(), serverAccountItem.getValue()]);
    await checkBalanceSoon(device.aiSource, account);
    return { ok: true };
  },
  perspectives: async (msg, sender) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined || !fromFeedTab(sender)) deny('perspectives');
    // Before any `await`, as fact-check's.
    void openFactcheckPanel({ id: tabId, windowId: sender.tab?.windowId });
    // Field by field: anything else on the message (post text included) goes nowhere.
    return runPerspectivesForTab(tabId, msg.key, { link: msg.link, platform: msg.platform, audience: msg.audience });
  },
  // Problem reports (ADR 0009 §2). A draft of a page comes from that page's content script (`openReport` checks which
  // sender may send which draft); the popup and Settings ask for one about no page facts. Only the report page reads a
  // draft back or sends it.
  openReport: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('openReport');
    if ('about' in msg) {
      if (!fromExtensionPage(sender)) deny('openReport');
      return openReport({ about: msg.about }, sender);
    }
    return openReport({ draft: msg.draft, notice: msg.notice, nextTo: msg.nextTo }, sender);
  },
  reportDraft: async (msg, sender) => {
    if (!fromReportPage(sender)) deny('reportDraft');
    return { report: await reportDraft(String(msg.id)) };
  },
  sendReport: async (msg, sender) => {
    if (!fromReportPage(sender)) deny('sendReport');
    if (typeof msg.body !== 'string') return { ok: false, code: 'refused' };
    return sendReport(String(msg.id), msg.body);
  },
  snoozeNotice: async (msg, sender) => {
    if (!fromOwnUi(sender)) deny('snoozeNotice');
    await snoozeNotice(msg);
    return { ok: true };
  },
};

/**
 * Put unAlgorithm on LinkedIn and Facebook tabs that were already open when it was installed. A tab that loaded while
 * the extension installed already has the manifest's copy, so it gets none: a second copy would stop the first.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const scripts: Record<string, string> = {
    'www.linkedin.com': '/content-scripts/linkedin.js',
    'www.facebook.com': '/content-scripts/facebook.js',
  };
  const tabs = await browser.tabs.query({ url: FEED_TAB_URLS });
  for (const tab of tabs) {
    try {
      const host = new URL(tab.url ?? '').hostname;
      const file = scripts[host];
      // Paths come from the build output; facebook.js exists once the Facebook script is built.
      if (tab.id === undefined || !file) continue;
      const [running] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (key: string) => key in globalThis,
        args: [CONTENT_STARTED],
      });
      if (running?.result !== true) await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [file as never] });
    } catch {
      // The script for that site may not exist yet, or the tab is discarded: it loads on the next visit.
    }
  }
}

export default defineBackground(() => {
  // Settings an older version stored: stored again at this version, with clocks for what the upgrade changed.
  void upgradeStoredSettings().catch((err: unknown) => console.warn('[unAlgorithm] settings upgrade', err));
  initSync();
  syncServerOffer();
  // unAlgorithm Cloud's source list, while UnEcho Chamber is on: at most daily, anonymous (D98).
  startOfficialListUpdates();
  browser.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
    const handler = handlers[msg?.type] as unknown as ((m: BgRequest, s: Sender) => Promise<unknown>) | undefined;
    if (!handler) return false;
    // Firefox: the event page stays up until the answer is sent, however long the AI or the server takes.
    keepAwake(handler(msg, sender))
      .then(sendResponse)
      .catch((err: unknown) => {
        console.warn('[unAlgorithm]', msg.type, err);
        sendResponse({ __uaError: err instanceof Error ? err.message : String(err) } satisfies BgFailure);
      });
    return true;
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      await openPage('onboarding');
      // Firefox puts the content scripts on open tabs itself (and its manifest has no `scripting`).
      if (browserKind() !== 'firefox') await injectIntoOpenTabs();
    }
  });

  // Firefox: consent to send given again (Settings, or Firefox's add-on settings) lifts the pause it caused in the feed.
  if (browserKind() === 'firefox') {
    browser.permissions.onAdded.addListener((added) => {
      if (added.data_collection?.length) void resumeFeedTabs();
    });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    void forgetTab(tabId);
    // A closed report page forgets its draft.
    void forgetReportTab(tabId).catch(() => undefined);
  });
  // A popup is the toolbar action; the side panel ("Highlights") opens from it.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});
