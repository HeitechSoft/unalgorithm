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

/**
 * The admin contract (P3-73, decisions D93–D95): admins of a server add, edit and remove its outlets, one change at a
 * time and published at once, or import the candidate list into an empty list. Every change is kept in its history.
 */
export const ADMIN_OUTLETS_PATH = '/v1/admin/outlets';
export const ADMIN_OUTLETS_IMPORT_PATH = '/v1/admin/outlets/import';
export const OUTLET_CHANGE_ACTIONS = ['import', 'add', 'edit', 'remove'] as const;
/** Newest first; the admin page and the public history show at most this many. */
export const MAX_LISTED_CHANGES = 500;
const ListVersion = z.string().regex(/^\d{1,15}$/);
/** An outlet as an admin sends it: the server sets `changedOn`. */
export const OutletInputSchema = OfficialOutletSchema.omit({ changedOn: true }).strict();
/** One change. `baseVersion`: the list version the admin's page showed (409 when the list changed since). */
export const OutletChangeRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), baseVersion: ListVersion, outlet: OutletInputSchema }),
  z.strictObject({ action: z.literal('edit'), baseVersion: ListVersion, outlet: OutletInputSchema }),
  z.strictObject({ action: z.literal('remove'), baseVersion: ListVersion, id: OutletIdSchema }),
]);
/** One entry of the change history: the outlet as published before and after (null before an add, after a remove). */
export const OutletChangeSchema = z.object({
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  action: z.enum(OUTLET_CHANGE_ACTIONS),
  outletId: OutletIdSchema,
  before: OfficialOutletSchema.nullable(),
  after: OfficialOutletSchema.nullable(),
});
/**
 * The public change history (`OUTLET_CHANGES_JSON_PATH`, decision D94): the latest changes, newest first, without who
 * made them. Not strict, as `OfficialListSchema`.
 */
export const OutletChangesSchema = z.object({
  v: z.literal(1),
  changes: z.array(OutletChangeSchema).max(MAX_LISTED_CHANGES),
});
/** The admin page's view: who made each change (their address; null once that account is deleted). */
export const AdminOutletChangeSchema = OutletChangeSchema.extend({ by: z.string().max(254).nullable() });
export const AdminOutletsSchema = z.object({
  list: OfficialListSchema,
  changes: z.array(AdminOutletChangeSchema).max(MAX_LISTED_CHANGES),
});
/** The answer to a change or an import: the list's version now. */
export const OutletChangedSchema = z.object({ ok: z.literal(true), version: ListVersion });
export type OutletChangeAction = (typeof OUTLET_CHANGE_ACTIONS)[number];
export type OutletInput = z.infer<typeof OutletInputSchema>;
export type OutletChangeRequest = z.infer<typeof OutletChangeRequestSchema>;
export type OutletChange = z.infer<typeof OutletChangeSchema>;
export type OutletChanges = z.infer<typeof OutletChangesSchema>;
export type AdminOutletChange = z.infer<typeof AdminOutletChangeSchema>;
export type AdminOutlets = z.infer<typeof AdminOutletsSchema>;
export type OutletChanged = z.infer<typeof OutletChangedSchema>;
