/**
 * Test data only: a fictional source list. Every host ends in `.example`, so it can never name a real outlet, and
 * every evidence note carries FIXTURE_MARKER, which the store-build scan looks for (`e2e/perspectives.spec.ts`). These
 * leans are the only ones an agent may write.
 */
import { LEAN_BUCKETS, type OfficialList, type OfficialOutlet } from '@unalgorithm/protocol';
import { officialSourceList, type SourceList } from '../schema.ts';

/** In every evidence note of the fixture: a bundle holding it holds the fixture. */
export const FIXTURE_MARKER = 'UA-FIXTURE-OUTLETS-DO-NOT-SHIP';

const CHANGED_ON = '2026-01-15';

function title(bucket: string): string {
  return bucket
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const outlets: OfficialOutlet[] = LEAN_BUCKETS.flatMap((bucket, b) =>
  (['a', 'b'] as const).map((suffix, s): OfficialOutlet => {
    const id = `fx-${bucket}-${suffix}`;
    return {
      id,
      name: `Fixture ${title(bucket)} ${suffix.toUpperCase()}`,
      domains: [`${bucket}-${suffix}.example`],
      country: (b * 2 + s) % 2 === 0 ? 'US' : 'CA',
      lean: {
        bucket,
        evidence: [{ url: `https://evidence.example/${id}`, note: `Fictional evidence for tests (${FIXTURE_MARKER}).` }],
      },
      changedOn: CHANGED_ON,
    };
  }),
);

/** Ten fictional outlets, two per bucket (`fx-<bucket>-<a|b>` on `<bucket>-<a|b>.example`), as a server publishes them. */
export const FIXTURE_OFFICIAL_LIST: OfficialList = {
  v: 1,
  version: '1',
  updatedAt: `${CHANGED_ON}T00:00:00.000Z`,
  license: 'CC-BY-4.0',
  outlets,
};

/** The fixture as a run reads it. */
export const FIXTURE_LIST: SourceList = officialSourceList(FIXTURE_OFFICIAL_LIST);
