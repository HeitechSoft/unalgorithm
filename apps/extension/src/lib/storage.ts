import {
  type Device,
  EMPTY_LEARNED,
  emptyTabState,
  type LearnedPrefs,
  migrateDevice,
  migrateSettings,
  type ServerOffer,
  type Settings,
  type SettingsClocks,
  type TabState,
  type UsageLedger,
} from '@unalgorithm/core';
import { type FactcheckResult, type OfficialList, type PerspectivesResult, type PostKey, uuid } from '@unalgorithm/protocol';
import { storage } from 'wxt/utils/storage';
import type { BgError } from './messages.ts';

/**
 * Every storage key unAlgorithm uses. `local:settings` and its clocks are the only data sync reads; `local:syncState`
 * is this device's own bookkeeping and never leaves it. Device state, usage, learned preferences and caches stay on
 * this machine. API keys are not here at all: they live in the extension's own IndexedDB (see background/idb.ts),
 * which content scripts cannot read.
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

/**
 * What the signed-in server offers (fact-check, and its price on a billing server), derived from its discovery
 * document. Written only by the background; content scripts may read it because it holds nothing personal (no email,
 * device id or token). Null without an account or while it needs signing in again.
 */
export const serverOfferItem = storage.defineItem<ServerOffer | null>('local:serverOffer', { fallback: null });

/** unAlgorithm Cloud's published source list, the last copy that passed validation, and when it was last asked for. */
export interface StoredOfficialList {
  list: OfficialList | null;
  /** Epoch ms of the last request, answered or not: the daily limit counts from here. */
  checkedAt: number;
}
/**
 * Written only by the background (`background/official-list.ts`); public data, never synced or exported. Content scripts
 * can write `storage.local` too (ADR 0005), so readers take the list only through `storedOfficialList()`.
 */
export const officialListItem = storage.defineItem<StoredOfficialList>('local:officialList', {
  fallback: { list: null, checkedAt: 0 },
});

/**
 * Why the last sync run failed: a code only, never the server's message. `consent`: Firefox's consent to send the
 * settings to the server is missing (ADR 0008).
 */
export type SyncProblem = 'auth' | 'network' | 'quota' | 'clock' | 'server' | 'unavailable' | 'consent';

/** Sync bookkeeping for one server and one account (CL3-19, CL3-20). */
export interface SyncState {
  /** The person turned sync on for this account (CL3-20). */
  enabled: boolean;
  /** The server this state (and its consent) belongs to. */
  origin: string | null;
  /** The account on that server. */
  email: string | null;
  spaceId: string | null;
  epoch: string | null;
  cursor: number;
  /** Item key → the HLC the server is known to hold (pulled, or pushed and applied). */
  known: Record<string, string>;
  lastSyncAt: number | null;
  problem: SyncProblem | null;
  /** Set by CL3-20 when the person turns sync on; while set, the pull lets the server's copy win. */
  firstPull: boolean;
  /**
   * While a resync after `410 resync-required` is under way: the item keys the server held before it started over
   * (`known` then). Kept until the download from 0 is applied, so a resync cut short still drops entries deleted
   * elsewhere on the next run, and an entry that never reached the server is never taken for one.
   */
  resyncKnown: string[] | null;
}
export const DEFAULT_SYNC_STATE: SyncState = {
  enabled: false,
  origin: null,
  email: null,
  spaceId: null,
  epoch: null,
  cursor: 0,
  known: {},
  lastSyncAt: null,
  problem: null,
  firstPull: false,
  resyncKnown: null,
};
export const syncStateItem = storage.defineItem<SyncState>('local:syncState', { fallback: DEFAULT_SYNC_STATE });

/** Dynamic declarativeNetRequest rule that lets a local AI server (Ollama) accept our requests. See ADR 0004. */
export const ORIGIN_RULE_ID = 1;

export function tabStateItem(tabId: number) {
  return storage.defineItem<TabState>(`session:tab:${tabId}`, { fallback: emptyTabState() });
}

/** One fact-check of a post on this tab. Session storage only: gone when the browser closes, never synced. */
/** A fact-check or an UnEcho Chamber comparison, kept for the side panel. */
export interface FactcheckEntry {
  key: PostKey;
  /** Absent: a fact-check (entries stored before RM3 read as before). */
  task?: 'perspectives';
  /**
   * For the sheet's header, display only. A fact-check: the post text's first 80 characters. A comparison: the link
   * title clipped to 80, else the link's host (never post text).
   */
  label: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed';
  result?: FactcheckResult;
  /** A comparison's result (`task: 'perspectives'`). */
  perspectives?: PerspectivesResult;
  /**
   * A comparison's source list balance warnings as they were when it started (`listBalance(list).warnings`): fixed words
   * from code, never post content. The sheet shows them above its footer (D104).
   */
  listWarnings?: string[];
  error?: BgError;
  costMicros?: number;
  /** What the server charged for this check (a billing server only). */
  chargedMicros?: number;
}

/** A tab's fact-checks and comparisons, newest first (at most 5). Removed when the tab closes. */
export const factcheckItem = (tabId: number) =>
  storage.defineItem<{ entries: FactcheckEntry[] }>(`session:factcheck:${tabId}`, { fallback: { entries: [] } });

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

/** `cb` gets the device as changed and as it was before (null when there was none). */
export function watchDevice(cb: (d: Device, previous: Device | null) => void): () => void {
  return deviceItem.watch((raw, oldRaw) => cb(migrateDevice(raw, uuid), oldRaw == null ? null : migrateDevice(oldRaw, uuid)));
}
