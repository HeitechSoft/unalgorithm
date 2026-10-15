import { z } from 'zod';
import { MAX_MODEL_CHARS } from './classify.ts';

/** The five verdicts a fact-checked claim can carry. */
export const FACTCHECK_VERDICTS = ['supported', 'disputed', 'misleading', 'unverifiable', 'needs-context'] as const;
export type FactcheckVerdict = (typeof FACTCHECK_VERDICTS)[number];
export const MAX_FACTCHECK_CLAIMS = 3;
export const MAX_FACTCHECK_SEARCHES = 5;
export const MAX_QUOTE_WORDS = 25;
export const MIN_INDEPENDENT_DOMAINS = 2;
export const MAX_CITATIONS_PER_CLAIM = 4;
export const MAX_RETRIEVED_SOURCES = 20;
/** Typical own-key Anthropic cost of one check (spec: ~$0.12), shown before a check runs. */
export const FACTCHECK_TYPICAL_COST_MICROS = 120_000;

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
  explanation: z.string().max(280),
  citations: z.array(FactcheckCitationSchema).max(MAX_CITATIONS_PER_CLAIM),
  /** Set when validation replaced the model's verdict with `unverifiable`. */
  downgraded: z.enum(['too-few-domains', 'no-verdict']).optional(),
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
