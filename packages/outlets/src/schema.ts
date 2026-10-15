/**
 * The open outlet registry: schema and review rules. A lean label exists only when the human review panel approved it
 * with evidence; never from a model, never from an agent. Browser-safe: no `node:` import.
 */
import { LEAN_BUCKETS, type LeanBucket } from '@unalgorithm/protocol';
import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9-]{2,40}$/);
const Day = z.iso.date();
const Https = z.url({ protocol: /^https$/ }).max(2048);
const Domain = z
  .string()
  .max(253)
  .regex(/^(?!www\.)(?:[a-z0-9-]+\.)+[a-z]{2,}$/);

export const OutletFactSchema = z.strictObject({
  kind: z.enum(['owner', 'parent-company', 'founded', 'headquarters']),
  text: z.string().min(1).max(200),
  source: Https,
  checkedOn: Day,
});

export const LeanLabelSchema = z.strictObject({
  bucket: z.enum(LEAN_BUCKETS),
  evidence: z
    .array(z.strictObject({ url: Https, note: z.string().min(1).max(280) }))
    .min(1)
    .max(10),
  /** Panel roster ids (decision D25). */
  reviewers: z.array(Id).min(2).max(10),
  reviewedOn: Day,
});

export const OutletSchema = z.strictObject({
  id: Id,
  name: z.string().min(1).max(120),
  domains: z.array(Domain).min(1).max(10),
  country: z.enum(['US', 'CA']),
  /** false: only name, domains and country are listed, and nothing about the outlet was checked. */
  verified: z.boolean(),
  facts: z.array(OutletFactSchema).max(10),
  lean: LeanLabelSchema.nullable(),
});

export const REGISTRY_STATUSES = ['draft', 'reviewed', 'fixture'] as const;
export type RegistryStatus = (typeof REGISTRY_STATUSES)[number];

export const RegistrySchema = z.strictObject({
  meta: z.strictObject({
    version: z
      .string()
      .max(40)
      .regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/),
    status: z.enum(REGISTRY_STATUSES),
    license: z.literal('CC-BY-4.0'),
    updatedOn: Day,
    panel: z.array(z.strictObject({ id: Id, name: z.string().min(1).max(80) })).max(50),
    notice: z.string().max(500),
  }),
  outlets: z.array(OutletSchema).max(1000),
});

export type Registry = z.infer<typeof RegistrySchema>;
export type Outlet = z.infer<typeof OutletSchema>;
export type LeanLabel = z.infer<typeof LeanLabelSchema>;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** `outlets[<id>]` when the raw outlet at `index` has a usable id, else `outlets.<index>`. */
function outletPath(raw: unknown, index: number): string {
  const outlets = (raw as { outlets?: unknown } | null)?.outlets;
  const id = Array.isArray(outlets) ? (outlets[index] as { id?: unknown } | undefined)?.id : undefined;
  return typeof id === 'string' && Id.safeParse(id).success ? `outlets[${id}]` : `outlets.${index}`;
}

function issuePath(raw: unknown, path: readonly PropertyKey[]): string {
  const parts = path.map(String);
  if (path[0] === 'outlets' && typeof path[1] === 'number') parts.splice(0, 2, outletPath(raw, path[1]));
  return parts.join('.') || '(root)';
}

