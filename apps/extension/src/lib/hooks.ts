import { type Device, emptyTabState, migrateDevice, migrateSettings, type Settings, type TabState } from '@unalgorithm/core';
import { uuid } from '@unalgorithm/protocol';
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { WxtStorageItem } from 'wxt/utils/storage';
import { browserKind } from './browser-kind.ts';
import { type DataCollection, hasConsent } from './data-consent.ts';
import { type AiStatus, sendToBackground } from './messages.ts';
import { updateDevice, updateSettings } from './settings-store.ts';
import { deviceItem, settingsItem, syncStateItem, tabStateItem } from './storage.ts';

/** Subscribe to one storage item. */
export function useStorageItem<T>(item: WxtStorageItem<T, Record<string, unknown>>, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe once per item; a new fallback object must not resubscribe
  useEffect(() => {
    let alive = true;
    void item.getValue().then((v) => alive && setValue(v ?? fallback));
    const unwatch = item.watch((v) => setValue(v ?? fallback));
    return () => {
      alive = false;
      unwatch();
    };
  }, [item]);
  return value;
}

/** Live settings plus a saver. Changes apply instantly everywhere (no Save button). */
export function useSettings(): [Settings | undefined, (mutate: (s: Settings) => Settings | void) => Promise<void>] {
  const [settings, setSettings] = useState<Settings>();
  useEffect(() => {
    void settingsItem.getValue().then((raw) => setSettings(migrateSettings(raw)));
    return settingsItem.watch((raw) => setSettings(migrateSettings(raw)));
  }, []);
  const save = useCallback(async (mutate: (s: Settings) => Settings | void) => {
    setSettings(await updateSettings(mutate));
  }, []);
  return [settings, save];
}

export function useDevice(): [Device | undefined, (mutate: (d: Device) => Device | void) => Promise<void>] {
  const [device, setDevice] = useState<Device>();
  useEffect(() => {
    void deviceItem.getValue().then((raw) => setDevice(migrateDevice(raw, uuid)));
    return deviceItem.watch((raw) => setDevice(migrateDevice(raw, uuid)));
  }, []);
  const save = useCallback(async (mutate: (d: Device) => Device | void) => {
    setDevice(await updateDevice(mutate));
  }, []);
  return [device, save];
}

export interface ActiveTab {
  id: number;
  url: string;
  windowId: number;
}

/**
 * The tab the popup or side panel is looking at: the active tab of its own window, following tab switches and
 * navigation there. Every window has its own side panel (Chrome, Edge) or sidebar (Firefox), so a panel never shows
 * the tab of another window, even the focused one.
 */
export function useActiveTab(): ActiveTab | undefined {
  const [tab, setTab] = useState<ActiveTab>();
  useEffect(() => {
    let alive = true;
    /** This page's window, once known. */
    let windowId: number | undefined;
    const own = browser.windows.getCurrent().then(
      (w) => (windowId = w?.id),
      () => undefined,
    );
    const refresh = async () => {
      const id = await own;
      const [t] = await browser.tabs.query(
        id === undefined ? { active: true, currentWindow: true } : { active: true, windowId: id },
      );
      if (alive && t?.id !== undefined) setTab({ id: t.id, url: t.url ?? '', windowId: t.windowId });
    };
    /** Events from another window are for its own panel. Before the window is known, every event refreshes. */
    const mine = (id: number | undefined) => windowId === undefined || id === windowId;
    void refresh().catch(() => undefined);
    const onActivated = (info: { windowId: number }) => {
      if (mine(info.windowId)) void refresh().catch(() => undefined);
    };
    const onUpdated = (_id: number, info: { url?: string; status?: string }, changed?: { windowId?: number }) => {
      if ((info.url || info.status === 'complete') && mine(changed?.windowId)) void refresh().catch(() => undefined);
    };
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => {
      alive = false;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);
  return tab;
}

/**
 * Whether the person agreed to send `types` (Firefox's data-collection consent, ADR 0008), following changes made in
 * Firefox's add-on settings while the page is open. Always true in Chrome and Edge; undefined until known.
 */
export function useConsent(types: readonly DataCollection[]): boolean | undefined {
  const [granted, setGranted] = useState<boolean>();
  const key = types.join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the types, a new array on every render
  useEffect(() => {
    let alive = true;
    const check = () => void hasConsent(types).then((ok) => alive && setGranted(ok));
    check();
    const firefox = browserKind() === 'firefox';
    if (firefox) {
      browser.permissions.onAdded.addListener(check);
      browser.permissions.onRemoved.addListener(check);
    }
    return () => {
      alive = false;
      if (firefox) {
        browser.permissions.onAdded.removeListener(check);
        browser.permissions.onRemoved.removeListener(check);
      }
    };
  }, [key]);
  return granted;
}

export function useTabState(tabId: number | undefined): TabState {
  const [state, setState] = useState<TabState>(emptyTabState());
  useEffect(() => {
    if (tabId === undefined) return;
    const item = tabStateItem(tabId);
    void item.getValue().then(setState);
    return item.watch((v) => setState(v ?? emptyTabState()));
  }, [tabId]);
  return state;
}

/** AI source status from the background. Pass a key (e.g. the source config as JSON) to refresh when it changes. */
export function useAiStatus(refreshKey: string | undefined = undefined): AiStatus | undefined {
  const [status, setStatus] = useState<AiStatus>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the trigger, not a value used inside
  useEffect(() => {
    let alive = true;
    void sendToBackground({ type: 'aiStatus' })
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return status;
}

/**
 * The name of the server settings sync with while sync is on (CL3-22), following every change to the sync state; null
 * when sync is off, nobody is signed in or the background doesn't answer. With `active` false nothing is sent.
 */
export function useSyncedServer(active: boolean): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const refresh = () =>
      void Promise.all([sendToBackground({ type: 'syncStatus' }), sendToBackground({ type: 'serverAccount' })])
        .then(([status, { account }]) => alive && setTitle(status.enabled && account ? account.label.title : null))
        .catch(() => alive && setTitle(null));
    refresh();
    const unwatch = syncStateItem.watch(refresh);
    return () => {
      alive = false;
      unwatch();
    };
  }, [active]);
  return title;
}

export function platformOfUrl(url: string): 'linkedin' | 'facebook' | null {
  try {
    const host = new URL(url).hostname;
    const on = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (on('linkedin.com')) return 'linkedin';
    if (on('facebook.com')) return 'facebook';
  } catch {
    // not a URL
  }
  return null;
}

export const FEED_URLS = { linkedin: 'https://www.linkedin.com/feed/', facebook: 'https://www.facebook.com/' } as const;
