import { type AIClient, AIError, toStrictJsonSchema } from '@unalgorithm/ai';
import { canonicalText, clipText, makeNonce } from '@unalgorithm/core';
import {
  type FactcheckResult,
  type LinkStatus,
  MAX_FACTCHECK_CLAIMS,
  MAX_FACTCHECK_SEARCHES,
  MAX_MODEL_CHARS,
  type NormalizedUsage,
  type PostForAI,
  type RetrievedSource,
} from '@unalgorithm/protocol';
import { blockedDomains as defaultBlockedDomains } from './blocklist.ts';
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

/** The plan every check uses unless `deps.retrieval` says otherwise. RM4's until P3-56. */
export const FACTCHECK_RETRIEVAL: RetrievalPlan = RM4_RETRIEVAL;

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
 * Fact-check one post: Haiku picks up to 3 claims, the retriever researches them (at most 5 searches, per the plan), Sonnet gives a
 * verdict per claim with no tools, and the validator keeps only citations that trace to retrieved sources.
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

  /** Ids of the cited sources whose URL the link check found dead. A broken checker never fails a check. */
  async function deadSources(sources: readonly RetrievedSource[], verdicts: readonly RawVerdict[]): Promise<Set<string>> {
    const dead = new Set<string>();
    if (!deps.linkCheck) return dead;
    const citedIds = new Set(verdicts.flatMap((v) => v.citations.map((c) => c.sourceId)));
    const cited = sources.filter((s) => citedIds.has(s.id)).sort((a, b) => sourceOrder(a.id) - sourceOrder(b.id));
    const urls = [...new Set(cited.map((s) => s.url))];
    if (urls.length === 0) return dead;
    let statuses: ReadonlyMap<string, LinkStatus>;
    try {
      statuses = await untilAborted(deps.linkCheck(urls, signal), signal);
    } catch (err) {
      if (signal.aborted) {
        if (guard.timedOut) throw new AIError('timeout', TIMEOUT_MESSAGE, { cause: err });
        throw err;
      }
      return dead;
    }
    for (const s of cited) if (statuses.get(s.url) === 'dead') dead.add(s.id);
    return dead;
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
      };
    }

    guard.checkCeiling();
    const research = await guard.step(models.research, () =>
      deps.retriever.retrieve({
        claims,
        maxSearches: clampSearches(plan.searches(claims.length)),
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
      user: buildVerdictUser(claims, shown, research.notes, nonce),
      jsonSchema: VERDICTS_JSON_SCHEMA,
      schemaName: 'factcheck_verdicts',
      effort: 'medium',
      maxOutputTokens: 1_500,
      timeoutMs: 60_000,
    });

    const { verdicts } = verdictRes.data;
    const dead = await deadSources(shown, verdicts);
    const validated = validateVerdicts({ claims, sources: shown, verdicts, blocked, dead });
    return {
      result: {
        ...base,
        model: clipText(verdictRes.model, MAX_MODEL_CHARS),
        claims: validated.claims,
        sources: validated.sources,
      },
      costMicros: guard.cost,
      stats: validated.stats,
    };
  } finally {
    guard.dispose();
  }
}
