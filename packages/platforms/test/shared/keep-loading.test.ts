import { describe, expect, it } from 'vitest';
import { MAX_FRUITLESS, type RearmState, shouldRearm } from '../../src/shared/keep-loading.ts';

const base: RearmState = {
  markerTop: 900,
  viewBottom: 800,
  viewHeight: 800,
  now: 100_000,
  lastGrowthAt: 90_000,
  lastRearmAt: 0,
  lastUserScrollAt: 99_000,
  fruitless: 0,
};

describe('shouldRearm', () => {
  it('re-arms when loading stalled with the marker near the bottom while scrolling', () => {
    expect(shouldRearm(base)).toBe(true);
  });

  it('waits for a batch to settle, spaces re-arms, needs recent scrolling and gives up after fruitless tries', () => {
    expect(shouldRearm({ ...base, lastGrowthAt: 99_500 })).toBe(false);
    expect(shouldRearm({ ...base, lastRearmAt: 99_000 })).toBe(false);
    expect(shouldRearm({ ...base, lastUserScrollAt: 0 })).toBe(false);
    expect(shouldRearm({ ...base, fruitless: MAX_FRUITLESS })).toBe(false);
    expect(shouldRearm({ ...base, markerTop: 5000 })).toBe(false);
  });
});
