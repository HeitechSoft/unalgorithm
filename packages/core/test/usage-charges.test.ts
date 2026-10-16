/**
 * What a billing server charged per batch (CL6-03, R35): the precise formatter for sub-cent charges, and the day's
 * charged batches in the device's usage ledger.
 */
import { ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { dateKey, emptyDay, formatCharge, MAX_DAY_BATCHES, recordUsage, type UsageLedger } from '../src/index.ts';

const NOW = new Date(2026, 9, 16, 9);
const LATER = new Date(2026, 9, 16, 10);
const DAY = dateKey(NOW);

describe('formatting', () => {
  it('test_format_charge_vectors', () => {
    const cases: [number, string][] = [
      [0, '$0.00'],
      [-5, '$0.00'],
      [49, '<$0.0001'],
      [50, '$0.0001'],
      [1_752, '$0.0018'],
      [9_899, '$0.0099'],
      [9_950, '$0.01'],
      [146_000, '$0.15'],
      [1_234_567_890, '$1,234.57'],
    ];
    for (const [micros, text] of cases) expect([micros, formatCharge(micros)]).toStrictEqual([micros, text]);
  });
});

describe('usage ledger', () => {
  it('test_record_usage_adds_batch_charges', () => {
    let ledger = recordUsage({}, { model: 'server', usage: ZERO_USAGE, posts: 12, chargedMicros: 1_752, now: NOW });
    expect(ledger[DAY]?.chargedMicros).toBe(1_752);
    expect(ledger[DAY]?.batches).toStrictEqual([{ at: NOW.toISOString(), posts: 12, chargedMicros: 1_752 }]);

    ledger = recordUsage(ledger, { model: 'server', usage: ZERO_USAGE, posts: 3, chargedMicros: 438, now: LATER });
    expect(ledger[DAY]?.chargedMicros).toBe(2_190);
    expect(ledger[DAY]?.batches).toStrictEqual([
      { at: LATER.toISOString(), posts: 3, chargedMicros: 438 },
      { at: NOW.toISOString(), posts: 12, chargedMicros: 1_752 },
    ]);
    expect(ledger[DAY]).toMatchObject({ posts: 15, calls: 2, failedCalls: 0 });
  });

  it('test_record_usage_keeps_50_batches', () => {
    let ledger: UsageLedger = {};
    let sum = 0;
    for (let i = 1; i <= 51; i++) {
      sum += i * 10;
      ledger = recordUsage(ledger, {
        model: 'server',
        usage: ZERO_USAGE,
        posts: 1,
        chargedMicros: i * 10,
        now: new Date(NOW.getTime() + i * 1000),
      });
    }
    const batches = ledger[DAY]?.batches ?? [];
    expect(MAX_DAY_BATCHES).toBe(50);
    expect(batches).toHaveLength(50);
    expect(batches.map((b) => b.chargedMicros)).toStrictEqual(Array.from({ length: 50 }, (_, i) => (51 - i) * 10));
    expect(ledger[DAY]?.chargedMicros).toBe(sum);
  });

  it('test_record_usage_ignores_bad_charges', () => {
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 60]) {
      const ledger = recordUsage({}, { model: 'server', usage: ZERO_USAGE, posts: 2, chargedMicros: bad, now: NOW });
      expect(ledger[DAY]).not.toHaveProperty('chargedMicros');
      expect(ledger[DAY]).not.toHaveProperty('batches');
    }

    // No charge on a day without charges: the day has exactly its four fields, as before.
    const plain = recordUsage({}, { model: 'm', usage: ZERO_USAGE, posts: 2, now: NOW });
    expect(plain[DAY]).toStrictEqual({ ...emptyDay(), posts: 2, calls: 1, byModel: { m: { calls: 1, usage: ZERO_USAGE } } });

    // A failed call (no charge) and an own-key call the same day keep the day's charges.
    let ledger = recordUsage({}, { model: 'server', usage: ZERO_USAGE, posts: 12, chargedMicros: 1_752, now: NOW });
    ledger = recordUsage(ledger, { model: 'server', usage: ZERO_USAGE, posts: 3, chargedMicros: 438, now: LATER });
    const batches = ledger[DAY]?.batches;
    ledger = recordUsage(ledger, { model: 'server', usage: ZERO_USAGE, posts: 0, failed: true, now: LATER });
    ledger = recordUsage(ledger, { model: 'claude-haiku-5-5', usage: ZERO_USAGE, posts: 1, now: LATER });
    expect(ledger[DAY]?.chargedMicros).toBe(2_190);
    expect(ledger[DAY]?.batches).toStrictEqual(batches);
    expect(ledger[DAY]?.batches).toHaveLength(2);
    expect(ledger[DAY]).toMatchObject({ calls: 4, failedCalls: 1 });
  });
});
