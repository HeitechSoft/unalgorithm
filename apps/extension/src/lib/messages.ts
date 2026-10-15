import type { AISourceConfig, FilterKey, HealthReport, PersonRule, Preset, TabState, Topic } from '@unalgorithm/core';
import type {
  AccountDevice,
  AIErrorCode,
  Classification,
  NoiseLabel,
  PlatformId,
  PostForAI,
  PostKey,
  ServerInfo,
} from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import type { PublicBalance } from '../background/server-balance.ts';
import type { ServerLabel } from './server-label.ts';
import type { SyncProblem } from './storage.ts';

/** A post to classify: its local key and exactly what the AI may see (no names, no URLs). */
export interface ClassifyItem {
  key: PostKey;
  input: Omit<PostForAI, 'ref'>;
}

export type ClassifyItemResult =
  | { key: PostKey; status: 'ok'; classification: Classification; model: string; cached: boolean }
  | { key: PostKey; status: 'skipped'; reason: 'cap-reached' | 'ai-off' | 'declined' | 'not-public' | 'paused' }
  | { key: PostKey; status: 'failed'; code: AIErrorCode; message: string; retryable: boolean };

export interface BgError {
  code: AIErrorCode;
  message: string;
}

/** Settings changes the in-feed UI can make, each with an inverse for Undo. */
export type SettingsAction =
  | { op: 'setFilter'; platform: PlatformId; key: FilterKey; value: boolean }
  | { op: 'setNoise'; platform: PlatformId; label: NoiseLabel; value: boolean }
  | { op: 'setLowRelevance'; platform: PlatformId; value: boolean }
  | { op: 'addPersonRule'; platform: PlatformId; list: 'alwaysShow' | 'alwaysHide'; id: string; rule: PersonRule }
  | { op: 'removePersonRule'; platform: PlatformId; list: 'alwaysShow' | 'alwaysHide'; id: string }
  | { op: 'addTopic'; list: 'more' | 'less'; id: string; topic: Topic }
  | { op: 'removeTopic'; list: 'more' | 'less'; id: string }
  | { op: 'setPreset'; platform: PlatformId; preset: Preset }
  | { op: 'setPlatformEnabled'; platform: PlatformId; value: boolean };

export interface AiStatus {
  configured: boolean;
  kind: AISourceConfig['kind'] | null;
  label: string;
  model?: string;
  state: 'off' | 'ready' | 'needs-attention';
  message?: string;
  postsToday: number;
  dailyCap: number;
  capApplies: boolean;
  costTodayMicros?: number;
  /** The server account's credit balance, only for a server that advertises billing (CL2-10). Extension pages only. */
  balance?: PublicBalance;
}

export type TestSourceResult =
  | { ok: true; model: string; mode: string; latencyMs: number; models: string[] }
  | { ok: false; error: BgError };

/** The server account as extension pages see it: no tokens and no device id, which stay in the background. */
export interface PublicServerAccount {
  origin: string;
  email: string;
  signedInAt: number;
  needsSignIn: boolean;
  label: ServerLabel;
  /** Present (true) when the server's discovery advertises billing, so `aiStatus` reports a balance once signed in. */
  billing?: boolean;
}

/** Settings sync as the server card shows it (CL3-20). */
export interface SyncStatus {
  /** Signed in to a server (whether it offers sync is learned when turning sync on). */
  available: boolean;
  enabled: boolean;
  state: 'off' | 'syncing' | 'ok' | 'problem';
  lastSyncAt: number | null;
  problem?: SyncProblem;
  /** Plain text for `problem`, naming the server by `serverLabel(origin).title`. */
  message?: string;
}

export type BgRequest =
  /** `cacheOnly`: AI is paused, so only the cache answers (nothing is sent, nothing is metered). */
  | { type: 'classify'; platform: PlatformId; items: ClassifyItem[]; cacheOnly?: boolean }
  | { type: 'tabState'; patch: Partial<TabState> }
  | {
      type: 'vote';
      key: PostKey;
      verdict: 'more' | 'less' | null;
      topics: string[];
      summary?: string;
      /** Whether a server may receive the rated post, and so its summary (R23). */
      shareable?: boolean;
    }
  | { type: 'settingsAction'; action: SettingsAction }
  | { type: 'pause'; platform: PlatformId; until: number | 'manual' | null }
  | { type: 'coachMarkShown'; platform: PlatformId }
  | { type: 'openPage'; page: 'options' | 'onboarding'; hash?: string }
  | { type: 'aiStatus' }
  | { type: 'testSource'; config: AISourceConfig; apiKey?: string }
  | { type: 'listModels'; config: AISourceConfig }
  | { type: 'saveSource'; config: AISourceConfig | null; apiKey?: string }
  | { type: 'clearData'; what: 'cache' | 'learned' | 'stats' | 'all' }
  | { type: 'onDeviceStatus' }
  | { type: 'forgetKey'; config: AISourceConfig }
  | { type: 'serverDiscover'; baseUrl: string }
  | { type: 'serverSignIn'; baseUrl: string }
  | { type: 'serverSignOut' }
  | { type: 'serverAccount' }
  /** The account's devices (R11); ids and names only, no credentials. */
  | { type: 'serverDevices' }
  /** Signs a device out on the server; this computer's own id is the sign-out. */
  | { type: 'serverRevokeDevice'; deviceId: string }
  | { type: 'syncStatus' }
  | { type: 'syncSetEnabled'; enabled: boolean }
  | { type: 'syncNow' };

