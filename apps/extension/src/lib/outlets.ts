/**
 * The outlet registry this build may use for "Other perspectives", and the check that keeps every lean shown to the
 * person this build's own. Lean labels come only from a reviewed registry, never from a model or a server.
 */
import { bundledRegistry, outletForHost, type Registry, usableRegistry } from '@unalgorithm/outlets';
// `@unalgorithm/outlets` is `sideEffects: false`, and MODE is a build-time constant: store and development bundles
// drop the fixture with the branch below.
import { FIXTURE_REGISTRY } from '@unalgorithm/outlets/testing';
import type { LeanBucket, PerspectivesResult } from '@unalgorithm/protocol';

let chosen: Registry | null | undefined;

/**
 * The registry perspectives may use, or null (then perspectives is hidden everywhere). Store and development builds:
 * the bundled registry only when reviewed and ready. E2E builds (`import.meta.env.MODE === 'e2e'`): the fictional
 * fixture. Computed once.
 */
export function perspectivesRegistry(): Registry | null {
  if (chosen === undefined) {
    chosen =
      import.meta.env.MODE === 'e2e'
        ? usableRegistry(FIXTURE_REGISTRY, { allowFixture: true })
        : usableRegistry(bundledRegistry());
  }
  return chosen;
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
 * `outletForHost(registry, source.domain)` (and of its URL's host), its `outlet` is that outlet's registry name, that
 * outlet has a label, and the label's bucket is the source's `bucket`; and each `coverage` entry lists only sources of
 * its own bucket. A server (anyone's, any release, any registry it was built with) can therefore never put a lean in
 * front of the person that this build's reviewed registry does not hold, nor show a lean beside another outlet's name.
 */
export function leansMatchRegistry(result: PerspectivesResult, registry: Registry): boolean {
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
