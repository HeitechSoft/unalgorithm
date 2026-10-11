/** Run async read-modify-write operations one at a time (extension storage has no transactions). */
export function createLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Limit how many async tasks run at once. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Local calendar date as YYYY-MM-DD. */
export function dateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function snippet(text: string, max = 140): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** "1,234", "12K", "1.2M" to a number. */
export function parseCount(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /([\d.,]+)\s*([KkMm])?/.exec(s);
  if (!m?.[1]) return undefined;
  let n = Number.parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return undefined;
  if (m[2]) n *= /k/i.test(m[2]) ? 1_000 : 1_000_000;
  return Math.round(n);
}

/** JSON with object keys sorted, so equal values always produce the same string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/** Accept only http(s) links (adds https:// to bare domains). Returns null when unusable. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  let s = raw?.trim().replace(/[).,;]+$/, '');
  if (!s || /\s/.test(s)) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(s)) {
    if (!/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