/** Problems as `path: rule` strings, [] when sound. `today` bounds review and check dates. */
export function registryProblems(raw: unknown, today: Date = new Date()): string[] {
  const parsed = RegistrySchema.safeParse(raw);
  if (!parsed.success) return parsed.error.issues.map((i) => `${issuePath(raw, i.path)}: ${i.message}`);
  const reg = parsed.data;
  const day = dayOf(today);
  const problems: string[] = [];
  const at = (o: Outlet, field: string) => `outlets[${o.id}].${field}`;

  // Panel ids unique; a reviewed registry has at least two members (rule 7).
  const panel = new Set<string>();
  for (const member of reg.meta.panel) {
    if (panel.has(member.id)) problems.push(`meta.panel: duplicate panel id: ${member.id}`);
    panel.add(member.id);
  }
  if (reg.meta.status === 'reviewed' && panel.size < 2)
    problems.push('meta.panel: reviewed registry needs a panel of at least 2');

  // Rule 1: outlet ids unique.
  const ids = new Set<string>();
  for (const o of reg.outlets) {
    if (ids.has(o.id)) problems.push(`${at(o, 'id')}: duplicate outlet id: ${o.id}`);
    ids.add(o.id);
  }

  // Rule 2: a host maps to at most one outlet.
  const owners = new Map<string, string>();
  for (const o of reg.outlets) {
    for (const d of new Set(o.domains)) {
      const other = owners.get(d);
      if (other !== undefined && other !== o.id)
        problems.push(`${at(o, 'domains')}: domain listed by two outlets: ${other}, ${o.id}`);
      else owners.set(d, o.id);
    }
  }
  for (const o of reg.outlets) {
    for (const d of new Set(o.domains)) {
      for (const [parent, owner] of owners) {
        if (owner !== o.id && d.endsWith(`.${parent}`)) {
          problems.push(`${at(o, 'domains')}: domain nested in another outlet's: ${o.id}, ${owner}`);
        }
      }
    }
  }

  for (const o of reg.outlets) {
    // Rule 3: facts only for a verified outlet, and a verified outlet has at least one.
    if (!o.verified && o.facts.length > 0) problems.push(`${at(o, 'facts')}: unverified outlet lists facts: ${o.id}`);
    if (o.verified && o.facts.length === 0) problems.push(`${at(o, 'facts')}: verified outlet lists no facts: ${o.id}`);
    for (const f of o.facts) {
      if (f.checkedOn > day) problems.push(`${at(o, 'facts')}: fact checked in the future: ${o.id}`);
    }

    const lean = o.lean;
    if (lean) {
      // Rule 4: a draft has no labels.
      if (reg.meta.status === 'draft') problems.push(`${at(o, 'lean')}: draft registry has a lean label: ${o.id}`);
      // Rule 5: distinct panel reviewers, reviewed no later than today.
      if (new Set(lean.reviewers).size !== lean.reviewers.length) {
        problems.push(`${at(o, 'lean.reviewers')}: same reviewer listed twice: ${o.id}`);
      }
      if (lean.reviewers.some((r) => !panel.has(r)))
        problems.push(`${at(o, 'lean.reviewers')}: reviewer not on the panel: ${o.id}`);
      if (lean.reviewedOn > day) problems.push(`${at(o, 'lean.reviewedOn')}: reviewed in the future: ${o.id}`);
    }

    // Rule 6: a fixture names only `.example` hosts, so it can never name a real outlet.
    if (reg.meta.status === 'fixture') {
      const hosts = [...o.domains, ...(lean?.evidence.map((e) => hostOf(e.url)) ?? []), ...o.facts.map((f) => hostOf(f.source))];
      if (hosts.some((h) => !h.endsWith('.example')))
        problems.push(`${at(o, 'domains')}: fixture names a non-.example host: ${o.id}`);
    }
  }
  return problems;
}

/** Labelled outlets of one bucket, sorted by id (the order bucket searches use). */
export function outletsIn(reg: Registry, bucket: LeanBucket): Outlet[] {
  return reg.outlets.filter((o) => o.lean?.bucket === bucket).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Reviewed, sound, and every LEAN_BUCKETS member has at least one labelled outlet. */
export function registryReady(reg: Registry, today?: Date): boolean {
  return (
    reg.meta.status === 'reviewed' &&
    registryProblems(reg, today).length === 0 &&
    LEAN_BUCKETS.every((b) => outletsIn(reg, b).length > 0)
  );
}

/** The registry perspectives may use: a ready one; a sound `fixture` one only with `allowFixture` (tests, e2e builds). */
export function usableRegistry(reg: Registry | null, opts: { allowFixture?: boolean } = {}): Registry | null {
  if (!reg) return null;
  if (reg.meta.status === 'fixture') return opts.allowFixture && registryProblems(reg).length === 0 ? reg : null;
  return registryReady(reg) ? reg : null;
}

/**
 * The one outlet one of whose domains equals `host` or is a parent of it (lowercased, `www.` ignored), else null.
 * Unique by rule 2. Used by the bucket search (P3-29) and by the extension's check of a server's result (P3-38).
 */
export function outletForHost(reg: Registry, host: string): Outlet | null {
  const h = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!h) return null;
  return reg.outlets.find((o) => o.domains.some((d) => h === d || h.endsWith(`.${d}`))) ?? null;
}
