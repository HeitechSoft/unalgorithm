import { z } from 'zod';
import { ClassifyResponseSchema, MAX_MODEL_CHARS, PostForAISchema } from './classify.ts';
import { ServerErrorSchema } from './server.ts';

/** The five verdicts a fact-checked claim can carry. */
export const FACTCHECK_VERDICTS = ['supported', 'disputed', 'misleading', 'unverifiable', 'needs-context'] as const;
export type FactcheckVerdict = (typeof FACTCHECK_VERDICTS)[number];
export const MAX_FACTCHECK_CLAIMS = 3;
export const MAX_FACTCHECK_SEARCHES = 5;
export const MAX_QUOTE_WORDS = 25;
export const MIN_INDEPENDENT_DOMAINS = 2;
export const MAX_CITATIONS_PER_CLAIM = 4;
/** A verdict's explanation: the model's short reason, at most this many characters (a cache entry's too). */
export const MAX_EXPLANATION_CHARS = 280;
export const MAX_RETRIEVED_SOURCES = 20;
/** Typical own-key Anthropic cost of one check (spec: ~$0.12), shown before a check runs. */
export const FACTCHECK_TYPICAL_COST_MICROS = 120_000;
/** What a server's link check found for a URL: only `dead` removes citations. */
export const LINK_STATUSES = ['live', 'dead', 'unknown'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];
/** A check stops before its next model call once it has cost this much (decision 1: hold cap $0.40 at 2×). */
export const FACTCHECK_COST_CEILING_MICROS = 200_000;
/** How long a cached claim verdict is served (decision D59): a server's and a device's alike. */
export const CLAIM_CACHE_TTL_MS = 24 * 60 * 60_000;

export const FactcheckSourceSchema = z.object({
  id: z.string().regex(/^s\d{1,2}$/),
  url: z.url({ protocol: /^https?$/ }).max(2048),
  domain: z.string().max(253),
  title: z.string().max(300),
  pageAge: z.string().max(64).nullable(),
});
export type FactcheckSource = z.infer<typeof FactcheckSourceSchema>;
export const FactcheckCitationSchema = z.object({ sourceId: z.string().max(8), quote: z.string().max(300) });
export const FactcheckClaimSchema = z.object({
  id: z.string().regex(/^c[1-3]$/),
  claim: z.string().max(300),
  verdict: z.enum(FACTCHECK_VERDICTS),
  explanation: z.string().max(MAX_EXPLANATION_CHARS),
  citations: z.array(FactcheckCitationSchema).max(MAX_CITATIONS_PER_CLAIM),
  /** Set when validation replaced the model's verdict with `unverifiable`. */
  downgraded: z.enum(['too-few-domains', 'no-verdict']).optional(),
  /**
   * When the verdict and citations came from an earlier check's cache entry: that check's time, to the hour. Explanation
   * is then the entry's, or '' when it was not kept (it repeated the post's words).
   */
  cachedAt: z.iso.datetime().optional(),
});
export type FactcheckClaim = z.infer<typeof FactcheckClaimSchema>;
export const FactcheckResultSchema = z.object({
  v: z.literal(1),
  checkedAt: z.iso.datetime(),
  model: z.string().max(MAX_MODEL_CHARS),
  promptVersion: z.number().int(),
  claims: z.array(FactcheckClaimSchema).max(MAX_FACTCHECK_CLAIMS),
  sources: z.array(FactcheckSourceSchema).max(MAX_FACTCHECK_CLAIMS * MAX_CITATIONS_PER_CLAIM),
});
export type FactcheckResult = z.infer<typeof FactcheckResultSchema>;

/** A source as retrieved in one run, before validation: what a research adapter returns (P3-02). */
export interface RetrievedSource extends FactcheckSource {
  /** The only readable text of the page: the passages the research model cited. */
  snippets: string[];
}

export const FACTCHECK_JOBS_PATH = '/v1/jobs/factcheck';
export const factcheckJobPath = (id: string) => `${FACTCHECK_JOBS_PATH}/${id}`;
/** POST: CORS on /v1 allows GET and POST only, so cancel is a POST. */
export const factcheckJobCancelPath = (id: string) => `${factcheckJobPath(id)}/cancel`;
/** A poll with `?wait=1` waits at most this long for a running job to end. */
export const FACTCHECK_POLL_WAIT_MS = 20_000;
/** A finished job's view is kept this long, then forgotten. */
export const FACTCHECK_JOB_TTL_MS = 10 * 60_000;
export const FactcheckJobRequestSchema = z.object({ v: z.literal(1), post: PostForAISchema });
export type FactcheckJobRequest = z.infer<typeof FactcheckJobRequestSchema>;
export const FACTCHECK_JOB_STATUSES = ['running', 'done', 'failed', 'cancelled'] as const;
/**
 * The view of an on-demand job (a check, a comparison): `done` carries a result, `failed` an error, `running` and
 * `cancelled` neither. Every job task shares it, and FACTCHECK_POLL_WAIT_MS and FACTCHECK_JOB_TTL_MS.
 */
export function jobSchemaFor<R extends z.ZodType>(result: R) {
  return z
    .object({
      v: z.literal(1),
      id: z.uuid(),
      status: z.enum(FACTCHECK_JOB_STATUSES),
      result: result.optional(),
      error: ServerErrorSchema.optional(),
      /** Only from a billing server that charged it: the same shape as classify's. */
      billing: ClassifyResponseSchema.shape.billing,
    })
    .refine((j) => (j.status === 'done') === (j.result !== undefined), { path: ['result'] })
    .refine((j) => j.status !== 'failed' || j.error !== undefined, { path: ['error'] });
}
export const FactcheckJobSchema = jobSchemaFor(FactcheckResultSchema);
export type FactcheckJob = z.infer<typeof FactcheckJobSchema>;
