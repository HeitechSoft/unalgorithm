import { AIError } from '@unalgorithm/ai';
import { clipText } from '@unalgorithm/core';
import { FactcheckSourceSchema, MAX_RETRIEVED_SOURCES, type RetrievedSource, ZERO_USAGE } from '@unalgorithm/protocol';
import { z } from 'zod';
import type { Retriever } from './retriever.ts';
import { isBlocked } from './validate.ts';

/**
 * Web search for routes whose model cannot search (any OpenAI-compatible route): the claims are searched through the
 * admin's (or, in RM4, the person's) search provider and the hits become the sources the verdict step judges. Plain
 * `fetch`, no SDK. Every error carries a fixed message: an answer's body or URL can echo the query, which is claim text,
 * and the API key is a secret.
 */

export const SEARCH_PROVIDERS = ['searxng', 'brave', 'tavily'] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDERS)[number];

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  published: string | null;
}

/**
 * `domains`, `from` and `to` are best-effort hints (RM3 bucket search): each provider passes on what its API takes, and
 * `searchBuckets` enforces both the domains and the dates on whatever comes back.
 */
export interface SearchOptions {
  count: number;
  signal?: AbortSignal;
  domains?: readonly string[];
  from?: Date;
  to?: Date;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
}

export interface SearchProviderConfig {
  provider: SearchProviderId;
  /** searxng only: the instance's base URL, e.g. http://searxng:8080 (admin-configured, so not the egress fetcher's). */
  url?: string;
  /** brave and tavily only. A secret: never logged or put in an error. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per search; default 10_000. */
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;
/** Brave and Tavily both cap a page of results at 20. */
const MAX_COUNT = 20;

const MESSAGES = {
  refused: 'The search provider refused the request.',
  rateLimit: 'The search provider is limiting requests.',
  down: "The search provider couldn't be reached.",
  timeout: 'The search provider took too long to answer.',
  unreadable: "The search provider's answer couldn't be read.",
  rejected: 'The search provider rejected the request.',
} as const;

const optionalText = z.string().nullish();

interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

function errorForStatus(res: Response): AIError {
  if (res.status === 401 || res.status === 403) return new AIError('not-available', MESSAGES.refused);
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'));
    return new AIError(
      'rate-limit',
      MESSAGES.rateLimit,
      Number.isFinite(retry) && retry > 0 ? { retryAfterMs: retry * 1000 } : {},
    );
  }
  if (res.status >= 500) return new AIError('overloaded', MESSAGES.down);
  return new AIError('unknown', MESSAGES.rejected);
}

/** One request with the timeout, the size cap and fixed-message errors; returns the parsed JSON. */
async function getJson(
  doFetch: typeof fetch,
  req: HttpRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const failed = (): never => {
    signal?.throwIfAborted();
    if (timeout.aborted) throw new AIError('timeout', MESSAGES.timeout);
    throw new AIError('overloaded', MESSAGES.down);
  };
  let res: Response;
  try {
    res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: 'error',
      credentials: 'omit',
      signal: combined,
    });
  } catch {
    return failed();
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw errorForStatus(res);
  }
  if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new AIError('unknown', MESSAGES.unreadable);
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    return failed();
  }
  if (text.length > MAX_BODY_BYTES) throw new AIError('unknown', MESSAGES.unreadable);
  try {
    return JSON.parse(text);
  } catch {
    throw new AIError('unknown', MESSAGES.unreadable);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AIError('unknown', MESSAGES.unreadable);
  return parsed.data;
}

function clampCount(count: number): number {
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(count) || 1));
}

/** `(site:a.com OR site:b.com)` over the first `max` domains, in the given order; '' for none (decision D34). */
export function siteClause(domains: readonly string[], max = 8): string {
  const picked = domains.slice(0, Math.max(0, max));
  return picked.length ? `(${picked.map((d) => `site:${d}`).join(' OR ')})` : '';
}

