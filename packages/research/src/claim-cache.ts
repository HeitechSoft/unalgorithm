import {
  CLAIM_CACHE_TTL_MS,
  FactcheckCitationSchema,
  type FactcheckClaim,
  type FactcheckSource,
  FactcheckSourceSchema,
  MAX_CITATIONS_PER_CLAIM,
  MIN_INDEPENDENT_DOMAINS,
  type PlatformId,
  type PostForAI,
} from '@unalgorithm/protocol';
import { z } from 'zod';
import { FACTCHECK_PROMPT_VERSION } from './prompts.ts';
import { isBlocked, normalizeQuote, registrableDomain } from './validate.ts';

/**
 * The shared claim cache's rules (F27, decisions D59 and D60): an entry holds a keyed hash of the normalized claim, the
 * verdict, its validated citations and the hour it was checked, nothing else. Storage is the caller's (a server, a
 * device); every rule about what is stored, served or refused lives here.
 */

export const CACHEABLE_VERDICTS = ['supported', 'disputed', 'misleading', 'needs-context'] as const;
/**
 * A quote or title sharing this many consecutive echo words with the post text (or its link title) is not kept; when
 * that text has fewer words, sharing all of them in a row is enough.
 */
export const POST_ECHO_WORDS = 6;
/**
 * Where checked posts live: a source there can be the checked post itself, and its URL carries a post id and its
 * author's name, so such a citation is never kept. One entry per platform, so a new platform must add its domains.
 */
export const PLATFORM_SOURCE_DOMAINS: Record<PlatformId, readonly string[]> = {
  linkedin: ['linkedin.com', 'lnkd.in'],
  facebook: ['facebook.com', 'fb.com', 'fb.watch'],
};
/** Times kept in an entry (and a server row) are floored to this, so none can be joined to the check that wrote it. */
export const CLAIM_CACHE_TIME_UNIT_MS = 60 * 60_000;
const MIN_SECRET_BYTES = 32;

export const CachedCitationSchema = z.strictObject({
  url: FactcheckSourceSchema.shape.url,
  /** The URL's host as retrieved; nothing beyond the URL. */
  domain: FactcheckSourceSchema.shape.domain,
  title: FactcheckSourceSchema.shape.title,
  quote: FactcheckCitationSchema.shape.quote,
});
export const CachedClaimSchema = z.strictObject({
  v: z.literal(1),
  verdict: z.enum(CACHEABLE_VERDICTS),
  citations: z.array(CachedCitationSchema).min(MIN_INDEPENDENT_DOMAINS).max(MAX_CITATIONS_PER_CLAIM),
  checkedAt: z.iso.datetime(),
});
export type CachedClaim = z.infer<typeof CachedClaimSchema>;
export type CachedCitation = z.infer<typeof CachedCitationSchema>;

/** Storage for cached claim verdicts. Every method may reject: a check then runs as if nothing were cached. */
export interface ClaimCache {
  /** The claim's key: lowercase hex HMAC-SHA-256 under this cache's secret. Never the text. */
  key(claimText: string): Promise<string>;
  /** Unexpired entries by key, as stored (the pipeline parses them; a bad one is a miss). */
  get(keys: readonly string[]): Promise<ReadonlyMap<string, unknown>>;
  /**
   * Stores each entry until its `checkedAt` + CLAIM_CACHE_TTL_MS (never from the write's own time); an unexpired entry
   * under the same key is kept, not replaced; of two entries under one key in one call, the first is stored.
   */
  put(entries: readonly { key: string; entry: CachedClaim }[]): Promise<void>;
}

/**
 * Folds only what never changes a claim's meaning: case, spacing, quote marks and a final `.` or `!`. Signs, currency,
 * percent and decimal points are kept, so a key matches only an identical claim.
 */
