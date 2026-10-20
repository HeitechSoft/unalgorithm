import {
  type Decision,
  type DegradedSignal,
  decide,
  defaultPlatformSettings,
  defaultSettings,
  evaluateHealth,
  type HealthReport,
  type HealthSample,
  type ItemFacts,
  multiPostCount,
  postFacts,
  type Settings,
  tallyIds,
  watchFrom,
} from '@unalgorithm/core';
import type { DiscoveryState, HomeSignature, InspectResult, PlatformAdapter, RouteClass } from '../types.ts';

/**
 * Golden captures (ADR 0009 §9, phase C): a feed page, anonymized or built from the fixture builders, read the way the
 * feed controller reads it, with the result kept in `test/golden/<platform>/<name>.expect.json`. A change to an adapter
 * that changes what a page shows, what its health says or how its items are found then shows up as a diff of that file,
 * for review. The mutation suite (`mutate.ts`) reads the same pages after changing them the ways a platform might.
 *
 * Only reads: nothing here changes the page except putting it in the document.
 */

/** The presets every golden is decided on. */
export const GOLDEN_PRESETS = ['light', 'balanced', 'calm'] as const;
export type GoldenPreset = (typeof GOLDEN_PRESETS)[number];

/** Health is checked as the controller checks it, every 10 s of visible time; a golden is read at the second check. */
export const GOLDEN_CHECKS_MS = [10_000, 20_000] as const;
/** When a golden is read, unless its setup says otherwise. */
export const GOLDEN_NOW = '2026-10-19T12:00:00';

/** The watchdog's rule (apps/extension content/watchdog.ts): a feed scope, 3 items, 2 posts with an author in the first 10. */
const WATCHDOG_ITEMS = 3;
const WATCHDOG_AUTHORED = 2;
const WATCHDOG_SAMPLE = 10;

/** How a golden is set up: where the page was, where its feed list is, and anything put back before it is read. */
export interface GoldenSetup {
  /** The page's address: it decides whether unAlgorithm runs at all (ADR 0009 §3). */
  url: string;
  /** Selector of the feed list: each of its children is one row of the golden, in page order. */
  list: string;
  /** The page's UI language (default `en`). */
  lang?: string;
  /** Local time the page is read at, for post ages (default GOLDEN_NOW). */
  now?: string;
  /**
   * Labels the capture script of the time scrambled, put back before reading: `from` must occur exactly `count` times,
   * so a new capture can't quietly drop the case.
   */
  restore?: ReadonlyArray<{ from: string; to: string; count: number }>;
  /**
   * One screen of a longer page (Facebook's captures, two posts each): checked as captured, but too small for page-wide
   * rules (health thresholds, discovery's 3-item minimum), so the mutation suite reads it as part of the whole page.
   */
  slice?: boolean;
}

/** How unAlgorithm treats the address: the controller runs, the watchdog watches, or nothing runs. */
export type GoldenRuns = 'controller' | 'watchdog' | 'off';

export interface GoldenHealth {
  /** `off` when nothing runs on the address. */
  status: HealthReport['status'] | 'off';
  issues: string[];
  degraded?: DegradedSignal[];
  notice?: HealthReport['notice'];
}

/** What a golden page gives: the part a `*.expect.json` file pins. */
export interface GoldenResult {
  /**
   * Per preset, one entry per row: `-` (not a feed item), `panel` or `show` (a feed panel, hidden or not), a post's
   * decision and relationship as `reason/relationship` (`show/followed`, `sponsored/unknown`), or the item's kind
   * (`pending`, `offscreen`, `ignore`). A row holding several items joins them with `+`.
   */
  decisions: Record<GoldenPreset, string[]>;
  /** Each row's post id (null for anything else): ids keep a person's votes and reveals, so they must not drift. */
  ids: Array<string | null>;
  /** Every id came out the same when the page was read a second time. */
  idsStable: boolean;
  /** What evaluateHealth says at 20 s of visible time, per preset. */
  health: Record<GoldenPreset, GoldenHealth>;
  /** The item discovery strategy that won, or null. */
  discovery: DiscoveryState | null;
  page: {
    route: RouteClass;
    runs: GoldenRuns;
    homeSignature: HomeSignature | 'none';
    signedIn: boolean | 'none';
    loadMore: boolean;
  };
  /** How many items each detector and observation id was seen on (each item counts an id once). */
  emitted: { detectors: Record<string, number>; observations: Record<string, number> };
  /** Adapter exceptions caught, per operation (the controller's `safe()` counts the same way). */
  errors: Record<string, number>;
}

/**
 * The page put in the document: the feed list as found before any change, its rows, and each row's first element
 * (its anchor), so a row is still found after a mutation unwraps it or wraps it once more.
 */
