import { type AIClient, AIError } from '@unalgorithm/ai';
import { clipText } from '@unalgorithm/core';
import { outletForHost, outletsIn, type SourceList } from '@unalgorithm/outlets';
import {
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_SOURCES_PER_BUCKET,
  type NormalizedUsage,
  PerspectivesSourceSchema,
  type RetrievedCoverageSource,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { BUCKET_SEARCH_SYSTEM, buildBucketSearchUser } from './perspectives-prompts.ts';
import { cleanSnippet, hitUrl, type SearchProvider } from './search.ts';

/**
 * The bucket search for UnEcho Chamber (RM3): one search per lean bucket, restricted to that bucket's outlets on the
 * source list and to a date window. The spread is enforced here, in code, whatever a model or a search provider
 * returns: a hit is kept only when its host is an outlet of the bucket searched and its date falls in the window, and
 * its outlet and bucket come from the source list, never from a model.
 */

export interface BucketSearchRequest {
  query: string;
  domains: readonly string[];
  from: Date;
  to: Date;
  nonce: string;
  signal?: AbortSignal;
}

export interface BucketHit {
  url: string;
  title: string;
  snippets: string[];
  published: string | null;
}

export interface BucketSearchResult {
  hits: BucketHit[];
  usage: NormalizedUsage;
  model: string;
}

export interface BucketSearcher {
  /** The model (or `search:<provider>`) calls are billed under, also for a call that failed. */
  readonly model: string;
  search(req: BucketSearchRequest): Promise<BucketSearchResult>;
}

/** Anthropic web search, one search, allowed_domains = the bucket's domains. AIError('unsupported') without research. */
export function aiBucketSearcher(client: AIClient, model: string): BucketSearcher {
  const research = client.research?.bind(client);
  if (!research) throw new AIError('unsupported', 'This AI source cannot search the web, so it cannot compare coverage.');
  return {
    model,
    async search(req) {
      const res = await research({
        model,
        system: BUCKET_SEARCH_SYSTEM,
        user: buildBucketSearchUser(req.query, req.from, req.to, req.nonce),
        maxSearches: 1,
        blockedDomains: [],
        allowedDomains: req.domains,
        effort: 'low',
        maxOutputTokens: 1_000,
        timeoutMs: 60_000,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      // `res.notes` is text a model wrote after reading pages: dropped, never returned or passed on.
      const hits = res.sources.map((s) => ({ url: s.url, title: s.title, snippets: s.snippets, published: s.pageAge }));
      return { hits, usage: res.usage, model: res.model };
    },
  };
}

/** A search provider (RM2), 20 results asked, with the domain and date hints; usage ZERO_USAGE, model `search:<id>`. */
export function providerBucketSearcher(provider: SearchProvider): BucketSearcher {
  const model = `search:${provider.id}`;
  return {
    model,
    async search(req) {
      const hits = await provider.search(clipText(req.query, 200), {
        count: 20,
        domains: req.domains,
        from: req.from,
        to: req.to,
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return {
        hits: hits.map((h) => ({ url: h.url, title: h.title, snippets: [h.snippet], published: h.published })),
        usage: ZERO_USAGE,
        model,
      };
    },
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/** A UTC date from its parts, or null when they do not name a real day (2026-02-30, month 13). */
function utcDay(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

function parseDateText(raw: string, now: Date): Date | null {
  const text = raw.trim();
  // ISO 8601: a date, optionally a time and an offset; a time without an offset is read as UTC.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
  if (iso) {
    const day = utcDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (!day || iso[4] === undefined) return day;
    const t = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6] ?? '00'}${iso[7] ?? 'Z'}`);
    return Number.isNaN(t) ? null : new Date(t);
  }
  // RFC 1123 / 2822, which always carries a zone: `Tue, 14 Oct 2026 10:00:00 GMT`.
  if (/^(?:[a-z]{3},\s*)?\d{1,2} [a-z]{3} \d{4} \d{2}:\d{2}(?::\d{2})? (?:GMT|UTC?|Z|[+-]\d{4})$/i.test(text)) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : new Date(t);
  }
  // `October 14, 2026` or `Oct 14, 2026`.
  const named = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(text);
  if (named) {
    const month = MONTHS.indexOf((named[1] ?? '').slice(0, 3).toLowerCase());
    return month < 0 ? null : utcDay(Number(named[3]), month + 1, Number(named[2]));
  }
  // `N minutes|hours|days ago`.
  const ago = /^(\d{1,4}) (minute|hour|day)s? ago$/i.exec(text);
  if (ago) return new Date(now.getTime() - Number(ago[1]) * UNIT_MS[(ago[2] ?? 'day').toLowerCase() as keyof typeof UNIT_MS]);
  return null;
}

function dateInPath(url: string): Date | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/.exec(path) ?? /\/(\d{4})-(\d{2})-(\d{2})(?=\/|$|[^\d])/.exec(path);
  return m ? utcDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/**
 * A hit's publication time: an ISO/RFC/"Month D, YYYY" date, "N minutes|hours|days ago" from `now`, else a
 * /YYYY/MM/DD/ or /YYYY-MM-DD path segment in the URL; null when none (an undated hit is dropped, decision D29).
 */
export function publishedAt(published: string | null, url: string, now: Date): Date | null {
  return (published ? parseDateText(published, now) : null) ?? dateInPath(url);
}

export interface CoverageSearch {
  /** Ids s1..sN, bucket order then hit order. */
  sources: RetrievedCoverageSource[];
  /** Buckets with no outlet on the source list (never searched) or whose search failed: shown as gaps. */
  unsearched: LeanBucket[];
  failed: LeanBucket[];
  dropped: { offDomain: number; offDate: number; undated: number; noText: number; duplicate: number; excluded: number };
}

const withoutFragment = (href: string): string => href.replace(/#.*$/s, '');

/** One search per bucket of LEAN_BUCKETS on its source list outlets, then the domain and date rules enforced on every hit. */
export async function searchBuckets(input: {
  query: string;
  from: Date;
  to: Date;
  registry: SourceList;
  searcher: BucketSearcher;
  nonce: string;
  now: Date;
  /** The shared article's canonical URL: never listed as coverage of itself. */
  exclude?: string;
  signal?: AbortSignal;
  onUsage?: (u: { model: string; usage: NormalizedUsage; failed: boolean }) => void;
}): Promise<CoverageSearch> {
  const { registry, searcher, signal } = input;
  signal?.throwIfAborted();
  const plans = LEAN_BUCKETS.map((bucket) => ({ bucket, outlets: outletsIn(registry, bucket) }));
  const searched = plans.filter((p) => p.outlets.length > 0);
  const unsearched = plans.filter((p) => p.outlets.length === 0).map((p) => p.bucket);

  const settled = await Promise.allSettled(
    searched.map((p) =>
      searcher.search({
        query: input.query,
        domains: p.outlets.flatMap((o) => o.domains),
        from: input.from,
        to: input.to,
        nonce: input.nonce,
        ...(signal ? { signal } : {}),
      }),
    ),
  );
  for (const s of settled) {
    if (s.status === 'fulfilled') input.onUsage?.({ model: s.value.model, usage: s.value.usage, failed: false });
    else {
      const usage = s.reason instanceof AIError && s.reason.usage ? s.reason.usage : ZERO_USAGE;
      input.onUsage?.({ model: searcher.model, usage, failed: true });
    }
  }
  if (signal?.aborted) throw signal.reason;
  const firstFailure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
  if (firstFailure && settled.every((s) => s.status === 'rejected')) throw firstFailure.reason;

  const exclude = input.exclude ? hitUrl(input.exclude) : undefined;
  const excludeKey = exclude ? withoutFragment(exclude.href) : undefined;
  const dropped = { offDomain: 0, offDate: 0, undated: 0, noText: 0, duplicate: 0, excluded: 0 };
  const failed: LeanBucket[] = [];
  const sources: RetrievedCoverageSource[] = [];
  const seen = new Set<string>();

  searched.forEach(({ bucket }, i) => {
    const result = settled[i];
    if (!result || result.status === 'rejected') {
      failed.push(bucket);
      return;
    }
    let kept = 0;
    for (const hit of result.value.hits) {
      if (kept >= MAX_SOURCES_PER_BUCKET) break;
      const url = hitUrl(hit.url);
      const outlet = url ? outletForHost(registry, url.hostname) : null;
      if (!url || !outlet || outlet.lean?.bucket !== bucket) {
        dropped.offDomain++;
        continue;
      }
      const date = publishedAt(hit.published, url.href, input.now);
      if (!date) {
        dropped.undated++;
        continue;
      }
      if (date < input.from || date > input.to) {
        dropped.offDate++;
        continue;
      }
      const key = withoutFragment(url.href);
      if (key === excludeKey) {
        dropped.excluded++;
        continue;
      }
      if (seen.has(key)) {
        dropped.duplicate++;
        continue;
      }
      const snippets = hit.snippets.map(cleanSnippet).filter(Boolean);
      if (snippets.length === 0) {
        dropped.noText++;
        continue;
      }
      const source: RetrievedCoverageSource = {
        id: `s${sources.length + 1}`,
        url: url.href,
        domain: url.hostname,
        title: clipText(cleanSnippet(hit.title), 300),
        pageAge: date.toISOString().slice(0, 10),
        snippets,
        outletId: outlet.id,
        outlet: outlet.name,
        bucket,
      };
      // The URL parser lets through what the wire shape refuses (a host over 253 characters, say).
      if (!PerspectivesSourceSchema.safeParse(source).success) continue;
      seen.add(key);
      sources.push(source);
      kept++;
    }
  });

  return { sources, unsearched, failed, dropped };
}
