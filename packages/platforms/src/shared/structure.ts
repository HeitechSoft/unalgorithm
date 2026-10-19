/**
 * Pure helpers for finding feed items by their structure rather than by class names or test ids (ADR 0009 §9, phase
 * B). Each adapter has a few discovery strategies, cheapest first; these score them on a sample of items and decide
 * when another one takes over. Read-only: nothing here changes the page.
 */

/** At most this many anchors are walked, so discovery stays within its few-millisecond budget on a long feed. */
export const MAX_LIST_ANCHORS = 80;
/** Items sampled to score a strategy. */
export const SAMPLE_SIZE = 10;
/** A strategy takes over only when it beats the current one by this much... */
export const SWITCH_MARGIN = 0.15;
/** ...on this many discoveries in a row (the health ticks, 10 s apart). */
export const SWITCH_TICKS = 2;

export interface RepeatedList {
  /** The element whose children are the items. */
  list: Element;
  /** Its children that hold an anchor, in page order. */
  items: Element[];
}

/**
 * The repeated list the anchors sit in: the element inside `within` with the most children holding an anchor (at least
 * `min` of them), such as the feed list when the anchors are every post's menu button. On a tie the outer one wins.
 * Anchors outside `within` are ignored; only the first MAX_LIST_ANCHORS are walked.
 */
export function repeatedList(within: Element, anchors: readonly Element[], min = 3): RepeatedList | null {
  const holders = new Map<Element, Set<Element>>();
  for (const anchor of anchors.slice(0, MAX_LIST_ANCHORS)) {
    if (anchor === within || !within.contains(anchor)) continue;
    let child: Element = anchor;
    for (let parent = anchor.parentElement; parent; child = parent, parent = parent.parentElement) {
      let set = holders.get(parent);
      if (!set) holders.set(parent, (set = new Set()));
      set.add(child);
      if (parent === within) break;
    }
  }
  let best: Element | null = null;
  let bestCount = 0;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const [parent, set] of holders) {
    if (set.size < min || set.size < bestCount) continue;
    const depth = depthIn(within, parent);
    if (set.size > bestCount || depth < bestDepth) {
      best = parent;
      bestCount = set.size;
      bestDepth = depth;
    }
  }
  if (!best) return null;
  const set = holders.get(best) as Set<Element>;
  return { list: best, items: Array.from(best.children).filter((c) => set.has(c)) };
}

function depthIn(root: Element, el: Element): number {
  let depth = 0;
  for (let p: Element | null = el; p && p !== root; p = p.parentElement) depth++;
  return depth;
}

/** How alike two sets are: shared members over all members (1 when both are empty). */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const x of left) if (right.has(x)) shared++;
  return shared / (left.size + right.size - shared);
}

/** What an item looks like: a real post has an author, an action bar, an age, a menu and some text. */
export interface ItemAnatomy {
  author: boolean;
  actionBar: boolean;
  ageSlot: boolean;
  menu: boolean;
  text: boolean;
}

/** An author and an action bar tell a post from a comment or a panel best, so they weigh most. */
export const ANATOMY_WEIGHTS: Readonly<Record<keyof ItemAnatomy, number>> = Object.freeze({
  author: 0.25,
  actionBar: 0.25,
  ageSlot: 0.2,
  menu: 0.15,
  text: 0.15,
});

/** How post-like one item is, from 0 to 1. */
export function anatomyScore(item: ItemAnatomy): number {
  let score = 0;
  for (const [part, weight] of Object.entries(ANATOMY_WEIGHTS) as [keyof ItemAnatomy, number][]) {
    if (item[part]) score += weight;
  }
  return Math.round(score * 1000) / 1000;
}

/**
 * How well a strategy found posts, from 0 to 1: the mean anatomy of its first SAMPLE_SIZE items, or 0 when it found
 * fewer than `min` (a strategy that finds two things hasn't found the feed).
 */
export function scoreModel(sample: readonly ItemAnatomy[], min = 3): number {
  if (sample.length < min) return 0;
  const items = sample.slice(0, SAMPLE_SIZE);
  return Math.round((items.reduce((sum, item) => sum + anatomyScore(item), 0) / items.length) * 1000) / 1000;
}

/** Which strategy is in use, and a challenger's run of wins. */
export interface StrategyChoice {
  current: string | null;
  challenger: string | null;
  streak: number;
}

export const NO_STRATEGY: StrategyChoice = Object.freeze({ current: null, challenger: null, streak: 0 });

/**
 * The strategy to use after one full discovery. `scores` are in the adapter's order, cheapest first; on a tie the
 * cheaper one is best. The first discovery takes the best (if it found anything); after that, another strategy takes
 * over only when it beats the current one by SWITCH_MARGIN on SWITCH_TICKS discoveries in a row, so one odd scan
 * never flips the page's item model.
 */
export function chooseStrategy(state: StrategyChoice, scores: ReadonlyArray<{ id: string; score: number }>): StrategyChoice {
  let best: { id: string; score: number } | undefined;
  for (const s of scores) if (!best || s.score > best.score) best = s;
  if (!best) return state;
  if (state.current === null) return best.score > 0 ? { current: best.id, challenger: null, streak: 0 } : state;
  if (best.id === state.current) return { ...state, challenger: null, streak: 0 };
  const current = scores.find((s) => s.id === state.current)?.score ?? 0;
  // A small epsilon, so a lead of exactly SWITCH_MARGIN counts despite floating point (0.6 + 0.15).
  if (best.score - current < SWITCH_MARGIN - 1e-9) return { ...state, challenger: null, streak: 0 };
  const streak = state.challenger === best.id ? state.streak + 1 : 1;
  return streak >= SWITCH_TICKS ? { current: best.id, challenger: null, streak: 0 } : { ...state, challenger: best.id, streak };
}
