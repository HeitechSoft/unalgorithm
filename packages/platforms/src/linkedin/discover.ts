import {
  chooseStrategy,
  type ItemAnatomy,
  NO_STRATEGY,
  repeatedList,
  SAMPLE_SIZE,
  type StrategyChoice,
  scoreModel,
} from '../shared/structure.ts';
import type { DiscoveryState } from '../types.ts';
import { findPostRoots, moduleInfo, nameFromMenu } from './extract.ts';
import type { LinkedInMarkers } from './markers/en.ts';
import { LINKEDIN_MARKERS } from './markers/index.ts';
import { CARD_KEY_PREFIX, POST_ROOT_SELECTOR, SEL } from './selectors.ts';
import { isInCommentsArea, locateActionBar, locateText, readHead } from './slots.ts';

/**
 * How the LinkedIn adapter finds feed items when the markup changes (ADR 0009 §9, phase B). A mutation probe on the
 * 2026-10 captures showed that renaming the card key's prefix, or dropping `role="listitem"`, left 0 items. Each
 * strategy below finds the items another way, cheapest first; a sample of each one's items is scored on how much they
 * look like posts, and the best one is used. The fast path (the winner) runs on every scan; full discovery runs when
 * a feed is first seen and on every health tick, and another strategy takes over only after beating the current one
 * by 0.15 on 2 ticks in a row. Read-only.
 */

/** Strategies, cheapest first; the first is today's selector and the only one that isn't a fallback. */
export const LINKEDIN_STRATEGIES = [
  'li.items.card-key',
  'li.items.feed-list',
  'li.items.anatomy',
  'li.items.sr-heading',
] as const;
export type LinkedInStrategy = (typeof LINKEDIN_STRATEGIES)[number];
export const FAST_PATH: LinkedInStrategy = 'li.items.card-key';

/**
 * Full discovery stops trying more strategies after this long, once the current one is scored and still finds posts.
 * At attach, or when the current strategy finds none, every strategy runs: that is when a fallback matters.
 */
export const DISCOVERY_BUDGET_MS = 5;
/** While nothing has won (the feed is still loading), a scan runs full discovery at most this often. */
export const UNDECIDED_RETRY_MS = 1000;
/** At most this many lists are compared by the feed-list strategy. */
const MAX_LISTS = 20;

const MARKERS = Object.values(LINKEDIN_MARKERS);
/** The post's menu, Repost and Send: only a post has them (comments don't), in every language we read. */
const POST_ANCHORS = MARKERS.flatMap((m) => [m.authorMenuSelector, m.shareSelector]).join(', ');

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** What a part of the page holds, gathered with one query each and kept for one discovery or scan. */
interface Survey {
  /** Each post's menu, Repost and Send buttons, outside comments. */
  anchors(): Element[];
  /** The cards' screen-reader "Feed post" headings. */
  headings(): Element[];
  /** Whether `el` holds a post anchor (a post, not a panel, the composer or a comment). */
  holdsPost(el: Element): boolean;
  /** Whether `el` holds a card heading (a post or a panel). */
  holdsCard(el: Element): boolean;
}

/** Every ancestor of `els` up to `root`: the elements that hold one. */
function holders(els: readonly Element[], root: Element): Set<Element> {
  const out = new Set<Element>();
  for (const el of els) {
    for (let p = el.parentElement; p && !out.has(p); p = p.parentElement) {
      out.add(p);
      if (p === root) break;
    }
  }
  return out;
}

const once = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  let made = false;
  return () => {
    if (!made) {
      value = make();
      made = true;
    }
    return value as T;
  };
};

function survey(root: Element): Survey {
  const anchors = once(() => Array.from(root.querySelectorAll(POST_ANCHORS)).filter((a) => !isInCommentsArea(a)));
  const headings = once(() =>
    Array.from(root.querySelectorAll('h2, h3, [role="heading"]')).filter((h) => {
      // textContent, not the rendered lines: no layout on every scan.
      const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
      return MARKERS.some((m) => m.cardHeading.test(text));
    }),
  );
  const posts = once(() => holders(anchors(), root));
  const cards = once(() => holders(headings(), root));
  return { anchors, headings, holdsPost: (el) => posts().has(el), holdsCard: (el) => cards().has(el) };
}

/** What a strategy found: the items, in page order, and the list whose children they are. */
interface Found {
  items: HTMLElement[];
  list: Element | null;
}

const NOTHING: Found = { items: [], list: null };

/** The list's children that are feed items: posts, and cards with the "Feed post" heading (panels). */
function itemsOf(list: Element, page: Survey): Found {
  const items = (Array.from(list.children) as HTMLElement[]).filter((c) => page.holdsPost(c) || page.holdsCard(c));
  return { items, list };
}