export interface MountedGolden {
  list: Element;
  rows: Element[];
  anchors: Element[];
}

/** One item as the controller keeps it. */
interface ItemRead {
  el: HTMLElement;
  result: InspectResult;
  /** A panel found between the items (`siblingModules`), not an item itself. */
  sibling?: boolean;
}

/** What reading the page found, before any preset applies (opaque outside this module). */
export interface GoldenRead {
  scope: HTMLElement | null;
  items: ItemRead[];
  facts: ItemFacts[];
  discovery: DiscoveryState | null;
  homeSignature: HomeSignature | 'none';
  signedIn: boolean | 'none';
  loadMore: boolean;
  markers: boolean;
  errors: Record<string, number>;
}

/** The capture with `setup.restore` applied. Throws when a label to restore isn't there the expected number of times. */
export function restoreCapture(html: string, setup: Pick<GoldenSetup, 'restore'>): string {
  let out = html;
  for (const { from, to, count } of setup.restore ?? []) {
    const found = out.split(from).length - 1;
    if (found !== count) throw new Error(`golden restore: "${from}" found ${found} times, expected ${count}`);
    out = out.replaceAll(from, to);
  }
  return out;
}

/** Parse a golden once (restored), to mount it again for every mutation without parsing it again. */
export function loadGolden(html: string, setup: Pick<GoldenSetup, 'restore'>): Document {
  return new DOMParser().parseFromString(restoreCapture(html, setup), 'text/html');
}

/** Put a parsed golden in `doc` (a copy: the template stays as it was) and find its feed list and rows. */
export function mountGolden(template: Document, setup: GoldenSetup, doc: Document = document): MountedGolden {
  doc.documentElement.lang = setup.lang ?? 'en';
  doc.body.replaceChildren(...Array.from(doc.importNode(template.body, true).childNodes));
  const list = doc.querySelector(setup.list);
  if (!list) throw new Error(`golden: no feed list matches ${setup.list}`);
  const rows = Array.from(list.children);
  return { list, rows, anchors: rows.map((row) => row.firstElementChild ?? row) };
}

/** The settings of a fresh install with this preset on the page's platform. */
function settingsFor(adapter: PlatformAdapter, preset: GoldenPreset): Settings {
  const base = defaultSettings();
  return { ...base, platforms: { ...base.platforms, [adapter.id]: defaultPlatformSettings(adapter.id, preset) } };
}

/** Read the mounted page the way the controller does: scope, items (with discovery), each item, the panels between. */
function readPage(adapter: PlatformAdapter, doc: Document, now: Date): GoldenRead {
  const errors: Record<string, number> = {};
  const safe = <T>(op: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      errors[op] = (errors[op] ?? 0) + 1;
      return fallback;
    }
  };
  const markers = adapter.markersFor(doc.documentElement.lang || 'en');
  const ctx = { markers, now };
  const scope = safe('feedScope', () => adapter.feedScope(doc), null);
  const found = scope ? safe('findItems', () => adapter.findItems(scope), [] as HTMLElement[]) : [];
  const items: ItemRead[] = found.map((el) => ({
    el,
    result: safe<InspectResult>('inspect', () => adapter.inspect(el, ctx), { kind: 'ignore' }),
  }));
  const siblings = scope && adapter.siblingModules ? safe('findItems', () => adapter.siblingModules?.(found, ctx) ?? [], []) : [];
  for (const s of siblings) items.push({ el: s.el, result: { kind: 'module', module: s.module }, sibling: true });
  const facts: ItemFacts[] = items.flatMap(({ result: r }): ItemFacts[] => {
    if (r.kind === 'post') return [postFacts(r.post, r.observations)];
    if (r.kind === 'module') return [{ kind: 'module', observations: [...new Set(r.observations ?? [])] }];
    if (r.kind === 'ignore' && r.observations?.length) return [{ kind: 'ignore', observations: [...new Set(r.observations)] }];
    return [];
  });
  return {
    scope,
    items,
    facts,
    discovery: adapter.discovery?.() ?? null,
    homeSignature: adapter.homeSignature ? safe('probe', () => adapter.homeSignature?.(doc) ?? null, null) : 'none',
    signedIn: adapter.signedIn ? safe('probe', () => adapter.signedIn?.(doc) ?? false, false) : 'none',
    loadMore: !!(scope && adapter.loadMoreMarker && safe('probe', () => adapter.loadMoreMarker?.(scope, doc), null)),
    markers: markers !== null,
    errors,
  };
}

