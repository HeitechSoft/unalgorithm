import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultSettings,
  deleteAtKey,
  getAtKey,
  isSettingsEntryKey,
  PersonRuleSchema,
  SETTINGS_ENTRY_MAPS,
  type Settings,
  SettingsSchema,
  setAtKey,
  settingsItemKey,
  settingsItemKeysUnder,
  settingsItemSchema,
  TopicSchema,
} from '@unalgorithm/core';
import { formatHlc, PLATFORMS, type SyncItem } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  containsCredential,
  SETTINGS_COLLECTION,
  SYNC_COLLECTIONS,
  settingsCollection,
  validateSettingsItem,
} from '../src/index.ts';

const HLC = formatHlc({ ms: 1_760_000_000_000, counter: 0, device: 'd' });
const RULE_ID = '0190f5c8-3b1e-7c2a-9d4e-123456789abc';
const HIDE_KEY = `platforms.facebook.alwaysHide.${RULE_ID}`;

function live(key: string, value: unknown, collection = SETTINGS_COLLECTION): SyncItem {
  return { collection, key, hlc: HLC, deleted: false, value } as SyncItem;
}

function tombstone(key: string, collection = SETTINGS_COLLECTION): SyncItem {
  return { collection, key, hlc: HLC, deleted: true };
}

/** Default settings with two `interests.more` entries. */
function withTwoInterests(): Settings {
  const s = defaultSettings();
  s.interests.more['ai-tech'] = { label: 'AI', keywords: ['llm'], addedAt: 1 };
  s.interests.more.climate = { label: 'Climate', keywords: [], addedAt: 2 };
  return s;
}

