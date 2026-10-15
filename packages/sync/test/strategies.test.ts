import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatHlc, type SyncItem } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  type DecideContext,
  type Decision,
  decide,
  defineCollection,
  type Incoming,
  isExpired,
  itemBytes,
  type MergeStrategy,
  type StoredState,
} from '../src/index.ts';

const DEVICE = '0190f5c8-3b1e-7c2a-9d4e-123456789abc';
const OTHER_DEVICE = '0190f5c8-3b1e-7c2a-9d4e-cba987654321';
const CTX: DecideContext = { deviceId: DEVICE, now: 1_760_000_000_000 };

/** A stamp at `ms` from `device`; a higher `ms` (or counter) is a later edit. */
function hlc(ms: number, counter = 0, device = DEVICE): string {
  return formatHlc({ ms, counter, device });
}

function stored(at: string, deleted = false, extra: Partial<StoredState> = {}): StoredState {
  return { hlc: at, deleted, deviceId: DEVICE, expiresAt: null, ...extra };
}

function incoming(at: string, deleted = false, key = 'display.mode'): Incoming {
  return { key, hlc: at, deleted };
}

const WRITE: Decision = { kind: 'write', expiresAt: null };
const STALE: Decision = { kind: 'stale' };

interface LwwCase {
  name: string;
  stored: StoredState | undefined;
  incoming: Incoming;
  expected: Decision;
}

/** The six last-writer-wins cases (AC 2), shared by every strategy that follows the LWW rule. */
function lwwCases(key = 'display.mode'): LwwCase[] {
  return [
    { name: 'no stored item', stored: undefined, incoming: incoming(hlc(2000), false, key), expected: WRITE },
    { name: 'a newer HLC', stored: stored(hlc(2000)), incoming: incoming(hlc(2000, 1), false, key), expected: WRITE },
    { name: 'an older HLC', stored: stored(hlc(2000)), incoming: incoming(hlc(1999, 5), false, key), expected: STALE },
    { name: 'an equal HLC', stored: stored(hlc(2000)), incoming: incoming(hlc(2000), false, key), expected: STALE },
    {
      name: 'a newer tombstone over a value',
      stored: stored(hlc(2000)),
      incoming: incoming(hlc(3000), true, key),
      expected: WRITE,
    },
    {
      name: 'an older value over a tombstone',
      stored: stored(hlc(3000), true),
      incoming: incoming(hlc(2000), false, key),
      expected: STALE,
    },
  ];
}

describe('last writer wins', () => {
  it('test_lww_map_decisions', () => {
    for (const c of lwwCases()) {
      expect(decide('lww-map', c.stored, c.incoming, CTX), c.name).toEqual(c.expected);
    }
    // A newer edit wins over an older delete too, and the device that wrote either side does not matter.
    expect(decide('lww-map', stored(hlc(2000), true), incoming(hlc(2001, 0, OTHER_DEVICE)), CTX)).toEqual(WRITE);
    // The counter and then the device id break ties within one millisecond, as compareHlc orders them.
    expect(decide('lww-map', stored(hlc(2000, 0, 'a')), incoming(hlc(2000, 0, 'b')), CTX)).toEqual(WRITE);
    expect(decide('lww-map', stored(hlc(2000, 0, 'b')), incoming(hlc(2000, 0, 'a')), CTX)).toEqual(STALE);
  });

  describe.each(lwwCases())('test_lww_doc_matches_lww_map: $name', (c) => {
    it('decides as lww-map does', () => {
      expect(decide('lww-doc', c.stored, c.incoming, CTX)).toEqual(c.expected);
      expect(decide('lww-doc', c.stored, c.incoming, CTX)).toEqual(decide('lww-map', c.stored, c.incoming, CTX));
    });
  });
});

