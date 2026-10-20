import {
  type Audience,
  authorKey,
  type Decision,
  type Device,
  decide,
  evaluateHealth,
  type FilterDecision,
  type FilterKey,
  factcheckOffered,
  HEALTHY,
  type HealthReport,
  type HealthSample,
  type HiddenItem,
  type HighlightItem,
  type ItemFacts,
  isPaused,
  jobPriceLabel,
  type LearnedPrefs,
  type ModuleInfo,
  multiPostCount,
  NOT_NOW_SNOOZE_MS,
  type NoticePrefs,
  noticeIssues,
  noticeKinds,
  noticeVisible,
  type PostCharge,
  type PostData,
  type PostSignals,
  perspectivesOffered,
  postFacts,
  presetOf,
  REPORT_SNOOZE_MS,
  reasonKey,
  reasonLabel,
  type ScrollWatch,
  type ServerOffer,
  type Settings,
  snippet,
  summarizePostForReport,
  type TabState,
  tallyIds,
  toPostForAI,
  VisibleClock,
  watchFrom,
} from '@unalgorithm/core';
import { listBalance } from '@unalgorithm/outlets';
import {
  type DiscoveryState,
  type InspectContext,
  type InspectResult,
  MAX_FRUITLESS,
  type PlatformAdapter,
  rearmMarker,
  shouldRearm,
} from '@unalgorithm/platforms';
import {
  BLOCKING_AI_ERRORS,
  type Classification,
  type COUNT_KEYS,
  type ErrorOp,
  NOTICE_KINDS,
  type NoticeKind,
  type PlatformId,
  type PostForAI,
  type PostKey,
  type ReportFrom,
  type ReportPost,
  type SharedLink,
  serverMayReceive,
  uuidv7,
} from '@unalgorithm/protocol';
import {
  type FactcheckAction,
  type FactcheckItemModel,
  type FeedItemHandlers,
  type FeedItemModel,
  type NoticeModel,
  type ToastModel,
  type WhyActionId,
  whyCopy,
} from '@unalgorithm/ui';
import type { BgError, BgResponses, ClassifyItem, SettingsAction } from '../lib/messages.ts';
import { chosenList, listName, listReady, storedOfficialList } from '../lib/outlets.ts';
import type { StoredOfficialList } from '../lib/storage.ts';
import { GLOBAL_STYLE_ID, globalCss, sampleHostTheme } from './global-css.ts';

const BATCH_SIZE = 6;
const FLUSH_DELAY_MS = 600;
const SCAN_DEBOUNCE_MS = 150;
const INSPECT_BUDGET_MS = 8;
const SETTLE_MS = 1500;
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_WINDOW = 30;
const MAX_HIGHLIGHTS = 20;
const MAX_HIDDEN_ITEMS = 60;
const TOAST_MS = 6000;
/** Items whose facts (flags and ids, never content) are kept for the page load's breakage checks. */
const MAX_FACTS = 2000;
/** The most detector and observation ids a report carries (the wire's limits). */
const MAX_DETECTOR_IDS = 64;
const MAX_OBSERVATION_IDS = 32;
const NO_NOTICES: NoticePrefs = { enabled: true, snoozed: {} };
const FACTCHECK_STALE = "Couldn't reach unAlgorithm. Reload the page.";
const FACTCHECK_TOOLBAR_HINT = 'Open unAlgorithm from the toolbar to see it.';

/**
 * What a done fact-check or comparison says when the side panel didn't open. Chrome and Edge: their toolbar popup opens
 * it. Firefox can't open its sidebar from a click in the page (ADR 0008), so it names the way in: the popup's
 * Open Highlights button, or the sidebar's keyboard shortcut when the person has one.
 */
export function panelHint(firefox: boolean, shortcut?: string): string {
  if (!firefox) return FACTCHECK_TOOLBAR_HINT;
  const popup = 'open unAlgorithm from the toolbar and choose Open Highlights';
  return shortcut ? `Press ${shortcut} to see it, or ${popup}.` : `To see it, ${popup}.`;
}

export interface Runtime {
  settings: Settings;
  device: Device;
  learned: LearnedPrefs;
  votes: Record<string, 'more' | 'less'>;
  /** What the signed-in server offers (`local:serverOffer`); only a server source reads it. */
  serverOffer: ServerOffer | null;
  /**
   * unAlgorithm Cloud's source list as the background stored it (`local:officialList`); read only through
   * `storedOfficialList`.
   */
  officialList: StoredOfficialList;
}

/** The chosen source list as the feed needs it: whether UnEcho Chamber can run on it, and its balance notice. */
interface ListState {
  /** What it was computed from: recomputed only when the settings section or the stored copy is another object. */
  from: [Settings['perspectives'], StoredOfficialList];
  ready: boolean;
  /** "Your list isn't balanced: No outlets in Right." (drafts, D110); absent when balanced. */
  notice?: string;
}

/** What a report started in the feed is about (ADR 0009 §2). The draft is built from the page at that moment. */
export interface ReportOptions {
  kind: 'detection' | 'wrong-call';
  /** Where it started (`REPORT_FROM`): `notice` for the in-feed card, `why` for *Why? → Wrong call?*. */
  from: ReportFrom;
  /** The post a *Wrong call?* is about, to look up with `postReportSummary`. A lookup key only, never sent. */
  key?: string;
  /** The in-feed card the report came from. */
  notice?: NoticeKind;
}

/** How the controller talks to the rest of the extension (mocked in tests). */
export interface Bridge {
  /** `cacheOnly`: AI is paused, so only the background's cache answers (no network). */
  classify(items: ClassifyItem[], opts?: { cacheOnly?: boolean }): Promise<BgResponses['classify']>;
  pushTabState(patch: Partial<TabState>): void;
  /** `shareable`: a server may receive the rated post, and so its summary (R23). */
  vote(
    key: PostKey,
    verdict: 'more' | 'less' | null,
    topics: string[],
    summary: string | undefined,
    shareable: boolean,
  ): Promise<void>;
  settingsAction(action: SettingsAction): Promise<SettingsAction | null>;
  coachMarkShown(): void;
  openSettings(hash?: string): void;
  /** Open the report page with a draft of this page (ADR 0009 §2); nothing is sent from here. */
  report(opts?: ReportOptions): void;
  /**
   * Keep the in-feed `kind` card away on this platform for `ms` (`device.notices`, shared by this browser's tabs), the
   * way `coachMarkShown` keeps its device flag: through the background, which applies core's `snooze`.
   */
  snoozeNotice?(kind: NoticeKind, ms: number): void;
  /** Fact-check one post on the person's own key (P3-06). Only ever called after the person confirmed the price. */
  factcheck(key: PostKey, input: Omit<PostForAI, 'ref'>): Promise<BgResponses['factcheck']>;
  /** True when the side panel opened (P3-06 `openFactcheck`); false when it didn't, or on a stale context. */
  openFactcheck(): Promise<boolean>;
  /** What to say when it didn't (`panelHint`, which knows the browser); Chrome's toolbar hint when absent. */
  panelHint?(): string;
  /**
   * UnEcho Chamber for one post's shared link (P3-38). Only the link (URL and link-card title), the platform and
   * the audience leave the content script, never post text; only ever called after the person confirmed the price.
   */
  perspectives(
    key: PostKey,
    req: { link: SharedLink; platform: PlatformId; audience?: Audience },
  ): Promise<BgResponses['perspectives']>;
}

export type FeedBridge = Bridge;

/** Content-free numbers about the page for a problem report: counts, codes and ids only (ADR 0009 §4). */
export interface PageDiagnostics {
  counts: Record<string, number>;
  landmarks: Record<string, number>;
  hiddenBy?: Record<string, number>;
  detectors?: Record<string, number>;
  observations?: Record<string, number>;
  /** Adapter exceptions caught, per operation; never their messages. */
  errors?: Record<string, number>;
  /** The item discovery strategy that won (phase B). */
  strategy?: string;
}

export interface ControllerDiagnostics extends PageDiagnostics {
  counts: Record<(typeof COUNT_KEYS)[number], number>;
  hiddenBy: Record<string, number>;
  detectors: Record<string, number>;
  observations: Record<string, number>;
  errors: Record<string, number>;
}

/** What a report draft reads from a page: the controller, or the watchdog where unAlgorithm didn't start. */
export interface ReportSource {
  getHealth(): HealthReport;
  /** Read at the moment of the click. */
  diagnostics(): PageDiagnostics;
  /** The *Wrong call?* post, as `summarizePostForReport` sees it; null when there is no such hidden item. */
  postReportSummary?(key: string): ReportPost | null;
}

/** The jobs a post can offer (Fact-check, UnEcho Chamber), in the order their rows render. */
type Job = 'factcheck' | 'perspectives';
const JOBS: readonly Job[] = ['factcheck', 'perspectives'];