describe('item keys', () => {
  it('test_settings_item_key_granularity', () => {
    expect(settingsItemKey('display.mode')).toBe('display.mode');
    expect(settingsItemKey('interests.more.ai-tech.keywords')).toBe('interests.more.ai-tech');
    expect(settingsItemKey('interests.more.ai-tech')).toBe('interests.more.ai-tech');
    expect(settingsItemKey(HIDE_KEY)).toBe(HIDE_KEY);
    expect(settingsItemKey(`${HIDE_KEY}.label`)).toBe(HIDE_KEY);
    for (const path of [
      'version',
      'interests',
      'interests.more',
      'platforms',
      'platforms.linkedin',
      'platforms.linkedin.filters',
      'platforms.linkedin.alwaysHide',
      'display',
      'display/mode',
      'display.mo/de',
      'display..mode',
      'display.',
      '',
    ]) {
      expect(settingsItemKey(path), path).toBeNull();
    }
    // A field this version does not know (written by a newer one) is its own item.
    expect(settingsItemKey('display.newField')).toBe('display.newField');
    expect(settingsItemKey('newSection')).toBe('newSection');
    // Leaves deeper in the schema, and the plain setting beside the interest maps.
    expect(settingsItemKey('platforms.linkedin.filters.sponsored')).toBe('platforms.linkedin.filters.sponsored');
    expect(settingsItemKey('interests.about')).toBe('interests.about');
    // A path below a known leaf would overlap the leaf's own item.
    expect(settingsItemKey('display.mode.x')).toBeNull();
    expect(settingsItemKey('version.x')).toBeNull();
    // A segment longer than 64 characters is not a key segment.
    expect(settingsItemKey(`display.${'a'.repeat(65)}`)).toBeNull();
    expect(isSettingsEntryKey(HIDE_KEY)).toBe(true);
    expect(isSettingsEntryKey('interests.more.ai-tech')).toBe(true);
    expect(isSettingsEntryKey('interests.more')).toBe(false);
    expect(isSettingsEntryKey('interests.more.ai-tech.label')).toBe(false);
    expect(isSettingsEntryKey('display.mode')).toBe(false);
    expect(isSettingsEntryKey('interests.more.__proto__')).toBe(false);
  });

  it('test_entry_maps_match_schema_records', () => {
    // Every z.record in SettingsSchema, with the platform segment as `*`.
    const records: string[] = [];
    const walk = (schema: unknown, path: string[]): void => {
      if (schema instanceof z.ZodRecord) {
        records.push(path.map((seg, i) => (i === 1 && path[0] === 'platforms' ? '*' : seg)).join('.'));
        return;
      }
      if (schema instanceof z.ZodObject) {
        for (const [seg, child] of Object.entries(schema.shape as Record<string, unknown>)) walk(child, [...path, seg]);
      }
    };
    walk(SettingsSchema, []);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(SETTINGS_ENTRY_MAPS, record).toContain(record);

    // Every entry map resolves to a z.record, for every platform.
    for (const map of SETTINGS_ENTRY_MAPS) {
      const paths = map.includes('*') ? PLATFORMS.map((p) => map.replace('*', p)) : [map];
      for (const path of paths) expect(settingsItemSchema(path), path).toBeInstanceOf(z.ZodRecord);
    }
  });

  it('test_settings_item_schema_per_key', () => {
    const mode = settingsItemSchema('display.mode');
    expect(mode?.safeParse('hide').success).toBe(true);
    expect(mode?.safeParse('shout').success).toBe(false);

    const rule = settingsItemSchema(HIDE_KEY);
    expect(rule).toBe(PersonRuleSchema);
    expect(rule?.safeParse({ label: 'Ann Example', match: 'li:in:ann', addedAt: 1 }).success).toBe(true);
    expect(rule?.safeParse({ label: 'x' }).success).toBe(false);
    expect(settingsItemSchema('interests.less.politics')).toBe(TopicSchema);

    expect(settingsItemSchema('display.newField')).toBeNull();
    // A newer version's platform: its entries are unknown here too.
    expect(settingsItemSchema('platforms.mastodon.alwaysHide.x')).toBeNull();
  });

  it('test_item_keys_under_ancestor', () => {
    expect(settingsItemKeysUnder(defaultSettings(), 'display')).toEqual([
      'display.mode',
      'display.showReason',
      'display.showAuthor',
      'display.groupRuns',
      'display.forYou',
      'display.badgeCount',
      'display.tips',
    ]);
    expect(settingsItemKeysUnder(withTwoInterests(), 'interests').sort()).toEqual(
      ['interests.more.ai-tech', 'interests.more.climate', 'interests.about'].sort(),
    );
    // An item key lists itself; a path below an item, a missing path and `version` list nothing.
    expect(settingsItemKeysUnder(withTwoInterests(), 'interests.more.climate')).toEqual(['interests.more.climate']);
    expect(settingsItemKeysUnder(withTwoInterests(), 'interests.more.climate.keywords')).toEqual([]);
    expect(settingsItemKeysUnder(defaultSettings(), 'display.missing')).toEqual([]);
    expect(settingsItemKeysUnder(defaultSettings(), 'version')).toEqual([]);
    // Fields a newer version wrote are listed leaf by leaf, as changedPaths stamps them.
    const newer = { ...defaultSettings(), display: { ...defaultSettings().display, extra: { a: 1, b: [2] }, flag: true } };
    expect(settingsItemKeysUnder(newer, 'display')).toEqual(
      expect.arrayContaining(['display.extra.a', 'display.extra.b', 'display.flag']),
    );
    expect(settingsItemKeysUnder(newer, 'display')).not.toContain('display.extra');
  });

  it('test_path_helpers', () => {
    const obj: Record<string, unknown> = {};
    setAtKey(obj, 'a.b.c', 1);
    expect(obj).toEqual({ a: { b: { c: 1 } } });
    setAtKey(obj, 'a.b.d', 2);
    expect(obj).toEqual({ a: { b: { c: 1, d: 2 } } });
    expect(getAtKey(obj, 'a.b.c')).toBe(1);
    expect(getAtKey(obj, 'a.b')).toEqual({ c: 1, d: 2 });
    expect(getAtKey(obj, 'a.x.c')).toBeUndefined();
    expect(getAtKey(obj, 'a.b.c.d')).toBeUndefined();
    expect(getAtKey(undefined, 'a')).toBeUndefined();

    deleteAtKey(obj, 'a.b.c');
    expect(obj).toEqual({ a: { b: { d: 2 } } });
    deleteAtKey(obj, 'a.b.d');
    // Only the last segment goes: the emptied parent stays.
    expect(obj).toEqual({ a: { b: {} } });
    deleteAtKey(obj, 'a.missing.d');
    expect(obj).toEqual({ a: { b: {} } });

    // A value in the way of a deeper key is replaced by an object.
    const flat: Record<string, unknown> = { a: 1 };
    setAtKey(flat, 'a.b', 2);
    expect(flat).toEqual({ a: { b: 2 } });
  });
});

