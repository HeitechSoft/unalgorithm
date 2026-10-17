/**
 * Source lists for UnEcho Chamber: the bundled candidate list's schema, the one runtime shape every run reads, the list
 * rules and the lookups. A lean exists only where a person set one: UnAlgorithm Cloud's admins with evidence, or a
 * person on their own list. Never a model, never an agent. Browser-safe: no `node:` import.
 */
import {
  type LeanBucket,
  type ListKind,
  MAX_LIST_DOMAINS,
  MAX_LIST_OUTLETS,
  MAX_OUTLET_DOMAINS,
  type OfficialList,
  OUTLET_COUNTRIES,
  OutletDomainSchema,
  OutletIdSchema,
} from '@unalgorithm/protocol';
import { z } from 'zod';

/** One candidate outlet: name, web addresses and country. Its `lean` is always null. */
export const CandidateOutletSchema = z.strictObject({
  id: OutletIdSchema,
  name: z.string().min(1).max(120),
  domains: z.array(OutletDomainSchema).min(1).max(MAX_OUTLET_DOMAINS),
  country: z.enum(OUTLET_COUNTRIES),
  lean: z.null(),
});
/** The bundled candidate list (`data/candidates.json`): prepared by an agent, so it can never hold a lean. */
export const CandidatesSchema = z.strictObject({
  meta: z.strictObject({ license: z.literal('CC-BY-4.0'), updatedOn: z.iso.date(), notice: z.string().max(500) }),
  outlets: z.array(CandidateOutletSchema).max(MAX_LIST_OUTLETS),
});
export type Candidates = z.infer<typeof CandidatesSchema>;
export type CandidateOutlet = z.infer<typeof CandidateOutletSchema>;

/** One outlet as a run reads it: its lean is the bucket alone (no evidence travels with a run). */
export interface ListedOutlet {
  id: string;
  name: string;
  domains: readonly string[];
  lean: { bucket: LeanBucket } | null;
}
/** What a UnEcho Chamber run reads: any list, the Cloud's, a person's own, or the fixture. */
export interface SourceList {
  kind: ListKind;
  version: string;
  outlets: readonly ListedOutlet[];
}

/** A published list (already parsed with `OfficialListSchema`) as a run reads it: kind 'cloud', its version. */
export function officialSourceList(list: OfficialList): SourceList {
  return {
    kind: 'cloud',
    version: list.version,
    outlets: list.outlets.map((o) => ({
      id: o.id,
      name: o.name,
      domains: o.domains,
      lean: o.lean ? { bucket: o.lean.bucket } : null,
    })),
  };
}

export type ListProblemCode = 'duplicate-id' | 'domain-taken' | 'domain-nested' | 'too-many-outlets' | 'too-many-domains';
export interface ListProblem {
  code: ListProblemCode;
  /** The outlet the problem is about; null for the caps, which are about the whole list. */
  outletId: string | null;
}

/**
 * Problems of a whole list; [] when sound. Ids are unique (rule 1); a host maps to at most one outlet, so no web
 * address is listed by two outlets or nested under another outlet's (rule 2); at most MAX_LIST_OUTLETS outlets and
 * MAX_LIST_DOMAINS web addresses in all. Each problem once, in the order found.
 */
export function listProblems(outlets: readonly { id: string; domains: readonly string[] }[]): ListProblem[] {
  const problems: ListProblem[] = [];
  const seen = new Set<string>();
  const add = (code: ListProblemCode, outletId: string | null) => {
    const key = `${code} ${outletId}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ code, outletId });
  };

  // Rule 1: outlet ids unique.
  const ids = new Set<string>();
  for (const o of outlets) {
    if (ids.has(o.id)) add('duplicate-id', o.id);
    ids.add(o.id);
  }

  // Rule 2: a host maps to at most one outlet.
  const owners = new Map<string, string>();
  for (const o of outlets) {
    for (const d of new Set(o.domains)) {
      const other = owners.get(d);
      if (other !== undefined && other !== o.id) add('domain-taken', o.id);
      else owners.set(d, o.id);
    }
  }
  for (const o of outlets) {
    for (const d of new Set(o.domains)) {
      for (const [parent, owner] of owners) {
        if (owner !== o.id && d.endsWith(`.${parent}`)) add('domain-nested', o.id);
      }
    }
  }

  if (outlets.length > MAX_LIST_OUTLETS) add('too-many-outlets', null);
  if (outlets.reduce((n, o) => n + o.domains.length, 0) > MAX_LIST_DOMAINS) add('too-many-domains', null);
  return problems;
}

/** Plain words for a problem, naming the outlet by id (ids are `OutletIdSchema`, safe to show and to log). */
export function listProblemText(p: ListProblem): string {
  switch (p.code) {
    case 'duplicate-id':
      return `Two outlets have the id ${p.outletId}.`;
    case 'domain-taken':
      return `${p.outletId}: another outlet already lists one of its web addresses.`;
    case 'domain-nested':
      return `${p.outletId}: one of its web addresses is inside another outlet's.`;
    case 'too-many-outlets':
      return `The list has more than ${MAX_LIST_OUTLETS} outlets.`;
    case 'too-many-domains':
      return `The list has more than ${MAX_LIST_DOMAINS} web addresses.`;
  }
}

/** Outlets with a lean in one bucket, sorted by id (the order bucket searches use). */
export function outletsIn<O extends ListedOutlet>(list: { outlets: readonly O[] }, bucket: LeanBucket): O[] {
  return list.outlets.filter((o) => o.lean?.bucket === bucket).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The one outlet one of whose domains equals `host` or is a parent of it (lowercased, `www.` ignored), else null.
 * Unique by rule 2. Used by the bucket search (P3-29) and by the extension's check of a server's result (P3-38).
 */
export function outletForHost<O extends { domains: readonly string[] }>(list: { outlets: readonly O[] }, host: string): O | null {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!h) return null;
  return list.outlets.find((o) => o.domains.some((d) => h === d || h.endsWith(`.${d}`))) ?? null;
}

/** `https://www.NYTimes.com/x` → `nytimes.com`; null unless the result passes `OutletDomainSchema`. */
export function domainFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  return OutletDomainSchema.safeParse(host).success ? host : null;
}

/** `Le Devoir` → `le-devoir` (NFKD, accents dropped, non-alphanumerics → `-`, at most 40); '' when under 2 characters. */
export function outletIdFromName(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return id.length >= 2 ? id : '';
}