export interface BgResponses {
  classify: { results: ClassifyItemResult[]; pause?: BgError };
  tabState: { ok: true };
  vote: { ok: true };
  settingsAction: { ok: true; undo: SettingsAction | null };
  pause: { ok: true };
  coachMarkShown: { ok: true };
  openPage: { ok: true };
  aiStatus: AiStatus;
  testSource: TestSourceResult;
  listModels: { ok: true; models: string[] } | { ok: false; error: BgError };
  saveSource: { ok: true } | { ok: false; error: BgError };
  clearData: { ok: true };
  onDeviceStatus: { availability: 'no-api' | 'unavailable' | 'downloadable' | 'downloading' | 'available' };
  forgetKey: { ok: true };
  serverDiscover: { ok: true; origin: string; label: ServerLabel; info: ServerInfo } | { ok: false; error: BgError };
  serverSignIn: { ok: true; account: PublicServerAccount } | { ok: false; error: BgError };
  serverSignOut: { ok: true };
  serverAccount: { account: PublicServerAccount | null };
  serverDevices: { ok: true; devices: AccountDevice[] } | { ok: false; error: BgError };
  /** `signedOut`: the device was this computer, which is now signed out. */
  serverRevokeDevice: { ok: true; signedOut: boolean } | { ok: false; error: BgError };
  syncStatus: SyncStatus;
  syncSetEnabled: SyncStatus;
  syncNow: SyncStatus;
}

/** How the background reports a failed handler (an `undefined` reply would look like success). */
export interface BgFailure {
  __uaError: string;
}

/**
 * Sends a request to the background and resolves with its reply. Rejects when the handler failed or the extension
 * context is gone (after a reload, a stale content script's runtime throws synchronously); callers handle rejections.
 */
export async function sendToBackground<T extends BgRequest['type']>(
  msg: Extract<BgRequest, { type: T }>,
): Promise<BgResponses[T]> {
  const res = (await browser.runtime.sendMessage(msg)) as BgResponses[T] | BgFailure | undefined;
  if (res && typeof res === 'object' && '__uaError' in res) throw new Error(res.__uaError);
  if (res === undefined) throw new Error(`No reply to ${msg.type}`);
  return res;
}

/** For requests nobody waits on (opening a page, a preset change): a failure is logged, never unhandled. */
export function sendQuietly<T extends BgRequest['type']>(msg: Extract<BgRequest, { type: T }>): void {
  sendToBackground(msg).catch((err: unknown) => console.debug('[UnAlgorithm]', msg.type, err));
}

// ---------- extension pages -> content script ----------

export type ContentRequest =
  | { type: 'ping' }
  | { type: 'scrollTo'; key: PostKey }
  | { type: 'peek'; on: boolean }
  | { type: 'reveal'; key: PostKey }
  | { type: 'diagnostics' }
  /** The prefilled "Filtering looks wrong" issue URL for this page (content-free diagnostics only). */
  | { type: 'reportUrl' }
  /** The person signed in to the server again: try AI again (the device in storage may not have changed). */
  | { type: 'aiResume' };

export interface Diagnostics {
  adapter: string;
  extension: string;
  browser: string;
  lang: string;
  pageKind: string;
  health: HealthReport;
  counts: Record<string, number>;
  detectors: Record<string, number>;
  landmarks: Record<string, number>;
}

export interface ContentResponses {
  ping: { ok: true; onFeed: boolean; platform: PlatformId };
  scrollTo: { ok: boolean };
  peek: { ok: true };
  reveal: { ok: boolean };
  diagnostics: Diagnostics;
  reportUrl: { url: string };
  aiResume: { ok: true };
}

export async function sendToTab<T extends ContentRequest['type']>(
  tabId: number,
  msg: Extract<ContentRequest, { type: T }>,
): Promise<ContentResponses[T] | undefined> {
  try {
    return (await browser.tabs.sendMessage(tabId, msg)) as ContentResponses[T];
  } catch {
    return undefined; // no content script in that tab
  }
}
