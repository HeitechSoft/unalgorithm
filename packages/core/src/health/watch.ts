import type { HealthWatch } from '../health.ts';
import type { PostData } from '../post.ts';

/**
 * What the breakage checks keep about one item over a page load: flags, ids and an in-memory hash, never content. The
 * feed controller keeps one per post (by its key), so a post the platform re-renders or re-reads counts once.
 */
export interface ItemFacts {
  kind: 'post' | 'module' | 'ignore';
  sponsored?: boolean;
  /** Hash of a near-miss ad label (`PostData.quality.adNearMiss`): in memory only, never sent. */
  adNearMiss?: string;
  adCue?: boolean;
  headerKnown?: boolean;
  headerUnknown?: boolean;
  /** Ids of the detectors that saw something (`Evidence.detector`), each once. */
  detectors?: readonly string[];
  /** Observation ids from the adapter (`InspectResult.observations`), each once. */
  observations?: readonly string[];
}

/** The facts of a post as read: its flags and each detector once. */
export function postFacts(post: PostData, observations: readonly string[] = []): ItemFacts {
  const q = post.quality;
  return {
    kind: 'post',
    sponsored: post.signals.sponsored,
    ...(q.adNearMiss ? { adNearMiss: q.adNearMiss } : {}),
    ...(q.adCue ? { adCue: true } : {}),
    ...(q.headerKnown ? { headerKnown: true } : {}),
    ...(q.headerUnknown ? { headerUnknown: true } : {}),
    detectors: [...new Set(post.evidence.map((e) => e.detector))],
    observations: [...new Set(observations)],
  };
}

/** Scrolling since the last new item, from the controller (see `HealthWatch`). */
export type ScrollWatch = Pick<HealthWatch, 'scrolledScreens' | 'grownScreens' | 'newItemsWhileScrolling'>;

const NO_SCROLL: ScrollWatch = { scrolledScreens: 0, grownScreens: 0, newItemsWhileScrolling: 0 };

/** Fold a page load's item facts into the counts `evaluateHealth` watches. */
export function watchFrom(facts: Iterable<ItemFacts>, scroll: ScrollWatch = NO_SCROLL): HealthWatch {
  const w: HealthWatch = {
    ...scroll,
    postsSeen: 0,
    sponsoredSeen: 0,
    nearMissRepeat: 0,
    adCueOnly: 0,
    headersKnown: 0,
    headersUnknown: 0,
  };
  const nearMiss = new Map<string, number>();
  for (const f of facts) {
    if (f.kind !== 'post') continue;
    w.postsSeen++;
    if (f.sponsored) w.sponsoredSeen++;
    else if (f.adCue) w.adCueOnly++;
    if (f.headerKnown) w.headersKnown++;
    if (f.headerUnknown) w.headersUnknown++;
    if (f.adNearMiss) {
      const n = (nearMiss.get(f.adNearMiss) ?? 0) + 1;
      nearMiss.set(f.adNearMiss, n);
      if (n > w.nearMissRepeat) w.nearMissRepeat = n;
    }
  }
  return w;
}

/** How many items on the page load hold several posts (`*.item.multi-post`). */
export function multiPostCount(facts: Iterable<ItemFacts>): number {
  let n = 0;
  for (const f of facts) if (f.observations?.some((o) => o.endsWith('.item.multi-post'))) n++;
  return n;
}

/** How often each id was seen over the facts (each item counts an id once). */
export function tallyIds(facts: Iterable<ItemFacts>, field: 'detectors' | 'observations'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of facts) for (const id of f[field] ?? []) out[id] = (out[id] ?? 0) + 1;
  return out;
}
