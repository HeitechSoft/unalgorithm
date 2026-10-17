/** The one balance rule (P3-72, decision D101): warn, never block, except a list with no lean. */
import type { LeanBucket } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { listBalance, MAX_SIDE_RATIO, MIN_OUTLETS_PER_BUCKET } from '../src/index.ts';
import { FIXTURE_LIST } from '../src/testing/fixture.ts';

/** A list with `counts[bucket]` outlets in each bucket, plus `unlabelled` outlets with no lean. */
function listOf(counts: Partial<Record<LeanBucket, number>>, unlabelled = 0) {
  const outlets: { lean: { bucket: LeanBucket } | null }[] = [];
  for (const [bucket, n] of Object.entries(counts) as [LeanBucket, number][]) {
    for (let i = 0; i < n; i++) outlets.push({ lean: { bucket } });
  }
  for (let i = 0; i < unlabelled; i++) outlets.push({ lean: null });
  return { outlets };
}

const BALANCED = { left: 2, 'lean-left': 2, center: 2, 'lean-right': 2, right: 2 };
const sideWarning = (warnings: string[]) => warnings.filter((w) => w.startsWith('Left and Leans left'));

describe('balance', () => {
  it('test_balance_fixture_is_balanced', () => {
    expect(MIN_OUTLETS_PER_BUCKET).toBe(2);
    expect(MAX_SIDE_RATIO).toBe(2);
    expect(listBalance(FIXTURE_LIST)).toEqual({
      counts: { left: 2, 'lean-left': 2, center: 2, 'lean-right': 2, right: 2 },
      empty: false,
      warnings: [],
    });
  });

  it('test_balance_warnings_in_plain_words', () => {
    const lopsided = listBalance(listOf({ left: 5, 'lean-left': 4, center: 3, 'lean-right': 1, right: 1 }, 7));
    expect(lopsided.counts).toEqual({ left: 5, 'lean-left': 4, center: 3, 'lean-right': 1, right: 1 });
    expect(lopsided.empty).toBe(false);
    expect(lopsided.warnings).toEqual([
      'Only 1 outlet in Leans right.',
      'Only 1 outlet in Right.',
      'Left and Leans left have 9 outlets, Leans right and Right have 2.',
    ]);

    expect(listBalance(listOf({ ...BALANCED, 'lean-right': 3, right: 0 })).warnings).toEqual(['No outlets in Right.']);
    expect(listBalance(listOf({ center: 4 })).warnings).toEqual([
      'No outlets in Left.',
      'No outlets in Leans left.',
      'No outlets in Leans right.',
      'No outlets in Right.',
    ]);
    // "1 outlet", singular, on the left side's count.
    expect(sideWarning(listBalance(listOf({ left: 1, center: 2, 'lean-right': 2, right: 2 })).warnings)).toEqual([
      'Left and Leans left have 1 outlet, Leans right and Right have 4.',
    ]);
  });

  it('test_balance_side_ratio_edges', () => {
    // 4 against 2: exactly twice, no side warning.
    expect(listBalance(listOf({ ...BALANCED, right: 0 })).warnings).toEqual(['No outlets in Right.']);
    expect(sideWarning(listBalance(listOf({ left: 2, 'lean-left': 2, center: 2, 'lean-right': 2 })).warnings)).toEqual([]);
    // 5 against 2: more than twice.
    expect(sideWarning(listBalance(listOf({ ...BALANCED, left: 3, 'lean-right': 0 })).warnings)).toEqual([
      'Left and Leans left have 5 outlets, Leans right and Right have 2.',
    ]);
    // 3 against 0, either way round.
    expect(sideWarning(listBalance(listOf({ left: 2, 'lean-left': 1, center: 2 })).warnings)).toEqual([
      'Left and Leans left have 3 outlets, Leans right and Right have 0.',
    ]);
    expect(sideWarning(listBalance(listOf({ 'lean-right': 1, right: 2, center: 2 })).warnings)).toEqual([
      'Left and Leans left have 0 outlets, Leans right and Right have 3.',
    ]);
    // Center counts on neither side.
    expect(sideWarning(listBalance(listOf({ ...BALANCED, center: 40 })).warnings)).toEqual([]);
  });

  it('test_balance_empty_list_blocks', () => {
    for (const list of [listOf({}), listOf({}, 12), { outlets: [] }]) {
      const balance = listBalance(list);
      expect(balance.empty).toBe(true);
      expect(balance.warnings).toEqual([]);
      expect(balance.counts).toEqual({ left: 0, 'lean-left': 0, center: 0, 'lean-right': 0, right: 0 });
    }
    expect(Object.isFrozen(listBalance(FIXTURE_LIST).counts)).toBe(true);
  });
});
