/**
 * The one balance rule (decision D101; the thresholds are Tom's to confirm), shown wherever a list is: the editor, before
 * a run, on the result and on the Cloud's pages. It warns and never blocks, except a list with no lean at all.
 *
 * Why the sides matter although a result shows at most MAX_SOURCES_PER_BUCKET sources per bucket: each bucket's search
 * is restricted to that bucket's outlets, so the more outlets one side has, the likelier its coverage of a story is
 * found at all, and the other side's shows as a gap.
 */
import { BUCKET_LABELS, LEAN_BUCKETS, type LeanBucket } from '@unalgorithm/protocol';

/** Fewer outlets than this in a bucket warns. */
export const MIN_OUTLETS_PER_BUCKET = 2;
/** One side (Left + Leans left, or Leans right + Right) with more than this many times the other's outlets warns. */
export const MAX_SIDE_RATIO = 2;

export interface ListBalance {
  /** Outlets with a lean, per bucket. */
  counts: Readonly<Record<LeanBucket, number>>;
  /** No outlet has a lean: UnEcho Chamber cannot run on this list. The only case that blocks. */
  empty: boolean;
  /** Plain words, buckets in LEAN_BUCKETS order, then the sides; [] when balanced or empty. */
  warnings: string[];
}

const outlets = (n: number) => `${n} ${n === 1 ? 'outlet' : 'outlets'}`;

export function listBalance(list: { outlets: readonly { lean: { bucket: LeanBucket } | null }[] }): ListBalance {
  const counts: Record<LeanBucket, number> = { left: 0, 'lean-left': 0, center: 0, 'lean-right': 0, right: 0 };
  for (const o of list.outlets) if (o.lean) counts[o.lean.bucket]++;
  const empty = LEAN_BUCKETS.every((b) => counts[b] === 0);
  const warnings: string[] = [];
  if (!empty) {
    for (const b of LEAN_BUCKETS) {
      if (counts[b] === 0) warnings.push(`No outlets in ${BUCKET_LABELS[b]}.`);
      else if (counts[b] < MIN_OUTLETS_PER_BUCKET) warnings.push(`Only ${outlets(counts[b])} in ${BUCKET_LABELS[b]}.`);
    }
    const left = counts.left + counts['lean-left'];
    const right = counts['lean-right'] + counts.right;
    if (Math.max(left, right) > MAX_SIDE_RATIO * Math.min(left, right)) {
      warnings.push(
        `${BUCKET_LABELS.left} and ${BUCKET_LABELS['lean-left']} have ${outlets(left)}, ` +
          `${BUCKET_LABELS['lean-right']} and ${BUCKET_LABELS.right} have ${right}.`,
      );
    }
  }
  return { counts: Object.freeze(counts), empty, warnings };
}
