import { ServerInfoSchema } from '@unalgorithm/protocol';
import { type Browser, browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
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
import { recordVote } from '../background/feedback.ts';
import { clearSecrets } from '../background/idb.ts';
import { discoverServer, type ServerAccount, serverAccountItem, signIn, signOut } from '../background/server-auth.ts';
import { applySettingsAction } from '../background/settings-actions.ts';
import { forgetTab, mergeTabState } from '../background/tabs.ts';
import { type BgFailure, type BgRequest, type BgResponses, type PublicServerAccount, sendToTab } from '../lib/messages.ts';
import { isServerAt, serverLabel } from '../lib/server-label.ts';
import { updateDevice } from '../lib/settings-store.ts';
import { learnedItem, readDevice, statsItem, usageItem, votesItem } from '../lib/storage.ts';

const FEED_HOSTS = ['www.linkedin.com', 'www.facebook.com'];
const FEED_TAB_URLS = ['https://www.linkedin.com/*', 'https://www.facebook.com/*'];

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
  };
}

/**
 * Open feed tabs try AI again after a sign-in. A new source reaches them through their device watch, but signing in
 * again to the server that is already the source writes an identical device, which the watch never reports, and those
 * tabs would stay paused on "Sign in to … again". The message carries nothing; tabs without UnAlgorithm are skipped.
 */
async function resumeFeedTabs(): Promise<void> {
  const tabs = await browser.tabs.query({ url: FEED_TAB_URLS }).catch(() => []);
  await Promise.all(tabs.map((tab) => (tab.id === undefined ? undefined : sendToTab(tab.id, { type: 'aiResume' }))));
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
    if (!fromOwnUi(sender)) deny('aiStatus');
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
      // Ending the device on the server needs its refresh token, which `clearSecrets` deletes, so this goes first. A
      // failed sign-out doesn't stop the erase: the account itself is removed below either way.
      try {
        const account = await serverAccountItem.getValue();
        if (account) await signOut(account.origin);
      } catch (err) {
        console.debug('[UnAlgorithm] server sign-out failed', err);
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
        // Per-tab Highlights (author names, snippets, links) live in session storage until the tab closes.
        () => browser.storage.session.clear(),
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
  serverDiscover: async (msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverDiscover');
    const found = await discoverServer(msg.baseUrl);
    return found.ok ? { ...found, label: serverLabel(found.origin, found.info) } : found;
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
    if (!account) return { ok: true };
    // AI turns off rather than staying on a source that can only fail with "Sign in again"; rules keep working. Off
    // first, so feed tabs stop sending posts before the device's tokens go.
    if (isServerAt((await readDevice()).aiSource, account.origin)) await saveSource(null);
    await signOut(account.origin);
    return { ok: true };
  },
  serverAccount: async (_msg, sender) => {
    if (!fromExtensionPage(sender)) deny('serverAccount');
    const account = await serverAccountItem.getValue();
    return { account: account ? publicAccount(account) : null };
  },
};

/** Put UnAlgorithm on LinkedIn and Facebook tabs that were already open when it was installed. */
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
      if (tab.id !== undefined && file)
        await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [file as never] });
    } catch {
      // The script for that site may not exist yet, or the tab is discarded: it loads on the next visit.
    }
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
    const handler = handlers[msg?.type] as unknown as ((m: BgRequest, s: Sender) => Promise<unknown>) | undefined;
    if (!handler) return false;
    handler(msg, sender)
      .then(sendResponse)
      .catch((err: unknown) => {
        console.warn('[UnAlgorithm]', msg.type, err);
        sendResponse({ __uaError: err instanceof Error ? err.message : String(err) } satisfies BgFailure);
      });
    return true;
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    if (reason === 'install') {
      await openPage('onboarding');
      await injectIntoOpenTabs();
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));
  // A popup is the toolbar action; the side panel ("Highlights") opens from it.
  void browser.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});
