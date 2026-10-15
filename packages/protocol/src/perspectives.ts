/**
 * "Other perspectives": the wire contract every RM3 piece shares (pipeline, server endpoint, extension, side panel).
 * The only part of a post a comparison sends anywhere is its shared link (`SharedLinkSchema`); lean labels come only
 * from the reviewed outlet registry (packages/outlets), never from a model.
 */
import { z } from 'zod';
import { AUDIENCES, MAX_MODEL_CHARS } from './classify.ts';
import {
  FactcheckCitationSchema,
  FactcheckSourceSchema,
  jobSchemaFor,
  MAX_CITATIONS_PER_CLAIM,
  type RetrievedSource,
} from './factcheck.ts';
import { PlatformIdSchema } from './platform.ts';

/** Lean buckets, in display order (decision D24). Labels come only from the reviewed registry (packages/outlets). */
export const LEAN_BUCKETS = ['left', 'lean-left', 'center', 'lean-right', 'right'] as const;
export type LeanBucket = (typeof LEAN_BUCKETS)[number];
export const PERSPECTIVES_WINDOW_DAYS = 3;
export const MAX_SOURCES_PER_BUCKET = 4;
export const MAX_PERSPECTIVES_POINTS = 6;
/** Spec → Monetization: typical cost $0.135; shown on an own Anthropic key before a run. */
export const PERSPECTIVES_TYPICAL_COST_MICROS = 135_000;
/** A comparison stops before its next model call once it has cost this much (hold cap $0.50 at 2×). */
export const PERSPECTIVES_COST_CEILING_MICROS = 250_000;
export const DIFFERENCE_KINDS = ['emphasis', 'framing', 'sourcing', 'omission'] as const;
export type DifferenceKind = (typeof DIFFERENCE_KINDS)[number];

const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);

/** The only part of a post that perspectives sends anywhere: the shared link's URL and its link-card title. */
export const SharedLinkSchema = z.strictObject({
  url: HttpUrl,
  title: z.string().max(300).optional(),
});
export type SharedLink = z.infer<typeof SharedLinkSchema>;

export const PerspectivesSourceSchema = FactcheckSourceSchema.extend({
  outletId: z.string().regex(/^[a-z0-9-]{2,40}$/),
  outlet: z.string().max(120),
  bucket: z.enum(LEAN_BUCKETS),
});
export type PerspectivesSource = z.infer<typeof PerspectivesSourceSchema>;

/** A source as found by a bucket search, before validation; outlet and bucket set by code from the registry. */
export interface RetrievedCoverageSource extends RetrievedSource {
  outletId: string;
  outlet: string;
  bucket: LeanBucket;
}

const Point = z.object({
  text: z.string().max(280),
  citations: z.array(FactcheckCitationSchema).min(1).max(MAX_CITATIONS_PER_CLAIM),
});

export const PerspectivesResultSchema = z
  .object({
    v: z.literal(1),
    checkedAt: z.iso.datetime(),
    model: z.string().max(MAX_MODEL_CHARS),
    promptVersion: z.number().int(),
    registryVersion: z.string().max(40),
    story: z.object({ url: HttpUrl, query: z.string().max(200), from: z.iso.datetime(), to: z.iso.datetime() }),
    /** One entry per LEAN_BUCKETS member, in that order; empty sourceIds = no coverage found (a gap). */
    coverage: z
      .array(
        z.object({
          bucket: z.enum(LEAN_BUCKETS),
          sourceIds: z.array(z.string().max(8)).max(MAX_SOURCES_PER_BUCKET),
        }),
      )
      .length(LEAN_BUCKETS.length),
    agreed: z.array(Point).max(MAX_PERSPECTIVES_POINTS),
    differences: z.array(Point.extend({ kind: z.enum(DIFFERENCE_KINDS) })).max(MAX_PERSPECTIVES_POINTS),
    unique: z.array(Point).max(MAX_PERSPECTIVES_POINTS),
    sources: z.array(PerspectivesSourceSchema).max(LEAN_BUCKETS.length * MAX_SOURCES_PER_BUCKET),
  })
  .refine((r) => r.coverage.every((c, i) => c.bucket === LEAN_BUCKETS[i]), { path: ['coverage'] });
export type PerspectivesResult = z.infer<typeof PerspectivesResultSchema>;

export const PERSPECTIVES_JOBS_PATH = '/v1/jobs/perspectives';
export const perspectivesJobPath = (id: string) => `${PERSPECTIVES_JOBS_PATH}/${id}`;
/** POST, as fact-check's: CORS on /v1 allows GET and POST only. */
export const perspectivesJobCancelPath = (id: string) => `${perspectivesJobPath(id)}/cancel`;

/** Strict: a body with post text (or any other field) is refused, not stripped (F18). */
export const PerspectivesJobRequestSchema = z.strictObject({
  v: z.literal(1),
  link: SharedLinkSchema,
  platform: PlatformIdSchema,
  /** Facebook only, as PostForAI: the server refuses anything not public. */
  audience: z.enum(AUDIENCES).optional(),
});
export type PerspectivesJobRequest = z.infer<typeof PerspectivesJobRequestSchema>;

/** Polled and kept as a fact-check job is: FACTCHECK_POLL_WAIT_MS, FACTCHECK_JOB_TTL_MS. */
export const PerspectivesJobSchema = jobSchemaFor(PerspectivesResultSchema);
export type PerspectivesJob = z.infer<typeof PerspectivesJobSchema>;
