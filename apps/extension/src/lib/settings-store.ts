import {
  changedPaths,
  createLock,
  type Device,
  migrateDevice,
  type Settings,
  SettingsSchema,
  stampClocks,
} from '@unalgorithm/core';
import { uuid } from '@unalgorithm/protocol';
import { deviceItem, lastHlcItem, readDevice, readSettings, settingsClocksItem, settingsItem } from './storage.ts';

const lock = createLock();

/**
 * The only way to change settings. Applies the mutator, validates, saves, and stamps a hybrid logical clock on
 * every changed field so Phase 2 sync can merge devices field by field. Invalid results are rejected, not saved.
 */
export async function updateSettings(mutate: (s: Settings) => Settings | void): Promise<Settings> {
  return lock(async () => {
    const before = await readSettings();
    const draft = structuredClone(before);
    const after = (mutate(draft) ?? draft) as Settings;
    const parsed = SettingsSchema.safeParse(after);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid settings');
    const paths = changedPaths(before, parsed.data);
    if (!paths.length) return before;
    const device = await readDevice();
    const { clocks, last } = stampClocks(
      await settingsClocksItem.getValue(),
      paths,
      device.deviceId,
      (await lastHlcItem.getValue()) ?? undefined,
    );
    await settingsItem.setValue(parsed.data);
    await settingsClocksItem.setValue(clocks);
    await lastHlcItem.setValue(last ?? null);
    return parsed.data as Settings;
  });
}

/** Replace all settings (import, reset). Every field gets a fresh clock. */
export async function replaceSettings(next: Settings): Promise<Settings> {
  return updateSettings(() => next);
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