export function normalizeClaim(text: string): string {
  return normalizeQuote(text)
    .replace(/[.!]+$/, '')
    .trim();
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keys claims with HMAC-SHA-256 (Web Crypto) under `secret`; the prompt version is part of the key. */
export function hmacClaimKeyer(secret: Uint8Array): (claimText: string) => Promise<string> {
  if (secret.byteLength < MIN_SECRET_BYTES) throw new TypeError(`A claim cache secret needs ${MIN_SECRET_BYTES} bytes.`);
  const keyPromise = globalThis.crypto.subtle.importKey('raw', new Uint8Array(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const encoder = new TextEncoder();
  return async (claimText) => {
    const message = encoder.encode(`factcheck-claim/v${FACTCHECK_PROMPT_VERSION}\n${normalizeClaim(claimText)}`);
    return toHex(await globalThis.crypto.subtle.sign('HMAC', await keyPromise, message));
  };
}

/** Echo words: a finer split than `normalizeClaim`, so a marker or a hyphenated name counts as several words. */
function echoWords(text: string): string[] {
  return normalizeQuote(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Every run of POST_ECHO_WORDS words of `text` (all of it when shorter), as joined keys with the run length. */
function echoRuns(text: string | undefined): { size: number; runs: Set<string> } | null {
  const words = text ? echoWords(text) : [];
  if (words.length === 0) return null;
  const size = Math.min(POST_ECHO_WORDS, words.length);
  const runs = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) runs.add(words.slice(i, i + size).join(' '));
  return { size, runs };
}

function echoes(text: string, against: readonly { size: number; runs: Set<string> }[]): boolean {
  const words = echoWords(text);
  return against.some(({ size, runs }) => {
    for (let i = 0; i + size <= words.length; i++) if (runs.has(words.slice(i, i + size).join(' '))) return true;
    return false;
  });
}

const PLATFORM_DOMAINS = Object.values(PLATFORM_SOURCE_DOMAINS).flat();

function floorTime(iso: string): string {
  const t = Date.parse(iso);
  return new Date(Math.floor(t / CLAIM_CACHE_TIME_UNIT_MS) * CLAIM_CACHE_TIME_UNIT_MS).toISOString();
}

function distinctDomains(citations: readonly CachedCitation[]): number {
  return new Set(citations.map((c) => registrableDomain(c.domain))).size;
}

/**
 * The cache entry for a freshly validated claim, or null when it must not be cached: an inconclusive or downgraded
 * verdict, or fewer than two domains once citations on a platform or echoing the post are dropped. The claim text, the
 * explanation, `pageAge`, any id and the post never enter it.
 */
export function cacheEntryFor(
  claim: FactcheckClaim,
  sources: readonly FactcheckSource[],
  post: PostForAI,
  checkedAt: string,
): CachedClaim | null {
  if (!(CACHEABLE_VERDICTS as readonly string[]).includes(claim.verdict) || claim.downgraded) return null;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const against = [echoRuns(post.text), echoRuns(post.link?.title)].filter((r) => r !== null);
  const citations: CachedCitation[] = [];
  for (const c of claim.citations) {
    const source = byId.get(c.sourceId);
    if (!source || isBlocked(source.domain, PLATFORM_DOMAINS)) continue;
    if (echoes(c.quote, against) || echoes(source.title, against)) continue;
    citations.push({ url: source.url, domain: source.domain, title: source.title, quote: c.quote });
  }
  if (distinctDomains(citations) < MIN_INDEPENDENT_DOMAINS) return null;
  const out = CachedClaimSchema.safeParse({ v: 1, verdict: claim.verdict, citations, checkedAt: floorTime(checkedAt) });
  return out.success ? out.data : null;
}

/**
 * A stored entry as it may be served now, or null: malformed, from the future, expired (whatever the store says), or
 * left with fewer than two domains once now-blocked domains and dead links are dropped.
 */
export function replayCached(
  raw: unknown,
  o: { blocked: readonly string[]; deadUrls?: ReadonlySet<string>; now: number },
): CachedClaim | null {
  const parsed = CachedClaimSchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const at = Date.parse(entry.checkedAt);
  if (at > o.now || o.now - at >= CLAIM_CACHE_TTL_MS) return null;
  const citations = entry.citations.filter((c) => !isBlocked(c.domain, o.blocked) && !o.deadUrls?.has(c.url));
  if (distinctDomains(citations) < MIN_INDEPENDENT_DOMAINS) return null;
  return { ...entry, citations };
}

/** An in-memory cache (tests and the eval): an entry expires at its `checkedAt` + `ttlMs`, read against `now()`. */
export function memoryClaimCache(o: { secret: Uint8Array; now?: () => number; ttlMs?: number }): ClaimCache {
  const key = hmacClaimKeyer(o.secret);
  const now = o.now ?? (() => Date.now());
  const ttl = o.ttlMs ?? CLAIM_CACHE_TTL_MS;
  const store = new Map<string, CachedClaim>();
  const live = (entry: CachedClaim | undefined): entry is CachedClaim =>
    entry !== undefined && now() < Date.parse(entry.checkedAt) + ttl;
  return {
    key,
    async get(keys) {
      const out = new Map<string, unknown>();
      for (const k of keys) {
        const entry = store.get(k);
        if (live(entry)) out.set(k, structuredClone(entry));
      }
      return out;
    },
    async put(entries) {
      const written = new Set<string>();
      for (const { key: k, entry } of entries) {
        if (written.has(k) || live(store.get(k))) continue;
        written.add(k);
        store.set(k, structuredClone(entry));
      }
    },
  };
}