describe('validation', () => {
  const rule = { label: 'Ann Example', match: 'li:in:ann', addedAt: 1 };
  const cases: { name: string; item: SyncItem; ok: boolean }[] = [
    { name: 'a live display.mode', item: live('display.mode', 'hide'), ok: true },
    { name: 'a live entry', item: live(HIDE_KEY, rule), ok: true },
    { name: 'a tombstone of an entry key', item: tombstone('interests.more.ai-tech'), ok: true },
    { name: 'a live unknown field', item: live('display.newField', true), ok: true },
    { name: 'a tombstone of display.mode', item: tombstone('display.mode'), ok: false },
    {
      name: 'a non-canonical key',
      item: live('interests.more.ai-tech.label', 'AI'),
      ok: false,
    },
    { name: 'the key version', item: live('version', 1), ok: false },
    { name: 'the collection learned', item: live('display.mode', 'hide', 'learned'), ok: false },
    {
      name: 'an entry failing TopicSchema',
      item: live('interests.more.ai-tech', { label: '', keywords: [], addedAt: 1 }),
      ok: false,
    },
    // JSON adds the two quotes: 8,191 letters are 8,193 bytes.
    { name: 'a value of 8,193 bytes', item: live('display.newField', 'a'.repeat(8_191)), ok: false },
    { name: 'U+0000 in an always-hide label', item: live(HIDE_KEY, { ...rule, label: 'Ann\u0000' }), ok: false },
  ];

  it.each(cases)('test_validate_settings_item_accepts_and_rejects: $name', ({ item, ok }) => {
    expect(validateSettingsItem(item)).toBe(ok);
  });

  it('test_validate_settings_item_edges', () => {
    // 8,192 bytes is the limit itself.
    expect(validateSettingsItem(live('display.newField', 'a'.repeat(8_190)))).toBe(true);
    // A key U+0000 hides in, and a tombstone of a field this version does not know.
    expect(validateSettingsItem(live('display.newField', { 'a\u0000': 1 }))).toBe(false);
    expect(validateSettingsItem(tombstone('display.newField'))).toBe(true);
    // An ancestor never syncs as one item.
    expect(validateSettingsItem(live('display', defaultSettings().display))).toBe(false);
    expect(validateSettingsItem(tombstone('interests.more'))).toBe(false);
    // Anything that is not a sync item at all.
    expect(validateSettingsItem({ collection: 'settings', key: 'display.mode', hlc: 'x', deleted: false, value: 'hide' })).toBe(
      false,
    );
    expect(validateSettingsItem(live('display.newField', undefined))).toBe(false);
  });

  it('test_only_settings_collection_registered', () => {
    expect(SYNC_COLLECTIONS.names()).toEqual(['settings']);
    expect(SYNC_COLLECTIONS.get('settings')).toBe(settingsCollection);
    expect(settingsCollection.strategy).toBe('lww-map');
    expect(settingsCollection.validate).toBe(validateSettingsItem);
    for (const absent of ['learned', 'votes', 'usage', 'stats', 'device', 'cache', 'secrets']) {
      expect(SYNC_COLLECTIONS.get(absent), absent).toBeUndefined();
    }
  });

  it('test_reserved_key_segments_never_reach_prototype', () => {
    expect(settingsItemKey('__proto__.x')).toBeNull();
    expect(settingsItemKey('constructor.prototype.x')).toBeNull();
    expect(settingsItemKey('display.prototype')).toBeNull();
    expect(settingsItemKey('interests.more.__proto__')).toBeNull();
    expect(validateSettingsItem(live('__proto__.x', 1))).toBe(false);
    expect(validateSettingsItem(live('constructor.prototype.x', 1))).toBe(false);
    expect(settingsItemSchema('display.constructor')).toBeNull();
    expect(settingsItemSchema('constructor')).toBeNull();
    expect(settingsItemSchema('display.toString')).toBeNull();
    expect(getAtKey({}, 'constructor')).toBeUndefined();
    expect(getAtKey({}, '__proto__')).toBeUndefined();
    expect(getAtKey({}, 'constructor.prototype')).toBeUndefined();
    expect(settingsItemKeysUnder({}, 'constructor')).toEqual([]);

    // The path helpers write own properties only, even when handed a reserved key directly.
    const target: Record<string, unknown> = {};
    setAtKey(target, '__proto__.x', 1);
    setAtKey(target, 'constructor.prototype.x', 1);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(Object.hasOwn(target, '__proto__')).toBe(true);
    deleteAtKey({}, 'constructor.prototype.x');
    deleteAtKey({}, '__proto__.x');

    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
  });
});

