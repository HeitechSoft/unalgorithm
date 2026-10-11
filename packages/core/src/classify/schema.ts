import { type Classification, NOISE_LABELS } from '@unalgorithm/protocol';
import { z } from 'zod';
import { clamp } from '../util.ts';

/**
 * What the model returns. Kept to the subset every provider accepts in strict structured-output mode: every field
 * required, enums allowed, no numeric or length limits (values are clamped after parsing). The reason comes before
 * the score so the model explains before it decides.
 */
export const ClassificationItemSchema = z.object({
  id: z.string(),
  topics: z.array(z.string()),
  noise: z.array(z.enum(NOISE_LABELS)),
  reason: z.string(),
  relevance: z.number(),
  isNews: z.boolean(),
  hasCheckableClaims: z.boolean(),
});
export type ClassificationItem = z.infer<typeof ClassificationItemSchema>;

export const ClassificationBatchSchema = z.object({ results: z.array(ClassificationItemSchema) });
export type ClassificationBatch = z.infer<typeof ClassificationBatchSchema>;
export const CLASSIFICATION_SCHEMA_NAME = 'post_classifications';

const HANDLE = /@[\p{L}\p{N}_.]+/gu;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/** Clamp and clean a raw model result into the stored shape. */
export function normalizeItem(raw: ClassificationItem): Classification {
  const relevance = Number.isFinite(raw.relevance) ? clamp(Math.round(raw.relevance), 0, 100) : 50;
  const noise = [...new Set(raw.noise)].filter((n) => (NOISE_LABELS as readonly string[]).includes(n)).slice(0, 3);
  const topics = [
    ...new Set(raw.topics.map((t) => t.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32)).filter(Boolean)),
  ].slice(0, 3);
  let reason = raw.reason.replace(LINK, '').replace(HANDLE, '').replace(/\s+/g, ' ').trim();
  if (reason.length > 140) reason = `${reason.slice(0, 139).trimEnd()}…`;
  return { relevance, noise, topics, reason, isNews: !!raw.isNews, hasCheckableClaims: !!raw.hasCheckableClaims };
}
