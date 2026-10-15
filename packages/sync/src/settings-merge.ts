import {
  deleteAtKey,
  getAtKey,
  isSettingsEntryKey,
  type Settings,
  type SettingsClocks,
  SettingsSchema,
  setAtKey,
  settingsItemKey,
  settingsItemKeysUnder,
} from '@unalgorithm/core';
import { compareHlc, HLC_ZERO, HlcSchema, maxHlc, type SyncItem, type SyncValue } from '@unalgorithm/protocol';
import { SETTINGS_COLLECTION, validateSettingsItem } from './collections.ts';
import { containsCredential } from './credential.ts';

/**
 * The client's side of the settings collection (R15, R16): which items to send, how items from other devices fold in
 * field by field, and what to drop after a `410 resync-required`. Pure: the extension's sync client (CL3-19) reads and
 * writes storage and talks to the server.
 *
 * Echo suppression lives here: an applied remote item takes the remote HLC as its clock, so it is not a change
 * afterwards. The caller writes the result without `updateSettings()`, which would stamp it again.
 */

/** Item key → the HLC of its newest local edit. */
export type ItemClocks = Record<string, string>;

/**
 * Turns the per-leaf clocks `stampClocks` writes into one clock per item, the newest of its leaves. An ancestor stamp
 * (`interests`) covers every item below it in `settings`. `version`, paths that never sync and stamps that are not
 * HLCs (storage the extension's content scripts can write) are dropped.
 */
export function normalizeClocks(settings: Settings, clocks: SettingsClocks): ItemClocks {
  const out: ItemClocks = {};
  for (const [path, hlc] of Object.entries(clocks)) {
    if (path === 'version' || !HlcSchema.safeParse(hlc).success) continue;
    const key = settingsItemKey(path);
    for (const k of key === null ? settingsItemKeysUnder(settings, path) : [key]) {
      out[k] = maxHlc(Object.hasOwn(out, k) ? out[k] : undefined, hlc);
    }
  }
  return out;
}

/** The HLC `record` holds for `key`, or `HLC_ZERO` (never stamped, or not known to be on the server). */
function clockOf(record: Readonly<Record<string, string>>, key: string): string {
  return (Object.hasOwn(record, key) ? record[key] : undefined) ?? HLC_ZERO;
}

/**
 * The item for `key` at `hlc` as the server would get it (no local value: a tombstone), or why it is never sent:
 * `invalid` (it fails `validateSettingsItem`) or `withheld` (its key or value holds what looks like a provider's API
 * key, R17). One rule for `changedItems` and `dropAfterResync`, so what is sent and what counts as sent cannot drift.
 */
function outgoingItem(settings: Settings, key: string, hlc: string): SyncItem | 'invalid' | 'withheld' {
  const value = getAtKey(settings, key);
  const item: SyncItem =
    value === undefined
      ? { collection: SETTINGS_COLLECTION, key, hlc, deleted: true }
      : { collection: SETTINGS_COLLECTION, key, hlc, deleted: false, value: value as SyncValue };
  // Validation bounds the value's depth before the credential walk reads it.
  if (!validateSettingsItem(item)) return 'invalid';
  // An unknown field's key segment can hold a whole provider key, so the key is checked for tombstones too.
  if (containsCredential(key.split('.')) || (!item.deleted && containsCredential(item.value))) return 'withheld';
  return item;
}

/**
 * Items whose local HLC is newer than what the server is known to hold (`known`: item key → HLC). Untouched defaults
 * carry no clock, so they are never sent. An item whose key or value holds what looks like a provider's API key is
 * `withheld` (by key only) and never returned (R17); invalid items are left out.
 */
export function changedItems(
  settings: Settings,
  clocks: SettingsClocks,
  known: Readonly<Record<string, string>>,
): { items: SyncItem[]; withheld: string[] } {
  const items: SyncItem[] = [];
  const withheld: string[] = [];
  for (const [key, hlc] of Object.entries(normalizeClocks(settings, clocks))) {
    if (compareHlc(hlc, clockOf(known, key)) <= 0) continue;
    const item = outgoingItem(settings, key, hlc);
    if (item === 'withheld') withheld.push(key);
    else if (item !== 'invalid') items.push(item);
  }
  return { items, withheld };
}

export interface SkippedItem {
  key: string;
  reason: 'invalid' | 'older' | 'other-collection';
}