/** A job's progress on one post; absent means offered (when its offer rule holds). */
interface JobProgress {
  state: FactcheckItemModel['state'];
  message?: string;
}

/** Where our per-item UI lives: a custom element with a shadow root, appended as the item's last child. */
export interface UiHost {
  host: HTMLElement;
  container: HTMLElement;
}

export interface Entry {
  id: string;
  el: HTMLElement;
  kind: 'post' | 'module' | 'pending' | 'ignore';
  sibling: boolean;
  post?: PostData;
  module?: ModuleInfo;
  firstSeen: number;
  /** When it was first seen, in the page's visible time (health limits count visible time only). */
  firstSeenVisible: number;
  sig: string;
  stableSince: number;
  settled: boolean;
  near: boolean;
  /** Visible time at which it came near the viewport; absent while it isn't near. */
  nearSince?: number;
  /**
   * The platform emptied or virtualised the slot after it scrolled away: the decision is kept, our UI and attributes
   * are off the empty slot, and health leaves it out until the platform fills it in again.
   */
  offscreen?: boolean;
  onScreen: boolean;
  classification?: Classification;
  /** What a billing server charged for the batch `classification` came from (CL6-03); none for a cached result. */
  charge?: PostCharge;
  partialText?: boolean;
  aiStatus: 'idle' | 'queued' | 'pending' | 'done' | 'skipped' | 'error';
  aiMessage?: string;
  retryAt?: number;
  decision: Decision;
  /** The filter actually applied to the page (an AI verdict waits while the post is on screen). */
  applied: FilterDecision | null;
  revealed: boolean;
  vote?: 'more' | 'less';
  run?: { count: number; labels: string[] } | 'member';
  ui?: UiHost;
  handlers?: FeedItemHandlers;
  coach?: boolean;
  /** "Check facts" progress; absent means offered (when the offer rule holds). */
  factcheck?: JobProgress;
  /** UnEcho Chamber progress, as fact-check's. */
  perspectives?: JobProgress;
}

type Listener = () => void;

const EMPTY_DECISION: Decision = { filter: null, highlight: null };

