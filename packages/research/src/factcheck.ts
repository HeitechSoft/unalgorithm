import { type AIClient, AIError, toStrictJsonSchema } from '@unalgorithm/ai';
import { canonicalText, clipText, makeNonce } from '@unalgorithm/core';
import {
  type FactcheckClaim,
  type FactcheckResult,
  FactcheckResultSchema,
  type FactcheckSource,
  type LinkStatus,
  MAX_FACTCHECK_CLAIMS,
  MAX_FACTCHECK_SEARCHES,
  MAX_MODEL_CHARS,
  type NormalizedUsage,
  type PostForAI,
  type RetrievedSource,
  serverMayReceive,
} from '@unalgorithm/protocol';
import { blockedDomains as defaultBlockedDomains } from './blocklist.ts';
import { type CachedClaim, type ClaimCache, cacheEntryFor, replayCached } from './claim-cache.ts';
import {
  buildClaimsUser,
  buildVerdictUser,
  CLAIMS_SYSTEM,
  ClaimsSchema,
  FACTCHECK_PROMPT_VERSION,
  VERDICT_SYSTEM,
  VerdictsSchema,
} from './prompts.ts';
import type { Retriever } from './retriever.ts';
import { startRun, structuredStep, untilAborted } from './run.ts';
import { type RawVerdict, sourceOrder, type ValidationStats, validateVerdicts } from './validate.ts';

export const FACTCHECK_MODELS = {
  claims: 'claude-haiku-5-5',
  research: 'claude-sonnet-5-5',
  verdict: 'claude-sonnet-5-5',
} as const;

/** A whole check ends by then, so it fits inside an MV3 service worker's 5-minute message event (P3-06). */
export const FACTCHECK_DEADLINE_MS = 240_000;

const MAX_CLAIM_CHARS = 300;
const TIMEOUT_MESSAGE = 'The fact-check took too long.';
/** How a check researches (F28): the knobs RM5 tunes, in one place so the eval can compare two plans. */
export interface RetrievalPlan {
  /** Searches allowed for one research call over `claims` claims. */
  searches(claims: number): number;
  /** The research call's effort. */
  effort: 'low' | 'medium';
  /**
   * 'all': every retrieved source goes to the verdict step. 'quotable': only sources with at least one non-blank
   * snippet, the only ones a quote can match (`citationProblem`).
   */
  verdictSources: 'all' | 'quotable';
}

/** RM4's retrieval: 5 searches whatever the claim count, medium effort, every source. The eval's baseline. */
export const RM4_RETRIEVAL: RetrievalPlan = Object.freeze({
  searches: () => MAX_FACTCHECK_SEARCHES,
  effort: 'medium',
  verdictSources: 'all',
});

/** RM5 (F28): one search per claim plus one (at most 5), low research effort, only sources a quote can match. */
export const FACTCHECK_RETRIEVAL: RetrievalPlan = Object.freeze({
  searches: (claims: number) => Math.min(MAX_FACTCHECK_SEARCHES, claims + 1),
  effort: 'low',
  verdictSources: 'quotable',
});

/** A plan's search budget: truncated to an integer in 1..MAX_FACTCHECK_SEARCHES; non-finite gives the maximum. */
function clampSearches(n: number): number {
  if (!Number.isFinite(n)) return MAX_FACTCHECK_SEARCHES;
  return Math.min(MAX_FACTCHECK_SEARCHES, Math.max(1, Math.trunc(n)));
}

const CLAIMS_JSON_SCHEMA = toStrictJsonSchema(ClaimsSchema);
const VERDICTS_JSON_SCHEMA = toStrictJsonSchema(VerdictsSchema);

