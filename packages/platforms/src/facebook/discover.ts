import { chooseStrategy, NO_STRATEGY, repeatedList, SAMPLE_SIZE, type StrategyChoice, scoreModel } from '../shared/structure.ts';
import type { DiscoveryState } from '../types.ts';
import type { FacebookStrategy } from './ids.ts';
import { FB_SEL } from './selectors.ts';
import { isEmptySlot, itemAnatomy } from './slots.ts';

/**
 * How the Facebook adapter finds the feed's items (ADR 0009 §9, phase B). Several strategies each find the list whose
 * children are the feed items, cheapest first. Full discovery scores every strategy on a sample of items and keeps
 * the winner; every scan then runs only the winner (the fast path). When Facebook changes its markup, a strategy that
 * reads structure rather than hooks takes over, the page goes into cautious mode, and reports name the strategy.
 * Read-only: nothing here changes the page.
 */

/** The two layouts unAlgorithm was written for, before and since 2026. Any other winner is a fallback. */
const PRIMARY: readonly FacebookStrategy[] = ['fb.items.role-feed', 'fb.items.heading-list'];

/** Posts climbed from when looking for the list after a heading: if these don't find it, later ones won't. */
const CLIMB_POSTS = 20;

/** Within a few siblings after a heading: the 2026 list follows a screen-reader "Feed posts" h3 and a spacer. */
function afterHeading(el: Element): boolean {
  let s = el.previousElementSibling;
  for (let i = 0; s && i < 3; i++, s = s.previousElementSibling) if (s.matches('h2, h3')) return true;
  return false;
}

/** Until 2026: the outermost `[role="feed"]` lists. */
function roleFeed(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FB_SEL.feed)).filter((el) => !el.parentElement?.closest(FB_SEL.feed));
}

/** Since 2026: the unlabelled block right after a heading, not inside a post, holding posts; climbed to from a post. */
function headingList(root: Element): HTMLElement[] {
  const posts = Array.from(root.querySelectorAll(FB_SEL.post)).slice(0, CLIMB_POSTS);
  for (const post of posts) {
    for (let el = post.parentElement; el && el !== root; el = el.parentElement) {
      if (afterHeading(el) && !el.closest(FB_SEL.post) && el.querySelector(FB_SEL.post)) return [el];
    }
  }
  return [];
}

/** The repeated list the post markers sit in, wherever it is and whatever comes before it. */
function posinset(root: Element): HTMLElement[] {
  const found = repeatedList(root, Array.from(root.querySelectorAll(FB_SEL.post)));
  return found ? [found.list as HTMLElement] : [];
}

/** Share and Send buttons by name (English; the `share_button` hook goes first). */
const SHARE = /^(share|send)\b/i;

/**
 * The repeated list a post's own parts sit in: its Like button, its Share or Send button, its author's name. Each kind
 * of anchor appears once per post, so a part of one post can never pass for the list; the kind that finds the most
 * items wins, the first on a tie.
 */
function anatomy(root: Element): HTMLElement[] {
  const share = [
    ...Array.from(root.querySelectorAll(FB_SEL.shareButton)),
    ...Array.from(root.querySelectorAll('[role="button"][aria-label], button[aria-label]')).filter((b) =>
      SHARE.test(b.getAttribute('aria-label') ?? ''),
    ),
  ];
  let best: { list: Element; items: Element[] } | null = null;
  for (const anchors of [
    Array.from(root.querySelectorAll(FB_SEL.likeButton)),
    share,
    Array.from(root.querySelectorAll(FB_SEL.profileName)),
  ]) {
    const found = repeatedList(root, anchors);
    if (found && (!best || found.items.length > best.items.length)) best = found;
  }
  return best ? [best.list as HTMLElement] : [];
}

/** Cheapest first: on a tie the cheaper strategy wins. */
const STRATEGIES: ReadonlyArray<{ id: FacebookStrategy; find: (root: Element) => HTMLElement[] }> = [
  { id: 'fb.items.role-feed', find: roleFeed },
  { id: 'fb.items.heading-list', find: headingList },
  { id: 'fb.items.posinset', find: posinset },
  { id: 'fb.items.anatomy', find: anatomy },
];

interface State {
  doc: Document | null;
  choice: StrategyChoice;
  /** The strategy in use: the chosen one, or before any strategy scores, the cheapest that found a list. */
  strategy: FacebookStrategy | null;
  lists: HTMLElement[];
  listSet: Set<Element>;
}