/** The list the cards sit in (each in its own child), or null with fewer than 2. */
function listOfCards(scope: Element, cards: readonly Element[]): Element | null {
  return cards.length >= 2 ? (repeatedList(scope, cards, 2)?.list ?? null) : null;
}

/** Today's selector: each card is a list item keyed "update-card-focus…" (or a post URN in older layouts). */
function byCardKey(scope: HTMLElement): Found {
  const items = findPostRoots(scope);
  return { items, list: listOfCards(scope, items) };
}

/** The main feed list (`data-testid="mainFeed"`), or the `role="list"` with the most item children. */
function byFeedList(scope: HTMLElement, page: Survey): Found {
  const main = scope.matches(SEL.feedList) ? scope : scope.querySelector(SEL.feedList);
  if (main) return itemsOf(main, page);
  let best = NOTHING;
  for (const list of Array.from(scope.querySelectorAll('[role="list"]')).slice(0, MAX_LISTS)) {
    const found = itemsOf(list, page);
    if (found.items.length > best.items.length) best = found;
  }
  return best.items.length >= 3 ? best : NOTHING;
}

/** The repeated list over each post's menu, Repost and Send buttons, which comments don't have. */
function byAnatomy(scope: HTMLElement, page: Survey): Found {
  const found = repeatedList(scope, page.anchors(), 3);
  return found ? itemsOf(found.list, page) : NOTHING;
}

/** The repeated list over the cards' screen-reader "Feed post" headings. */
function bySrHeading(scope: HTMLElement, page: Survey): Found {
  const found = repeatedList(scope, page.headings(), 3);
  return found ? itemsOf(found.list, page) : NOTHING;
}

const FIND: Record<LinkedInStrategy, (scope: HTMLElement, page: Survey) => Found> = {
  'li.items.card-key': byCardKey,
  'li.items.feed-list': byFeedList,
  'li.items.anatomy': byAnatomy,
  'li.items.sr-heading': bySrHeading,
};

/** A 2026 card by its key alone, without `role="listitem"`, which a fallback strategy may be working around. */
const CARD_KEY = `[componentkey^="${CARD_KEY_PREFIX}"]`;

/**
 * The card inside an item: list strategies return the list's child, which wraps the card, and the card is what holds
 * the post's id, so a post keeps its id whichever strategy found it.
 */
export function cardOf(item: HTMLElement): HTMLElement {
  if (item.matches(`${CARD_KEY}, ${POST_ROOT_SELECTOR}`)) return item;
  return item.querySelector<HTMLElement>(CARD_KEY) ?? item.querySelector<HTMLElement>(POST_ROOT_SELECTOR) ?? item;
}

/** How post-like an item is: an author, an action bar, an age slot, a menu, and text. */
function anatomyOf(card: HTMLElement, m: LinkedInMarkers): ItemAnatomy {
  const menu = !!card.querySelector(m.authorMenuSelector);
  const author =
    menu || Array.from(card.querySelectorAll(`${SEL.profileLink}, ${SEL.groupLink}`)).some((a) => !isInCommentsArea(a));
  return {
    author,
    actionBar: !!locateActionBar(card, m),
    ageSlot: readHead(card, m, nameFromMenu(card, m)).ageSlot !== undefined,
    menu,
    text: !!locateText(card),
  };
}

/**
 * A strategy's score: the mean anatomy of its first SAMPLE_SIZE items that aren't feed panels. Panels are left out,
 * since some strategies list them as items and others leave them to `siblingModules`: on a healthy page every
 * strategy then scores the same, and the cheapest keeps winning.
 */
function score(found: Found, cache: Map<Element, ItemAnatomy | null>): number {
  const m = MARKERS[0] as LinkedInMarkers;
  const sample: ItemAnatomy[] = [];
  for (const item of found.items) {
    if (sample.length >= SAMPLE_SIZE) break;
    // Strategies often return the same items, or a wrapper around the same card: each is read once per discovery.
    let anatomy = cache.get(item);
    if (anatomy === undefined) {
      const card = cardOf(item);
      anatomy = cache.get(card);
      if (anatomy === undefined) anatomy = moduleInfo(card, m) ? null : anatomyOf(card, m);
      cache.set(card, anatomy);
      cache.set(item, anatomy);
    }
    if (anatomy) sample.push(anatomy);
  }
  return scoreModel(sample);
}

/** The item model in use on one feed scope. */
interface Model {
  choice: StrategyChoice;
  /** The list the winning strategy found on the last scan: the fast path, and the load-more marker's parent. */
  list: Element | null;
  /** When full discovery last ran, so an undecided page doesn't run it on every scan. */
  fullAt: number;
}

