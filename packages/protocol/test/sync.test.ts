import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_ERROR_CODES,
  compareHlc,
  HLC_ZERO,
  HlcSchema,
  hlcMs,
  maxHlc,
  SYNC_CHANGES_PATH,
  SYNC_ERROR_CODES,
  SYNC_MAX_HLC_AHEAD_MS,
  SYNC_MAX_ITEM_BYTES,
  SYNC_MAX_KEY_LENGTH,
  SYNC_MAX_PUSH_BYTES,
  SYNC_MAX_PUSH_ITEMS,
  SYNC_MAX_WAIT_SECONDS,
  SYNC_PULL_LIMIT,
  SYNC_PUSH_PATH,
  SYNC_REJECT_REASONS,
  SYNC_SPACE_MAX_BYTES,
  SYNC_SPACE_MAX_ITEMS,
  SYNC_SPACES_PATH,
  SyncChangeSchema,
  SyncChangesQuerySchema,
  SyncChangesResponseSchema,
  SyncErrorSchema,
  SyncItemSchema,
  SyncKeySchema,
  SyncPushRequestSchema,
  SyncPushResponseSchema,
  SyncPushResultSchema,
  SyncSpaceSchema,
  SyncSpacesResponseSchema,
  TOMBSTONE_TTL_DAYS,
  tickHlc,
} from '../src/index.ts';

const DEVICE = '0190f5c8-3b1e-7c2a-9d4e-123456789abc';
const SPACE = '0190f5c8-3b1e-7c2a-9d4e-0000000000a1';
const EPOCH = '0190f5c8-3b1e-7c2a-9d4e-0000000000e1';
const PUSH = '0190f5c8-3b1e-7c2a-9d4e-0000000000f1';
const hlc = tickHlc(undefined, DEVICE, 1_760_000_000_000);

const live = { collection: 'settings', key: 'display.mode', hlc, deleted: false, value: 'hide' } as const;
const tombstone = { collection: 'settings', key: 'interests.more.ai-tech', hlc, deleted: true } as const;

