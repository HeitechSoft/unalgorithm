/**
 * Test data only: a fictional registry. Every host ends in `.example` (rule 6), so it can never name a real outlet,
 * and `check` refuses to ship it. These labels are the only ones an agent may write.
 */
import { LEAN_BUCKETS } from '@unalgorithm/protocol';
import type { Outlet, Registry } from '../schema.ts';

const REVIEWED_ON = '2026-01-15';

function title(bucket: string): string {
  return bucket
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const outlets: Outlet[] = LEAN_BUCKETS.flatMap((bucket, b) =>
  (['a', 'b'] as const).map((suffix, s): Outlet => {
    const id = `fx-${bucket}-${suffix}`;
    return {
      id,
      name: `Fixture ${title(bucket)} ${suffix.toUpperCase()}`,
      domains: [`${bucket}-${suffix}.example`],
      country: (b * 2 + s) % 2 === 0 ? 'US' : 'CA',
      verified: false,
      facts: [],
      lean: {
        bucket,
        evidence: [{ url: `https://evidence.example/${id}`, note: 'Fictional evidence for tests.' }],
        reviewers: ['fixture-a', 'fixture-b'],
        reviewedOn: REVIEWED_ON,
      },
    };
  }),
);

export const FIXTURE_REGISTRY: Registry = {
  meta: {
    version: '0.0.0-fixture',
    status: 'fixture',
    license: 'CC-BY-4.0',
    updatedOn: REVIEWED_ON,
    panel: [
      { id: 'fixture-a', name: 'Fixture Reviewer A' },
      { id: 'fixture-b', name: 'Fixture Reviewer B' },
    ],
    notice: 'FIXTURE. Fictional outlets for tests. Never bundled.',
  },
  outlets,
};
