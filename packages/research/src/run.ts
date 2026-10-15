import { type AIClient, AIError, extractJson, type StructuredResult } from '@unalgorithm/ai';
import { type NormalizedUsage, costMicros as priceOf, ZERO_USAGE } from '@unalgorithm/protocol';
import type { z } from 'zod';

/**
 * The run plumbing fact-check and perspectives share: one deadline combined with the caller's signal, usage reported for
 * every call (failed ones too) and priced at the requested model id, and an optional cost ceiling checked before a call.
 */

export type UsageReport = { model: string; usage: NormalizedUsage; failed: boolean };

export interface RunGuard {
  /** The caller's signal and the deadline, combined. */
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  /** Every recorded call's cost; undefined once a call had no price card. */
  readonly cost: number | undefined;
  /** One model call under the run's signal; usage reported at the requested model id, failed calls too. */
  step<T extends { usage: NormalizedUsage }>(model: string, call: () => Promise<T>): Promise<T>;
  /** Usage of a call made outside `step` (the concurrent bucket searches). */
  record(model: string, usage: NormalizedUsage, failed: boolean): void;
  /** AIError('truncated') once cost ≥ maxCostMicros; an unpriced run (cost undefined) has no ceiling. */
  checkCeiling(): void;
  dispose(): void;
}

export function startRun(opts: {
  deadlineMs: number;
  timeoutMessage: string;
  signal?: AbortSignal;
  maxCostMicros?: number;
  onUsage?: (u: UsageReport) => void;
}): RunGuard {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new AIError('timeout', opts.timeoutMessage));
  }, opts.deadlineMs);
  const forwardAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal?.aborted) forwardAbort();
  else opts.signal?.addEventListener('abort', forwardAbort, { once: true });

  let cost: number | undefined = 0;
  function record(model: string, usage: NormalizedUsage, failed: boolean): void {
    opts.onUsage?.({ model, usage, failed });
    const c = priceOf(model, usage);
    cost = cost === undefined || c === undefined ? undefined : cost + c;
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get cost() {
      return cost;
    },
    async step(model, call) {
      try {
        const out = await untilAborted(call(), controller.signal);
        record(model, out.usage, false);
        return out;
      } catch (err) {
        const usage = err instanceof AIError && err.usage ? err.usage : ZERO_USAGE;
        record(model, usage, true);
        if (timedOut) throw new AIError('timeout', opts.timeoutMessage, { usage, cause: err });
        throw err;
      }
    },
    record,
    checkCeiling() {
      if (opts.maxCostMicros !== undefined && cost !== undefined && cost >= opts.maxCostMicros) {
        throw new AIError('truncated', 'The run reached its cost limit.');
      }
    },
    dispose() {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', forwardAbort);
    },
  };
}

/** Parse a structured answer exactly as `classifyPosts` does, with the same errors. */
export function parseStructured<T>(res: StructuredResult, schema: z.ZodType<T>): T {
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

/** Rejects as soon as `signal` aborts, even when `promise` never settles. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface StructuredStepRequest {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  effort: 'low' | 'medium';
  maxOutputTokens: number;
  timeoutMs: number;
}

/** One structured call (no tools) as a step of `guard`, parsed against `schema`. */
export function structuredStep<T>(
  guard: RunGuard,
  client: AIClient,
  model: string,
  schema: z.ZodType<T>,
  req: StructuredStepRequest,
): Promise<{ data: T; model: string; usage: NormalizedUsage }> {
  return guard.step(model, async () => {
    const res = await client.structured({ model, ...req, signal: guard.signal });
    return { data: parseStructured(res, schema), model: res.model, usage: res.usage };
  });
}