export class FeedController implements ReportSource {
  private rt: Runtime | undefined;
  private listState: ListState | undefined;
  private active = false;
  private scope: HTMLElement | null = null;
  private entries = new Map<HTMLElement, Entry>();
  private byId = new Map<string, Entry>();
  private dirty = new Set<HTMLElement>();
  private queue: Entry[] = [];
  private flushTimer: number | undefined;
  private scanTimer: number | undefined;
  private observer: MutationObserver | undefined;
  private bodyObserver: MutationObserver | undefined;
  private look: IntersectionObserver | undefined;
  private screen: IntersectionObserver | undefined;
  private healthTimer: number | undefined;
  private pushTimer: number | undefined;
  private keepTimer: number | undefined;
  private themeObserver: MutationObserver | undefined;
  /** Visible time since start: every health time limit counts it (ADR 0009 §3). */
  private clock = new VisibleClock(true);
  private health: HealthReport = HEALTHY;
  private degraded = new Set<keyof PostSignals | 'relationship'>();
  /** A fallback discovery strategy is winning: only strong signals hide (ADR 0009 §9). */
  private cautious = false;
  /** Started on an address unAlgorithm didn't know, because the page had a strong home signature. */
  private routeNew = false;
  /** Adapter exceptions caught on this page, per operation (never their messages). */
  private errors: Partial<Record<ErrorOp, number>> = {};
  /** What the breakage checks keep about each item on this page load, by post key: flags and ids, in memory only. */
  private facts = new Map<string, ItemFacts>();
  /** The last items `findItems` found, kept when it fails. */
  private items: HTMLElement[] = [];
  /** Feed items registered so far, and the scrolling since the count last changed (`items-not-growing`). */
  private registered = 0;
  private scrollWindow = { screens: 0, height: 0, items: 0 };
  private lastScrollTop: number | null = null;
  /** Visible time at which the load-more marker was last on the page. */
  private markerSeenAt = 0;
  /** Notice cards raised at the last health check, the ones raised at two in a row, the card showing, and the ones done. */
  private noticeRaised = new Set<NoticeKind>();
  private noticeSteady: NoticeKind[] = [];
  private noticeCard: NoticeKind | null = null;
  /** Cards shown on this page load: each kind shows at most once per load, across visits to the feed. */
  private noticeDone = new Set<NoticeKind>();
  private aiPause: BgError | undefined;
  private aiWorking = 0;
  private peek = false;
  /**
   * Posts whose run was opened with Show all, by key: each keeps its own fold line from then on. Kept per post, not per
   * run, because runs re-form as the platform empties and refills slots (see `recomputeRuns`).
   */
  private unfolded = new Set<string>();
  /** Each run's posts, by its lead, as `recomputeRuns` last drew them. */
  private runs = new Map<Entry, Entry[]>();
  private moduleSeq = 0;
  private coachShown = false;
  private listeners = new Set<Listener>();
  private version = 0;
  private notifyScheduled = false;
  toasts: ToastModel[] = [];
  /** keepLoading state (see platforms/shared/keep-loading.ts). */
  private lastItemCount = 0;
  private lastVisibleCount = 0;
  private lastGrowthAt = 0;
  private lastRearmAt = 0;
  private lastUserScrollAt = 0;
  private fruitless = 0;

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly bridge: Bridge,
    private readonly mountUi: (entry: Entry) => UiHost,
    private readonly isAlive: () => boolean = () => true,
    private readonly doc: Document = document,
  ) {}

  // ---------- lifecycle ----------

  get isActive(): boolean {
    return this.active;
  }

  /**
   * `routeNew`: the address isn't one the adapter knows as the feed, but the page has a strong home signature, so
   * filtering runs and the next report says so (`route-new`). Left as it was when not given.
   */
  start(rt: Runtime, opts?: { routeNew?: boolean }): void {
    this.rt = rt;
    this.coachShown = rt.device.onboarding.coachMarkShown[this.adapter.id];
    if (opts?.routeNew !== undefined) this.routeNew = opts.routeNew;
    if (this.active) return;
    this.active = true;
    this.clock = new VisibleClock(this.doc.visibilityState === 'visible');
    this.errors = {};
    this.facts.clear();
    this.items = [];
    this.registered = 0;
    this.scrollWindow = { screens: 0, height: 0, items: 0 };
    this.lastScrollTop = null;
    this.markerSeenAt = 0;
    this.noticeRaised.clear();
    this.noticeSteady = [];
    this.cautious = false;
    this.injectGlobalCss();
    this.watchTheme();
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.doc.addEventListener('scroll', this.onUserScroll, { passive: true, capture: true });
    this.doc.defaultView?.addEventListener('wheel', this.onUserScroll, { passive: true });
    this.doc.addEventListener('click', this.onDocClick, { capture: true });
    this.healthTimer = window.setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS);
    if (this.adapter.loadMoreMarker) this.keepTimer = window.setInterval(() => this.keepLoading(), 1000);
    this.attachScope();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.observer?.disconnect();
    this.bodyObserver?.disconnect();
    this.look?.disconnect();
    this.screen?.disconnect();
    this.themeObserver?.disconnect();
    this.look = undefined;
    this.screen = undefined;
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.doc.removeEventListener('scroll', this.onUserScroll, { capture: true });
    this.doc.defaultView?.removeEventListener('wheel', this.onUserScroll);
    this.doc.removeEventListener('click', this.onDocClick, { capture: true });
    window.clearTimeout(this.flushTimer);
    window.clearTimeout(this.scanTimer);
    window.clearTimeout(this.pushTimer);
    window.clearInterval(this.healthTimer);
    window.clearInterval(this.keepTimer);
    for (const e of this.entries.values()) this.clearEntry(e);
    this.entries.clear();
    this.byId.clear();
    this.dirty.clear();
    this.runs.clear();
    this.queue = [];
    this.toasts = [];
    this.doc.getElementById(GLOBAL_STYLE_ID)?.remove();
    this.scope = null;
    this.routeNew = false;
    if (this.noticeCard) this.noticeDone.add(this.noticeCard);
    this.noticeCard = null;
    this.notify();
  }

  /** Settings, device state, votes or learned preferences changed: re-decide everything, no reload. */
  update(rt: Runtime): void {
    const sourceChanged = JSON.stringify(rt.device.aiSource) !== JSON.stringify(this.rt?.device.aiSource);
    this.rt = rt;
    this.aiPause = undefined;
    if (!this.active) return;
    for (const e of this.entries.values()) {
      e.vote = e.post ? rt.votes[e.post.id] : undefined;
      if (sourceChanged || e.aiStatus === 'error' || e.aiStatus === 'skipped') {
        e.aiStatus = 'idle';
        if (sourceChanged) {
          e.classification = undefined;
          e.charge = undefined;
        }
      }
      this.decideAndApply(e);
      if (e.near) this.maybeQueue(e);
    }
    this.injectGlobalCss();
    this.recomputeRuns();
    // The notice switch or a snooze may have changed, here or in another tab.
    this.refreshNotice();
    this.schedulePush();
  }

  /** Popup "Peek at hidden posts": show everything on this page, with a bar saying why each was hidden. */
  setPeek(on: boolean): void {
    this.peek = on;
    for (const e of this.entries.values()) this.apply(e);
    this.recomputeRuns();
    this.schedulePush();
  }

  // ---------- discovery ----------

  private guard(): boolean {
    if (this.isAlive()) return true;
    if (this.active) this.stop();
    return false;
  }

  /**
   * Every call into the adapter goes through here (ADR 0009 §9): an exception is counted for its operation, never
   * kept, and the page fails open (`inspect` → ignore, `findItems` → the items it found last). Three or more on a page
   * pause filtering (`adapter-error`). Hooks outside the five reported operations count under the nearest one: item
   * discovery under `findItems`, page-level reads (markers, theme, signed-in shell, load-more marker) under `probe`.
   */
  private safe<T>(op: ErrorOp, fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      this.errors[op] = (this.errors[op] ?? 0) + 1;
      return fallback;
    }
  }

  private errorCount(): number {
    return Object.values(this.errors).reduce((n, c) => n + (c ?? 0), 0);
  }

  private discovery(): DiscoveryState | null {
    if (!this.adapter.discovery) return null;
    return this.safe('findItems', () => this.adapter.discovery?.() ?? null, null);
  }

  private markers(): unknown {
    const lang = this.doc.documentElement.lang || 'en';
    return this.safe('probe', () => this.adapter.markersFor(lang), null);
  }

  private attachScope(): void {
    const scope = this.safe('feedScope', () => this.adapter.feedScope(this.doc), null);
    if (!scope) {
      // The feed is not on the page yet (single-page navigation): watch the body until it appears.
      if (!this.bodyObserver) {
        this.bodyObserver = new MutationObserver(() => this.scheduleScan());
        this.bodyObserver.observe(this.doc.body, { childList: true, subtree: true });
      }
      this.schedulePush();
      return;
    }
    this.bodyObserver?.disconnect();
    this.bodyObserver = undefined;
    this.scope = scope;
    this.observer?.disconnect();
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(scope, { childList: true, subtree: true, characterData: true });
    this.scan();
  }

  private onMutations(records: MutationRecord[]): void {
    if (!this.guard() || !this.scope) return;
    let relevant = false;
    for (const r of records) {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!target) continue;
      // Our own UI changing is not the page changing.
      if (target.closest('unalgo-post')) continue;
      if (r.type === 'childList' && isOwnOnly(r)) continue;
      relevant = true;
      const scope = this.scope;
      const root = this.safe('itemRootOf', () => this.adapter.itemRootOf(target, scope), null);
      if (root && this.entries.has(root)) this.dirty.add(root);
    }
    if (relevant) this.scheduleScan();
  }

  private scheduleScan(): void {
    if (this.scanTimer !== undefined) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = undefined;
      if (this.active && this.guard()) this.scan();
    }, SCAN_DEBOUNCE_MS);
  }

  private scan(): void {
    if (!this.scope?.isConnected) {
      this.scope = null;
      this.attachScope();
      if (!this.scope) return;
    }
    const scope = this.scope;
    const items = this.safe(
      'findItems',
      () => this.adapter.findItems(scope),
      this.items.filter((el) => el.isConnected),
    );
    this.items = items;
    this.ensureObservers(items[0]);
    for (const el of items) {
      const e = this.entries.get(el);
      if (!e) {
        this.register(el, false);
        this.registered++;
      } else if (e.ui && e.ui.host.parentElement !== el) el.appendChild(e.ui.host);
    }
    const ctx = this.ctx();
    for (const { el, module } of [
      ...this.safe('findItems', () => this.adapter.siblingModules?.(items, ctx) ?? [], []),
      ...this.safe('findItems', () => this.adapter.extraRegions?.(this.doc, ctx) ?? [], []),
    ]) {
      if (!this.entries.has(el)) this.registerModule(el, module);
    }
    for (const [el, e] of this.entries) {
      if (!el.isConnected) this.forget(e);
    }
    this.inspectDirty();
    this.recomputeRuns();
    this.schedulePush();
  }

  private ctx(): InspectContext<unknown> {
    return { markers: this.markers(), now: new Date() };
  }

  private ensureObservers(sample: HTMLElement | undefined): void {
    const root = this.look?.root;
    if (root instanceof Element && !root.isConnected) {
      this.look?.disconnect();
      this.screen?.disconnect();
      this.look = undefined;
      this.screen = undefined;
    }
    if (this.look || !sample || typeof IntersectionObserver === 'undefined') return;
    const scroller = findScroller(sample);
    this.look = new IntersectionObserver((changes) => this.onNear(changes), {
      root: scroller,
      rootMargin: '0px 0px 1500px 0px',
    });
    this.screen = new IntersectionObserver((changes) => this.onScreenChange(changes), { root: scroller });
    for (const el of this.entries.keys()) {
      this.look.observe(el);
      this.screen.observe(el);
    }
  }

  private register(el: HTMLElement, sibling: boolean): Entry {
    const e: Entry = {
      id: `pending:${this.moduleSeq++}`,
      el,
      kind: 'pending',
      sibling,
      firstSeen: Date.now(),
      firstSeenVisible: this.clock.ms(),
      sig: '',
      stableSince: Date.now(),
      settled: false,
      near: false,
      onScreen: false,
      aiStatus: 'idle',
      decision: EMPTY_DECISION,
      applied: null,
      revealed: false,
    };
    this.entries.set(el, e);
    this.inspect(e);
    this.look?.observe(el);
    this.screen?.observe(el);
    return e;
  }

  private registerModule(el: HTMLElement, module: ModuleInfo): void {
    const e = this.register(el, true);
    e.kind = 'module';
    e.module = module;
    e.settled = true;
    e.id = `module:${this.moduleSeq++}`;
    this.decideAndApply(e);
  }

  private forget(e: Entry): void {
    this.clearEntry(e);
    this.look?.unobserve(e.el);
    this.screen?.unobserve(e.el);
    this.entries.delete(e.el);
    if (this.byId.get(e.id) === e) this.byId.delete(e.id);
  }

  private clearEntry(e: Entry): void {
    e.el.removeAttribute('data-unalgo');
    e.el.removeAttribute('data-unalgo-run');
    e.el.removeAttribute('data-unalgo-pick');
    e.el.removeAttribute('data-unalgo-debug');
    e.ui?.host.remove();
    e.ui = undefined;
  }

  /** Re-read changed items that have not settled, within a small time budget per frame. */
  private inspectDirty(): void {
    const start = performance.now();
    for (const el of [...this.dirty]) {
      if (performance.now() - start > INSPECT_BUDGET_MS) {
        this.scheduleScan();
        return;
      }
      this.dirty.delete(el);
      const e = this.entries.get(el);
      // A settled item is read again only when it changes far from the viewport: there the platform may have emptied
      // or virtualised it (offscreen), and reading it costs the person nothing.
      if (e && el.isConnected && !e.sibling && (!e.settled || !e.near)) this.inspect(e);
    }
  }

  private inspect(e: Entry): void {
    if (e.sibling) return;
    const ctx = this.ctx();
    const res = this.safe<InspectResult>('inspect', () => this.adapter.inspect(e.el, ctx), { kind: 'ignore' });
    const now = Date.now();
    const prevKind = e.kind;
    if (res.kind === 'pending' && res.offscreen) {
      // Emptied or virtualised after it scrolled away: keep the decision, take our UI and attributes off the empty
      // slot, and wait for the platform to fill it in again (its mutations bring it back here).
      if (!e.offscreen) {
        e.offscreen = true;
        e.settled = false;
        this.apply(e);
        this.recomputeRuns();
      }
      return;
    }
    e.offscreen = false;
    if (res.kind === 'post') {
      const p = res.post;
      const sig = [
        p.id,
        ...Object.values(p.signals),
        p.author.relationship,
        p.author.name ?? '',
        p.text.length,
        p.group?.joined ?? '',
      ].join('|');
      if (sig !== e.sig) {
        e.sig = sig;
        e.stableSince = now;
      }
      // Carry over what we know if the platform re-created the element for the same post.
      const previous = this.byId.get(p.id);
      if (previous && previous !== e) {
        e.classification ??= previous.classification;
        e.revealed ||= previous.revealed;
        if (previous.aiStatus === 'done') e.aiStatus = 'done';
      }
      if (e.id !== p.id) {
        if (this.byId.get(e.id) === e) this.byId.delete(e.id);
        e.id = p.id;
        this.byId.set(p.id, e);
      }
      e.kind = 'post';
      e.post = p;
      e.vote = this.rt?.votes[p.id];
      this.remember(p.id, postFacts(p, res.observations));
      // Settled: fully read and unchanged for a while (or old enough that it will not change). Settled items are
      // not re-read on every mutation, which keeps heavy feeds fast.
      e.settled =
        (p.quality.authorFound && p.quality.textFound && now - e.stableSince >= SETTLE_MS) || now - e.firstSeen >= 10_000;
    } else if (res.kind === 'module') {
      e.kind = 'module';
      e.module = res.module;
      if (!e.id.startsWith('module:')) e.id = `module:${this.moduleSeq++}`;
      e.settled = now - e.firstSeen >= SETTLE_MS;
      this.remember(e.id, { kind: 'module', observations: [...new Set(res.observations ?? [])] });
    } else {
      e.kind = res.kind;
      e.settled = res.kind === 'ignore';
      if (res.kind === 'ignore' && res.observations?.length) {
        this.remember(e.id, { kind: 'ignore', observations: [...new Set(res.observations)] });
      }
    }
    if (!e.settled) {
      window.setTimeout(() => {
        if (!this.active || !e.el.isConnected) return;
        this.dirty.add(e.el);
        this.scheduleScan();
      }, SETTLE_MS);
    }
    if (prevKind !== e.kind || e.kind !== 'pending') this.decideAndApply(e);
    if (e.near) this.maybeQueue(e);
  }

  /** Keep an item's facts for the page load, newest last; the oldest go first past `MAX_FACTS`. */
  private remember(key: string, facts: ItemFacts): void {
    this.facts.delete(key);
    this.facts.set(key, facts);
    if (this.facts.size > MAX_FACTS) {
      const oldest = this.facts.keys().next().value;
      if (oldest !== undefined) this.facts.delete(oldest);
    }
  }

  // ---------- deciding & applying ----------

  private decideAndApply(e: Entry): void {
    const rt = this.rt;
    if (!rt) return;
    if (e.kind === 'post' && e.post) {
      e.decision = decide({
        item: { kind: 'post', post: e.post },
        settings: rt.settings,
        ...(e.classification ? { classification: e.classification } : {}),
        // A configured source, paused or not: what is already known about a post keeps applying while AI is paused
        // (R27); only new AI calls stop.
        aiActive: !!rt.device.aiSource,
        learned: rt.learned,
        ...(e.vote ? { vote: e.vote } : {}),
        degraded: this.degraded,
        cautious: this.cautious,
      });
    } else if (e.kind === 'module' && e.module) {
      e.decision = decide({
        item: { kind: 'module', platform: this.adapter.id, module: e.module },
        settings: rt.settings,
        aiActive: false,
      });
    } else {
      e.decision = EMPTY_DECISION;
    }
    this.apply(e);
  }

  /** Put the decision on the page: one attribute on the item root, plus our UI only when needed. */
  private apply(e: Entry): void {
    const rt = this.rt;
    if (!rt) return;
    const next = this.health.status === 'broken' ? null : e.decision.filter;
    // AI never folds away the post you are reading: an AI verdict waits until the post scrolls off screen.
    if (next?.source === 'ai' && !e.applied && e.onScreen) {
      this.notify();
    } else {
      e.applied = next;
    }
    if (e.offscreen) {
      // No stale fold line on an empty slot: the decision waits in `applied` for the post to come back.
      this.clearEntry(e);
      this.notify();
      return;
    }
    const mode = rt.settings.display.mode;
    let state: string | null = null;
    if (e.applied) {
      if (e.revealed || this.peek) state = 'revealed';
      else if (mode === 'dim') state = 'dimmed';
      else if (mode === 'hide') state = 'hidden';
      else state = 'collapsed';
    }
    setAttr(e.el, 'data-unalgo', state);
    const pick = !e.applied && !!e.decision.highlight && rt.settings.display.forYou === 'ring';
    setAttr(e.el, 'data-unalgo-pick', pick ? '' : null);
    setAttr(e.el, 'data-unalgo-debug', rt.device.dev.debugOverlay ? debugLabel(e) : null);
    let jobUi = false;
    for (const job of JOBS) {
      const offered = this.jobOffered(e, job);
      // The feature switched off, the source changed or the post folded: an offer not yet confirmed goes away.
      if (!offered && (e[job]?.state === 'offered' || e[job]?.state === 'confirming')) e[job] = undefined;
      jobUi ||= offered || !!e[job];
    }
    const wantsUi =
      state === 'collapsed' ||
      state === 'dimmed' ||
      state === 'revealed' ||
      (!e.applied && !!e.decision.highlight && rt.settings.display.forYou !== 'off') ||
      jobUi;
    if (wantsUi && !e.ui) {
      e.ui = this.mountUi(e);
      e.handlers = this.handlersFor(e);
    }
    if (e.ui && e.ui.host.parentElement !== e.el) e.el.appendChild(e.ui.host);
    if (!wantsUi && e.ui) {
      e.ui.host.remove();
      e.ui = undefined;
    }
    this.notify();
  }

  /**
   * Merge hidden posts that sit next to each other into one "3 hidden" line. Invisible items, Facebook's emptied slots
   * among them, do not break a run, so runs re-form as the platform empties and refills slots far from the viewport. A
   * post opened with Show all stays out of every run from then on: folding it again would change the page's height by
   * hundreds of pixels, the platform would empty or refill slots in answer, and the runs would open and fold without end.
   */
  private recomputeRuns(): void {
    const rt = this.rt;
    if (!rt) return;
    const ordered = [...this.entries.values()].sort((a, b) =>
      a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const group = rt.settings.display.groupRuns && rt.settings.display.mode === 'collapse' && !this.peek;
    this.runs.clear();
    let run: Entry[] = [];
    const single = (e: Entry) => {
      e.run = undefined;
      setAttr(e.el, 'data-unalgo-run', null);
    };
    const close = () => {
      const lead = run[0];
      if (lead && run.length > 1 && group) {
        const labels = [...new Set(run.map((r) => (r.applied ? reasonLabel(r.applied, this.adapter.id) : '')).filter(Boolean))];
        lead.run = { count: run.length, labels };
        setAttr(lead.el, 'data-unalgo-run', 'lead');
        for (const m of run.slice(1)) {
          m.run = 'member';
          setAttr(m.el, 'data-unalgo-run', 'member');
        }
        this.runs.set(lead, run);
      } else {
        for (const m of run) single(m);
      }
      run = [];
    };
    for (const e of ordered) {
      const state = e.el.getAttribute('data-unalgo');
      if (state === 'collapsed' && !this.unfolded.has(e.id)) {
        run.push(e);
        continue;
      }
      // Out of every run: never left marked as a member, which hides the whole item.
      single(e);
      // Invisible items do not break a run; anything else does, a post opened with Show all included.
      if (!(state === 'hidden' || e.kind === 'ignore' || e.kind === 'pending' || e.offscreen)) close();
    }
    close();
    this.assignCoachMark(ordered);
    this.notify();
  }

  private assignCoachMark(ordered: Entry[]): void {
    const rt = this.rt;
    // One thing at a time: no coach mark while a breakage notice is up.
    if (!rt || this.coachShown || !rt.settings.display.tips || this.noticeCard) return;
    if (ordered.some((e) => e.coach)) return;
    const target = ordered.find((e) => e.onScreen && e.el.getAttribute('data-unalgo') === 'collapsed' && e.run !== 'member');
    if (target) target.coach = true;
  }

  // ---------- the per-item UI ----------

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.version++;
      for (const fn of this.listeners) fn();
    });
  }

  /** Items that currently show our UI. */
  mounted(): Entry[] {
    return [...this.entries.values()].filter((e) => e.ui);
  }

  modelFor(e: Entry): FeedItemModel {
    const rt = this.rt as Runtime;
    const platform = this.adapter.id;
    const state = (e.el.getAttribute('data-unalgo') as FeedItemModel['state'] | 'hidden' | null) ?? 'shown';
    const d = e.applied ?? e.decision.filter;
    const preset = presetOf(platform, rt.settings.platforms[platform]);
    return {
      key: e.id,
      platform,
      state: state === 'hidden' ? 'collapsed' : state,
      ...(d ? { reason: d.reason, reasonLabel: reasonLabel(d, platform), ai: d.source === 'ai' } : {}),
      ...(rt.settings.display.showAuthor ? { who: d?.reason === 'module' ? undefined : e.post?.author.name } : {}),
      showReason: rt.settings.display.showReason,
      ...(e.run && e.run !== 'member' ? { run: e.run } : {}),
      ...(d ? { why: whyCopy(d, e.post, platform, preset, d.source === 'ai' ? e.charge : undefined) } : {}),
      ...(e.decision.highlight ? { highlight: { matched: e.decision.highlight.matched } } : {}),
      forYouStyle: rt.settings.display.forYou,
      ...(e.vote ? { vote: e.vote } : {}),
      ...(e.coach ? { coach: true } : {}),
      ...this.jobModel(e, 'factcheck'),
      ...this.jobModel(e, 'perspectives'),
    };
  }

  /**
   * The chosen source list's readiness and balance notice (D103, D104), computed once per change of the settings'
   * `perspectives` section or of the stored Cloud copy (each a new object when it changes), not once per post.
   */
  private chosenListState(rt: Runtime): ListState {
    const cached = this.listState;
    if (cached && cached.from[0] === rt.settings.perspectives && cached.from[1] === rt.officialList) return cached;
    const list = chosenList(rt.settings, storedOfficialList(rt.officialList));
    const ready = listReady(list);
    const warnings = ready ? listBalance(list).warnings : [];
    const state: ListState = {
      from: [rt.settings.perspectives, rt.officialList],
      ready,
      ...(ready && warnings.length ? { notice: `${listName(list.kind)} isn't balanced: ${warnings.join(' ')}` } : {}),
    };
    this.listState = state;
    return state;
  }

  /**
   * A job's offer rule (fact-check: P3-05; perspectives: P3-36, with the chosen source list ready), on a post that is not
   * folded away (shown, revealed or dimmed).
   */
  private jobOffered(e: Entry, job: Job): boolean {
    const rt = this.rt;
    if (!rt || e.kind !== 'post' || !e.post) return false;
    const state = e.el.getAttribute('data-unalgo');
    if (state !== null && state !== 'revealed' && state !== 'dimmed') return false;
    const offer = { device: rt.device, post: e.post, classification: e.classification, serverOffer: rt.serverOffer };
    return job === 'factcheck'
      ? factcheckOffered(offer)
      : perspectivesOffered({ ...offer, listReady: this.chosenListState(rt).ready });
  }

  private jobModel(e: Entry, job: Job): { factcheck?: FactcheckItemModel } | { perspectives?: FactcheckItemModel } {
    const state = e[job]?.state ?? 'offered';
    if ((state === 'offered' || state === 'confirming') && !this.jobOffered(e, job)) return {};
    // The chosen list's balance warnings, beside the price (D104): they warn and never block.
    const notice = job === 'perspectives' && this.rt ? this.chosenListState(this.rt).notice : undefined;
    return {
      [job]: {
        state,
        price:
          jobPriceLabel(job, this.rt?.device.aiSource ?? null, this.rt?.serverOffer ?? null, this.rt?.device.webSearch) ?? '',
        ...(notice ? { notice } : {}),
        ...(e[job]?.message ? { message: e[job].message } : {}),
      },
    };
  }

  /** What a confirmed job sends: fact-check the post for AI; perspectives only the shared link, built field by field. */
  private sendJob(post: PostData, job: Job): Promise<{ ok: true } | { ok: false; error: BgError }> {
    if (job === 'factcheck') {
      const { ref: _ref, ...input } = toPostForAI(post, {
        ref: 'x',
        redactMentions: (this.rt as Runtime).settings.ai.redactMentions,
      });
      return this.bridge.factcheck(post.id, input);
    }
    const shared = post.sharedLink as NonNullable<PostData['sharedLink']>;
    const title = shared.title;
    return this.bridge.perspectives(post.id, {
      link: { url: shared.url, ...(title ? { title } : {}) },
      platform: post.platform,
      ...(post.audience ? { audience: post.audience } : {}),
    });
  }

  /** Never automatic: `confirm`, after the price was shown, is the only way a job starts. */
  private async onJob(e: Entry, job: Job, action: FactcheckAction): Promise<void> {
    const rt = this.rt;
    const post = e.post;
    if (!rt || !post) return;
    switch (action) {
      case 'start':
      case 'retry':
        e[job] = { state: 'confirming' };
        break;
      case 'cancel':
        e[job] = undefined;
        break;
      case 'open': {
        // Both jobs show their result in the same side panel.
        const opened = await this.bridge.openFactcheck().catch(() => false);
        const hint = this.bridge.panelHint?.() ?? FACTCHECK_TOOLBAR_HINT;
        if (!opened && e[job]?.state === 'done') e[job] = { state: 'done', message: hint };
        break;
      }
      case 'confirm': {
        if (e[job]?.state !== 'confirming' || !this.jobOffered(e, job)) return;
        e[job] = { state: 'running' };
        this.notify();
        try {
          const res = await this.sendJob(post, job);
          e[job] = res.ok ? { state: 'done' } : { state: 'failed', message: res.error.message };
        } catch {
          e[job] = { state: 'failed', message: FACTCHECK_STALE };
        }
        break;
      }
    }
    if (this.active && this.entries.get(e.el) === e) this.apply(e);
  }

  private handlersFor(e: Entry): FeedItemHandlers {
    return {
      onShow: () => this.setRevealed(e, true),
      onHide: () => this.setRevealed(e, false),
      onShowAll: () => {
        for (const m of this.runs.get(e) ?? [e]) this.unfolded.add(m.id);
        this.recomputeRuns();
        e.ui?.host.shadowRoot?.querySelector<HTMLElement>('button')?.focus();
      },
      onWhyAction: (id) => void this.onWhyAction(e, id),
      onVote: (v) => void this.castVote(e, v),
      onCoachDone: () => {
        if (this.coachShown) return;
        this.coachShown = true;
        e.coach = false;
        this.bridge.coachMarkShown();
        // A notice that waited for the coach mark may show now.
        this.refreshNotice();
      },
      onFactcheck: (action) => void this.onJob(e, 'factcheck', action),
      onPerspectives: (action) => void this.onJob(e, 'perspectives', action),
    };
  }

  private setRevealed(e: Entry, revealed: boolean): void {
    e.revealed = revealed;
    this.apply(e);
    this.recomputeRuns();
    this.schedulePush();
    if (revealed) {
      e.el.setAttribute('tabindex', '-1');
      e.el.focus({ preventScroll: true });
    }
  }

  private toast(title: string, undo?: () => void): void {
    const id = uuidv7();
    this.toasts = [...this.toasts, { id, title, ...(undo ? { action: { label: 'Undo', onAction: undo } } : {}) }].slice(-3);
    this.notify();
    window.setTimeout(() => this.dismissToast(id), TOAST_MS);
  }

  dismissToast = (id: string): void => {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.notify();
  };

  private async runAction(action: SettingsAction, message: string): Promise<void> {
    const undo = await this.bridge.settingsAction(action).catch(() => null);
    this.toast(message, undo ? () => void this.bridge.settingsAction(undo) : undefined);
  }

  private async onWhyAction(e: Entry, id: WhyActionId): Promise<void> {
    const d = e.applied ?? e.decision.filter;
    const platform = this.adapter.id;
    const site = platform === 'facebook' ? 'Facebook' : 'LinkedIn';
    switch (id) {
      case 'show':
        this.setRevealed(e, true);
        return;
      case 'always-show-author': {
        const match = e.post ? authorKey(e.post) : undefined;
        const name = e.post?.author.name;
        if (!match || !name) return;
        await this.runAction(
          { op: 'addPersonRule', platform, list: 'alwaysShow', id: uuidv7(), rule: { label: name, match, addedAt: Date.now() } },
          `Posts from ${name} will always show.`,
        );
        return;
      }
      case 'stop-hiding': {
        if (!d) return;
        const action = stopHidingAction(d, platform);
        if (action) await this.runAction(action.action, `${action.what} will show on ${site}.`);
        return;
      }
      case 'unmute-topic': {
        const topicLabel = d?.topic;
        const entry = Object.entries(this.rt?.settings.interests.less ?? {}).find(([, t]) => t.label === topicLabel);
        if (!entry) return;
        await this.runAction({ op: 'removeTopic', list: 'less', id: entry[0] }, `${topicLabel} is no longer muted.`);
        return;
      }
      case 'not-bait':
      case 'want-like-this':
        await this.castVote(e, 'more');
        this.toast('Thanks. unAlgorithm will learn from this.');
        return;
      case 'settings':
        this.bridge.openSettings(`#/${platform}`);
        return;
      case 'report':
        this.bridge.report({ kind: 'wrong-call', from: 'why', key: e.id });
        return;
    }
  }

  private async castVote(e: Entry, v: 'more' | 'less' | null): Promise<void> {
    if (!e.post) return;
    if (v) e.vote = v;
    else delete e.vote;
    this.decideAndApply(e);
    this.recomputeRuns();
    await this.bridge
      .vote(e.post.id, v, e.classification?.topics ?? [], e.classification?.reason, serverMayReceive(e.post))
      .catch(() => undefined);
  }

  // ---------- AI classification queue ----------

  private onNear(changes: IntersectionObserverEntry[]): void {
    if (!this.guard()) return;
    for (const c of changes) {
      const e = this.entries.get(c.target as HTMLElement);
      if (!e) continue;
      if (c.isIntersecting && !e.near) e.nearSince = this.clock.ms();
      if (!c.isIntersecting) e.nearSince = undefined;
      e.near = c.isIntersecting;
      if (e.near) this.maybeQueue(e);
    }
  }

  private onScreenChange(changes: IntersectionObserverEntry[]): void {
    if (!this.guard()) return;
    let changed = false;
    for (const c of changes) {
      const e = this.entries.get(c.target as HTMLElement);
      if (!e) continue;
      e.onScreen = c.isIntersecting;
      // A deferred AI verdict applies once the post has scrolled away.
      if (!e.onScreen && e.decision.filter?.source === 'ai' && !e.applied) {
        this.apply(e);
        changed = true;
      }
      if (e.onScreen && !this.coachShown) changed = true;
    }
    if (changed) this.recomputeRuns();
  }

  private maybeQueue(e: Entry): void {
    const rt = this.rt;
    // Queued while AI is paused too: the batch then asks the cache only (see flush).
    if (!rt?.device.aiSource || e.kind !== 'post' || !e.post || e.aiStatus !== 'idle') return;
    if (e.retryAt && Date.now() < e.retryAt) return;
    // Posts already hidden by a rule or the user's own lists never cost an AI call.
    if (e.decision.filter && e.decision.filter.source !== 'ai') return;
    if (!e.post.text.trim()) return;
    if (!rt.settings.platforms[this.adapter.id].enabled) return;
    e.aiStatus = 'queued';
    this.queue.push(e);
    if (this.queue.length >= BATCH_SIZE) void this.flush();
    else if (this.flushTimer === undefined) this.flushTimer = window.setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (!this.guard() || !this.rt) return;
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // Nearest to the viewport first.
    this.queue.sort((a, b) => Number(b.onScreen) - Number(a.onScreen));
    while (this.queue.length && this.rt) {
      const batch = this.queue.splice(0, BATCH_SIZE).filter((e) => e.aiStatus === 'queued' && e.post);
      if (!batch.length) continue;
      // While AI is paused the background answers from its cache only: no AI call, no network (R27).
      const cacheOnly = !!this.aiPause;
      const redactMentions = this.rt.settings.ai.redactMentions;
      const items: ClassifyItem[] = batch.map((e) => {
        const { ref: _ref, ...input } = toPostForAI(e.post as PostData, { ref: 'x', redactMentions });
        e.partialText = !input.textComplete;
        e.aiStatus = 'pending';
        return { key: (e.post as PostData).id, input };
      });
      this.aiWorking++;
      this.schedulePush();
      let res: BgResponses['classify'];
      try {
        res = await this.bridge.classify(items, { cacheOnly });
      } catch (err) {
        res = { results: [], pause: undefined };
        for (const e of batch) {
          e.aiStatus = 'idle';
          e.retryAt = Date.now() + 20_000;
        }
        console.debug('[unAlgorithm] classify failed', err);
      } finally {
        this.aiWorking--;
      }
      if (!this.active) return;
      const byKey = new Map(res.results.map((r) => [r.key, r]));
      for (const e of batch) {
        const r = byKey.get((e.post as PostData).id);
        if (!r) {
          if (e.aiStatus === 'pending') e.aiStatus = 'idle';
          continue;
        }
        if (r.status === 'ok') {
          e.classification = r.classification;
          e.charge = r.charge; // none for a cached or own-key result: it cost nothing now
          e.aiStatus = 'done';
        } else if (r.status === 'skipped') {
          // Not in the cache while AI is paused: update() queues it again on resume. If AI resumed while this lookup
          // was on its way, it is asked again now.
          e.aiStatus = r.reason === 'paused' && !this.aiPause ? 'idle' : 'skipped';
          e.aiMessage =
            r.reason === 'cap-reached' ? 'Daily limit reached' : r.reason === 'declined' ? 'The AI declined this post' : '';
        } else if (r.retryable) {
          e.aiStatus = 'idle';
          e.retryAt = Date.now() + 20_000;
        } else {
          e.aiStatus = 'error';
          e.aiMessage = r.message;
        }
        this.decideAndApply(e);
        if (e.aiStatus === 'idle' && e.near) this.maybeQueue(e);
      }
      // The rest of the queue stays: the next batches go out as cache-only lookups.
      if (res.pause && BLOCKING_AI_ERRORS.has(res.pause.code)) this.aiPause = res.pause;
      this.recomputeRuns();
      this.schedulePush();
    }
  }

  // ---------- health, theme, keep-loading ----------

  /**
   * A single-page navigation can replace the area the feed lives in: after sign-in, LinkedIn swaps the login page's
   * <main> for the feed's. The controller may already have started on the old one (it starts as the address changes,
   * before the page does), and its observer then watches a detached node, so no post ever arrives and health reports
   * no items. Attach again when the scope has left the page, or holds no items while the adapter now names another.
   */
  private rescopeIfStale(): void {
    const scope = this.scope;
    if (!scope || (scope.isConnected && this.items.length > 0)) return;
    if (scope.isConnected) {
      const current = this.safe('feedScope', () => this.adapter.feedScope(this.doc), null);
      if (!current || current === scope) return;
    }
    this.observer?.disconnect();
    this.observer = undefined;
    this.scope = null;
    this.attachScope();
  }

  private checkHealth(): void {
    if (!this.active || !this.guard() || !this.rt) return;
    this.rescopeIfStale();
    // Phase B: full item discovery again on each tick (read-only, a few ms at most), so a better strategy can win.
    const rediscover = this.adapter.rediscover;
    if (rediscover) this.safe('findItems', () => rediscover.call(this.adapter, this.doc), undefined);
    const cautious = this.discovery()?.fallback === true;
    const visibleMs = this.clock.ms();
    const recent = [...this.entries.values()].filter((e) => !e.sibling).slice(-HEALTH_WINDOW);
    const samples: HealthSample[] = recent.filter((e) => e.kind !== 'ignore' || e.offscreen).map((e) => sampleOf(e, visibleMs));
    const report = evaluateHealth({
      platform: this.adapter.id,
      feedFound: !!this.scope,
      visibleMs,
      samples,
      localeSupported: this.markers() !== null,
      preset: presetOf(this.adapter.id, this.rt.settings.platforms[this.adapter.id]),
      signedIn: this.signedIn(),
      errors: this.errorCount(),
      routeNew: this.routeNew,
      fallback: cautious,
      multiPost: multiPostCount(this.facts.values()),
      loadMore: { expected: !!this.adapter.loadMoreMarker, missingForMs: visibleMs - this.markerSeenAt },
      watch: watchFrom(this.facts.values(), this.scrollWatch()),
    });
    // A new item since the last check: the scrolling window for `items-not-growing` starts again.
    if (this.registered !== this.scrollWindow.items) {
      this.scrollWindow = { screens: 0, height: this.scope?.scrollHeight ?? 0, items: this.registered };
    }
    const changed = JSON.stringify(report) !== JSON.stringify(this.health) || cautious !== this.cautious;
    this.health = report;
    this.degraded = new Set(report.degraded);
    this.cautious = cautious;
    if (changed) {
      for (const e of this.entries.values()) this.decideAndApply(e);
      this.recomputeRuns();
      this.schedulePush();
    }
    this.trackNotice(report);
  }

  /**
   * Whether the page has a signed-in shell, so a missing feed means breakage (ADR 0009 §3). An adapter without the
   * hook keeps the behaviour from before it existed: a missing feed always counts.
   */
  private signedIn(): boolean {
    const hook = this.adapter.signedIn;
    if (!hook) return true;
    return this.safe('probe', () => hook.call(this.adapter, this.doc), false);
  }

  /** Scrolling since the last new item, in screens of the feed's scroller. Measured on the device, never reported. */
  private scrollWatch(): ScrollWatch {
    const { view } = this.scrollPosition();
    const grown = (this.scope?.scrollHeight ?? 0) - this.scrollWindow.height;
    return {
      scrolledScreens: this.scrollWindow.screens,
      grownScreens: view > 0 ? Math.max(0, grown) / view : 0,
      newItemsWhileScrolling: this.registered - this.scrollWindow.items,
    };
  }

  private scrollPosition(): { top: number; view: number } {
    const root = this.look?.root;
    if (root instanceof Element) return { top: root.scrollTop, view: root.clientHeight };
    const win = this.doc.defaultView;
    return { top: win?.scrollY ?? 0, view: win?.innerHeight ?? 0 };
  }

  private onVisibility = (): void => {
    this.clock.setVisible(this.doc.visibilityState === 'visible');
  };

  // ---------- the breakage notice ----------

  /** An issue must hold in two health checks in a row (10 s apart) before its card shows (ADR 0009 §3). */
  private trackNotice(report: HealthReport): void {
    const raised = noticeKinds(report.issues, report.status);
    this.noticeSteady = raised.filter((k) => this.noticeRaised.has(k));
    this.noticeRaised = new Set(raised);
    this.refreshNotice();
  }

  /**
   * One card at a time, in priority order. A card goes away silently when its issue clears, the person turns notices
   * off or snoozes it (in any tab); a higher card takes its place. Either way it has had its one showing on this load.
   */
  private refreshNotice(): void {
    const before = this.noticeCard;
    let card = before;
    if (card && (!this.noticeSteady.includes(card) || !this.noticeAllowed(card, true))) {
      this.noticeDone.add(card);
      card = null;
    }
    const next = this.noticeSteady.find((k) => k !== card && this.noticeAllowed(k, false));
    if (next && (!card || NOTICE_KINDS.indexOf(next) < NOTICE_KINDS.indexOf(card))) {
      if (card) this.noticeDone.add(card);
      card = next;
    }
    this.noticeCard = card;
    if (card !== before) this.notify();
  }

  /** `noticeVisible` for this page; a card already showing isn't held back by the coach mark or by its own showing. */
  private noticeAllowed(kind: NoticeKind, showing: boolean): boolean {
    const rt = this.rt;
    if (!rt || !this.active) return false;
    const platform = this.adapter.id;
    return noticeVisible({
      kind,
      platform,
      adapter: this.adapter.version,
      now: Date.now(),
      prefs: rt.device.notices ?? NO_NOTICES,
      shownThisLoad: this.noticeDone,
      coachMark: !showing && !this.coachShown && [...this.entries.values()].some((e) => e.coach),
      paused: isPaused(rt.device, platform) || !rt.settings.platforms[platform].enabled,
    });
  }

  /** The in-feed card to render, if any. */
  notice(): NoticeModel | null {
    return this.noticeCard ? { kind: this.noticeCard, platform: this.adapter.id } : null;
  }

  /** *Let us know*: the report page, with the page as it is now. The card stays until a report is sent or it's put away. */
  noticeReport = (): void => {
    const kind = this.noticeCard;
    if (kind) this.bridge.report({ kind: 'detection', from: 'notice', notice: kind });
  };

  /** *Not now*, ✕ or Escape: away for this load, and for 24 hours on this platform in every tab. */
  noticeNotNow = (): void => {
    const kind = this.noticeCard;
    if (!kind) return;
    this.noticeDone.add(kind);
    this.noticeCard = null;
    this.bridge.snoozeNotice?.(kind, NOT_NOW_SNOOZE_MS);
    this.notify();
  };

  /**
   * A report was sent from any surface (the background tells the tab it came from). That card, or the one raised now
   * when no kind is given, stays away for 7 days on this platform: we already know.
   */
  onReportSent(kind?: NoticeKind): void {
    const sent = kind ?? this.noticeCard ?? this.health.notice;
    if (!sent) return;
    this.noticeDone.add(sent);
    this.bridge.snoozeNotice?.(sent, REPORT_SNOOZE_MS);
    if (this.noticeCard === sent) {
      this.noticeCard = null;
      this.notify();
    }
  }

  /** Why AI is paused on this tab (R27), or undefined while it runs. */
  pausedFor(): BgError['code'] | undefined {
    return this.aiPause?.code;
  }

  getHealth(): HealthReport {
    return this.health;
  }

  private injectGlobalCss(): void {
    const style = (this.doc.getElementById(GLOBAL_STYLE_ID) as HTMLStyleElement | null) ?? this.doc.createElement('style');
    style.id = GLOBAL_STYLE_ID;
    const sample = [...this.entries.keys()][0] ?? null;
    const theme = this.safe<'light' | 'dark'>('probe', () => this.adapter.theme(this.doc), 'light');
    style.textContent = globalCss(sampleHostTheme(this.doc, sample, theme), !!this.rt?.device.dev.debugOverlay);
    if (!style.isConnected) (this.doc.head ?? this.doc.documentElement).appendChild(style);
  }

  private watchTheme(): void {
    this.themeObserver?.disconnect();
    this.themeObserver = new MutationObserver(() => this.injectGlobalCss());
    for (const el of [this.doc.documentElement, this.doc.body]) {
      if (el) this.themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    }
  }

  private onUserScroll = (): void => {
    const now = Date.now();
    this.lastUserScrollAt = now;
    if (this.fruitless >= MAX_FRUITLESS && now - this.lastRearmAt > 10_000) this.fruitless = 0;
    const { top, view } = this.scrollPosition();
    if (this.lastScrollTop !== null && view > 0) this.scrollWindow.screens += Math.abs(top - this.lastScrollTop) / view;
    this.lastScrollTop = top;
  };

  /** A click on "See more" may reveal text the AI has not seen: re-read that post once. */
  private onDocClick = (ev: Event): void => {
    const sel = this.adapter.expanderSelector;
    const target = ev.target instanceof Element ? ev.target : null;
    const scope = this.scope;
    if (!sel || !target?.closest(sel) || !scope) return;
    const root = this.safe('itemRootOf', () => this.adapter.itemRootOf(target, scope), null);
    const e = root ? this.entries.get(root) : undefined;
    if (!e) return;
    window.setTimeout(() => {
      const before = e.post?.text.length ?? 0;
      e.settled = false;
      this.inspect(e);
      const after = e.post?.text.length ?? 0;
      if (e.partialText && after >= before * 1.5 && !e.decision.filter) {
        e.classification = undefined;
        e.charge = undefined;
        e.aiStatus = 'idle';
        this.maybeQueue(e);
      }
    }, 300);
  };

  private keepLoading(): void {
    if (!this.active || this.doc.visibilityState !== 'visible' || !this.guard()) return;
    this.rescopeIfStale();
    if (!this.scope) return;
    const scope = this.scope;
    const marker = this.safe('probe', () => this.adapter.loadMoreMarker?.(scope, this.doc) ?? null, null);
    if (!marker) return;
    this.markerSeenAt = this.clock.ms();
    const now = Date.now();
    let visible = 0;
    for (const e of this.entries.values()) if (!e.applied || e.revealed) visible++;
    if (this.entries.size !== this.lastItemCount) {
      this.lastItemCount = this.entries.size;
      this.lastGrowthAt = now;
    }
    if (visible > this.lastVisibleCount) this.fruitless = 0;
    this.lastVisibleCount = visible;
    const scroller = this.look?.root instanceof Element ? this.look.root : null;
    const win = this.doc.defaultView;
    if (
      !shouldRearm({
        markerTop: marker.getBoundingClientRect().top,
        viewBottom: scroller ? scroller.getBoundingClientRect().bottom : (win?.innerHeight ?? 0),
        viewHeight: scroller ? scroller.clientHeight : (win?.innerHeight ?? 0),
        now,
        lastGrowthAt: this.lastGrowthAt,
        lastRearmAt: this.lastRearmAt,
        lastUserScrollAt: this.lastUserScrollAt,
        fruitless: this.fruitless,
      })
    ) {
      return;
    }
    rearmMarker(marker);
    this.lastRearmAt = now;
    this.fruitless++;
  }

  // ---------- popup / side panel ----------

  scrollTo(id: string): boolean {
    const e = this.byId.get(id);
    if (!e?.el.isConnected) return false;
    if (e.applied && !e.revealed) this.setRevealed(e, true);
    e.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    e.el.setAttribute('data-unalgo-flash', '');
    window.setTimeout(() => e.el.removeAttribute('data-unalgo-flash'), 1300);
    return true;
  }

  reveal(id: string): boolean {
    const e = this.byId.get(id);
    if (!e) return false;
    this.setRevealed(e, true);
    return true;
  }

  /**
   * The page's numbers for a problem report (ADR 0009 §4), read at the moment of the click: counts of what's on the
   * page now, folded items by reason, and over the page load how many items each detector and observation id was
   * seen on (each item once), with the adapter's exceptions per operation. Codes and counts only.
   */
  diagnostics(): ControllerDiagnostics {
    const counts = {
      items: this.entries.size,
      posts: 0,
      modules: 0,
      pending: 0,
      offscreen: 0,
      hidden: 0,
      classified: 0,
      unknownAuthor: 0,
    };
    const hiddenBy: Record<string, number> = {};
    for (const e of this.entries.values()) {
      if (e.offscreen) counts.offscreen++;
      else if (e.kind === 'pending') counts.pending++;
      if (e.kind === 'post') counts.posts++;
      if (e.kind === 'module') counts.modules++;
      if (e.applied) {
        counts.hidden++;
        hiddenBy[e.applied.reason] = (hiddenBy[e.applied.reason] ?? 0) + 1;
      }
      if (e.classification) counts.classified++;
      if (e.kind === 'post' && !e.post?.quality.authorFound) counts.unknownAuthor++;
    }
    const scope = this.scope;
    const strategy = this.discovery()?.strategy;
    return {
      counts,
      hiddenBy,
      detectors: topCounts(tallyIds(this.facts.values(), 'detectors'), MAX_DETECTOR_IDS),
      landmarks: this.safe('probe', () => this.adapter.probe(this.doc, scope), {}),
      observations: topCounts(tallyIds(this.facts.values(), 'observations'), MAX_OBSERVATION_IDS),
      errors: { ...this.errors },
      ...(strategy ? { strategy } : {}),
    };
  }

  /** What a *Wrong call?* report says about the hidden item `key` (`summarizePostForReport`): never its content. */
  postReportSummary(key: string): ReportPost | null {
    const e = this.byId.get(key) ?? [...this.entries.values()].find((x) => x.id === key);
    const d = e ? (e.applied ?? e.decision.filter) : null;
    if (!e || !d) return null;
    return summarizePostForReport(e.post ?? null, d);
  }

  // ---------- tab state for the popup and side panel ----------

  private schedulePush(): void {
    if (this.pushTimer !== undefined) return;
    this.pushTimer = window.setTimeout(() => {
      this.pushTimer = undefined;
      if (this.active && this.guard()) this.bridge.pushTabState(this.buildState());
    }, 400);
  }

  buildState(): Partial<TabState> {
    const platform = this.adapter.id;
    const hidden: Record<string, number> = {};
    const reasonLabels: Record<string, string> = {};
    const hiddenItems: HiddenItem[] = [];
    const highlights: HighlightItem[] = [];
    let posts = 0;
    let classified = 0;
    let hiddenTotal = 0;
    for (const e of this.entries.values()) {
      if (e.kind === 'post') posts++;
      if (e.classification) classified++;
      const d = e.applied;
      if (d && !e.revealed) {
        const k = reasonKey(d);
        hidden[k] = (hidden[k] ?? 0) + 1;
        reasonLabels[k] = reasonLabel(d, platform);
        hiddenTotal++;
        if (hiddenItems.length < MAX_HIDDEN_ITEMS) {
          hiddenItems.push({
            id: (e.post?.id ?? e.id) as PostKey,
            reasonKey: k,
            label: reasonLabel(d, platform),
            ...(e.post?.author.name ? { author: e.post.author.name } : e.module?.title ? { author: e.module.title } : {}),
            snippet: e.post ? snippet(e.post.text, 120) : '',
            ...(e.post?.permalink ? { permalink: e.post.permalink } : {}),
            ai: d.source === 'ai',
          });
        }
      } else if (!d && e.decision.highlight && e.post) {
        highlights.push({
          id: e.post.id,
          ...(e.post.permalink ? { permalink: e.post.permalink } : {}),
          ...(e.post.author.name ? { author: e.post.author.name } : {}),
          snippet: snippet(e.post.text, 160),
          ...(e.decision.adjustedRelevance !== undefined ? { relevance: e.decision.adjustedRelevance } : {}),
          matched: e.decision.highlight.matched,
          source: e.decision.highlight.source,
        });
      }
    }
    highlights.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    const configured = !!this.rt?.device.aiSource;
    return {
      platform,
      url: this.doc.location?.href,
      onFeed: true,
      paused: false,
      counts: { items: this.entries.size, posts, classified, hidden, hiddenTotal, highlighted: highlights.length },
      reasonLabels,
      hiddenItems,
      highlights: highlights.slice(0, MAX_HIGHLIGHTS),
      ai: !configured
        ? { state: 'off' }
        : this.aiPause
          ? { state: 'paused', code: this.aiPause.code, message: this.aiPause.message }
          : { state: this.aiWorking > 0 ? 'working' : 'ready' },
      health: this.health,
      // Whatever the snoozes: the popup and side panel always say it. Sent as undefined when it clears.
      notice: this.health.notice
        ? { kind: this.health.notice, issues: noticeIssues(this.health.notice, this.health.issues) }
        : undefined,
      routeNew: this.routeNew,
      updatedAt: Date.now(),
    };
  }
}

