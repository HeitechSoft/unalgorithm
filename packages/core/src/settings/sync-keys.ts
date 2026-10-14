import { z } from 'zod';
import { isPlainObject } from '../util.ts';
import { SettingsSchema } from './schema.ts';

/**
 * Which part of the settings one sync item holds (R15). A plain setting is one item, keyed by its path
 * (`display.mode`); one entry of an id-keyed map is one item, keyed by the map and the entry id
 * (`interests.more.<id>`). Ancestors of several items (`display`, `interests.more`) never sync as one, and `version`
 * is a schema marker, not a setting.
 *
 * Item keys can come from a server, and a self-hosted one may be someone else's: every walk below steps into own
 * properties only, so a key can never read or write through `Object.prototype`.
 */

/** The id-keyed maps in Settings. Each entry syncs as one item; `*` is any one segment. */
export const SETTINGS_ENTRY_MAPS = [
  'platforms.*.alwaysShow',
  'platforms.*.alwaysHide',
  'interests.more',
  'interests.less',
  'interests.highlightWords',
  'interests.muteWords',
] as const;

const ENTRY_MAP_PATTERNS = SETTINGS_ENTRY_MAPS.map((m) => m.split('.'));

/** The segments `SyncKeySchema` (protocol) allows: 1 to 64 `[A-Za-z0-9_-]`, never one that reaches `Object.prototype`. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isKeySegment(seg: string): boolean {
  return KEY_SEGMENT.test(seg) && !RESERVED_SEGMENTS.has(seg);
}

/** Whether `segs` and `pattern` agree on every segment both have (`*` matches any). */
function matchesPattern(segs: readonly string[], pattern: readonly string[]): boolean {
  const n = Math.min(segs.length, pattern.length);
  for (let i = 0; i < n; i++) {
    if (pattern[i] !== '*' && pattern[i] !== segs[i]) return false;
  }
  return true;
}

type SchemaAt =
  | { kind: 'known'; schema: z.ZodType }
  /** A field this version does not know: loose objects keep fields from newer versions. */
  | { kind: 'unknown' }
  /** The path runs on below a known leaf, which is an item of its own. */
  | { kind: 'below-leaf' };

/** Walks `SettingsSchema` along `segs` (`ZodObject.shape[seg]`, `ZodRecord.valueType`), own properties only. */
function schemaAt(segs: readonly string[]): SchemaAt {
  let node: z.ZodType = SettingsSchema;
  for (const seg of segs) {
    let next: unknown;
    if (node instanceof z.ZodObject) {
      // `.shape` inherits from Object.prototype: `shape.constructor` would be `Object`.
      const shape: Record<string, unknown> = node.shape;
      if (!Object.hasOwn(shape, seg)) return { kind: 'unknown' };
      next = shape[seg];
    } else if (node instanceof z.ZodRecord) {
      next = node.valueType;
    } else {
      return { kind: 'below-leaf' };
    }
    if (!(next instanceof z.ZodType)) return { kind: 'unknown' };
    node = next;
  }
  return { kind: 'known', schema: node };
}

type PathKind = { kind: 'item'; key: string; unknown: boolean } | { kind: 'ancestor' } | { kind: 'none' };

/** What a dotted path is: inside one item, an ancestor of several, or nothing that syncs. */
function pathKind(path: string): PathKind {
  const segs = path.split('.');
  if (path === 'version' || !segs.every(isKeySegment)) return { kind: 'none' };
  for (const pattern of ENTRY_MAP_PATTERNS) {
    if (!matchesPattern(segs, pattern)) continue;
    // Below an entry map, the entry is the item; the map itself and its ancestors hold several.
    if (segs.length <= pattern.length) return { kind: 'ancestor' };
    return { kind: 'item', key: segs.slice(0, pattern.length + 1).join('.'), unknown: false };
  }
  const at = schemaAt(segs);
  if (at.kind === 'below-leaf') return { kind: 'none' };
  if (at.kind === 'unknown') return { kind: 'item', key: path, unknown: true };
  if (at.schema instanceof z.ZodObject || at.schema instanceof z.ZodRecord) return { kind: 'ancestor' };
  return { kind: 'item', key: path, unknown: false };
}

/** The item a changed path belongs to, or null (not syncable, or an ancestor of several items). */
export function settingsItemKey(path: string): string | null {
  const kind = pathKind(path);
  return kind.kind === 'item' ? kind.key : null;
}

/** Whether `key` is `<entry map>.<id>`: one entry of an id-keyed map. */
export function isSettingsEntryKey(key: string): boolean {
  const segs = key.split('.');
  if (!segs.every(isKeySegment)) return false;
  return ENTRY_MAP_PATTERNS.some((pattern) => segs.length === pattern.length + 1 && matchesPattern(segs, pattern));
}

/** The zod schema an item's value must pass; null for a field this version does not know (written by a newer one). */
export function settingsItemSchema(key: string): z.ZodType | null {
  const at = schemaAt(key.split('.'));
  return at.kind === 'known' && at.schema instanceof z.ZodType ? at.schema : null;
}

/**
 * Item keys at or below `path` in `settings` (expands an ancestor clock such as 'interests'). Fields this version
 * does not know are listed leaf by leaf, as `changedPaths` stamps them. Walks a stack: never recurses.
 */
export function settingsItemKeysUnder(settings: unknown, path: string): string[] {
  const keys: string[] = [];
  const stack: [string, unknown][] = [[path, getAtKey(settings, path)]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [at, value] = next;
    if (value === undefined) continue;
    const kind = pathKind(at);
    if (kind.kind === 'none') continue;
    if (kind.kind === 'item') {
      // Below an item (only `path` itself can be): that item is above `path`, not under it.
      if (kind.key !== at) continue;
      if (!kind.unknown || !isPlainObject(value) || Object.keys(value).length === 0) {
        keys.push(at);
        continue;
      }
    } else if (!isPlainObject(value)) {
      continue;
    }
    // Reversed, so the stack hands children back in the object's own order.
    for (const child of Object.keys(value).reverse()) stack.push([`${at}.${child}`, value[child]]);
  }
  return keys;
}

export function getAtKey(obj: unknown, key: string): unknown {
  let node = obj;
  for (const seg of key.split('.')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

/** Defines an own data property: never a setter, so `__proto__` is a plain key here. */
function defineOwn(obj: Record<string, unknown>, seg: string, value: unknown): void {
  Object.defineProperty(obj, seg, { value, writable: true, enumerable: true, configurable: true });
}

/** Sets `key` in `obj`, creating missing objects; a non-object in the way is replaced by one. */
export function setAtKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  const segs = key.split('.');
  const last = segs.pop() ?? key;
  let node = obj;
  for (const seg of segs) {
    const existing = Object.hasOwn(node, seg) ? node[seg] : undefined;
    let child: Record<string, unknown>;
    if (isPlainObject(existing)) {
      child = existing;
    } else {
      child = {};
      defineOwn(node, seg, child);
    }
    node = child;
  }
  defineOwn(node, last, value);
}

/** Removes the last segment of `key` from `obj`; parents stay, even when left empty. */
export function deleteAtKey(obj: Record<string, unknown>, key: string): void {
  const segs = key.split('.');
  const last = segs.pop() ?? key;
  const parent = segs.length > 0 ? getAtKey(obj, segs.join('.')) : obj;
  if (isPlainObject(parent) && Object.hasOwn(parent, last)) delete parent[last];
}