/** One page at a time: the adapter is a single object per content script. */
const state: State = { doc: null, choice: NO_STRATEGY, strategy: null, lists: [], listSet: new Set() };

function use(strategy: FacebookStrategy | null, lists: HTMLElement[]): HTMLElement[] {
  state.strategy = strategy;
  state.lists = lists;
  state.listSet = new Set(lists);
  return lists;
}

/** Where the feed is looked for: the main column, or the whole page when nothing is found there. */
function rootsOf(doc: Document): Element[] {
  const main = doc.querySelector('[role="main"]');
  return main ? [main, doc.body] : [doc.body];
}

/**
 * How well the lists hold posts, from 0 to 1, over their first SAMPLE_SIZE children with content: every strategy is
 * sampled the same way, so two strategies that find the same list score the same.
 */
function score(lists: readonly HTMLElement[], cache: Map<Element, ReturnType<typeof itemAnatomy>>): number {
  const sample: Element[] = [];
  for (const list of lists) {
    for (const child of Array.from(list.children)) {
      if (sample.length >= SAMPLE_SIZE) break;
      if (child.tagName === 'UNALGO-POST' || isEmptySlot(child)) continue;
      sample.push(child);
    }
  }
  return scoreModel(
    sample.map((item) => {
      let a = cache.get(item);
      if (!a) cache.set(item, (a = itemAnatomy(item)));
      return a;
    }),
  );
}

/**
 * Full discovery: every strategy, scored. The first discovery on a page takes the best (the cheaper on a tie); after
 * that, another strategy takes over only after beating the current one by SWITCH_MARGIN on SWITCH_TICKS discoveries
 * in a row. Two exceptions start over: a new page or a re-created feed (the lists in use are gone), and a current
 * strategy that no longer finds a scorable feed, which would otherwise leave the page with nothing.
 */
export function discover(doc: Document): HTMLElement[] {
  if (state.doc !== doc || !state.lists.some((l) => l.isConnected)) {
    state.doc = doc;
    state.choice = NO_STRATEGY;
  }
  let found: Array<{ id: FacebookStrategy; lists: HTMLElement[] }> = [];
  for (const root of rootsOf(doc)) {
    found = STRATEGIES.map((s) => ({ id: s.id, lists: s.find(root) }));
    if (found.some((f) => f.lists.length)) break;
  }
  const cache = new Map<Element, ReturnType<typeof itemAnatomy>>();
  const scores = found.map((f) => ({ id: f.id, score: f.lists.length ? score(f.lists, cache) : 0 }));
  const current = state.choice.current;
  if (current && !scores.some((s) => s.id === current && s.score > 0)) state.choice = NO_STRATEGY;
  state.choice = chooseStrategy(state.choice, scores);
  const chosen = found.find((f) => f.id === state.choice.current) ?? found.find((f) => f.lists.length);
  return use(chosen?.id ?? null, chosen?.lists ?? []);
}

/**
 * The feed lists, for every scan: the strategy in use runs alone (the fast path). Full discovery runs on a new page,
 * when the lists in use are gone, or when that strategy finds nothing.
 */
export function itemLists(doc: Document): HTMLElement[] {
  const strategy = STRATEGIES.find((s) => s.id === state.strategy);
  if (state.doc !== doc || !strategy || !state.lists.some((l) => l.isConnected)) return discover(doc);
  for (const root of rootsOf(doc)) {
    const lists = strategy.find(root);
    if (lists.length) return use(strategy.id, lists);
  }
  return discover(doc);
}

/** The lists found last, for `itemRootOf` (the hot path never runs discovery). */
export function knownLists(): ReadonlySet<Element> {
  return state.listSet;
}

/** A feed list as the home feed draws it: `[role="feed"]`, the list after a heading, or at least 3 posts. Cheap. */
export function hasFeedList(doc: Document): boolean {
  return !!doc.querySelector(FB_SEL.feed) || doc.querySelectorAll(FB_SEL.post).length >= 3 || headingList(doc.body).length > 0;
}

/** The strategy in use and whether it is a fallback, or null before any list was found. */
export function discoveryState(): DiscoveryState | null {
  return state.strategy ? { strategy: state.strategy, fallback: !PRIMARY.includes(state.strategy) } : null;
}
