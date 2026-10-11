import { tickHlc } from '@unalgorithm/protocol';
import { isPlainObject } from '../util.ts';

/**
 * Per-field edit clocks for settings. Every save stamps the leaf paths that changed with a hybrid logical clock,
 * so Phase 2 sync can merge two devices field by field instead of one whole settings object winning.
 */
export type SettingsClocks = Record<string, string>;

/** Dotted paths of leaves that differ between a and b (objects recurse; arrays and scalars compare by value). */
export function changedPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [prefix];
}

/** Stamp every changed path with a fresh clock. Returns the new clocks and the last stamp issued. */
export function stampClocks(
  clocks: SettingsClocks,
  paths: readonly string[],
  device: string,
  last: string | undefined,
  now = Date.now(),
): { clocks: SettingsClocks; last: string | undefined } {
  if (!paths.length) return { clocks, last };
  const next = { ...clocks };
  let stamp = last;
  for (const p of paths) {
    stamp = tickHlc(stamp, device, now);
    next[p] = stamp;
  }
  return { clocks: next, last: stamp };
}
