/**
 * True when `test` holds for any string in `value`: string values and object keys, at any depth. Walks a stack, never
 * recurses, and visits each object once, so neither a deep nor a cyclic value can overflow or loop.
 */
export function someString(value: unknown, test: (s: string) => boolean): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (test(node)) return true;
      continue;
    }
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(node)) {
      if (test(key)) return true;
      stack.push(child);
    }
  }
  return false;
}