/** Where unAlgorithm runs on this address (ADR 0009 §3), as the content script decides at load. */
function runsOn(adapter: PlatformAdapter, url: URL, signature: HomeSignature | 'none'): { route: RouteClass; runs: GoldenRuns } {
  let route: RouteClass;
  try {
    route = adapter.classifyRoute ? adapter.classifyRoute(url) : adapter.isFeedPage(url) ? 'feed' : 'not-feed';
  } catch {
    route = 'not-feed';
  }
  if (route === 'feed') return { route, runs: 'controller' };
  if (route === 'feed-candidate') return { route, runs: signature === 'strong' ? 'controller' : 'watchdog' };
  return { route, runs: 'off' };
}

/** A row's entry for one item and decision. */
function entry(item: ItemRead, decision: Decision | null): string {
  const r = item.result;
  if (r.kind === 'post') return `${decision?.filter?.reason ?? 'show'}/${r.post.author.relationship}`;
  if (r.kind === 'module') return decision?.filter ? 'panel' : 'show';
  if (r.kind === 'pending') return r.offscreen ? 'offscreen' : 'pending';
  return 'ignore';
}

/**
 * The items each row holds: the row itself, an item inside it, or an item around it (a wrapper a mutation added). A
 * row a mutation unwrapped is found by its anchor.
 */
function itemsOfRows(mounted: MountedGolden, items: readonly ItemRead[]): ItemRead[][] {
  const related = (el: Element, x: Element) => el === x || x.contains(el) || el.contains(x);
  return mounted.rows.map((row, i) => {
    const anchor = mounted.anchors[i] ?? row;
    return items.filter(({ el }) => related(el, row) || related(el, anchor));
  });
}

function sample(item: ItemRead, hidden: boolean, visibleMs: number): HealthSample | null {
  const r = item.result;
  if (r.kind === 'ignore') return null;
  const post = r.kind === 'post' ? r.post : undefined;
  return {
    kind: r.kind,
    // A capture holds no earlier read: an emptied slot was never decided, so it stays out of every ratio.
    ...(r.kind === 'pending' && r.offscreen ? { offscreen: true } : {}),
    authorFound: !!post?.quality.authorFound,
    textFound: !!post?.quality.textFound,
    sponsored: !!post?.signals.sponsored,
    hidden,
    ageMs: visibleMs,
    // No layout: no item counts as near the viewport, so none can be a stuck skeleton.
    near: false,
  };
}

/**
 * Decide every item on one preset as the controller does at 20 s of visible time: decided at attach, health checked at
 * 10 s and 20 s, the items decided again after each check with the signals it stopped trusting, and nothing hidden
 * while health is broken. Cautious mode follows the discovery strategy.
 */
function decidePreset(
  adapter: PlatformAdapter,
  read: GoldenRead,
  preset: GoldenPreset,
  runs: GoldenRuns,
  routeNew: boolean,
): { shown: Array<Decision | null>; health: GoldenHealth } {
  if (runs !== 'controller') {
    const shown = read.items.map(() => null);
    if (runs === 'off') return { shown, health: { status: 'off', issues: [] } };
    // The watchdog reads the page the same way, hides nothing, and says so after two passing probes.
    const first = read.items.filter((i) => !i.sibling).slice(0, WATCHDOG_SAMPLE);
    const authored = first.filter((i) => i.result.kind === 'post' && i.result.post.quality.authorFound).length;
    const feedLike =
      !!read.scope && read.items.filter((i) => !i.sibling).length >= WATCHDOG_ITEMS && authored >= WATCHDOG_AUTHORED;
    return {
      shown,
      health: feedLike
        ? { status: 'not-started', issues: ['feed-not-started'], notice: 'not-running' }
        : { status: 'not-started', issues: [] },
    };
  }
  const settings = settingsFor(adapter, preset);
  const cautious = read.discovery?.fallback === true;
  const decideAll = (degraded: ReadonlySet<DegradedSignal>) =>
    read.items.map(({ result: r }): Decision | null => {
      if (r.kind === 'post')
        return decide({ item: { kind: 'post', post: r.post }, settings, aiActive: false, degraded, cautious });
      if (r.kind === 'module')
        return decide({ item: { kind: 'module', platform: adapter.id, module: r.module }, settings, aiActive: false });
      return null;
    });
  const errorCount = Object.values(read.errors).reduce((a, b) => a + b, 0);
  let decisions = decideAll(new Set());
  let report: HealthReport | undefined;
  for (const visibleMs of GOLDEN_CHECKS_MS) {
    const samples = read.items.flatMap((item, i) =>
      item.sibling ? [] : (sample(item, !!decisions[i]?.filter, visibleMs) ?? []),
    );
    report = evaluateHealth({
      platform: adapter.id,
      feedFound: !!read.scope,
      visibleMs,
      samples,
      localeSupported: read.markers,
      preset,
      signedIn: read.signedIn !== false,
      errors: errorCount,
      routeNew,
      fallback: cautious,
      multiPost: multiPostCount(read.facts),
      loadMore: { expected: !!adapter.loadMoreMarker, missingForMs: read.loadMore ? 0 : visibleMs },
      watch: watchFrom(read.facts),
    });
    decisions = decideAll(new Set(report.degraded));
  }
  const final = report as HealthReport;
  const health: GoldenHealth = {
    status: final.status,
    issues: final.issues,
    ...(final.degraded.length ? { degraded: final.degraded } : {}),
    ...(final.notice ? { notice: final.notice } : {}),
  };
  return { shown: final.status === 'broken' ? decisions.map(() => null) : decisions, health };
}