export interface FactcheckDeps {
  client: AIClient;
  retriever: Retriever;
  models?: Partial<Record<keyof typeof FACTCHECK_MODELS, string>>;
  /** Default `blockedDomains()`. */
  blockedDomains?: readonly string[];
  /** Fixed in tests. */
  now?: () => Date;
  nonce?: string;
  /** Default FACTCHECK_DEADLINE_MS; short in tests. */
  deadlineMs?: number;
  /** Stop before a model call once the run has cost this much (priced runs only). Default: no ceiling (own key). */
  maxCostMicros?: number;
  /** The server's link check (P3-13). Default: none; every source counts as live. */
  linkCheck?: LinkChecker;
  /** Default FACTCHECK_RETRIEVAL. */
  retrieval?: RetrievalPlan;
  /** Cached claim verdicts (P3-57): read and written for public posts only. Default: none. */
  claimCache?: ClaimCache;
}

/** Status of each URL, by URL; a URL left out counts as `unknown`. Must settle (or reject) when `signal` aborts. */
export type LinkChecker = (urls: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, LinkStatus>>;

export interface FactcheckOptions {
  signal?: AbortSignal;
  /** Called after every model call, failed ones too, so the caller can record spend. */
  onUsage?: (u: { model: string; usage: NormalizedUsage; failed: boolean }) => void;
}

export interface FactcheckRun {
  result: FactcheckResult;
  /** Every call's cost at the requested models' prices; undefined when one of them has no price card. */
  costMicros: number | undefined;
  stats: ValidationStats;
  /** Claims answered from the claim cache. */
  cached: number;
}

const NO_STATS: ValidationStats = {
  raw: 0,
  kept: 0,
  unknownSource: 0,
  deadLink: 0,
  blockedSource: 0,
  quoteTooLong: 0,
  quoteMismatch: 0,
  duplicate: 0,
};

/** Trim, drop empty, de-duplicate case-insensitively, clip, cut to MAX_FACTCHECK_CLAIMS, number c1…c3. */
function pickClaims(raw: readonly { claim: string }[]): { id: string; text: string }[] {
  const seen = new Set<string>();
  const out: { id: string; text: string }[] = [];
  for (const { claim } of raw) {
    const text = clipText(canonicalText(claim).trim(), MAX_CLAIM_CHARS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: `c${out.length + 1}`, text });
    if (out.length === MAX_FACTCHECK_CLAIMS) break;
  }
  return out;
}

/**
 * Claims in their order c1…c3, cached ones from `hits` (their explanation or '', `cachedAt`), fresh ones from `fresh`; sources
 * de-duplicated by URL in first-citation order and renumbered s1…sN, citations rewritten to match.
 */
function mergeClaims(
  claims: readonly { id: string; text: string }[],
  hits: ReadonlyMap<string, CachedClaim>,
  fresh: readonly FactcheckClaim[],
  freshSources: readonly FactcheckSource[],
): { claims: FactcheckClaim[]; sources: FactcheckSource[] } {
  const freshById = new Map(fresh.map((c) => [c.id, c]));
  const freshSourceById = new Map(freshSources.map((s) => [s.id, s]));
  const sources: FactcheckSource[] = [];
  const idByUrl = new Map<string, string>();
  const idFor = (s: Omit<FactcheckSource, 'id'>): string => {
    let id = idByUrl.get(s.url);
    if (id === undefined) {
      id = `s${sources.length + 1}`;
      idByUrl.set(s.url, id);
      sources.push({ id, url: s.url, domain: s.domain, title: s.title, pageAge: s.pageAge });
    }
    return id;
  };
  const out: FactcheckClaim[] = [];
  for (const { id, text } of claims) {
    const hit = hits.get(id);
    if (hit) {
      out.push({
        id,
        claim: text,
        verdict: hit.verdict,
        explanation: hit.explanation ?? '',
        citations: hit.citations.map((c) => ({
          sourceId: idFor({ url: c.url, domain: c.domain, title: c.title, pageAge: null }),
          quote: c.quote,
        })),
        cachedAt: hit.checkedAt,
      });
      continue;
    }
    const claim = freshById.get(id);
    if (!claim) continue;
    out.push({
      ...claim,
      citations: claim.citations.flatMap((c) => {
        const source = freshSourceById.get(c.sourceId);
        return source ? [{ sourceId: idFor(source), quote: c.quote }] : [];
      }),
    });
  }
  return { claims: out, sources };
}

