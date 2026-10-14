import { isSettingsEntryKey, settingsItemKey, settingsItemSchema } from '@unalgorithm/core';
import { SYNC_MAX_ITEM_BYTES, type SyncItem, SyncItemSchema } from '@unalgorithm/protocol';
import { createRegistry, defineCollection } from './registry.ts';
import { itemBytes } from './strategies.ts';
import { someString } from './strings.ts';

/**
 * Settings, interests and exceptions, field by field (R15): a plain setting is one item, one entry of an id-keyed map
 * is one item (`settingsItemKey` in `@unalgorithm/core`). The server stores settings and nothing else.
 */
export const SETTINGS_COLLECTION = 'settings';

/** Postgres `jsonb` cannot store U+0000; refused here, it is one `invalid` item instead of a failed push. */
const hasNul = (s: string): boolean => s.includes('\0');

/**
 * Whether `item` may exist in the settings collection: a well-formed sync item, on its canonical key (no item
 * overlaps another), within `SYNC_MAX_ITEM_BYTES`, free of U+0000, and passing the setting's schema when this version
 * knows it. Only entries and fields this version does not know can be deleted.
 */
export function validateSettingsItem(item: SyncItem): boolean {
  // The depth check comes first, so the size and string walks below only see values it bounded.
  const parsed = SyncItemSchema.safeParse(item);
  if (!parsed.success) return false;
  const { data } = parsed;
  if (data.collection !== SETTINGS_COLLECTION || settingsItemKey(data.key) !== data.key) return false;
  const schema = settingsItemSchema(data.key);
  if (data.deleted) return schema === null || isSettingsEntryKey(data.key);
  if (itemBytes(data.value) > SYNC_MAX_ITEM_BYTES || someString(data.value, hasNul)) return false;
  return schema === null || schema.safeParse(data.value).success;
}

export const settingsCollection = defineCollection({
  name: SETTINGS_COLLECTION,
  strategy: 'lww-map',
  validate: validateSettingsItem,
});

/** Every collection this version syncs. Learned topics, votes, usage, caches and device state are deliberately absent. */
export const SYNC_COLLECTIONS = createRegistry([settingsCollection]);