export interface ReadGoldenOptions {
  /** Read every item a second time and compare the ids (the golden check does; the mutation suite needs not). */
  reread?: boolean;
  /** Judge the page at this address instead of the golden's own (route mutations). */
  url?: URL;
}

/** Read the mounted page once, to judge it at one or more addresses (`judgeGolden`). Read-only. */
export function readGoldenPage(adapter: PlatformAdapter, setup: GoldenSetup, doc: Document = document): GoldenRead {
  return readPage(adapter, doc, new Date(setup.now ?? GOLDEN_NOW));
}

/**
 * Per-row decisions on each preset, ids, health at 20 s, the discovery strategy, the page's route facts and the ids
 * emitted, from a page read once. Reads nothing more, so a route mutation costs no second read.
 */
export function judgeGolden(
  adapter: PlatformAdapter,
  setup: GoldenSetup,
  mounted: MountedGolden,
  read: GoldenRead,
  options: Pick<ReadGoldenOptions, 'url'> = {},
): GoldenResult {
  const { route, runs } = runsOn(adapter, options.url ?? new URL(setup.url), read.homeSignature);
  const routeNew = route === 'feed-candidate' && runs === 'controller';
  const byRow = itemsOfRows(mounted, read.items);
  const decisions = {} as Record<GoldenPreset, string[]>;
  const health = {} as Record<GoldenPreset, GoldenHealth>;
  for (const preset of GOLDEN_PRESETS) {
    const judged = decidePreset(adapter, read, preset, runs, routeNew);
    health[preset] = judged.health;
    decisions[preset] = byRow.map((items) =>
      items.length ? items.map((item) => entry(item, judged.shown[read.items.indexOf(item)] ?? null)).join('+') : '-',
    );
  }
  const ids = byRow.map((items) => {
    const found = items.flatMap((i) => idOf(i.result) ?? []);
    return found.length ? found.join('+') : null;
  });
  return {
    decisions,
    ids,
    idsStable: true,
    health,
    discovery: read.discovery,
    page: { route, runs, homeSignature: read.homeSignature, signedIn: read.signedIn, loadMore: read.loadMore },
    emitted: { detectors: tallyIds(read.facts, 'detectors'), observations: tallyIds(read.facts, 'observations') },
    errors: read.errors,
  };
}

const idOf = (r: InspectResult) => (r.kind === 'post' ? r.post.id : null);

/** Read and judge a mounted golden; with `reread`, read every item again and check its id didn't change. Read-only. */
export function readGolden(
  adapter: PlatformAdapter,
  setup: GoldenSetup,
  mounted: MountedGolden,
  options: ReadGoldenOptions = {},
  doc: Document = document,
): GoldenResult {
  const read = readGoldenPage(adapter, setup, doc);
  const result = judgeGolden(adapter, setup, mounted, read, options);
  if (options.reread) {
    const ctx = { markers: adapter.markersFor(doc.documentElement.lang || 'en'), now: new Date(setup.now ?? GOLDEN_NOW) };
    for (const item of read.items) {
      if (item.sibling) continue;
      let again: InspectResult;
      try {
        again = adapter.inspect(item.el, ctx);
      } catch {
        again = { kind: 'ignore' };
      }
      if (idOf(again) !== idOf(item.result)) result.idsStable = false;
    }
  }
  return result;
}

/**
 * Read a golden page from its HTML: restored, mounted in `doc`, judged on every preset and read again for id stability.
 * Compare the result with the golden's `*.expect.json`.
 */
export function runGolden(adapter: PlatformAdapter, html: string, setup: GoldenSetup, doc: Document = document): GoldenResult {
  const mounted = mountGolden(loadGolden(html, setup), setup, doc);
  return readGolden(adapter, setup, mounted, { reread: true }, doc);
}
