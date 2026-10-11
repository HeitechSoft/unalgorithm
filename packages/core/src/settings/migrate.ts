import type { z } from 'zod';
import { isPlainObject } from '../util.ts';
import { defaultDevice, defaultSettings } from './defaults.ts';
import { type Device, DeviceSchema, SETTINGS_VERSION, type Settings, SettingsSchema } from './schema.ts';

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

/** Ordered upgrades from older stored shapes. Each receives raw JSON and returns raw JSON at version `to`. */
const MIGRATIONS: { to: number; up: (raw: Record<string, unknown>) => Record<string, unknown> }[] = [];

function upgrade(raw: Record<string, unknown>): Record<string, unknown> {
  let cur = raw;
  const from = typeof cur.version === 'number' ? cur.version : SETTINGS_VERSION;
  for (const m of MIGRATIONS) if (m.to > from) cur = m.up(cur);
  return { ...cur, version: SETTINGS_VERSION };
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