describe('per-device and ttl', () => {
  it('test_per_device_only_own_key', () => {
    for (const c of lwwCases(DEVICE)) {
      expect(decide('per-device', c.stored, c.incoming, CTX), c.name).toEqual(c.expected);
    }
    const notOwn: Decision = { kind: 'reject', reason: 'not-own-device' };
    expect(decide('per-device', undefined, incoming(hlc(2000), false, OTHER_DEVICE), CTX)).toEqual(notOwn);
    expect(decide('per-device', stored(hlc(1000)), incoming(hlc(2000), false, OTHER_DEVICE), CTX)).toEqual(notOwn);
    expect(decide('per-device', stored(hlc(1000)), incoming(hlc(2000), true, OTHER_DEVICE), CTX)).toEqual(notOwn);
    // Another device's id as a prefix or a path is still not this device's key.
    expect(decide('per-device', undefined, incoming(hlc(2000), false, `${DEVICE}.name`), CTX)).toEqual(notOwn);
  });

  it('test_ttl_cache_expiry_and_no_tombstones', () => {
    const ctx: DecideContext = { deviceId: DEVICE, now: 1000, ttlMs: 500 };
    const invalid: Decision = { kind: 'reject', reason: 'invalid' };
    expect(decide('ttl-cache', undefined, incoming(hlc(900), true), ctx)).toEqual(invalid);
    expect(decide('ttl-cache', stored(hlc(100), false, { expiresAt: 1200 }), incoming(hlc(900), true), ctx)).toEqual(invalid);

    expect(decide('ttl-cache', undefined, incoming(hlc(900)), ctx)).toEqual({ kind: 'write', expiresAt: 1500 });
    // An unexpired item: only a newer HLC replaces it, and the write starts a fresh TTL.
    const live = stored(hlc(900), false, { expiresAt: 1200 });
    expect(decide('ttl-cache', live, incoming(hlc(800)), ctx)).toEqual(STALE);
    expect(decide('ttl-cache', live, incoming(hlc(900)), ctx)).toEqual(STALE);
    expect(decide('ttl-cache', live, incoming(hlc(950)), ctx)).toEqual({ kind: 'write', expiresAt: 1500 });
    // An expired item (expiresAt <= now) is replaced by any write, even one with an older HLC.
    expect(decide('ttl-cache', stored(hlc(900), false, { expiresAt: 1000 }), incoming(hlc(800)), ctx)).toEqual({
      kind: 'write',
      expiresAt: 1500,
    });
    expect(decide('ttl-cache', stored(hlc(900), false, { expiresAt: 999 }), incoming(hlc(800)), ctx)).toEqual({
      kind: 'write',
      expiresAt: 1500,
    });

    expect(isExpired({ expiresAt: null }, 1000)).toBe(false);
    expect(isExpired({ expiresAt: 1001 }, 1000)).toBe(false);
    expect(isExpired({ expiresAt: 1000 }, 1000)).toBe(true);
    expect(isExpired({ expiresAt: 999 }, 1000)).toBe(true);

    // A ttl-cache decision without its TTL is a programming error, never an item that lives forever.
    expect(() => decide('ttl-cache', undefined, incoming(hlc(900)), { deviceId: DEVICE, now: 1000 })).toThrow(TypeError);
    expect(() => decide('ttl-cache', undefined, incoming(hlc(900)), { deviceId: DEVICE, now: 1000, ttlMs: 0 })).toThrow(
      TypeError,
    );
  });
});

const acceptAll = (_item: SyncItem): boolean => true;

