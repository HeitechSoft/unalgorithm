/**
 * Scores `runPerspectives` on the perspectives eval set (RM4, F20, F25): citation provenance against the hits the
 * searcher returned in that run, lean integrity (every lean shown is the source list's, never a model's), live cited links,
 * coverage gaps and mirror-pair consistency. Items run one at a time. A failure is reported by item id and short codes,
 * never by link text or a provider's message; a provider error (busy, unreachable, a refused key) is listed in
 * `providerErrors` and its item is left out of every ratio. Pair consistency is reported, not gated, in v0 (D51).
 */
import { AIError, anthropicClient, memoryCapabilities } from '@unalgorithm/ai';
import { type AnthropicRequestKind, mockAnthropicFetch, structuredMessage } from '@unalgorithm/ai/testing/anthropic';
import { outletForHost, type SourceList } from '@unalgorithm/outlets';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import {
  type AIErrorCode,
  costMicros,
  type LeanBucket,
  type NormalizedUsage,
  type PerspectivesResult,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import type { BucketHit, BucketSearcher, BucketSearchRequest } from '../src/coverage.ts';
import type { LinkChecker } from '../src/factcheck.ts';
import { type PerspectivesDeps, type PerspectivesRun, runPerspectives } from '../src/perspectives.ts';
import { cleanSnippet, hitUrl } from '../src/search.ts';
import { citationProblem } from '../src/validate.ts';
import { PERSPECTIVES_EVAL_SET, type PerspectivesEvalItem } from './perspectives-set.ts';
import { checkCitedLinks, type GateResult, gate, liveLinksGate, PROVIDER_ERROR_CODES } from './score.ts';

export { PERSPECTIVES_EVAL_SET, type PerspectivesEvalItem } from './perspectives-set.ts';

export interface PerspectivesEvalReport {
  total: number;
  /** Shown citations whose source URL was among the hits the searcher returned in that run and whose quote passes
   *  citationProblem against that hit's cleaned snippets / shown citations (1 when none). */
  provenance: number;
  citationsShown: number;
  /** Result sources whose bucket and outletId equal outletForHost(list, host) / result sources (1 when none). */
  leanIntegrity: number;
  sourcesShown: number;
  /** Items whose covered buckets equal expectCovered / items scored (diagnostic). */
  coverageMatch: number;
  pairsScored: number;
  /** Twins with identical covered-bucket sets / pairs scored (1 when none). */
  pairConsistency: number;
  /** Cited URLs by link status, summed over items; null when the eval had no link checker. */
  links: { live: number; dead: number; unknown: number } | null;
  /** live / (live + dead); null when both are 0 or without a link checker. */
  liveLinks: number | null;
  /** Mean spend per scored item at the requested models' prices, failed calls included; undefined when unpriced. */
  meanCostMicros: number | undefined;
  failures: { id: string; reason: string }[];
  providerErrors: AIErrorCode[];
}

export interface PerspectivesEvalOptions {
  /** Checks the cited links after each item; the run itself never gets one. */
  linkCheck?: LinkChecker;
  /** Per item's link check; default 30 s. */
  linkTimeoutMs?: number;
}

/** RM4's perspectives trust gates, and the least a run must measure before a gate can pass. */
export const PERSPECTIVES_TRUST_GATES = { provenance: 1, leanIntegrity: 1, liveLinks: 0.97, minCited: 10 } as const;

const DEFAULT_LINK_TIMEOUT_MS = 30_000;

const ratio = (num: number, den: number, empty: number) => (den === 0 ? empty : num / den);

const pointsOf = (r: PerspectivesResult) => [...r.agreed, ...r.differences, ...r.unique];

/** Covered buckets = coverage entries with at least one source id. */
const coveredOf = (r: PerspectivesResult): Set<LeanBucket> =>
  new Set(r.coverage.filter((c) => c.sourceIds.length > 0).map((c) => c.bucket));

const sameSet = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((x) => b.has(x));

const listed = (s: ReadonlySet<string> | null) => (s?.size ? [...s].join(',') : 'none');

/**
 * Pure: the shown citations and sources of `result`, how many trace to `hits` (what the searcher returned in that run)
 * and how many carry the source list's own outlet and bucket. An independent re-check of `searchBuckets` and
 * `validateComparison`.
 */
export function tracePerspectives(
  result: PerspectivesResult,
  hits: readonly BucketHit[],
  registry: SourceList,
): { shown: number; traced: number; sources: number; leanOk: number } {
  const shownSources = new Map(result.sources.map((s) => [s.id, s]));
  let shown = 0;
  let traced = 0;
  for (const point of pointsOf(result)) {
    for (const citation of point.citations) {
      shown++;
      const source = shownSources.get(citation.sourceId);
      if (!source) continue;
      const ok = hits.some(
        (h) =>
          hitUrl(h.url)?.href === source.url &&
          citationProblem(citation.quote, h.snippets.map(cleanSnippet).filter(Boolean)) === null,
      );
      if (ok) traced++;
    }
  }
  let leanOk = 0;
  for (const s of result.sources) {
    const host = hitUrl(s.url)?.hostname;
    const outlet = host ? outletForHost(registry, host) : null;
    if (outlet && outlet.id === s.outletId && outlet.lean?.bucket === s.bucket) leanOk++;
  }
  return { shown, traced, sources: result.sources.length, leanOk };
}

export async function runPerspectivesEval(
  deps: PerspectivesDeps,
  items: readonly PerspectivesEvalItem[] = PERSPECTIVES_EVAL_SET,
  opts: PerspectivesEvalOptions = {},
): Promise<PerspectivesEvalReport> {
  // The eval checks links itself after each item and never resolves a link: a fixed run of what was shared.
  const { resolveLink: _dropped, ...runDeps } = deps;
  /** A clone of every hit the searcher returned for the current item, so a later mutation changes nothing. */
  let recorded: BucketHit[] = [];
  const searcher: BucketSearcher = {
    model: deps.searcher.model,
    async search(req) {
      const res = await deps.searcher.search(req);
      recorded.push(...structuredClone(res.hits));
      return res;
    },
  };
  const links = opts.linkCheck ? { live: 0, dead: 0, unknown: 0 } : null;
  const failures: PerspectivesEvalReport['failures'] = [];
  const providerErrors = new Set<AIErrorCode>();
  /** Covered buckets of every scored item; null when it failed. */
  const covered = new Map<string, Set<LeanBucket> | null>();
  let matched = 0;
  let shown = 0;
  let traced = 0;
  let sources = 0;
  let leanOk = 0;
  let cost: number | undefined = 0;

  for (const item of items) {
    let itemCost: number | undefined = 0;
    const onUsage = ({ model, usage }: { model: string; usage: NormalizedUsage }) => {
      const c = costMicros(model, usage);
      itemCost = itemCost === undefined || c === undefined ? undefined : itemCost + c;
    };
    let run: PerspectivesRun;
    recorded = [];
    try {
      run = await runPerspectives(item.link, { ...runDeps, searcher }, { onUsage });
    } catch (err) {
      const code: AIErrorCode = err instanceof AIError ? err.code : 'unknown';
      failures.push({ id: item.id, reason: `error ${code}` });
      if (PROVIDER_ERROR_CODES.has(code)) {
        providerErrors.add(code);
        continue;
      }
      covered.set(item.id, null);
      cost = cost === undefined || itemCost === undefined ? undefined : cost + itemCost;
      continue;
    }
    cost = cost === undefined || itemCost === undefined ? undefined : cost + itemCost;

    const { result } = run;
    const trace = tracePerspectives(result, recorded, deps.registry);
    shown += trace.shown;
    traced += trace.traced;
    sources += trace.sources;
    leanOk += trace.leanOk;
    if (trace.traced < trace.shown) failures.push({ id: item.id, reason: `untraced ${trace.shown - trace.traced}` });
    if (trace.leanOk < trace.sources) failures.push({ id: item.id, reason: `lean ${trace.sources - trace.leanOk}` });

    if (links && opts.linkCheck) {
      const citedIds = new Set(pointsOf(result).flatMap((p) => p.citations.map((c) => c.sourceId)));
      const cited = result.sources.filter((s) => citedIds.has(s.id));
      const checked = await checkCitedLinks(
        cited.map((s) => s.url),
        opts.linkCheck,
        opts.linkTimeoutMs ?? DEFAULT_LINK_TIMEOUT_MS,
      );
      links.live += checked.live;
      links.dead += checked.dead;
      links.unknown += checked.unknown;
      for (const s of cited) if (checked.deadUrls.has(s.url)) failures.push({ id: item.id, reason: `dead link ${s.id}` });
    }

    const got = coveredOf(result);
    covered.set(item.id, got);
    const expected = new Set(item.expectCovered);
    if (sameSet(got, expected)) matched++;
    else failures.push({ id: item.id, reason: `coverage ${listed(got)} not ${listed(expected)}` });
  }

  let pairs = 0;
  let consistent = 0;
  for (const item of items) {
    if (!item.pair || item.id > item.pair || !covered.has(item.id) || !covered.has(item.pair)) continue;
    pairs++;
    const a = covered.get(item.id) ?? null;
    const b = covered.get(item.pair) ?? null;
    if (a && b && sameSet(a, b)) consistent++;
    else failures.push({ id: item.id, reason: `pair ${item.pair} ${listed(a)} vs ${listed(b)}` });
  }

  const scored = covered.size;
  return {
    total: items.length,
    provenance: ratio(traced, shown, 1),
    citationsShown: shown,
    leanIntegrity: ratio(leanOk, sources, 1),
    sourcesShown: sources,
    coverageMatch: ratio(matched, scored, 0),
    pairsScored: pairs,
    pairConsistency: ratio(consistent, pairs, 1),
    links,
    liveLinks: links && links.live + links.dead > 0 ? links.live / (links.live + links.dead) : null,
    meanCostMicros: cost === undefined || scored === 0 ? undefined : Math.round(cost / scored),
    failures,
    providerErrors: [...providerErrors],
  };
}

/** Pure: the perspectives trust gates on a report. No gate passes on what it did not measure; `passed` needs all three. */
export function perspectivesTrustGates(r: PerspectivesEvalReport): {
  provenance: GateResult;
  leanIntegrity: GateResult;
  liveLinks: GateResult;
  passed: boolean;
} {
  const g = PERSPECTIVES_TRUST_GATES;
  const provenance = gate(r.provenance, g.provenance, r.citationsShown >= g.minCited);
  const leanIntegrity = gate(r.leanIntegrity, g.leanIntegrity, r.sourcesShown >= g.minCited);
  const liveLinks = liveLinksGate(r.links, g.liveLinks, g.minCited);
  const passed = provenance.passed === true && leanIntegrity.passed === true && liveLinks.passed === true;
  return { provenance, leanIntegrity, liveLinks, passed };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fakes: a mock Anthropic client and a bucket searcher on the fixture list (shared with perspectives.test.ts).

export const MOCK_NONCE = 'abc12345';
export const MOCK_NOW = new Date('2026-10-15T12:00:00.000Z');
export const MOCK_SEARCH_MODEL = 'fake-search';
export const MOCK_SEARCH_USAGE: NormalizedUsage = { ...ZERO_USAGE, uncachedInput: 2_000, output: 100, webSearches: 1 };

const SOURCE_TAG = new RegExp(`<source_${MOCK_NONCE} id="(s\\d+)"[^>]*>\\n([^\\n]*)`, 'g');

/** Every source matched; one agreed point citing the first and the last source's first 8 words. */
function comparisonFor(user: string, leanWord: boolean) {
  const tags = [...user.matchAll(SOURCE_TAG)];
  const cited = [...new Set([tags[0], tags.at(-1)])].filter((t) => t !== undefined);
  const text = 'Several outlets report the council vote.';
  return {
    matched: tags.map(([, id]) => id),
    agreed: [
      {
        text: leanWord ? `As the left outlets say, ${text.toLowerCase()}` : text,
        citations: cited.map(([, sourceId = '', quote = '']) => ({
          sourceId,
          quote: quote.split(/\s+/).slice(0, 8).join(' '),
        })),
      },
    ],
    differences: [],
    unique: [],
  };
}

export interface MockClientOptions {
  /** The story query: fixed, or from the story request's user text. Default 'council bridge vote'. */
  query?: string | ((user: string) => string);
  log?: string[];
  /** Delay before every answer, in ms. */
  delayMs?: number;
  /** The comparison writes a lean word into its point, to show leans still come from the source list. */
  leanWord?: boolean;
}

/** The text of the first user turn of a messages body. */
export function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as { role: string; content: unknown }[]) : [];
  const content = messages.find((m) => m.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : '';
}

/** An Anthropic client over a mock fetch: the story query, then a comparison of every source it was given. */
export function mockClient(opts: MockClientOptions = {}) {
  const kinds: AnthropicRequestKind[] = [];
  const fetch = mockAnthropicFetch((body, kind) => {
    kinds.push(kind);
    opts.log?.push(kind);
    if (kind === 'story') {
      const query = typeof opts.query === 'function' ? opts.query(userText(body)) : (opts.query ?? 'council bridge vote');
      return { status: 200, body: structuredMessage({ query }) };
    }
    if (kind === 'comparison') {
      const comparison = comparisonFor(userText(body), opts.leanWord ?? false);
      return { status: 200, body: structuredMessage(comparison, { model: 'claude-sonnet-5-5' }) };
    }
    return { status: 500, body: { type: 'error', error: { message: 'unexpected' } } };
  });
  const delayed = (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return fetch(input, init);
  }) as typeof globalThis.fetch;
  return { client: anthropicClient({ apiKey: 'sk-ant-test', capabilities: memoryCapabilities(), fetch: delayed }), fetch, kinds };
}

