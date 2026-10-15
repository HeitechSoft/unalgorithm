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

/**
 * `text` cut to at most `max` UTF-16 units between code points: a character that doesn't fit whole is dropped, never
 * cut in half, so no lone surrogate is left (Postgres `jsonb` refuses one, and sync with it).
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
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

/** `s` without any of `chars` at its end; a loop, so a long run of them stays linear. */
function trimTrailing(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1] as string)) end--;
  return s.slice(0, end);
}

/** Accept only http(s) links (adds https:// to bare domains). Returns null when unusable. */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  let s = raw == null ? raw : trimTrailing(raw.trim(), ').,;');
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

const GIGABYTES = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * A size in decimal units: GB with one decimal from 1 GB, else whole MB, so 48,000,000 bytes reads "48 MB" rather than
 * "0.0 GB"; "unknown" when it could not be read. The admin page's status and the server's alert messages use it.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const megabytes = Math.round(bytes / 1e6);
  return megabytes < 1000 ? `${megabytes} MB` : `${GIGABYTES.format(bytes / 1e9)} GB`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
