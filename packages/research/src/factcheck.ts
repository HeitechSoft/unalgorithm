import { type AIClient, AIError, extractJson, type StructuredResult, toStrictJsonSchema } from '@unalgorithm/ai';
import { canonicalText, clipText, makeNonce } from '@unalgorithm/core';
import {
  type FactcheckResult,
  MAX_FACTCHECK_CLAIMS,
  MAX_FACTCHECK_SEARCHES,
  MAX_MODEL_CHARS,
  type NormalizedUsage,
  type PostForAI,
  costMicros as priceOf,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import type { z } from 'zod';
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
import { type ValidationStats, validateVerdicts } from './validate.ts';

export const FACTCHECK_MODELS = {
  claims: 'claude-haiku-5-5',
  research: 'claude-sonnet-5-5',
  verdict: 'claude-sonnet-5-5',
} as const;

/** A whole check ends by then, so it fits inside an MV3 service worker's 5-minute message event (P3-06). */
export const FACTCHECK_DEADLINE_MS = 240_000;

const MAX_CLAIM_CHARS = 300;
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
}

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
  blockedSource: 0,
  quoteTooLong: 0,
  quoteMismatch: 0,
  duplicate: 0,
};

/** Parse a structured answer exactly as `classifyPosts` does, with the same errors. */
function parseStructured<T>(res: StructuredResult, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.mode === 'json-schema' || res.mode === 'on-device' ? res.text : extractJson(res.text));
  } catch {
    throw new AIError('bad-request', 'The AI answer was not valid JSON.', { usage: res.usage });
  }
  const out = schema.safeParse(parsed);
  if (!out.success) throw new AIError('bad-request', 'The AI answer did not match the expected shape.', { usage: res.usage });
  return out.data;
}

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

/** Rejects as soon as `signal` aborts, even when `promise` never settles. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Fact-check one post: Haiku picks up to 3 claims, the retriever researches them (at most 5 searches), Sonnet gives a
 * verdict per claim with no tools, and the validator keeps only citations that trace to retrieved sources.
 */
export async function runFactcheck(post: PostForAI, deps: FactcheckDeps, opts: FactcheckOptions = {}): Promise<FactcheckRun> {
  const models = { ...FACTCHECK_MODELS, ...deps.models };
  const blocked = deps.blockedDomains ?? defaultBlockedDomains();
  const nonce = deps.nonce ?? makeNonce();
  const now = deps.now ?? (() => new Date());

  const controller = new AbortController();
  const signal = controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new AIError('timeout', 'The fact-check took too long.'));
  }, deps.deadlineMs ?? FACTCHECK_DEADLINE_MS);
  const forwardAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) forwardAbort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });

  let cost: number | undefined = 0;
  function record(model: string, usage: NormalizedUsage, failed: boolean): void {
    opts.onUsage?.({ model, usage, failed });
    const c = priceOf(model, usage);
    cost = cost === undefined || c === undefined ? undefined : cost + c;
  }

  /** Run one model call under the shared signal, reporting its usage at the requested model id. */
  async function step<T extends { usage: NormalizedUsage }>(model: string, call: () => Promise<T>): Promise<T> {
    try {
      const out = await untilAborted(call(), signal);
      record(model, out.usage, false);
      return out;
    } catch (err) {
      const usage = err instanceof AIError && err.usage ? err.usage : ZERO_USAGE;
      record(model, usage, true);
      if (timedOut) throw new AIError('timeout', 'The fact-check took too long.', { usage, cause: err });
      throw err;
    }
  }

  async function structured<T>(
    model: string,
    schema: z.ZodType<T>,
    req: {
      system: string;
      user: string;
      jsonSchema: Record<string, unknown>;
      schemaName: string;
      effort: 'low' | 'medium';
      maxOutputTokens: number;
      timeoutMs: number;
    },
  ) {
    return step(model, async () => {
      const res = await deps.client.structured({ model, ...req, signal });
      return { data: parseStructured(res, schema), model: res.model, usage: res.usage };
    });
  }

  try {
    const claimsRes = await structured(models.claims, ClaimsSchema, {
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
        costMicros: cost,
        stats: { ...NO_STATS },
      };
    }

    const research = await step(models.research, () =>
      deps.retriever.retrieve({ claims, maxSearches: MAX_FACTCHECK_SEARCHES, blockedDomains: blocked, nonce, signal }),
    );

    const verdictRes = await structured(models.verdict, VerdictsSchema, {
      system: VERDICT_SYSTEM,
      user: buildVerdictUser(claims, research.sources, research.notes, nonce),
      jsonSchema: VERDICTS_JSON_SCHEMA,
      schemaName: 'factcheck_verdicts',
      effort: 'medium',
      maxOutputTokens: 1_500,
      timeoutMs: 60_000,
    });

    const validated = validateVerdicts({ claims, sources: research.sources, verdicts: verdictRes.data.verdicts, blocked });
    return {
      result: {
        ...base,
        model: clipText(verdictRes.model, MAX_MODEL_CHARS),
        claims: validated.claims,
        sources: validated.sources,
      },
      costMicros: cost,
      stats: validated.stats,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }
}