/** The bucket a fixture search was for, read from its domains (`left-a.example` → `left`). */
export const bucketOf = (req: BucketSearchRequest): LeanBucket =>
  (req.domains[0] ?? '').replace(/-a\.example$/, '') as LeanBucket;

/** A hit on a fixture outlet of `bucket` (outlet `a` unless told), dated `day` (YYYY/MM/DD) at 09:00 UTC. */
export function hit(bucket: LeanBucket, n: number, opts: { outlet?: 'a' | 'b'; day?: string; slug?: string } = {}): BucketHit {
  const day = opts.day ?? '2026/10/14';
  return {
    url: `https://${bucket}-${opts.outlet ?? 'a'}.example/${day}/${opts.slug ?? 'story'}-${n}`,
    title: `Headline ${n}`,
    snippets: [
      opts.slug
        ? `Reporting on story ${opts.slug} from outlet ${opts.outlet ?? 'a'} covers the main facts, part ${n}.`
        : `The city council approved the new bridge on Monday after a long debate ${n}.`,
    ],
    published: `${day.replaceAll('/', '-')}T09:00:00Z`,
  };
}

export interface FakeSearcherOptions {
  /** Buckets answered with `hit(bucket, 1)` (default none). */
  buckets?: readonly LeanBucket[];
  /** Replaces `buckets`: the hits for a search. */
  hits?: (req: BucketSearchRequest, bucket: LeanBucket) => BucketHit[];
  log?: string[];
  hang?: boolean;
  usage?: NormalizedUsage;
}

