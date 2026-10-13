/**
 * Scores an AI client on the classify eval set: the measure a server's eval gate compares with its minimum agreement
 * (R20). The posts go out in batches through `classifyPosts`, the same orchestrator, prompt and schema every classify
 * request uses, so the score is for exactly what the route will serve. A failure is reported by item id and short
 * codes (`relevance 52 not low`, `missing clickbait`, `error overloaded`), never by post text or a provider's message.
 * An error that measures the provider rather than the model's answers (busy, unreachable, a refused key) is also listed
 * in `providerErrors`: such a run did not measure agreement.
 */
import { type AIErrorCode, addUsage, type NormalizedUsage, type PostForAI, ZERO_USAGE } from '@unalgorithm/protocol';
import { classifyPosts, POST_ERROR_CODES, type PostOutcome } from '../src/classify.ts';
import type { AIClient } from '../src/types.ts';
import { EVAL_PROFILE, EVAL_SET, type EvalItem } from './classify-set.ts';

export { EVAL_PROFILE, EVAL_SET, type EvalItem } from './classify-set.ts';

/** Posts per classify call. */
export const EVAL_BATCH_SIZE = 6;

/**
 * A `high` item passes at this relevance or above, a `low` one below `LOW_BELOW`. The spec gives no thresholds; these
 * bracket the extension's default off-topic cutoff (35), so a passing route sorts every item to the right side of it.
 */
export const HIGH_AT_LEAST = 60;
export const LOW_BELOW = 40;

export interface EvalReport {
  /** `passed / total`, 0 to 1. */
  agreement: number;
  passed: number;
  total: number;
  /** One entry per item that did not pass: its id and short codes, comma-separated. */
  failures: { id: string; reason: string }[];
  /**
   * The distinct codes of errors that are not about the posts (`overloaded`, `auth`, `network`, ...). When any is
   * present the score reflects the provider's state, not the model, and is not a result to store.
   */
  providerErrors: AIErrorCode[];
  /** Every token the eval spent, failed calls included. */
  usage: NormalizedUsage;
  /** The model the eval asked for, whose price card prices `usage` (a provider may answer with a dated id). */
  model: string;
}

export async function runClassifyEval(client: AIClient, model: string): Promise<EvalReport> {
  const failures: EvalReport['failures'] = [];
  const providerErrors = new Set<AIErrorCode>();
  let usage = ZERO_USAGE;
  for (let start = 0; start < EVAL_SET.length; start += EVAL_BATCH_SIZE) {
    const batch = EVAL_SET.slice(start, start + EVAL_BATCH_SIZE);
    const posts: PostForAI[] = batch.map((item) => ({ ...item.post, ref: item.id }));
    const outcome = await classifyPosts(client, posts, { model, profile: EVAL_PROFILE });
    usage = addUsage(usage, outcome.usage);
    for (const item of batch) {
      const result = outcome.byRef.get(item.id);
      if (result && !result.ok && !POST_ERROR_CODES.has(result.error.code)) providerErrors.add(result.error.code);
      const problems = check(item, result);
      if (problems.length) failures.push({ id: item.id, reason: problems.join(', ') });
    }
  }
  const total = EVAL_SET.length;
  const passed = total - failures.length;
  return { agreement: passed / total, passed, total, failures, providerErrors: [...providerErrors], usage, model };
}

/** The short codes for what an item's outcome got wrong; empty when it passes. */
function check(item: EvalItem, outcome: PostOutcome | undefined): string[] {
  if (!outcome) return ['no result'];
  if (!outcome.ok) return [`error ${outcome.error.code}`];
  const { relevance, noise } = outcome.classification;
  const { expect } = item;
  const problems: string[] = [];
  if (expect.relevance === 'high' ? relevance < HIGH_AT_LEAST : relevance >= LOW_BELOW) {
    problems.push(`relevance ${relevance} not ${expect.relevance}`);
  }
  for (const label of expect.noise) if (!noise.includes(label)) problems.push(`missing ${label}`);
  for (const label of expect.notNoise) if (noise.includes(label)) problems.push(`unexpected ${label}`);
  return problems;
}