/**
 * Fact-check one post: Haiku picks up to 3 claims, the retriever researches them on the plan's budget (by default one
 * search per claim plus one, at most 5, at low effort), Sonnet gives a verdict per claim with no tools, and the
 * validator keeps only citations that trace to retrieved sources. With a claim cache (public posts only), a claim whose
 * key is cached skips research and verdict, and each fresh conclusive verdict is stored.
 */
export async function runFactcheck(post: PostForAI, deps: FactcheckDeps, opts: FactcheckOptions = {}): Promise<FactcheckRun> {
  const models = { ...FACTCHECK_MODELS, ...deps.models };
  const blocked = deps.blockedDomains ?? defaultBlockedDomains();
  const nonce = deps.nonce ?? makeNonce();
  const now = deps.now ?? (() => new Date());
  const plan = deps.retrieval ?? FACTCHECK_RETRIEVAL;

  const guard = startRun({
    deadlineMs: deps.deadlineMs ?? FACTCHECK_DEADLINE_MS,
    timeoutMessage: TIMEOUT_MESSAGE,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(deps.maxCostMicros !== undefined ? { maxCostMicros: deps.maxCostMicros } : {}),
    ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
  });
  const { signal } = guard;

  /** The error to throw once the run is aborted: AIError('timeout') at the deadline, the abort reason otherwise. */
  function abortError(err: unknown): unknown {
    return guard.timedOut ? new AIError('timeout', TIMEOUT_MESSAGE, { cause: err }) : err;
  }

  /** The link check's answer for `urls`; a failed checker answers nothing. A broken checker never fails a check. */
  async function linkStatuses(urls: readonly string[]): Promise<ReadonlyMap<string, LinkStatus>> {
    if (!deps.linkCheck || urls.length === 0) return new Map();
    try {
      return await untilAborted(deps.linkCheck(urls, signal), signal);
    } catch (err) {
      if (signal.aborted) throw abortError(err);
      return new Map();
    }
  }

  /** Ids of the cited sources whose URL the link check found dead. */
  async function deadSources(sources: readonly RetrievedSource[], verdicts: readonly RawVerdict[]): Promise<Set<string>> {
    const dead = new Set<string>();
    const citedIds = new Set(verdicts.flatMap((v) => v.citations.map((c) => c.sourceId)));
    const cited = sources.filter((s) => citedIds.has(s.id)).sort((a, b) => sourceOrder(a.id) - sourceOrder(b.id));
    const statuses = await linkStatuses([...new Set(cited.map((s) => s.url))]);
    for (const s of cited) if (statuses.get(s.url) === 'dead') dead.add(s.id);
    return dead;
  }

  /** Each claim's key, and its servable cache entry by claim id. A store failure counts as no hits. */
  async function lookup(
    store: ClaimCache,
    claims: readonly { id: string; text: string }[],
  ): Promise<{ keys: string[] | null; hits: Map<string, CachedClaim> }> {
    const hits = new Map<string, CachedClaim>();
    let keys: string[] | null = null;
    let raw: ReadonlyMap<string, unknown>;
    try {
      const computed = await untilAborted(Promise.all(claims.map((c) => store.key(c.text))), signal);
      keys = computed;
      raw = await untilAborted(store.get(computed), signal);
    } catch (err) {
      if (signal.aborted) throw abortError(err);
      return { keys, hits };
    }
    const at = now().getTime();
    const keyed = keys ?? [];
    const found = claims.flatMap((c, i) => {
      const entry = replayCached(raw.get(keyed[i] ?? ''), { blocked, now: at });
      return entry ? [{ id: c.id, entry }] : [];
    });
    if (found.length === 0) return { keys, hits };
    const statuses = await linkStatuses([...new Set(found.flatMap((f) => f.entry.citations.map((c) => c.url)))]);
    const deadUrls = new Set([...statuses].filter(([, status]) => status === 'dead').map(([url]) => url));
    for (const { id, entry } of found) {
      const replayed = replayCached(entry, { blocked, deadUrls, now: at });
      if (replayed) hits.set(id, replayed);
    }
    return { keys, hits };
  }

  try {
    const claimsRes = await structuredStep(guard, deps.client, models.claims, ClaimsSchema, {
      system: CLAIMS_SYSTEM,
      user: buildClaimsUser(post, nonce),
      jsonSchema: CLAIMS_JSON_SCHEMA,
      schemaName: 'factcheck_claims',
      effort: 'low',
      maxOutputTokens: 600,
      timeoutMs: 30_000,
    });
    const claims = pickClaims(claimsRes.data.claims);
    const base = { v: 1 as const, checkedAt: now().toISOString(), promptVersion: FACTCHECK_PROMPT_VERSION };
    if (claims.length === 0) {
      return {
        result: { ...base, model: clipText(claimsRes.model, MAX_MODEL_CHARS), claims: [], sources: [] },
        costMicros: guard.cost,
        stats: { ...NO_STATS },
        cached: 0,
      };
    }

    // Only public posts ever read or write a cache, even if a caller passes one.
    const cache = deps.claimCache && serverMayReceive(post) ? deps.claimCache : undefined;
    const { keys, hits } = cache ? await lookup(cache, claims) : { keys: null, hits: new Map<string, CachedClaim>() };
    const misses = claims.filter((c) => !hits.has(c.id));
    if (misses.length === 0) {
      return {
        result: FactcheckResultSchema.parse({
          ...base,
          model: clipText(claimsRes.model, MAX_MODEL_CHARS),
          ...mergeClaims(claims, hits, [], []),
        }),
        costMicros: guard.cost,
        stats: { ...NO_STATS },
        cached: hits.size,
      };
    }

    guard.checkCeiling();
    const research = await guard.step(models.research, () =>
      deps.retriever.retrieve({
        claims: misses,
        maxSearches: clampSearches(plan.searches(misses.length)),
        effort: plan.effort,
        blockedDomains: blocked,
        nonce,
        signal,
      }),
    );
    // A citation to a source the verdict model never saw counts as `unknownSource` and is dropped.
    const shown =
      plan.verdictSources === 'quotable' ? research.sources.filter((s) => s.snippets.some((t) => t.trim())) : research.sources;

    guard.checkCeiling();
    const verdictRes = await structuredStep(guard, deps.client, models.verdict, VerdictsSchema, {
      system: VERDICT_SYSTEM,
      user: buildVerdictUser(misses, shown, research.notes, nonce),
      jsonSchema: VERDICTS_JSON_SCHEMA,
      schemaName: 'factcheck_verdicts',
      effort: 'medium',
      maxOutputTokens: 1_500,
      timeoutMs: 60_000,
    });

    const { verdicts } = verdictRes.data;
    const dead = await deadSources(shown, verdicts);
    const validated = validateVerdicts({ claims: misses, sources: shown, verdicts, blocked, dead });

    if (cache && keys && !signal.aborted) {
      // One entry per key: two claims can normalize alike ("X." and "X"); the first wins.
      const entries: { key: string; entry: CachedClaim }[] = [];
      for (const claim of validated.claims) {
        const key = keys[claims.findIndex((c) => c.id === claim.id)];
        const entry = cacheEntryFor(claim, validated.sources, post, base.checkedAt);
        if (key !== undefined && entry && !entries.some((e) => e.key === key)) entries.push({ key, entry });
      }
      // A failed write never fails a check.
      if (entries.length > 0) await untilAborted(cache.put(entries), signal).catch(() => undefined);
    }

    const model = clipText(verdictRes.model, MAX_MODEL_CHARS);
    const result: FactcheckResult =
      hits.size === 0
        ? { ...base, model, claims: validated.claims, sources: validated.sources }
        : FactcheckResultSchema.parse({ ...base, model, ...mergeClaims(claims, hits, validated.claims, validated.sources) });
    return { result, costMicros: guard.cost, stats: validated.stats, cached: hits.size };
  } finally {
    guard.dispose();
  }
}