/** A health sample: what the window's ratios need, with ages in visible time. */
function sampleOf(e: Entry, visibleMs: number): HealthSample {
  return {
    kind: e.offscreen ? 'offscreen' : e.kind === 'module' ? 'module' : e.kind === 'post' ? 'post' : 'pending',
    authorFound: !!e.post?.quality.authorFound,
    textFound: !!e.post?.quality.textFound,
    sponsored: !!e.post?.signals.sponsored,
    hidden: !!e.decision.filter,
    ageMs: visibleMs - e.firstSeenVisible,
    near: e.near,
    nearMs: e.near && e.nearSince !== undefined ? visibleMs - e.nearSince : 0,
  };
}

/** The `max` most frequent ids, so a report stays within the wire's limits. */
function topCounts(counts: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(counts);
  if (entries.length <= max) return counts;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max));
}

function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

/**
 * Developer label for live testing (Settings → About → Developer, dev builds only): what the adapter read and what
 * was decided, never the author's name or the post text.
 */
function debugLabel(e: Entry): string {
  const verdict = e.applied
    ? `HIDE ${reasonKey(e.applied)}${e.applied.source === 'ai' ? ' (AI)' : ''}`
    : e.decision.filter
      ? `WAIT ${reasonKey(e.decision.filter)} (AI, on screen)`
      : e.decision.highlight
        ? `FOR YOU (${e.decision.highlight.source})`
        : 'show';
  if (e.kind === 'module') return `module:${e.module?.kind ?? '?'} → ${verdict}`;
  if (e.kind !== 'post' || !e.post) return e.kind;
  const p = e.post;
  const c = e.classification;
  const parts = [
    `${p.author.kind}/${p.author.relationship}`,
    ...(p.group ? [`group:${p.group.joined === null ? '?' : p.group.joined ? 'joined' : 'not-joined'}`] : []),
    ...Object.entries(p.signals)
      .filter(([, on]) => on)
      .map(([signal]) => signal),
    `text:${p.text.length}${p.textComplete ? '' : '…'}`,
    ...(p.mentions?.length ? [`tags:${p.mentions.length}`] : []),
    ...(c
      ? [`ai:${c.relevance}${c.noise.length ? ` ${c.noise.join(',')}` : ''}`]
      : e.aiStatus !== 'idle'
        ? [`ai:${e.aiStatus}`]
        : []),
  ];
  const detectors = p.evidence.map((x) => x.detector).join(' ');
  return `${parts.join(' · ')} → ${verdict}${detectors ? ` [${detectors}]` : ''}`;
}

