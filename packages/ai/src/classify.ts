import {
  buildCompactSystemPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  CLASSIFICATION_SCHEMA_NAME,
  ClassificationBatchSchema,
  makeNonce,
  normalizeItem,
} from '@unalgorithm/core';
import {
  type AIErrorCode,
  addUsage,
  type Classification,
  type InterestProfile,
  type NormalizedUsage,
  type PostForAI,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { AIError } from './errors.ts';
import { extractJson, toStrictJsonSchema } from './json-schema.ts';
import type { AIClient, StructuredMode } from './types.ts';

const BATCH_JSON_SCHEMA = toStrictJsonSchema(ClassificationBatchSchema);

export type PostOutcome = { ok: true; classification: Classification } | { ok: false; error: AIError };

/**
 * Errors about one call's posts or the model's answer to them: the rest of a run goes on. Any other error (a bad key,
 * no credit, a busy or unreachable provider) says nothing about the posts and would fail every call, so the run stops.
 */
export const POST_ERROR_CODES: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'refusal',
  'truncated',
  'context-overflow',
  'bad-request',
]);

export interface ClassifyOutcome {
  byRef: Map<string, PostOutcome>;
  /** Every token spent, including on calls that failed. */
  usage: NormalizedUsage;
  /** The tokens of calls that returned a valid answer: the part a server may charge for (failed calls never are). */
  okUsage: NormalizedUsage;
  model: string;
  mode?: StructuredMode;
  calls: number;
  failedCalls: number;
}

export interface ClassifyOptions {
  model: string;
  profile: InterestProfile;
  compact?: boolean;
  /** Fixed nonce for deterministic tests. */
  nonce?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The rubric part of the full system prompt, up to and including the blank line before `<user_profile>`, so providers
 * with several cache breakpoints can share it across users. Profile values are escaped and the rubric only mentions
 * the tag inline, so the last `\n\n<user_profile>\n` is the boundary.
 */
function rubricPrefix(system: string): string | undefined {
  const index = system.lastIndexOf('\n\n<user_profile>\n');
  return index > 0 ? system.slice(0, index + 2) : undefined;
}

async function callOnce(client: AIClient, posts: PostForAI[], opts: ClassifyOptions) {
  const system = opts.compact ? buildCompactSystemPrompt(opts.profile) : buildSystemPrompt(opts.profile);
  const cachePrefix = opts.compact ? undefined : rubricPrefix(system);
  const user = buildUserPrompt(posts, opts.nonce ?? makeNonce());
  const res = await client.structured({
    model: opts.model,
    system,
    ...(cachePrefix ? { cachePrefix } : {}),
    user,
    jsonSchema: BATCH_JSON_SCHEMA,
    schemaName: CLASSIFICATION_SCHEMA_NAME,
    effort: 'low',
    maxOutputTokens: 300 + posts.length * 220,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.mode === 'json-schema' || res.mode === 'on-device' ? res.text : extractJson(res.text));
  } catch {
    throw new AIError('bad-request', 'The AI answer was not valid JSON.', { usage: res.usage });
  }
  const batch = ClassificationBatchSchema.safeParse(parsed);
  if (!batch.success) throw new AIError('bad-request', 'The AI answer did not match the expected shape.', { usage: res.usage });
  const byRef = new Map<string, Classification>();
  const wanted = new Set(posts.map((p) => p.ref));
  for (const item of batch.data.results) if (wanted.has(item.id) && !byRef.has(item.id)) byRef.set(item.id, normalizeItem(item));
  return { byRef, usage: res.usage, model: res.model, mode: res.mode };
}

/**
 * Classify a batch with one call. If the model refuses, split the batch until only the offending post fails.
 * Posts the model skipped are retried once on their own. Usage from failed calls still counts in `usage`, never in
 * `okUsage`.
 */
export async function classifyPosts(client: AIClient, posts: PostForAI[], opts: ClassifyOptions): Promise<ClassifyOutcome> {
  const out: ClassifyOutcome = {
    byRef: new Map(),
    usage: ZERO_USAGE,
    okUsage: ZERO_USAGE,
    model: opts.model,
    calls: 0,
    failedCalls: 0,
  };

  async function run(group: PostForAI[], retryMissing: boolean): Promise<void> {
    out.calls++;
    let res: Awaited<ReturnType<typeof callOnce>>;
    try {
      res = await callOnce(client, group, opts);
    } catch (err) {
      const e = err instanceof AIError ? err : new AIError('unknown', String(err));
      out.failedCalls++;
      if (e.usage) out.usage = addUsage(out.usage, e.usage);
      if ((e.code === 'refusal' || e.code === 'truncated' || e.code === 'context-overflow') && group.length > 1) {
        const mid = Math.ceil(group.length / 2);
        await run(group.slice(0, mid), retryMissing);
        await run(group.slice(mid), retryMissing);
        return;
      }
      for (const p of group) out.byRef.set(p.ref, { ok: false, error: e });
      // Errors that affect every request (bad key, no credit) should not be retried per post.
      if (!POST_ERROR_CODES.has(e.code)) throw e;
      return;
    }
    out.usage = addUsage(out.usage, res.usage);
    out.okUsage = addUsage(out.okUsage, res.usage);
    out.model = res.model;
    out.mode = res.mode;
    for (const [ref, c] of res.byRef) out.byRef.set(ref, { ok: true, classification: c });
    // Outside the `try`: a retry that stops the run must not turn this call's results into errors.
    for (const p of group) {
      if (res.byRef.has(p.ref)) continue;
      if (retryMissing) await run([p], false);
      else out.byRef.set(p.ref, { ok: false, error: new AIError('refusal', 'The AI skipped this post.') });
    }
  }

  try {
    await run(posts, true);
  } catch (e) {
    for (const p of posts) if (!out.byRef.has(p.ref)) out.byRef.set(p.ref, { ok: false, error: e as AIError });
  }
  return out;
}
