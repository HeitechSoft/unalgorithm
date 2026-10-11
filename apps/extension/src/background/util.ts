import { defaultSettings, type Settings } from '@unalgorithm/core';
import { readSettings } from '../lib/storage.ts';

export { createLock, dateKey } from '@unalgorithm/core';

export async function readSettingsSafe(): Promise<Settings> {
  try {
    return await readSettings();
  } catch {
    return defaultSettings();
  }
}