export function fakeSearcher(opts: FakeSearcherOptions = {}): BucketSearcher & { calls: BucketSearchRequest[] } {
  const calls: BucketSearchRequest[] = [];
  const buckets = opts.buckets ?? [];
  return {
    model: MOCK_SEARCH_MODEL,
    calls,
    async search(req) {
      calls.push(req);
      opts.log?.push('search');
      if (opts.hang) {
        await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
      }
      const bucket = bucketOf(req);
      const hits = opts.hits ? opts.hits(req, bucket) : buckets.includes(bucket) ? [hit(bucket, 1)] : [];
      return { hits, usage: opts.usage ?? MOCK_SEARCH_USAGE, model: MOCK_SEARCH_MODEL };
    },
  };
}

const PATH_DAY = /\/(\d{4}\/\d{2}\/\d{2})\//;

/**
 * Deterministic deps for `items` on FIXTURE_LIST at a fixed now: the story query names the item, and each bucket in
 * `expectCovered` (but `uncoverBucket`) answers two hits on its `a` and `b` outlets, dated on the link's own day.
 */
export function mockPerspectivesDepsFor(
  items: readonly PerspectivesEvalItem[],
  opts: { leanWord?: boolean; uncoverBucket?: LeanBucket } = {},
): PerspectivesDeps {
  const tag = (item: PerspectivesEvalItem) => `[${item.id}]`;
  const find = (pred: (item: PerspectivesEvalItem) => boolean) => {
    const item = items.find(pred);
    if (!item) throw new AIError('bad-request', 'The mock got a link from outside the eval set.');
    return item;
  };
  const { client } = mockClient({
    leanWord: opts.leanWord ?? false,
    query: (user) => `story ${tag(find((item) => user.includes(`url="${item.link.url}"`)))}`,
  });
  const searcher = fakeSearcher({
    hits: (req, bucket) => {
      const item = find((x) => req.query.includes(tag(x)));
      if (!item.expectCovered.includes(bucket) || bucket === opts.uncoverBucket) return [];
      const day = PATH_DAY.exec(item.link.url)?.[1] ?? '2026/10/14';
      return [hit(bucket, 1, { outlet: 'a', day, slug: item.id }), hit(bucket, 2, { outlet: 'b', day, slug: item.id })];
    },
  });
  return { client, searcher, registry: FIXTURE_LIST, now: () => MOCK_NOW, nonce: MOCK_NONCE };
}
