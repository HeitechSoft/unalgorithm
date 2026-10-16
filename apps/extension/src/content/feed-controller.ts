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
  jobPriceLabel,
  type LearnedPrefs,
  type ModuleInfo,
  type PostCharge,
  type PostData,
  type PostSignals,
  perspectivesOffered,
  presetOf,
  reasonKey,
  reasonLabel,
  type ServerOffer,
  type Settings,
  snippet,
  type TabState,
  toPostForAI,
} from '@unalgorithm/core';
import { type InspectContext, MAX_FRUITLESS, type PlatformAdapter, rearmMarker, shouldRearm } from '@unalgorithm/platforms';
import {
  BLOCKING_AI_ERRORS,
  type Classification,
  type PlatformId,
  type PostForAI,
  type PostKey,
  type SharedLink,
  serverMayReceive,
  uuidv7,
} from '@unalgorithm/protocol';
import {
  type FactcheckAction,
  type FactcheckItemModel,
  type FeedItemHandlers,
  type FeedItemModel,
  type ToastModel,
  type WhyActionId,
  whyCopy,
} from '@unalgorithm/ui';
import type { BgError, BgResponses, ClassifyItem, SettingsAction } from '../lib/messages.ts';
import { perspectivesRegistry } from '../lib/outlets.ts';
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
const FACTCHECK_STALE = "Couldn't reach UnAlgorithm. Reload the page.";
const FACTCHECK_TOOLBAR_HINT = 'Open UnAlgorithm from the toolbar to see it.';

export interface Runtime {
  settings: Settings;
  device: Device;
  learned: LearnedPrefs;
  votes: Record<string, 'more' | 'less'>;
  /** What the signed-in server offers (`local:serverOffer`); only a server source reads it. */
  serverOffer: ServerOffer | null;
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
  report(): void;
  /** Fact-check one post on the person's own key (P3-06). Only ever called after the person confirmed the price. */
  factcheck(key: PostKey, input: Omit<PostForAI, 'ref'>): Promise<BgResponses['factcheck']>;
  /** True when the side panel opened (P3-06 `openFactcheck`); false when Chrome refused, or on a stale context. */
  openFactcheck(): Promise<boolean>;
  /**
   * "Other perspectives" for one post's shared link (P3-38). Only the link (URL and link-card title), the platform and
   * the audience leave the content script, never post text; only ever called after the person confirmed the price.
   */
  perspectives(
    key: PostKey,
    req: { link: SharedLink; platform: PlatformId; audience?: Audience },
  ): Promise<BgResponses['perspectives']>;
}

/** The Labs jobs a post can offer, in the order their rows render. */
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
  sig: string;
  stableSince: number;
  settled: boolean;
  near: boolean;
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
  /** "Other perspectives" progress, as fact-check's. */
  perspectives?: JobProgress;
}

type Listener = () => void;

const EMPTY_DECISION: Decision = { filter: null, highlight: null };

export class FeedController {
  private rt: Runtime | undefined;
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
  private startedAt = 0;
  private health: HealthReport = HEALTHY;
  private degraded = new Set<keyof PostSignals | 'relationship'>();
  private aiPause: BgError | undefined;
  private aiWorking = 0;
  private peek = false;
  private expandedRuns = new Set<string>();
  private moduleSeq = 0;
  private coachShown = false;
  private listeners = new Set<Listener>();
  private version = 0;
  private notifyScheduled = false;
  private detectorHits: Record<string, number> = {};
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