describe('registry', () => {
  it('test_define_collection_checks', () => {
    expect(() => defineCollection({ name: 'Bad Name', strategy: 'lww-map', validate: acceptAll })).toThrow(TypeError);
    expect(() => defineCollection({ name: 'cache', strategy: 'ttl-cache', validate: acceptAll })).toThrow(TypeError);
    expect(() => defineCollection({ name: 'cache', strategy: 'ttl-cache', ttlMs: 0, validate: acceptAll })).toThrow(TypeError);
    expect(() => defineCollection({ name: 'cache', strategy: 'ttl-cache', ttlMs: 1.5, validate: acceptAll })).toThrow(TypeError);
    expect(() => defineCollection({ name: 'settings', strategy: 'lww-map', ttlMs: 10, validate: acceptAll })).toThrow(TypeError);
    expect(() => defineCollection({ name: 'settings', strategy: 'last-wins' as MergeStrategy, validate: acceptAll })).toThrow(
      TypeError,
    );

    const settings = defineCollection({ name: 'settings', strategy: 'lww-map', validate: acceptAll });
    expect(Object.isFrozen(settings)).toBe(true);
    expect(settings).toMatchObject({ name: 'settings', strategy: 'lww-map' });
    expect(settings.ttlMs).toBeUndefined();
    const cache = defineCollection({ name: 'link-cache', strategy: 'ttl-cache', ttlMs: 60_000, validate: acceptAll });
    expect(Object.isFrozen(cache)).toBe(true);
    expect(cache.ttlMs).toBe(60_000);
  });

  it('test_registry_names_and_duplicates', () => {
    const settings = defineCollection({ name: 'settings', strategy: 'lww-map', validate: acceptAll });
    const devices = defineCollection({ name: 'devices', strategy: 'per-device', validate: acceptAll });
    const drafts = defineCollection({ name: 'drafts', strategy: 'lww-doc', validate: acceptAll });

    expect(() => createRegistry([settings, devices, { ...settings }])).toThrow(/settings/);

    const registry = createRegistry([settings, devices, drafts]);
    expect(registry.get('settings')).toBe(settings);
    expect(registry.get('missing')).toBeUndefined();
    // Only own entries: names that reach Object.prototype are not collections.
    expect(registry.get('constructor')).toBeUndefined();
    expect(registry.get('__proto__')).toBeUndefined();
    expect(registry.names()).toEqual(['settings', 'devices', 'drafts']);
    // names() hands out a copy.
    registry.names().pop();
    expect(registry.names()).toEqual(['settings', 'devices', 'drafts']);
  });
});

describe('helpers and boundaries', () => {
  it('test_item_bytes_counts_utf8', () => {
    expect(itemBytes('é')).toBe(4);
    expect(itemBytes(undefined)).toBe(0);
    expect(itemBytes(null)).toBe(4);
    expect(itemBytes({ a: 1 })).toBe(7);
    expect(itemBytes('😀')).toBe(6);
  });

  it('test_biome_override_blocks_ai_root_only', async () => {
    const biomePath = fileURLToPath(new URL('../../../biome.json', import.meta.url));
    const biome = JSON.parse(await readFile(biomePath, 'utf8')) as {
      overrides: { includes: string[]; linter?: { rules?: { style?: Record<string, unknown> } } }[];
    };
    const override = biome.overrides.find((o) => o.includes.length === 1 && o.includes[0] === 'packages/sync/**');
    expect(override).toBeDefined();
    const rule = override?.linter?.rules?.style?.noRestrictedImports as {
      level: string;
      options: { paths: Record<string, string>; patterns: { group: string[]; message: string }[] };
    };
    expect(rule.level).toBe('error');
    expect(Object.keys(rule.options.paths)).toContain('@unalgorithm/ai');
    expect(Object.keys(rule.options.paths)).not.toContain('@unalgorithm/ai/presets');
    const groups = rule.options.patterns.flatMap((p) => p.group);
    expect(groups).toEqual(expect.arrayContaining(['wxt', 'react', '@unalgorithm/ui', '@unalgorithm/platforms']));
    // Subpaths that need Chrome, Node or the DOM are blocked; the SDK-free presets subpath is carved out of the same group.
    const subpaths = rule.options.patterns.find((p) => p.group.includes('@unalgorithm/ai/*'));
    expect(subpaths?.group).toEqual(
      expect.arrayContaining(['!@unalgorithm/ai/presets', '@unalgorithm/platforms/*', '@unalgorithm/ui/*']),
    );
    const aiGroups = groups.filter((g) => g.startsWith('@unalgorithm/ai'));
    expect(aiGroups).toEqual(['@unalgorithm/ai/*']);
  });
});
