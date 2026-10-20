import { HLC_ZERO, HlcSchema, hlcMs, maxHlc, type PlatformId, tickHlc } from '@unalgorithm/protocol';
import type { z } from 'zod';
import { presetValues } from '../presets.ts';
import { isPlainObject } from '../util.ts';
import { changedPaths, type SettingsClocks } from './clocks.ts';
import { defaultDevice, defaultSettings } from './defaults.ts';
import { type Device, DeviceSchema, type FilterKey, SETTINGS_VERSION, type Settings, SettingsSchema } from './schema.ts';
import { getAtKey } from './sync-keys.ts';

/**
 * Objects merge recursively; arrays and scalars from `over` replace `base`. Keys only present in `over`
 * (written by a newer version) are kept.
 */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...over };
  for (const [k, v] of Object.entries(base)) out[k] = k in over ? deepMerge(v, over[k]) : v;
  return out as T;
}

/** One upgrade from settings stored by an older version. */
interface Migration {
  /** The version it brings settings to. */
  to: number;
  /** Receives raw JSON (any section may be missing or broken) and returns raw JSON at version `to`. */
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A filter whose value under a strength this version changed (`up` moves settings still on the old strength). Synced
   * items carry no version, and a device still on the older version reads the strength the old way, so sync keeps that
   * filter's value explicit: `editPaths`, `upgradeClocks` and `upgradeMerged`.
   */
  filter?: { platform: PlatformId; key: FilterKey };
}

/** Whether every leaf of `expected` has that value in `value`, or is missing from it (the defaults fill it in). */
function holds(value: unknown, expected: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(expected)) return value === expected;
  return isPlainObject(value) && Object.entries(expected).every(([k, v]) => holds(value[k], v));
}

/** Facebook's Balanced as version 1 stored it, kept as it was: it left people and pages you don't follow to Calm. */
const V1_FACEBOOK_BALANCED = {
  filters: {
    sponsored: true,
    suggested: true,
    networkActivity: true,
    reshares: false,
    notFollowed: false,
    unjoinedGroups: true,
    reels: false,
    modules: true,
  },
  ai: {
    noise: { 'engagement-bait': true, 'rage-bait': true, clickbait: true, promotional: false, 'low-effort': false },
    lowRelevance: false,
  },
};

/**
 * Version 2: Balanced hides people and pages you don't follow on Facebook too, now that the rule was checked on live
 * feeds (version 1 kept it in Calm until then). A Facebook platform still on version 1's Balanced (marked Balanced,
 * and every filter as Balanced set it) gets the rule, whether the platform is on or off. Custom, or any filter the
 * person changed, stays as it is.
 */
function facebookBalancedHidesNotFollowed(raw: Record<string, unknown>): Record<string, unknown> {
  const platforms = raw.platforms;
  const fb = isPlainObject(platforms) ? platforms.facebook : undefined;
  if (!isPlainObject(platforms) || !isPlainObject(fb) || fb.preset !== 'balanced') return raw;
  if (!holds(fb.filters, V1_FACEBOOK_BALANCED.filters) || !holds(fb.ai, V1_FACEBOOK_BALANCED.ai)) return raw;
  const filters = isPlainObject(fb.filters) ? fb.filters : {};
  if (filters.notFollowed === true) return raw;
  return { ...raw, platforms: { ...platforms, facebook: { ...fb, filters: { ...filters, notFollowed: true } } } };
}

/** Ordered upgrades from older stored settings. */
const MIGRATIONS: readonly Migration[] = [
  { to: 2, up: facebookBalancedHidesNotFollowed, filter: { platform: 'facebook', key: 'notFollowed' } },
];

function upgrade(raw: Record<string, unknown>): Record<string, unknown> {
  let cur = raw;
  const from = typeof cur.version === 'number' ? cur.version : SETTINGS_VERSION;
  for (const m of MIGRATIONS) if (m.to > from) cur = m.up(cur);
  return { ...cur, version: SETTINGS_VERSION };
}

/** The leaf paths of a migration's filter and of its platform's strength. */
function pathsOf(filter: NonNullable<Migration['filter']>): { value: string; strength: string } {
  return {
    value: `platforms.${filter.platform}.filters.${filter.key}`,
    strength: `platforms.${filter.platform}.preset`,
  };
}

/**
 * The leaves an edit from `before` to `after` stamps: those that changed and, when a platform's strength changed, the
 * filter whose value under a strength changed (`Migration.filter`), changed or not. A device still on an older version
 * holds its own value for it under the old strength and would keep it under the new one, as would a device that pulls
 * later and starts from its defaults; sent with the edit, it ends the same everywhere (Facebook's people and pages you
 * don't follow, when the person leaves Balanced).
 */
export function editPaths(before: Settings, after: Settings): string[] {
  const paths = changedPaths(before, after);
  for (const { filter } of MIGRATIONS) {
    if (!filter || before.platforms[filter.platform].preset === after.platforms[filter.platform].preset) continue;
    const { value } = pathsOf(filter);
    if (!paths.includes(value)) paths.push(value);
  }
  return paths;
}

/** The newest valid clock on `path` or on an object above it (a stamp on `platforms.facebook` covers its leaves). */
function clockOn(clocks: SettingsClocks, path: string): string | undefined {
  let newest: string | undefined;
  for (const [at, hlc] of Object.entries(clocks)) {
    if ((at === path || path.startsWith(`${at}.`)) && HlcSchema.safeParse(hlc).success) newest = maxHlc(newest, hlc);
  }
  return newest;
}