describe('HLC helpers', () => {
  it('test_hlc_schema_accepts_stamps_and_rejects_garbage', () => {
    expect(HlcSchema.safeParse(HLC_ZERO).success).toBe(true);
    expect(HlcSchema.safeParse(hlc).success).toBe(true);
    expect(HlcSchema.safeParse(tickHlc(hlc, DEVICE, 1_760_000_000_000)).success).toBe(true);
    for (const bad of ['', 'abc', '000000000:0000:', tickHlc(undefined, 'dev.1', 1000), `${hlc}x:y`]) {
      expect(HlcSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('test_hlc_ms_and_max_hlc', () => {
    expect(hlcMs(tickHlc(undefined, 'd', 1234))).toBe(1234);
    expect(hlcMs(HLC_ZERO)).toBe(0);
    expect(maxHlc(undefined, hlc)).toBe(hlc);
    const pairs: [older: string, newer: string][] = [
      [tickHlc(undefined, 'a', 1000), tickHlc(undefined, 'a', 2000)], // later wall clock
      [tickHlc(undefined, 'a', 1000), tickHlc(tickHlc(undefined, 'a', 1000), 'a', 1000)], // same ms, higher counter
      [tickHlc(undefined, 'a', 1000), tickHlc(undefined, 'b', 1000)], // same ms and counter: the device breaks the tie
      [HLC_ZERO, hlc],
    ];
    for (const [older, newer] of pairs) {
      expect(compareHlc(older, newer)).toBe(-1);
      expect(maxHlc(older, newer)).toBe(newer);
      expect(maxHlc(newer, older)).toBe(newer);
    }
    expect(maxHlc(hlc, hlc)).toBe(hlc);
  });
});

describe('items and changes', () => {
  it('test_sync_item_live_and_tombstone', () => {
    expect(SyncItemSchema.parse(live)).toEqual(live);
    expect(SyncItemSchema.parse(tombstone)).toEqual(tombstone);
    // Any JSON value, null included, is a live value.
    expect(SyncItemSchema.safeParse({ ...live, value: null }).success).toBe(true);
    expect(SyncItemSchema.safeParse({ ...live, value: { on: [1, 'two', true] } }).success).toBe(true);

    const { value: _, ...noValue } = live;
    const key200 = `${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}.${'d'.repeat(5)}`;
    expect(key200).toHaveLength(SYNC_MAX_KEY_LENGTH);
    expect(SyncItemSchema.safeParse({ ...live, key: key200 }).success).toBe(true);
    const rejected: unknown[] = [
      noValue,
      { ...live, value: undefined },
      { ...live, key: 'a..b' },
      { ...live, key: `${key200}d` },
      { ...live, key: 'a/b' },
      { ...live, key: 'display.a/b' },
      { ...live, key: `${'a'.repeat(65)}` },
      { ...live, collection: 'Settings' },
      { ...live, hlc: 'abc' },
      { ...live, deleted: 'false' },
    ];
    for (const item of rejected) expect(SyncItemSchema.safeParse(item).success, JSON.stringify(item)).toBe(false);
  });

  it('test_sync_tombstone_drops_value', () => {
    const parsed = SyncItemSchema.parse({ ...tombstone, value: 'stale' });
    expect(parsed).toEqual(tombstone);
    expect('value' in parsed).toBe(false);
  });

  it('test_sync_change_requires_seq', () => {
    expect(SyncChangeSchema.parse({ ...live, seq: 1 })).toEqual({ ...live, seq: 1 });
    expect(SyncChangeSchema.parse({ ...tombstone, seq: 7 })).toEqual({ ...tombstone, seq: 7 });
    for (const item of [live, tombstone]) {
      expect(SyncChangeSchema.safeParse(item).success).toBe(false);
      for (const seq of [0, -1, 1.5, '3']) expect(SyncChangeSchema.safeParse({ ...item, seq }).success).toBe(false);
    }
  });

  it('test_sync_key_rejects_prototype_segments', () => {
    for (const key of ['a.__proto__.b', 'constructor.prototype.x', 'prototype', '__proto__', 'constructor', 'a.b.constructor']) {
      expect(SyncKeySchema.safeParse(key).success, key).toBe(false);
    }
    for (const key of ['a.constructors', 'prototypes', 'my__proto__', 'display.mode']) {
      expect(SyncKeySchema.safeParse(key).success, key).toBe(true);
    }
  });
});

describe('requests and answers', () => {
  it('test_sync_paths_and_limits', () => {
    expect([SYNC_SPACES_PATH, SYNC_CHANGES_PATH, SYNC_PUSH_PATH]).toEqual([
      '/v1/sync/spaces',
      '/v1/sync/changes',
      '/v1/sync/push',
    ]);
    expect(TOMBSTONE_TTL_DAYS).toBe(90);
    expect({
      SYNC_PULL_LIMIT,
      SYNC_MAX_WAIT_SECONDS,
      SYNC_MAX_PUSH_ITEMS,
      SYNC_MAX_PUSH_BYTES,
      SYNC_MAX_KEY_LENGTH,
      SYNC_MAX_ITEM_BYTES,
      SYNC_SPACE_MAX_ITEMS,
      SYNC_SPACE_MAX_BYTES,
      SYNC_MAX_HLC_AHEAD_MS,
    }).toEqual({
      SYNC_PULL_LIMIT: 500,
      SYNC_MAX_WAIT_SECONDS: 20,
      SYNC_MAX_PUSH_ITEMS: 200,
      SYNC_MAX_PUSH_BYTES: 98_304,
      SYNC_MAX_KEY_LENGTH: 200,
      SYNC_MAX_ITEM_BYTES: 8_192,
      SYNC_SPACE_MAX_ITEMS: 5_000,
      SYNC_SPACE_MAX_BYTES: 2_097_152,
      SYNC_MAX_HLC_AHEAD_MS: 600_000,
    });
    // The push chunking target stays under the server's 128 KiB body limit for /v1.
    expect(SYNC_MAX_PUSH_BYTES).toBeLessThan(128 * 1024);
  });

  it('test_changes_query_coerces_and_bounds', () => {
    expect(SyncChangesQuerySchema.parse({ spaceId: SPACE, epoch: EPOCH, since: '5' })).toEqual({
      spaceId: SPACE,
      epoch: EPOCH,
      since: 5,
      limit: 500,
      wait: 0,
      snapshot: '0',
    });
    const base = { spaceId: SPACE, epoch: EPOCH, since: '0' };
    expect(SyncChangesQuerySchema.parse({ ...base, limit: '500', wait: '20', snapshot: '1' })).toMatchObject({
      since: 0,
      limit: 500,
      wait: 20,
      snapshot: '1',
    });
    const rejected: Record<string, unknown>[] = [
      { ...base, wait: '21' },
      { ...base, limit: '501' },
      { ...base, limit: '0' },
      { ...base, since: '-1' },
      { ...base, since: '1.5' },
      { ...base, since: 'x' },
      { ...base, snapshot: 'true' },
      { spaceId: SPACE, epoch: EPOCH },
      { ...base, spaceId: 'space-1' },
    ];
    for (const q of rejected) expect(SyncChangesQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);

    const answer = {
      v: 1,
      spaceId: SPACE,
      epoch: EPOCH,
      cursor: 7,
      more: false,
      gcFloorHlc: HLC_ZERO,
      items: [
        { ...live, seq: 6 },
        { ...tombstone, seq: 7 },
      ],
    };
    expect(SyncChangesResponseSchema.parse(answer)).toEqual(answer);
    const tooMany = Array.from({ length: SYNC_PULL_LIMIT + 1 }, (_, i) => ({ ...tombstone, seq: i + 1 }));
    expect(SyncChangesResponseSchema.safeParse({ ...answer, items: tooMany }).success).toBe(false);
  });

  it('test_push_request_bounds', () => {
    const push = (items: unknown[], pushId: string = PUSH) => ({ v: 1, spaceId: SPACE, epoch: EPOCH, pushId, items });
    expect(SyncPushRequestSchema.safeParse(push([live])).success).toBe(true);
    expect(SyncPushRequestSchema.safeParse(push(Array(SYNC_MAX_PUSH_ITEMS).fill(tombstone))).success).toBe(true);
    expect(SyncPushRequestSchema.safeParse(push([])).success).toBe(false);
    expect(SyncPushRequestSchema.safeParse(push(Array(SYNC_MAX_PUSH_ITEMS + 1).fill(tombstone))).success).toBe(false);
    expect(SyncPushRequestSchema.safeParse(push([live], 'push-1')).success).toBe(false);
    expect(SyncPushRequestSchema.safeParse({ ...push([live]), v: 2 }).success).toBe(false);
  });

  it('test_push_result_statuses', () => {
    const at = { collection: 'settings', key: 'display.mode' };
    const accepted = [
      { ...at, status: 'applied', seq: 12 },
      { ...at, status: 'stale' },
      ...SYNC_REJECT_REASONS.map((reason) => ({ ...at, status: 'rejected', reason })),
    ];
    for (const r of accepted) expect(SyncPushResultSchema.parse(r)).toEqual(r);
    const rejected = [
      { ...at, status: 'applied' },
      { ...at, status: 'rejected' },
      { ...at, status: 'rejected', reason: 'quota' },
      { ...at, status: 'merged' },
    ];
    for (const r of rejected) expect(SyncPushResultSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
    expect(SyncPushResponseSchema.parse({ v: 1, results: accepted })).toEqual({ v: 1, results: accepted });
  });

  it('test_sync_error_codes_are_their_own', () => {
    expect(SyncErrorSchema.parse({ code: 'resync-required', message: 'Start over from 0.' })).toEqual({
      code: 'resync-required',
      message: 'Start over from 0.',
    });
    expect(SyncErrorSchema.safeParse({ code: 'auth-required', message: 'Sign in again.' }).success).toBe(false);
    expect(SyncErrorSchema.safeParse({ code: 'not-found', message: 'x'.repeat(301) }).success).toBe(false);
    // Sync refusals and AI failures stay separate lists.
    const ai: readonly string[] = AI_ERROR_CODES;
    for (const code of SYNC_ERROR_CODES) expect(ai).not.toContain(code);
  });

  it('test_space_kinds_leave_room_for_org', () => {
    const org = { id: SPACE, kind: 'org', access: 'read', epoch: EPOCH };
    expect(SyncSpaceSchema.parse(org)).toEqual(org);
    expect(SyncSpaceSchema.parse({ ...org, kind: 'user', access: 'read-write' })).toMatchObject({ kind: 'user' });
    expect(SyncSpaceSchema.safeParse({ ...org, kind: 'team' }).success).toBe(false);
    expect(SyncSpaceSchema.safeParse({ ...org, access: 'write' }).success).toBe(false);
    expect(SyncSpacesResponseSchema.parse({ v: 1, spaces: [org] })).toEqual({ v: 1, spaces: [org] });
    expect(SyncSpacesResponseSchema.safeParse({ v: 1, spaces: Array(21).fill(org) }).success).toBe(false);
  });
});

describe('boundaries', () => {
  it('test_sync_contract_imports_only_zod', async () => {
    const source = await readFile(join(import.meta.dirname, '../src/sync.ts'), 'utf8');
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['zod', './hlc.ts']));
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
