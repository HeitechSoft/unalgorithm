import { SyncCollectionSchema, type SyncItem } from '@unalgorithm/protocol';

/**
 * How the server decides a pushed item against the one it holds (see `decide` in `strategies.ts`):
 * - `lww-map`: one item per field, keyed by the field's path; the later HLC wins.
 * - `lww-doc`: one item per document, keyed by the document id; the later HLC wins.
 * - `per-device`: each device owns one item, keyed by its server device id; the later HLC wins.
 * - `ttl-cache`: a shared cache whose items expire after `ttlMs` and are never deleted.
 */
export const MERGE_STRATEGIES = ['lww-map', 'lww-doc', 'per-device', 'ttl-cache'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];

export interface CollectionDef {
  /** `SyncCollectionSchema`. */
  readonly name: string;
  readonly strategy: MergeStrategy;
  /** ttl-cache only: how long a written item lives. */
  readonly ttlMs?: number;
  /** Whether this item (key, value or tombstone) may exist in the collection. Pure; no I/O. */
  validate(item: SyncItem): boolean;
}

/** Checks a collection's definition and returns a frozen copy. Throws `TypeError` for a definition no server could use. */
export function defineCollection(def: CollectionDef): CollectionDef {
  const copy: CollectionDef = { ...def };
  if (!SyncCollectionSchema.safeParse(copy.name).success) throw new TypeError(`invalid collection name: ${String(copy.name)}`);
  if (!(MERGE_STRATEGIES as readonly string[]).includes(copy.strategy)) {
    throw new TypeError(`collection ${copy.name}: unknown merge strategy`);
  }
  if (copy.strategy === 'ttl-cache') {
    if (!isPositiveInteger(copy.ttlMs)) throw new TypeError(`collection ${copy.name}: ttl-cache needs a positive integer ttlMs`);
  } else if (copy.ttlMs !== undefined) {
    throw new TypeError(`collection ${copy.name}: only ttl-cache takes a ttlMs`);
  }
  if (typeof copy.validate !== 'function') throw new TypeError(`collection ${copy.name}: validate must be a function`);
  return Object.freeze(copy);
}

export interface Registry {
  get(name: string): CollectionDef | undefined;
  /** In definition order. */
  names(): string[];
}

/** Every collection a server or client syncs, by name. Throws on a duplicate name. */
export function createRegistry(defs: readonly CollectionDef[]): Registry {
  const byName = new Map<string, CollectionDef>();
  for (const def of defs) {
    if (byName.has(def.name)) throw new Error(`duplicate collection name: ${def.name}`);
    byName.set(def.name, def);
  }
  return Object.freeze({
    get: (name: string) => byName.get(name),
    names: () => [...byName.keys()],
  });
}

function isPositiveInteger(n: number | undefined): n is number {
  return n !== undefined && Number.isSafeInteger(n) && n > 0;
}
