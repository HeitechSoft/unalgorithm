import {
  type Device,
  EMPTY_LEARNED,
  emptyTabState,
  type LearnedPrefs,
  migrateDevice,
  migrateSettings,
  type Settings,
  type SettingsClocks,
  type TabState,
  type UsageLedger,
} from '@unalgorithm/core';
import { uuid } from '@unalgorithm/protocol';
import { storage } from 'wxt/utils/storage';

/**
 * Every storage key UnAlgorithm uses. `local:settings` (+ its field clocks) is the only thing Phase 2 will sync.
 * Device state, usage, learned preferences and caches stay on this machine. API keys are not here at all: they
 * live in the extension's own IndexedDB (see background/idb.ts), which content scripts cannot read.
 */
export const settingsItem = storage.defineItem<unknown>('local:settings');
export const settingsClocksItem = storage.defineItem<SettingsClocks>('local:settingsClocks', { fallback: {} });
export const lastHlcItem = storage.defineItem<string | null>('local:lastHlc', { fallback: null });
export const deviceItem = storage.defineItem<unknown>('local:device');
export const learnedItem = storage.defineItem<LearnedPrefs>('local:learned', { fallback: EMPTY_LEARNED });
/** postKey → the user's vote on that post, newest last; capped. */
export const votesItem = storage.defineItem<Record<string, 'more' | 'less'>>('local:votes', { fallback: {} });
export const usageItem = storage.defineItem<UsageLedger>('local:usage', { fallback: {} });
/** Running totals for the popup ("412 today"). */
export const statsItem = storage.defineItem<Record<string, { hidden: number; seen: number }>>('local:stats', {
  fallback: {},
});
/** The local date (`dateKey()`) the popup last showed the low-balance banner: a date only, no amount. */
export const lowBalanceNoticeItem = storage.defineItem<string | null>('local:lowBalanceNoticeOn', { fallback: null });

/** Dynamic declarativeNetRequest rule that lets a local AI server (Ollama) accept our requests. See ADR 0004. */
export const ORIGIN_RULE_ID = 1;

export function tabStateItem(tabId: number) {
  return storage.defineItem<TabState>(`session:tab:${tabId}`, { fallback: emptyTabState() });
}

export async function readSettings(): Promise<Settings> {
  return migrateSettings(await settingsItem.getValue());
}

export async function readDevice(): Promise<Device> {
  const raw = await deviceItem.getValue();
  const device = migrateDevice(raw, uuid);
  if (!raw || (raw as { deviceId?: string }).deviceId !== device.deviceId) await deviceItem.setValue(device);
  return device;
}

export function watchSettings(cb: (s: Settings) => void): () => void {
  return settingsItem.watch((raw) => cb(migrateSettings(raw)));
}

export function watchDevice(cb: (d: Device) => void): () => void {
  return deviceItem.watch((raw) => cb(migrateDevice(raw, uuid)));
}