/** One model per feed scope: a new scope (a new page or a re-rendered feed) starts over with a full discovery. */
const models = new WeakMap<Element, Model>();
let lastModel: Model | null = null;

function modelFor(scope: HTMLElement): Model {
  let model = models.get(scope);
  if (!model) models.set(scope, (model = { choice: NO_STRATEGY, list: null, fullAt: Number.NEGATIVE_INFINITY }));
  lastModel = model;
  return model;
}

/** One full discovery's results: each strategy's items and score, in LINKEDIN_STRATEGIES order. */
type Results = Map<LinkedInStrategy, { found: Found; score: number }>;

/**
 * Run every strategy (the current one first, the rest cheapest first, within DISCOVERY_BUDGET_MS), score them and let
 * `chooseStrategy` decide.
 */
function fullDiscovery(scope: HTMLElement, model: Model): Results {
  const start = now();
  model.fullAt = start;
  const cache = new Map<Element, ItemAnatomy | null>();
  const page = survey(scope);
  const current = model.choice.current as LinkedInStrategy | null;
  const order = current ? [current, ...LINKEDIN_STRATEGIES.filter((s) => s !== current)] : [...LINKEDIN_STRATEGIES];
  const results: Results = new Map();
  for (const id of order) {
    // Within the budget, unless nothing works yet: at attach, or when the current strategy has stopped finding posts.
    const working = current !== null && (results.get(current)?.score ?? 0) > 0;
    if (working && now() - start > DISCOVERY_BUDGET_MS) break;
    const found = FIND[id](scope, page);
    results.set(id, { found, score: score(found, cache) });
  }
  const scores = LINKEDIN_STRATEGIES.flatMap((id) => {
    const r = results.get(id);
    return r ? [{ id, score: r.score }] : [];
  });
  model.choice = chooseStrategy(model.choice, scores);
  return results;
}

/** The feed items, by the winning strategy (today's selector until one has won). */
export function discoverItems(scope: HTMLElement): HTMLElement[] {
  const model = modelFor(scope);
  const results =
    model.choice.current === null && now() - model.fullAt >= UNDECIDED_RETRY_MS ? fullDiscovery(scope, model) : null;
  const id = (model.choice.current ?? FAST_PATH) as LinkedInStrategy;
  // A list strategy's fast path: the list it found last, while it is still on the page.
  const kept = id !== FAST_PATH && model.list?.isConnected && scope.contains(model.list) ? model.list : null;
  const found = results?.get(id)?.found ?? (kept ? itemsOf(kept, survey(kept)) : FIND[id](scope, survey(scope)));
  model.list = found.list;
  return found.items;
}

/** Full discovery now (the controller calls it on each health tick). Returns each strategy's score, for tests. */
export function rediscoverItems(scope: HTMLElement): Array<{ id: LinkedInStrategy; score: number }> {
  const model = modelFor(scope);
  const results = fullDiscovery(scope, model);
  const winner = results.get((model.choice.current ?? FAST_PATH) as LinkedInStrategy);
  if (winner) model.list = winner.found.list;
  return LINKEDIN_STRATEGIES.flatMap((id) => {
    const r = results.get(id);
    return r ? [{ id, score: r.score }] : [];
  });
}

/** The item containing `node`: its card (today's selector) or the winning list's child. Hot path: O(depth). */
export function itemRootFor(node: Node, scope: HTMLElement): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  const model = models.get(scope);
  if (model?.choice.current && model.choice.current !== FAST_PATH) {
    const list = model.list;
    if (!list || !scope.contains(list)) return null;
    let child: Element = el;
    for (let p = el.parentElement; p; child = p, p = p.parentElement) if (p === list) return child as HTMLElement;
    return null;
  }
  const root = el.closest<HTMLElement>(POST_ROOT_SELECTOR);
  if (!root || !scope.contains(root)) return null;
  // Outermost: a reshared inner post belongs to its outer card.
  const outer = root.parentElement?.closest<HTMLElement>(POST_ROOT_SELECTOR);
  return outer && scope.contains(outer) ? outer : root;
}

/** The winning list's last child when it is empty: LinkedIn's infinite-scroll marker, wherever the list moved. */
export function loadMoreFor(scope: HTMLElement, doc: Document): HTMLElement | null {
  const kept = models.get(scope)?.list;
  const list = kept?.isConnected ? kept : doc.querySelector(SEL.feedList);
  const marker = list?.lastElementChild as HTMLElement | null | undefined;
  return marker && marker.childElementCount === 0 ? marker : null;
}

/** The strategy in use on the last feed seen, or null before any discovery. */
export function discoveryState(): DiscoveryState | null {
  if (!lastModel) return null;
  const strategy = lastModel.choice.current ?? FAST_PATH;
  return { strategy, fallback: strategy !== FAST_PATH };
}
