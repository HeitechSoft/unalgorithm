/**
 * Keeps a feed's infinite scroll going when most posts are collapsed.
 *
 * LinkedIn loads the next batch when an empty marker at the end of the feed list enters a zone around the screen
 * (an IntersectionObserver with a large bottom margin). Normally each batch pushes the marker far down, out of that
 * zone, and scrolling brings it back in. When most of a batch collapses to one-line stubs, the marker only moves a
 * few hundred pixels, never leaves the zone, never "re-enters", and loading stalls: it looks like the end of the
 * feed until you reload.
 *
 * Observed on the live LinkedIn feed (2026-10-08): with the marker stuck on screen and no load for several frames,
 * hiding it for one frame and showing it again made LinkedIn load the next batch. That is the "re-arm" below.
 */

/** Marker counts as "near" (likely inside the platform's load zone) within this many screens below the view. */
export const NEAR_SCREENS = 1.5;
/** Wait this long after the last batch arrived before deciding loading has stalled. */
export const SETTLE_MS = 1500;
/** Minimum time between re-arms. */
export const REARM_GAP_MS = 2000;
/** Stop after this many re-arms in a row that bring no visible posts, until you scroll again. */
export const MAX_FRUITLESS = 10;
/** Only re-arm while you are actively scrolling (or just did). */
export const ACTIVE_MS = 30_000;

export interface RearmState {
  markerTop: number;
  viewBottom: number;
  viewHeight: number;
  now: number;
  lastGrowthAt: number;
  lastRearmAt: number;
  lastUserScrollAt: number;
  fruitless: number;
}

/** Decide whether loading has stalled with the marker near the bottom, and it is worth nudging the platform. */
export function shouldRearm(s: RearmState): boolean {
  const near = s.markerTop < s.viewBottom + s.viewHeight * NEAR_SCREENS;
  return (
    near &&
    s.now - s.lastGrowthAt >= SETTLE_MS &&
    s.now - s.lastRearmAt >= REARM_GAP_MS &&
    s.now - s.lastUserScrollAt <= ACTIVE_MS &&
    s.fruitless < MAX_FRUITLESS
  );
}

const nextFrame = (cb: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16);

/** Hide the marker for a couple of frames so the platform's observer sees it leave and re-enter. */
export function rearmMarker(marker: HTMLElement): void {
  marker.style.setProperty('display', 'none', 'important');
  nextFrame(() => nextFrame(() => marker.style.removeProperty('display')));
}