function withSites(query: string, domains: readonly string[] | undefined): string {
  const clause = siteClause(domains ?? []);
  return clause ? `${query} ${clause}` : query;
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

// SearXNG search API, https://docs.searxng.org/dev/search_api.html (checked 2026-10-15). The `json` format must be
// enabled in the instance's `search.formats`, otherwise it answers 403. There is no count parameter: the first
// `count` results are kept. Date hint: `time_range` (day, week, month, year) counts back from now, so the smallest one
// reaching back to `from` is sent; none when even a year does not.
const SearxngSchema = z.object({
  results: z.array(z.object({ url: z.string(), title: optionalText, content: optionalText, publishedDate: optionalText })),
});

const SEARXNG_RANGES = [
  ['day', 1],
  ['week', 7],
  ['month', 31],
  ['year', 365],
] as const;

function searxngTimeRange(from: Date | undefined, to: Date | undefined): string | undefined {
  if (!from || !to) return undefined;
  const span = Math.max(to.getTime(), Date.now()) - from.getTime();
  return SEARXNG_RANGES.find(([, days]) => span <= days * DAY_MS)?.[0];
}

function searxng(base: string, doFetch: typeof fetch, timeoutMs: number): SearchProvider {
  return {
    id: 'searxng',
    async search(query, opts) {
      const params = new URLSearchParams({ q: withSites(query, opts.domains), format: 'json', safesearch: '0' });
      const range = searxngTimeRange(opts.from, opts.to);
      if (range) params.set('time_range', range);
      const url = `${base}/search?${params}`;
      const data = await getJson(
        doFetch,
        { url, method: 'GET', headers: { accept: 'application/json' } },
        timeoutMs,
        opts.signal,
      );
      return parse(SearxngSchema, data)
        .results.slice(0, clampCount(opts.count))
        .map((r) => ({ url: r.url, title: r.title ?? '', snippet: r.content ?? '', published: r.publishedDate ?? null }));
    },
  };
}

// Brave Web Search API, https://api-dashboard.search.brave.com/app/documentation/web-search/query (checked
// 2026-10-15): `X-Subscription-Token` header, `count` up to 20; `freshness` takes a custom range written
// `YYYY-MM-DDtoYYYY-MM-DD` (checked 2026-10-15).
const BraveSchema = z.object({
  web: z
    .object({
      results: z.array(z.object({ url: z.string(), title: optionalText, description: optionalText, page_age: optionalText })),
    })
    .optional(),
});

function brave(apiKey: string, doFetch: typeof fetch, timeoutMs: number): SearchProvider {
  return {
    id: 'brave',
    async search(query, opts) {
      const params = new URLSearchParams({ q: withSites(query, opts.domains), count: String(clampCount(opts.count)) });
      if (opts.from && opts.to) params.set('freshness', `${isoDay(opts.from)}to${isoDay(opts.to)}`);
      const data = await getJson(
        doFetch,
        {
          url: `https://api.search.brave.com/res/v1/web/search?${params}`,
          method: 'GET',
          headers: { accept: 'application/json', 'x-subscription-token': apiKey },
        },
        timeoutMs,
        opts.signal,
      );
      return (parse(BraveSchema, data).web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.description ?? '',
        published: r.page_age ?? null,
      }));
    },
  };
}

// Tavily Search API, https://docs.tavily.com/documentation/api-reference/endpoint/search (checked 2026-10-15):
// bearer key, `max_results` 0..20. `published_date` is only returned with `include_published_date: true`.
// `include_domains` (up to 300), `start_date` (on or after) and `end_date` (before), both YYYY-MM-DD (checked
// 2026-10-15); `end_date` is the day after `to` so that day is included.
const TavilySchema = z.object({
  results: z.array(z.object({ url: z.string(), title: optionalText, content: optionalText, published_date: optionalText })),
});