export type ApplyResult =
  | { ok: true; settings: Settings; clocks: ItemClocks; applied: SyncItem[]; skipped: SkippedItem[]; maxHlc: string | null }
  | { ok: false; reason: 'schema' };

/**
 * Folds items from the server into `settings`, last writer wins per item: an item applies when its HLC is newer than
 * the local clock, and an applied key's clock becomes the remote HLC. On success the caller stores `clocks` as the new
 * `local:settingsClocks` and advances `local:lastHlc` to `maxHlc` (the HLC receive rule), so the next local edit
 * stamps higher. `{ ok: false }` means the merged settings fail the schema as a whole: the caller writes nothing.
 *
 * `preferRemote` is for the first pull after sync is turned on: every valid item wins, even when older than the local
 * clock, so the onboarding stamps of a second computer do not overwrite what the person tuned on the first one. Items
 * in one batch still apply in order, so a key's later item compares with the earlier one's result.
 */
export function applyRemoteItems(
  settings: Settings,
  clocks: SettingsClocks,
  items: readonly SyncItem[],
  opts: {
    /** First pull after sync is turned on: every valid item wins, even when older than the local clock. */
    preferRemote?: boolean;
  } = {},
): ApplyResult {
  const norm = normalizeClocks(settings, clocks);
  const next: Record<string, unknown> = structuredClone(settings);
  const applied: SyncItem[] = [];
  const skipped: SkippedItem[] = [];
  /** Keys this batch already applied: with `preferRemote`, the server's own items still compare among themselves. */
  const fromBatch = new Set<string>();
  let newest: string | null = null;
  for (const item of items) {
    if (item.collection !== SETTINGS_COLLECTION) {
      skipped.push({ key: item.key, reason: 'other-collection' });
      continue;
    }
    if (!validateSettingsItem(item)) {
      skipped.push({ key: item.key, reason: 'invalid' });
      continue;
    }
    const compare = !opts.preferRemote || fromBatch.has(item.key);
    if (compare && compareHlc(item.hlc, clockOf(norm, item.key)) <= 0) {
      skipped.push({ key: item.key, reason: 'older' });
      continue;
    }
    if (item.deleted) deleteAtKey(next, item.key);
    else setAtKey(next, item.key, item.value);
    norm[item.key] = item.hlc;
    fromBatch.add(item.key);
    applied.push(item);
    newest = maxHlc(newest ?? undefined, item.hlc);
  }
  // Each item passed its own schema, so this guards rules across fields only.
  const parsed = SettingsSchema.safeParse(next);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  return { ok: true, settings: parsed.data, clocks: norm, applied, skipped, maxHlc: newest };
}

/**
 * After a `410 resync-required`, once the full snapshot is applied: drops each local entry the server no longer has
 * (`serverKeys`: every key the snapshot returned, tombstones included) whose clock is at or before `gcFloorHlc`, with
 * its clock. Its tombstone was cleaned up after 90 days, so the entry was deleted on another device, and sending it
 * again would bring it back. An entry edited after the newest cleaned-up deletion cannot be the one deleted, so it
 * stays and is pushed, as are plain settings. A brand-new space has `gcFloorHlc = HLC_ZERO`: nothing is dropped.
 * Only an entry the server held before it started over (`wasKnown`: the client's `known` keys then) can have been
 * deleted elsewhere. One that never reached it, such as an entry added while this computer could not sync or had sync
 * turned off, stays and is pushed however old its clock; so does one `changedItems` never sends (`invalid` or
 * `withheld`), which stays local only.
 */
export function dropAfterResync(
  settings: Settings,
  clocks: SettingsClocks,
  serverKeys: ReadonlySet<string>,
  gcFloorHlc: string,
  wasKnown: ReadonlySet<string>,
): { settings: Settings; clocks: ItemClocks; dropped: string[] } {
  const norm = normalizeClocks(settings, clocks);
  const next = structuredClone(settings);
  const dropped: string[] = [];
  for (const [key, hlc] of Object.entries(norm)) {
    if (!isSettingsEntryKey(key) || !wasKnown.has(key) || serverKeys.has(key) || compareHlc(hlc, gcFloorHlc) > 0) continue;
    // A tombstone has nothing to drop, and an entry that is never sent was never on the server.
    const item = outgoingItem(next, key, hlc);
    if (typeof item === 'string' || item.deleted) continue;
    deleteAtKey(next, key);
    delete norm[key];
    dropped.push(key);
  }
  return { settings: next, clocks: norm, dropped };
}