describe('credentials', () => {
  it('test_contains_credential_finds_provider_keys', () => {
    expect(containsCredential({ about: 'my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAA' })).toBe(true);
    expect(containsCredential({ a: [[{ b: ['AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] }]] })).toBe(true);
    expect(containsCredential({ gsk_AAAAAAAAAAAAAAAAAAAAAAAA: true })).toBe(true);
    // Keys are passed by their segments: one segment can hold a whole key.
    expect(containsCredential(`display.gsk_${'A'.repeat(52)}`.split('.'))).toBe(true);
    // Quotes, brackets and `=` split tokens; a key inside them is still found.
    expect(containsCredential('OPENAI_API_KEY="sk-proj-AAAAAAAAAAAAAAAAAAAA"')).toBe(true);
    expect(containsCredential('(sk-or-v1-AAAAAAAAAAAAAAAAAAAA)')).toBe(true);

    expect(containsCredential('sk-learn tips')).toBe(false);
    expect(containsCredential('Ask the AI team')).toBe(false);
    // A provider prefix in a token shorter than 20 characters is a word, not a key.
    expect(containsCredential('sk-ant-short')).toBe(false);
    expect(containsCredential(defaultSettings())).toBe(false);
    for (const value of Object.values(defaultSettings())) expect(containsCredential(value)).toBe(false);
    expect(containsCredential(null)).toBe(false);
    expect(containsCredential(42)).toBe(false);

    // The walk uses a stack: a value nested far deeper than any sync item still neither overflows nor loops.
    let deep: unknown = 'gsk_AAAAAAAAAAAAAAAAAAAAAAAA';
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(containsCredential(deep)).toBe(true);
    const cyclic: Record<string, unknown> = { about: 'calm' };
    cyclic.self = cyclic;
    expect(containsCredential(cyclic)).toBe(false);
  });
});

describe('boundaries', () => {
  /** Every module specifier a source file imports or re-exports. */
  function specifiers(source: string): string[] {
    return [
      ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ].map((m) => m[1] ?? '');
  }

  it('test_sync_and_core_imports', async () => {
    const syncSrc = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (await readdir(syncSrc)).filter((f) => f.endsWith('.ts'));
    const syncSpecifiers = new Set<string>();
    for (const file of files) {
      const source = await readFile(join(syncSrc, file), 'utf8');
      expect(source, file).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
      for (const s of specifiers(source)) syncSpecifiers.add(s);
    }
    expect(syncSpecifiers).toContain('@unalgorithm/ai/presets');
    expect(syncSpecifiers).not.toContain('@unalgorithm/ai');
    expect([...syncSpecifiers].filter((s) => s.startsWith('@unalgorithm/ai'))).toEqual(['@unalgorithm/ai/presets']);

    const keysFile = fileURLToPath(new URL('../../core/src/settings/sync-keys.ts', import.meta.url));
    const coreRoot = resolve(fileURLToPath(new URL('../../core/', import.meta.url)));
    const source = await readFile(keysFile, 'utf8');
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    const keysSpecifiers = specifiers(source);
    expect(keysSpecifiers.length).toBeGreaterThan(0);
    for (const s of keysSpecifiers) {
      if (s === 'zod') continue;
      expect(s, s).toMatch(/^\.\.?\//);
      expect(resolve(dirname(keysFile), s).startsWith(coreRoot + sep), s).toBe(true);
    }
  });
});