function tavily(apiKey: string, doFetch: typeof fetch, timeoutMs: number): SearchProvider {
  return {
    id: 'tavily',
    async search(query, opts) {
      const data = await getJson(
        doFetch,
        {
          url: 'https://api.tavily.com/search',
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            query,
            max_results: clampCount(opts.count),
            search_depth: 'basic',
            include_answer: false,
            include_published_date: true,
            ...(opts.domains?.length ? { include_domains: [...opts.domains] } : {}),
            ...(opts.from && opts.to
              ? { start_date: isoDay(opts.from), end_date: isoDay(new Date(opts.to.getTime() + DAY_MS)) }
              : {}),
          }),
        },
        timeoutMs,
        opts.signal,
      );
      return parse(TavilySchema, data).results.map((r) => ({
        url: r.url,
        title: r.title ?? '',
        snippet: r.content ?? '',
        published: r.published_date ?? null,
      }));
    },
  };
}

/** Throws TypeError (naming the missing field, never a value) when url / apiKey do not fit the provider. */
export function createSearchProvider(cfg: SearchProviderConfig): SearchProvider {
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  switch (cfg.provider) {
    case 'searxng': {
      let base: URL;
      try {
        base = new URL(cfg.url ?? '');
      } catch {
        throw new TypeError('searxng needs `url`: the instance base URL.');
      }
      if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new TypeError('searxng needs `url` to be an http or https URL.');
      }
      return searxng(`${base.origin}${base.pathname.replace(/\/+$/, '')}`, doFetch, timeoutMs);
    }
    case 'brave':
    case 'tavily': {
      const apiKey = cfg.apiKey?.trim();
      if (!apiKey) throw new TypeError(`${cfg.provider} needs \`apiKey\`.`);
      return cfg.provider === 'brave' ? brave(apiKey, doFetch, timeoutMs) : tavily(apiKey, doFetch, timeoutMs);
    }
    default:
      throw new TypeError('`provider` must be searxng, brave or tavily.');
  }
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Tags out, the five common entities decoded (in one pass, so `&amp;lt;` stays `&lt;`), whitespace collapsed. */
export function cleanSnippet(text: string): string {
  const plain = text
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
  return clipText(plain, 1000);
}

/** An http(s) URL of at most 2,048 characters, else undefined. */
export function hitUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.href.length <= 2048 ? url : undefined;
  } catch {
    return undefined;
  }
}

/** A Retriever that searches each claim's text (at most `maxSearches`) and returns the hits as sources. */
export function searchRetriever(provider: SearchProvider, opts: { resultsPerClaim?: number } = {}): Retriever {
  const count = opts.resultsPerClaim ?? 5;
  return {
    async retrieve(req) {
      const sources: RetrievedSource[] = [];
      const seen = new Set<string>();
      for (const claim of req.claims.slice(0, Math.max(0, req.maxSearches))) {
        if (sources.length >= MAX_RETRIEVED_SOURCES) break;
        const hits = await provider.search(clipText(claim.text, 200), {
          count,
          ...(req.signal ? { signal: req.signal } : {}),
        });
        for (const hit of hits) {
          if (sources.length >= MAX_RETRIEVED_SOURCES) break;
          const url = hitUrl(hit.url);
          if (!url) continue;
          const domain = url.hostname.toLowerCase();
          if (isBlocked(domain, req.blockedDomains)) continue;
          const snippet = cleanSnippet(hit.snippet);
          if (!snippet) continue;
          const key = url.href.replace(/#.*$/s, '');
          if (seen.has(key)) continue;
          const source: RetrievedSource = {
            id: `s${sources.length + 1}`,
            url: url.href,
            domain,
            title: clipText(cleanSnippet(hit.title), 300),
            pageAge: hit.published === null ? null : clipText(hit.published, 64),
            snippets: [snippet],
          };
          // The URL parser lets through what the wire shape refuses (a host over 253 characters, say).
          if (!FactcheckSourceSchema.safeParse(source).success) continue;
          seen.add(key);
          sources.push(source);
        }
      }
      return { notes: '', sources, usage: ZERO_USAGE, model: `search:${provider.id}` };
    },
  };
}