/**
 * Clocks for the upgrade of `raw`, settings an older version stored on this device: the filter whose value under a
 * strength changed (`Migration.filter`) gets one when the upgrade changed it, or when it never had one. Unsent, the
 * value would be this device's alone: a device still on the older version keeps its own, and one that pulls later
 * starts from this version's default. The stamp comes right after the clocks of the filter and of its platform's strength, which date
 * the choice it belongs to: it wins over the older value it replaces, and any later change on any device wins over it.
 * Returns `clocks` and `last` as they are when there is nothing to stamp (settings at this version, or none stored);
 * otherwise `last` is the newest stamp, as `stampClocks` returns it.
 */
export function upgradeClocks(
  raw: unknown,
  clocks: SettingsClocks,
  device: string,
  last: string | undefined,
): { clocks: SettingsClocks; last: string | undefined } {
  if (!isPlainObject(raw) || typeof raw.version !== 'number' || raw.version >= SETTINGS_VERSION) return { clocks, last };
  const from = raw.version;
  const upgraded = migrateSettings(raw);
  let out = clocks;
  let newest = last;
  for (const { to, filter } of MIGRATIONS) {
    if (!filter || to <= from) continue;
    const { value, strength } = pathsOf(filter);
    const own = clockOn(clocks, value);
    if (own && getAtKey(raw, value) === getAtKey(upgraded, value)) continue;
    const of = clockOn(clocks, strength);
    // A minimal wall time: the stamp only has to follow the choice's clocks (no clock: the very first stamp).
    const stamp = tickHlc(of === undefined ? own : maxHlc(own, of), device, 0);
    out = { ...out, [value]: stamp };
    newest = maxHlc(newest, stamp);
  }
  return { clocks: out, last: newest };
}

/**
 * Settings just merged with items from other devices (`clocks`: item key → HLC after the merge). A device still on an
 * older version sends a strength as it meant there: version 1's Balanced leaves Facebook's people and pages you don't
 * follow shown, and picking a strength sends that filter only when its value changes. So when a platform's strength was
 * set no earlier than the filter (in the same millisecond: one edit), the filter takes what that strength sets in this
 * version. A later change of the filter alone stays, such as turning the rule off, which also makes the strength Custom
 * but may arrive in another page of items. Nothing is stamped, so nothing is sent back: every device on this version
 * reads the same items the same way. Returns `settings` itself when nothing changes.
 */
export function upgradeMerged(settings: Settings, clocks: Readonly<Record<string, string>>): Settings {
  let out = settings;
  for (const { filter } of MIGRATIONS) {
    if (!filter) continue;
    const ps = out.platforms[filter.platform];
    if (ps.preset === 'custom') continue;
    const { value, strength } = pathsOf(filter);
    const ms = (key: string) => hlcMs(Object.hasOwn(clocks, key) ? (clocks[key] as string) : HLC_ZERO);
    if (ms(strength) < ms(value)) continue;
    const want = presetValues(filter.platform, ps.preset).filters[filter.key];
    if (ps.filters[filter.key] === want) continue;
    const platform = { ...ps, filters: { ...ps.filters, [filter.key]: want } };
    out = { ...out, platforms: { ...out.platforms, [filter.platform]: platform } };
  }
  return out;
}

/**
 * Bring stored settings to the current shape: upgrade, fill in defaults for anything missing, then validate.
 * If a section is broken (hand-edited, bad import), only that section is reset; everything else is kept,
 * including fields this version does not know about.
 */
export function migrateSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!isPlainObject(raw)) return defaults;
  // Settings written by a newer version keep every field this version still validates (loose objects).
  const merged = deepMerge(defaults, upgrade(raw)) as Record<string, unknown>;
  return repair(SettingsSchema, merged, defaults as unknown as Record<string, unknown>) as Settings;
}

/**
 * Bring stored device state to the current shape, as `migrateSettings` does. A section added later is filled in from
 * the defaults (devices stored before ADR 0009 get `notices`, on and with nothing snoozed); a broken one is reset alone.
 */
export function migrateDevice(raw: unknown, newDeviceId: () => string): Device {
  const id = isPlainObject(raw) && typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : newDeviceId();
  const defaults = defaultDevice(id);
  if (!isPlainObject(raw)) return defaults;
  const merged = deepMerge(defaults, { ...raw, deviceId: id }) as Record<string, unknown>;
  return repair(DeviceSchema, merged, defaults as unknown as Record<string, unknown>) as Device;
}

function repair(
  schema: z.ZodType,
  merged: Record<string, unknown>,
  defaults: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const ok = schema.safeParse(merged);
  if (ok.success) return ok.data as Record<string, unknown>;
  if (depth > 3) return defaults;
  const fixed: Record<string, unknown> = { ...merged };
  for (const issue of ok.error.issues) {
    const top = issue.path[0];
    if (typeof top !== 'string' || !(top in defaults)) continue;
    const sub = issue.path[1];
    const sec = fixed[top];
    const def = defaults[top];
    // Reset the smallest broken unit we can: a platform, or else the whole section.
    if (typeof sub === 'string' && isPlainObject(sec) && isPlainObject(def) && sub in def) {
      fixed[top] = { ...sec, [sub]: def[sub] };
    } else {
      fixed[top] = def;
    }
  }
  return repair(schema, fixed, defaults, depth + 1);
}