function isOwnOnly(r: MutationRecord): boolean {
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return nodes.length > 0 && nodes.every((n) => n.nodeName === 'UNALGO-POST' || n.nodeName === 'UNALGO-LAYER');
}

/** The element that actually scrolls the feed (LinkedIn's 2026 layout scrolls <main>, not the window). */
function findScroller(sample: HTMLElement): Element | null {
  let el: HTMLElement | null = sample.parentElement;
  const view = sample.ownerDocument.defaultView;
  while (el && el !== sample.ownerDocument.body) {
    const style = view?.getComputedStyle(el);
    if (style && /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

/** The settings change behind "Stop hiding …" in the Why? popover, and what to call it in the toast. */
function stopHidingAction(d: FilterDecision, platform: PlatformId): { action: SettingsAction; what: string } | null {
  const filter = (key: FilterKey, what: string) => ({
    action: { op: 'setFilter' as const, platform, key, value: false },
    what,
  });
  switch (d.reason) {
    case 'sponsored':
      return filter('sponsored', 'Ads');
    case 'suggested':
      return filter('suggested', 'Suggested posts');
    case 'network-activity':
      return filter('networkActivity', 'Network activity');
    case 'reshare':
      return filter('reshares', 'Reposts');
    case 'unjoined-group':
      return filter('unjoinedGroups', 'Posts from other groups');
    case 'reel':
      return filter('reels', 'Reels');
    case 'not-followed':
      return filter('notFollowed', "Posts from people you don't follow");
    case 'module':
      return filter('modules', 'Feed panels');
    case 'noise':
      return d.noise?.[0] ? { action: { op: 'setNoise', platform, label: d.noise[0], value: false }, what: 'Those posts' } : null;
    case 'low-relevance':
      return { action: { op: 'setLowRelevance', platform, value: false }, what: 'Off-topic posts' };
    default:
      return null;
  }
}
