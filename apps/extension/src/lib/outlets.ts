/**
 * The source list this build may use for UnEcho Chamber, and the check that keeps every lean shown to the person this
 * build's own. Lean labels come only from a source list people set, never from a model or a server.
 */
import { listProblems, outletForHost, type SourceList } from '@unalgorithm/outlets';
// `@unalgorithm/outlets` is `sideEffects: false`, and MODE is a build-time constant: store and development bundles
// drop the fixture with the branches below.
import { FIXTURE_LIST, FIXTURE_OFFICIAL_LIST } from '@unalgorithm/outlets/testing';
import { type LeanBucket, type OfficialList, OfficialListSchema, type PerspectivesResult } from '@unalgorithm/protocol';
import type { StoredOfficialList } from './storage.ts';

/**
 * The source list UnEcho Chamber may use, or null (then it is hidden everywhere). E2E builds
 * (`import.meta.env.MODE === 'e2e'`): the fictional fixture. Store and development builds: none yet, as before (the
 * bundled candidates hold no lean); P3-77 replaces this with the list the person chose.
 */
export function perspectivesRegistry(): SourceList | null {
  return import.meta.env.MODE === 'e2e' ? FIXTURE_LIST : null;
}

/** `raw` as a published source list when it passes `OfficialListSchema` (unknown fields dropped) and the list rules. */
export function validOfficialList(raw: unknown): OfficialList | null {
  const parsed = OfficialListSchema.safeParse(raw);
  return parsed.success && listProblems(parsed.data.outlets).length === 0 ? parsed.data : null;
}

/**
 * UnAlgorithm Cloud's source list as this build may use it: the fictional fixture in e2e builds (which never fetch),
 * else the last good copy the background stored (`officialListItem`), checked again because content scripts can write
 * `storage.local` (ADR 0005). Null before the first good copy. Every reader of the Cloud's list goes through here.
 */
export function storedOfficialList(stored: StoredOfficialList): OfficialList | null {
  if (import.meta.env.MODE === 'e2e') return FIXTURE_OFFICIAL_LIST;
  return stored?.list ? validOfficialList(stored.list) : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * True when every lean in `result` is the extension's own: source ids are unique; each source's `outletId` is
 * `outletForHost(list, source.domain)` (and of its URL's host), its `outlet` is that outlet's name on the list, that
 * outlet has a lean, and the lean's bucket is the source's `bucket`; and each `coverage` entry lists only sources of
 * its own bucket. A server (anyone's, any release, any list it holds) can therefore never put a lean in front of the
 * person that this build's source list does not hold, nor show a lean beside another outlet's name.
 */
export function leansMatchRegistry(result: PerspectivesResult, registry: SourceList): boolean {
  const buckets = new Map<string, LeanBucket>();
  for (const source of result.sources) {
    // A repeated id would let a coverage row or a citation resolve to a source of another bucket.
    if (buckets.has(source.id)) return false;
    const outlet = outletForHost(registry, source.domain);
    if (!outlet?.lean || outlet.id !== source.outletId || outlet.lean.bucket !== source.bucket) return false;
    if (outlet.name !== source.outlet) return false;
    if (outletForHost(registry, hostOf(source.url))?.id !== outlet.id) return false;
    buckets.set(source.id, source.bucket);
  }
  return result.coverage.every((row) => row.sourceIds.every((id) => buckets.get(id) === row.bucket));
}
