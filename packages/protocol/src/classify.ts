import { z } from 'zod';
import { AUTHOR_KINDS, MEDIA_KINDS, PlatformIdSchema } from './platform.ts';

/** Bump when the classification contract changes in a way caches must not survive. */
export const CLASSIFY_SCHEMA_VERSION = 1;

/** Noise categories the AI can tag. "Off-topic" is not a label: it is relevance below the user's cutoff. */
export const NOISE_LABELS = ['engagement-bait', 'rage-bait', 'clickbait', 'promotional', 'low-effort'] as const;
export type NoiseLabel = (typeof NOISE_LABELS)[number];
export const NoiseLabelSchema = z.enum(NOISE_LABELS);

export const MAX_POST_CHARS = 2000;
export const MAX_POSTS_PER_REQUEST = 12;
/** The longest model name a server may report, and the longest the extension's usage ledger keeps. */
export const MAX_MODEL_CHARS = 200;

/** Who can see a post, as the platform shows it. Only Facebook reports this. */
export const AUDIENCES = ['public', 'friends', 'custom', 'unknown'] as const;

/**
 * Everything about a post that may leave the device for classification. Deliberately has no author name,
 * profile URL, group name, comments or images. Text is normalized and capped; mentions/emails/phones masked.
 */
export const PostForAISchema = z.object({
  /**
   * Batch-local id ("p1", "p2"…) for every source, servers included, mapped back to the post on the device. Never
   * derived from the post key: a hash of a key built from the author's name and the text would give the name away.
   */
  ref: z.string().min(1).max(64),
  platform: PlatformIdSchema,
  text: z.string().max(MAX_POST_CHARS),
  /** False when the platform truncated the text behind "See more" and it was not expanded. */
  textComplete: z.boolean(),
  lang: z.string().max(16).optional(),
  authorKind: z.enum(AUTHOR_KINDS),
  isReshare: z.boolean(),
  media: z.enum(MEDIA_KINDS),
  /** Only the domain and title of a shared link, never the URL. */
  link: z.object({ domain: z.string().max(253), title: z.string().max(300).optional() }).optional(),
  /** Facebook only: who can see the post. Servers drop anything not public (R23). */
  audience: z.enum(AUDIENCES).optional(),
});
export type PostForAI = z.infer<typeof PostForAISchema>;

/**
 * R23: a server may receive a post, or a summary of one, unless it is a Facebook post whose audience isn't public
 * (friends, custom, unknown or missing).
 */
export function serverMayReceive(post: Pick<PostForAI, 'platform' | 'audience'>): boolean {
  return post.platform !== 'facebook' || post.audience === 'public';
}

/** What the user wants more and less of, as sent with every classification request. */
export const InterestProfileSchema = z.object({
  v: z.literal(1),
  interests: z.array(z.string().max(40)).max(50),
  lessOf: z.array(z.string().max(40)).max(30),
  about: z.string().max(1000),
  /** Summaries of posts the user rated, never raw post text. */
  examples: z.array(z.object({ summary: z.string().max(240), verdict: z.enum(['more', 'less']) })).max(10),
});
export type InterestProfile = z.infer<typeof InterestProfileSchema>;

export const ClassifyRequestSchema = z.object({
  v: z.literal(1),
  posts: z.array(PostForAISchema).min(1).max(MAX_POSTS_PER_REQUEST),
  profile: InterestProfileSchema,
  profileHash: z.string().max(64),
  locale: z.string().max(16),
});
export type ClassifyRequest = z.infer<typeof ClassifyRequestSchema>;

/** One post's classification after normalization (clamped, trimmed, de-duplicated). */
export const ClassificationSchema = z.object({
  /** 0-100: how well the post matches the user's interests. */
  relevance: z.number().int().min(0).max(100),
  noise: z.array(NoiseLabelSchema).max(3),
  topics: z.array(z.string().max(32)).max(3),
  /** One short, plain-language sentence explaining the call. */
  reason: z.string().max(140),
  /** Phase 3 hooks: stored now, used to offer "Check facts" / "UnEcho Chamber" later. */
  isNews: z.boolean(),
  hasCheckableClaims: z.boolean(),
});
export type Classification = z.infer<typeof ClassificationSchema>;

const ResultRefSchema = z.string().max(64);
export const PostClassificationResultSchema = z.discriminatedUnion('status', [
  z.object({ ref: ResultRefSchema, status: z.literal('ok'), classification: ClassificationSchema }),
  z.object({ ref: ResultRefSchema, status: z.literal('declined') }),
  z.object({ ref: ResultRefSchema, status: z.literal('error'), message: z.string().max(500) }),
]);
export type PostClassificationResult = z.infer<typeof PostClassificationResultSchema>;

/** Every field is bounded: the extension reads this from a server it may not trust, and keeps parts of it. */
export const ClassifyResponseSchema = z.object({
  v: z.literal(1),
  results: z.array(PostClassificationResultSchema).max(MAX_POSTS_PER_REQUEST),
  source: z.object({ kind: z.string().max(40), model: z.string().max(MAX_MODEL_CHARS), promptVersion: z.number().int() }),
  /** Present only when the server bills (unAlgorithm Cloud); absent for self-hosted servers. */
  billing: z.object({ chargedMicros: z.number().int(), balanceMicros: z.number().int() }).optional(),
});
export type ClassifyResponse = z.infer<typeof ClassifyResponseSchema>;
