import type { Classification } from '@unalgorithm/protocol';

export const CACHE_TTL_MS = 14 * 24 * 3600_000;
export const CACHE_MAX_ENTRIES = 3000;

/** A cached classification. Holds no post text and no names: only the post key and the result. */
export interface CachedClassification {
  key: string;
  postKey: string;
  classification: Classification;
  model: string;
  partialText: boolean;
  at: number;
}

/**
 * Everything that changes the answer is in the key: what the AI saw, the user's profile, the source and model,
 * and the prompt version. Changing interests or model therefore never serves a stale result.
 */
export function classificationCacheKey(parts: {
  postKey: string;
  inputHash: string;
  profileHash: string;
  sourceId: string;
  model: string;
  promptVersion: number;
}): string {
  return [parts.postKey, parts.inputHash, parts.profileHash, `${parts.sourceId}:${parts.model}`, `v${parts.promptVersion}`].join(
    '|',
  );
}

export function isFresh(entry: Pick<CachedClassification, 'at'>, now = Date.now()): boolean {
  return now - entry.at < CACHE_TTL_MS;
}