  start(rt: Runtime): void {
    this.rt = rt;
    this.coachShown = rt.device.onboarding.coachMarkShown[this.adapter.id];
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.injectGlobalCss();
    this.watchTheme();
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
    this.queue = [];
    this.toasts = [];
    this.doc.getElementById(GLOBAL_STYLE_ID)?.remove();
    this.scope = null;
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

  private attachScope(): void {
    const scope = this.adapter.feedScope(this.doc);
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
      const root = this.adapter.itemRootOf(target, this.scope);
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
    const items = this.adapter.findItems(scope);
    this.ensureObservers(items[0]);
    for (const el of items) {
      const e = this.entries.get(el);
      if (!e) this.register(el, false);
      else if (e.ui && e.ui.host.parentElement !== el) el.appendChild(e.ui.host);
    }
    const ctx = this.ctx();
    for (const { el, module } of [
      ...(this.adapter.siblingModules?.(items, ctx) ?? []),
      ...(this.adapter.extraRegions?.(this.doc, ctx) ?? []),
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
    const lang = this.doc.documentElement.lang || 'en';
    return { markers: this.adapter.markersFor(lang), now: new Date() };
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
      if (e && el.isConnected && !e.settled && !e.sibling) this.inspect(e);
    }
  }

  private inspect(e: Entry): void {
    if (e.sibling) return;
    const res = this.adapter.inspect(e.el, this.ctx());
    const now = Date.now();
    const prevKind = e.kind;
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
      for (const ev of p.evidence) this.detectorHits[ev.detector] = (this.detectorHits[ev.detector] ?? 0) + 1;
      // Settled: fully read and unchanged for a while (or old enough that it will not change). Settled items are
      // not re-read on every mutation, which keeps heavy feeds fast.
      e.settled =
        (p.quality.authorFound && p.quality.textFound && now - e.stableSince >= SETTLE_MS) || now - e.firstSeen >= 10_000;
    } else if (res.kind === 'module') {
      e.kind = 'module';
      e.module = res.module;
      if (!e.id.startsWith('module:')) e.id = `module:${this.moduleSeq++}`;
      e.settled = now - e.firstSeen >= SETTLE_MS;
    } else {
      e.kind = res.kind;
      e.settled = res.kind === 'ignore';
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
      // Labs switched off, the source changed or the post folded: an offer not yet confirmed goes away.
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

  /** Merge hidden posts that sit next to each other into one "3 hidden" line. */
  private recomputeRuns(): void {
    const rt = this.rt;
    if (!rt) return;
    const ordered = [...this.entries.values()].sort((a, b) =>
      a.el === b.el ? 0 : a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const group = rt.settings.display.groupRuns && rt.settings.display.mode === 'collapse' && !this.peek;
    let run: Entry[] = [];
    const close = () => {
      const lead = run[0];
      if (lead && run.length > 1 && group && !this.expandedRuns.has(lead.id)) {
        const labels = [...new Set(run.map((r) => (r.applied ? reasonLabel(r.applied, this.adapter.id) : '')).filter(Boolean))];
        lead.run = { count: run.length, labels };
        setAttr(lead.el, 'data-unalgo-run', 'lead');
        for (const m of run.slice(1)) {
          m.run = 'member';
          setAttr(m.el, 'data-unalgo-run', 'member');
        }
      } else {
        for (const m of run) {
          m.run = undefined;
          setAttr(m.el, 'data-unalgo-run', null);
        }
      }
      run = [];
    };
    for (const e of ordered) {
      const state = e.el.getAttribute('data-unalgo');
      if (state === 'collapsed') run.push(e);
      else if (state === 'hidden' || e.kind === 'ignore' || e.kind === 'pending') {
        // Invisible items do not break a run.
      } else close();
    }
    close();
    this.assignCoachMark(ordered);
    this.notify();
  }

  private assignCoachMark(ordered: Entry[]): void {
    const rt = this.rt;
    if (!rt || this.coachShown || !rt.settings.display.tips) return;
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
   * A job's offer rule (fact-check: P3-05; perspectives: P3-36, with this build's registry), on a post that is not
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
      : perspectivesOffered({ ...offer, registryReady: perspectivesRegistry() !== null });
  }

  private jobModel(e: Entry, job: Job): { factcheck?: FactcheckItemModel } | { perspectives?: FactcheckItemModel } {
    const state = e[job]?.state ?? 'offered';
    if ((state === 'offered' || state === 'confirming') && !this.jobOffered(e, job)) return {};
    return {
      [job]: {
        state,
        price:
          jobPriceLabel(job, this.rt?.device.aiSource ?? null, this.rt?.serverOffer ?? null, this.rt?.device.webSearch) ?? '',
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
        if (!opened && e[job]?.state === 'done') e[job] = { state: 'done', message: FACTCHECK_TOOLBAR_HINT };
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
        this.expandedRuns.add(e.id);
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
        this.toast('Thanks. UnAlgorithm will learn from this.');
        return;
      case 'settings':
        this.bridge.openSettings(`#/${platform}`);
        return;
      case 'report':
        this.bridge.report();
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
        console.debug('[UnAlgorithm] classify failed', err);
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

  private checkHealth(): void {
    if (!this.active || !this.guard() || !this.rt) return;
    const recent = [...this.entries.values()].filter((e) => !e.sibling).slice(-HEALTH_WINDOW);
    const now = Date.now();
    const samples: HealthSample[] = recent
      .filter((e) => e.kind !== 'ignore')
      .map((e) => ({
        kind: e.kind === 'module' ? 'module' : e.kind === 'post' ? 'post' : 'pending',
        authorFound: !!e.post?.quality.authorFound,
        textFound: !!e.post?.quality.textFound,
        sponsored: !!e.post?.signals.sponsored,
        hidden: !!e.decision.filter,
        ageMs: now - e.firstSeen,
      }));
    const lang = this.doc.documentElement.lang || 'en';
    const report = evaluateHealth({
      feedFound: !!this.scope,
      elapsedMs: now - this.startedAt,
      samples,
      localeSupported: this.adapter.markersFor(lang) !== null,
      preset: presetOf(this.adapter.id, this.rt.settings.platforms[this.adapter.id]),
    });
    const changed = JSON.stringify(report) !== JSON.stringify(this.health);
    this.health = report;
    this.degraded = new Set(report.degraded);
    if (changed) {
      for (const e of this.entries.values()) this.decideAndApply(e);
      this.recomputeRuns();
      this.schedulePush();
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
    style.textContent = globalCss(
      sampleHostTheme(this.doc, sample, this.adapter.theme(this.doc)),
      !!this.rt?.device.dev.debugOverlay,
    );
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
  };

  /** A click on "See more" may reveal text the AI has not seen: re-read that post once. */
  private onDocClick = (ev: Event): void => {
    const sel = this.adapter.expanderSelector;
    const target = ev.target instanceof Element ? ev.target : null;
    if (!sel || !target?.closest(sel) || !this.scope) return;
    const root = this.adapter.itemRootOf(target, this.scope);
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
    if (!this.active || this.doc.visibilityState !== 'visible' || !this.scope || !this.guard()) return;
    const marker = this.adapter.loadMoreMarker?.(this.scope, this.doc);
    if (!marker) return;
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

  diagnostics(): { counts: Record<string, number>; detectors: Record<string, number>; landmarks: Record<string, number> } {
    const counts: Record<string, number> = {
      items: this.entries.size,
      posts: 0,
      modules: 0,
      pending: 0,
      hidden: 0,
      classified: 0,
      unknownAuthor: 0,
    };
    for (const e of this.entries.values()) {
      if (e.kind === 'post') counts.posts = (counts.posts ?? 0) + 1;
      if (e.kind === 'module') counts.modules = (counts.modules ?? 0) + 1;
      if (e.kind === 'pending') counts.pending = (counts.pending ?? 0) + 1;
      if (e.applied) counts.hidden = (counts.hidden ?? 0) + 1;
      if (e.classification) counts.classified = (counts.classified ?? 0) + 1;
      if (e.kind === 'post' && !e.post?.quality.authorFound) counts.unknownAuthor = (counts.unknownAuthor ?? 0) + 1;
    }
    return { counts, detectors: { ...this.detectorHits }, landmarks: this.adapter.probe(this.doc, this.scope) };
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
      updatedAt: Date.now(),
    };
  }
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
