/**
 * A server's published source list (decisions D92–D96): the outlets UnEcho Chamber sorts coverage with, each with a
 * lean only where a person set one with evidence. Never from a model or an agent. The field schemas, the list kinds
 * and the caps live in `perspectives.ts`, which this module builds on (never the other way round).
 */
import { z } from 'zod';
import { LEAN_BUCKETS, MAX_LIST_OUTLETS, MAX_OUTLET_DOMAINS, OutletDomainSchema, OutletIdSchema } from './perspectives.ts';

export const OUTLET_COUNTRIES = ['US', 'CA'] as const;
export const MAX_OUTLET_EVIDENCE = 5;

export const OutletEvidenceSchema = z.object({
  url: z.url({ protocol: /^https$/ }).max(2048),
  note: z.string().trim().min(1).max(280),
});
/** One outlet of a published list. A lean needs evidence (decision D93); `changedOn` is the UTC day of its last change. */
export const OfficialOutletSchema = z.object({
  id: OutletIdSchema,
  name: z.string().trim().min(1).max(120),
  domains: z.array(OutletDomainSchema).min(1).max(MAX_OUTLET_DOMAINS),
  country: z.enum(OUTLET_COUNTRIES),
  lean: z
    .object({ bucket: z.enum(LEAN_BUCKETS), evidence: z.array(OutletEvidenceSchema).min(1).max(MAX_OUTLET_EVIDENCE) })
    .nullable(),
  changedOn: z.iso.date(),
});
/**
 * A server's published source list (`OUTLETS_JSON_PATH`), CC BY 4.0. `version`: the number of its latest change.
 * Not strict on purpose: the extension reads lists from a newer server, and fields it doesn't know are dropped.
 */
export const OfficialListSchema = z.object({
  v: z.literal(1),
  version: z.string().regex(/^\d{1,15}$/),
  updatedAt: z.iso.datetime().nullable(),
  license: z.literal('CC-BY-4.0'),
  outlets: z.array(OfficialOutletSchema).max(MAX_LIST_OUTLETS),
});
export type OfficialList = z.infer<typeof OfficialListSchema>;
export type OfficialOutlet = z.infer<typeof OfficialOutletSchema>;

/** Served outside `/v1` (its CORS answers extension ids only): public, read by any origin (decision D96). */
export const OUTLETS_JSON_PATH = '/outlets.json';
export const OUTLET_CHANGES_JSON_PATH = '/outlets/changes.json';
export const OUTLETS_PAGE_PATH = '/outlets';
