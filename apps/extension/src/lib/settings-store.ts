import {
  createLock,
  type Device,
  editPaths,
  migrateDevice,
  migrateSettings,
  SETTINGS_VERSION,
  type Settings,
  type SettingsClocks,
  SettingsSchema,
  stampClocks,
  upgradeClocks,
} from '@unalgorithm/core';
import { HlcSchema, hlcMs, maxHlc, SYNC_MAX_HLC_AHEAD_MS, tickHlc, uuid } from '@unalgorithm/protocol';
import { deviceItem, lastHlcItem, readDevice, settingsClocksItem, settingsItem } from './storage.ts';

const moduleLock = createLock();

/**
 * Every settings write runs under one lock shared by the extension's pages and its background: the Web Lock
 * `ua-settings` (one per extension origin) where there is one, else this module's own lock (jsdom has no Web Locks).
 * Without it a remote apply in the background could land between a page's read and its write, and the page would
 * write stale settings over it with clocks that already carry the remote stamps. Content scripts never write settings.
 */
async function settingsLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator.locks as LockManager | undefined);
  return locks ? await locks.request('ua-settings', fn) : moduleLock(fn);
}

/**
 * Stored settings at this version, with their clocks and the last HLC, for a write under the lock. When an older
 * version stored them (`pending`), the clocks include the upgrade's (`upgradeClocks`): the first write stores both, so
 * sync sends the values the upgrade changed, once.
 */
async function readForWrite(): Promise<{
  settings: Settings;
  clocks: SettingsClocks;
  last: string | undefined;
  pending: boolean;
}> {
  const raw = await settingsItem.getValue();
  const version = (raw as { version?: unknown } | null | undefined)?.version;
  const pending = typeof version === 'number' && version < SETTINGS_VERSION;
  const stored = await settingsClocksItem.getValue();
  const storedLast = (await lastHlcItem.getValue()) ?? undefined;
  const { clocks, last } = pending
    ? upgradeClocks(raw, stored, (await readDevice()).deviceId, storedLast)
    : { clocks: stored, last: storedLast };
  return { settings: migrateSettings(raw), clocks, last, pending };
}

/**
 * The only way to change settings. Applies the mutator, validates, saves, and stamps a hybrid logical clock on
 * every changed field so Phase 2 sync can merge devices field by field (`editPaths`). Invalid results are rejected,
 * not saved.
 */
export async function updateSettings(mutate: (s: Settings) => Settings | void): Promise<Settings> {
  return settingsLock(async () => {
    const { settings: before, clocks: base, last: baseLast } = await readForWrite();
    const draft = structuredClone(before);
    const after = (mutate(draft) ?? draft) as Settings;
    const parsed = SettingsSchema.safeParse(after);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid settings');
    const paths = editPaths(before, parsed.data);
    if (!paths.length) return before;
    const device = await readDevice();
    const { clocks, last } = stampClocks(base, paths, device.deviceId, baseLast);
    await settingsItem.setValue(parsed.data);
    await settingsClocksItem.setValue(clocks);
    await lastHlcItem.setValue(last ?? null);
    return parsed.data as Settings;
  });
}

/**
 * Stores settings an older version left at this version, with the upgrade's clocks, so sync sends what the upgrade
 * changed without waiting for an edit. Resolves false when there was nothing to upgrade. The background runs it when
 * it starts; any earlier write does the same.
 */
export async function upgradeStoredSettings(): Promise<boolean> {
  return settingsLock(async () => {
    const { settings, clocks, last, pending } = await readForWrite();
    if (!pending) return false;
    await settingsItem.setValue(settings);
    await settingsClocksItem.setValue(clocks);
    await lastHlcItem.setValue(last ?? null);
    return true;
  });
}

/** Replace all settings (import, reset). Every field gets a fresh clock. */
export async function replaceSettings(next: Settings): Promise<Settings> {
  return updateSettings(() => next);
}

/**
 * Writes the result of merging another device's items: settings, item clocks and the last HLC seen, under the same lock
 * as updateSettings, and without stamping new clocks (stamping here would echo every remote change back to the server).
 * Resolves false when `merge` returned null (nothing written).
 */
export async function applyRemoteSettings(
  merge: (
    settings: Settings,
    clocks: SettingsClocks,
  ) => { settings: Settings; clocks: SettingsClocks; maxHlc: string | null } | null,
): Promise<boolean> {
  return settingsLock(async () => {
    const { settings, clocks, last } = await readForWrite();
    const result = merge(settings, clocks);
    if (!result) return false;
    await settingsItem.setValue(result.settings);
    await settingsClocksItem.setValue(result.clocks);
    await lastHlcItem.setValue((result.maxHlc ? maxHlc(last, result.maxHlc) : last) ?? null);
    return true;
  });
}

/**
 * After this computer's clock ran fast: gives every clock stamped further than `SYNC_MAX_HLC_AHEAD_MS` past `now` a
 * fresh, unique stamp (the server refuses those as `clock-ahead`, and `tickHlc` never moves backwards on its own), and
 * sets `local:lastHlc` to the newest stored clock so the next edit still stamps above all of them. Values are not
 * touched. Resolves with how many clocks it re-stamped (0: nothing written).
 */
export async function restampFutureClocks(now: number): Promise<number> {
  return settingsLock(async () => {
    const clocks = { ...(await settingsClocksItem.getValue()) };
    const { deviceId } = await readDevice();
    let issued: string | undefined;
    let kept: string | undefined;
    let count = 0;
    for (const [path, hlc] of Object.entries(clocks)) {
      if (!HlcSchema.safeParse(hlc).success) continue;
      if (hlcMs(hlc) > now + SYNC_MAX_HLC_AHEAD_MS) {
        issued = tickHlc(issued, deviceId, now);
        clocks[path] = issued;
        count++;
      } else {
        kept = maxHlc(kept, hlc);
      }
    }
    if (!issued) return 0;
    await settingsClocksItem.setValue(clocks);
    await lastHlcItem.setValue(maxHlc(kept, issued));
    return count;
  });
}

const deviceLock = createLock();

export async function updateDevice(mutate: (d: Device) => Device | void): Promise<Device> {
  return deviceLock(async () => {
    const before = await readDevice();
    const draft = structuredClone(before);
    const after = migrateDevice(mutate(draft) ?? draft, uuid);
    await deviceItem.setValue(after);
    return after;
  });
}
