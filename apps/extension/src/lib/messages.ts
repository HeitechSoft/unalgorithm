import type {
  AISourceConfig,
  FilterKey,
  HealthReport,
  PersonRule,
  PostCharge,
  Preset,
  TabState,
  Topic,
  WebSearchProviderId,
} from '@unalgorithm/core';
import type {
  AccountDevice,
  AIErrorCode,
  Classification,
  FactcheckResult,
  NoiseLabel,
  NoticeKind,
  PerspectivesJobRequest,
  PerspectivesResult,
  PlatformId,
  PostForAI,
  PostKey,
  ReportSendFailure,
  ServerInfo,
  SharedLink,
} from '@unalgorithm/protocol';
import { browser } from 'wxt/browser';
import type { PublicBalance } from '../background/server-balance.ts';
import type { ServerLabel } from './server-label.ts';
import type { ReportDraft, SyncProblem } from './storage.ts';

/** A post to classify: its local key and exactly what the AI may see (no names, no URLs). */
export interface ClassifyItem {
  key: PostKey;
  input: Omit<PostForAI, 'ref'>;
}

export type ClassifyItemResult =
  | { key: PostKey; status: 'ok'; classification: Classification; model: string; cached: boolean; charge?: PostCharge }
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

/**
 * A report draft as a content script or the side panel builds it (ADR 0009 §2): the background adds the version, the
 * id and `env`, checks it against the schema and keeps it for the report page. Never sent anywhere from here.
 */
export type ReportDraftInput = Omit<ReportDraft, 'v' | 'id' | 'env'>;

/**
 * A report page about no page facts: the popup on a tab whose content script didn't answer (`popup-no-script`, or
 * `popup` with no answer to its snapshot) or off LinkedIn and Facebook (`platform` null), and Settings, where the page
 * asks what it's about. The background builds these drafts itself; `tabId` is the tab the popup was looking at.
 */
export type ReportAbout =
  | { from: 'popup' | 'popup-no-script'; platform: PlatformId | null; tabId: number | null }
  | { from: 'settings' };

/**
 * Why a send didn't go through: the server's answers, and the extension's own: `consent` (Firefox's technical data is
 * off), `limit` (this browser's own limits) and `expired` (the draft is gone).
 */
export type ReportSendCode = ReportSendFailure | 'consent' | 'limit' | 'expired';
export type ReportSendResult = { ok: true; ref: string } | { ok: false; code: ReportSendCode; retryAfterSec?: number };

/** What the report page reads for its draft: the report minus the person's answers, and where it stands. */
export interface ReportPageData {
  /** One draft, or, from Settings, three (LinkedIn, Facebook, something else) for the page's first question. */
  drafts: ReportDraft[];
  state: 'open' | 'sent';
  ref?: string;
  /** The feed tab the report came from, for *Back to LinkedIn*; absent from Settings and the side panel. */
  opener?: { tabId: number; site: PlatformId };
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
  /** The person's own Brave or Tavily key for an OpenAI-compatible source (P3-45), tested with one fixed search. */
  | { type: 'saveSearchKey'; provider: WebSearchProviderId; apiKey: string }
  | { type: 'forgetSearchKey' }
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
  | { type: 'syncNow' }
  /** Fact-check one public post on the person's own Anthropic key. Opens the side panel for the tab. */
  | { type: 'factcheck'; key: PostKey; input: Omit<PostForAI, 'ref'> }
  /** Opens the side panel for the sending feed tab, where the newest check shows (Firefox: says whether it is open). */
  | { type: 'openFactcheck' }
  /**
   * A feed tab paused for want of credit became visible: the background refreshes an empty balance at most every 30 s,
   * and a restored one reaches every feed tab as `aiResume`. The reply carries no balance.
   */
  | { type: 'balanceCheck' }
  /**
   * UnEcho Chamber for one public post's shared link. Only the link (URL and link-card title) leaves the
   * browser, never post text. Opens the side panel for the tab.
   */
  | {
      type: 'perspectives';
      key: PostKey;
      link: SharedLink;
      platform: PlatformId;
      audience?: PerspectivesJobRequest['audience'];
    }
  /**
   * Opens the report page (ADR 0009 §2) with a draft: from a feed tab's content script (detection, wrong call; `notice`
   * is the in-feed card it came from) or the side panel (a correction). `nextTo`: the tab to open it beside when the
   * sender has none (the side panel). Nothing is sent from here.
   */
  | { type: 'openReport'; draft: ReportDraftInput; notice?: NoticeKind; nextTo?: number }
  /** Opens the report page about no page facts (`ReportAbout`): the popup without an answering tab, and Settings. */
  | { type: 'openReport'; about: ReportAbout }
  /** The report page's draft, by the id in its address. From report.html only. */
  | { type: 'reportDraft'; id: string }
  /**
   * The report page's *Send report*: the exact body it showed. From report.html only; the background checks it against
   * the draft and sends it, once.
   */
  | { type: 'sendReport'; id: string; body: string }
  /** Keeps an in-feed notice card away on this platform for `ms` (`device.notices`), under this adapter version. */
  | { type: 'snoozeNotice'; platform: PlatformId; kind: NoticeKind; ms: number; adapter: string };

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
  saveSearchKey: { ok: true } | { ok: false; error: BgError };
  forgetSearchKey: { ok: true };
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
  factcheck: { ok: true; result: FactcheckResult; costMicros?: number } | { ok: false; error: BgError };
  /**
   * False when the side panel didn't open: Chrome or Edge refused (no user gesture reached it), or Firefox's sidebar
   * isn't open in the tab's window. `shortcut`: Firefox's keyboard shortcut for the sidebar, when it has one.
   */
  openFactcheck: { ok: boolean; shortcut?: string };
  balanceCheck: { ok: true };
  perspectives: { ok: true; result: PerspectivesResult; costMicros?: number } | { ok: false; error: BgError };
  /** False when the draft was refused (not a report this version can make). */
  openReport: { ok: boolean };
  /** Null once the draft has expired, its tab closed, or everything was erased. */
  reportDraft: { report: ReportPageData | null };
  sendReport: ReportSendResult;
  snoozeNotice: { ok: true };
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
  sendToBackground(msg).catch((err: unknown) => console.debug('[unAlgorithm]', msg.type, err));
}

// ---------- extension pages -> content script ----------

export type ContentRequest =
  | { type: 'ping' }
  | { type: 'scrollTo'; key: PostKey }
  | { type: 'peek'; on: boolean }
  | { type: 'reveal'; key: PostKey }
  | { type: 'diagnostics' }
  /**
   * The popup's *Report a problem* (`popup`), its banner's *Let us know* (`popup-banner`) or the side panel's
   * (`sidepanel`): the content script builds a draft of this page as it is now and opens the report page. False when it
   * couldn't.
   */
  | { type: 'reportSnapshot'; from: 'popup' | 'popup-banner' | 'sidepanel' }
  /** A report about this tab was sent (from the background): its in-feed card goes away for a while. */
  | { type: 'reportSent'; kind?: NoticeKind }
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
  hiddenBy?: Record<string, number>;
  observations?: Record<string, number>;
  errors?: Record<string, number>;
  strategy?: string;
}

export interface ContentResponses {
  ping: { ok: true; onFeed: boolean; platform: PlatformId };
  scrollTo: { ok: boolean };
  peek: { ok: true };
  reveal: { ok: boolean };
  diagnostics: Diagnostics;
  reportSnapshot: { ok: boolean };
  reportSent: { ok: true };
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
