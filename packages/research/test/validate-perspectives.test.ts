import {
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_PERSPECTIVES_POINTS,
  PerspectivesResultSchema,
  type RetrievedCoverageSource,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { type RawComparison, type RawPoint, validateComparison } from '../src/validate-perspectives.ts';

/** A fixture-outlet source (`fx-left-a`, `left-a.example`), as P3-29's bucket search returns it. */
function source(id: string, bucket: LeanBucket, suffix = 'a'): RetrievedCoverageSource {
  const domain = `${bucket}-${suffix}.example`;
  return {
    id,
    url: `https://${domain}/story-${id}`,
    domain,
    title: `Bridge vote, as told by ${domain}`,
    pageAge: '2026-10-14T09:00:00Z',
    outletId: `fx-${bucket}-${suffix}`,
    outlet: `Fixture ${bucket} ${suffix.toUpperCase()}`,
    bucket,
    snippets: [`The council approved the bridge on Monday, ${bucket} ${suffix} reports.`, `Quote from ${id} here.`],
  };
}

const SOURCES: RetrievedCoverageSource[] = [
  source('s1', 'left'),
  source('s2', 'left', 'b'),
  source('s3', 'center'),
  source('s4', 'right'),
  source('s5', 'lean-right'),
  source('s6', 'lean-left'),
];

const cite = (sourceId: string) => ({ sourceId, quote: 'The council approved the bridge on Monday' });
const point = (text: string, ...ids: string[]): RawPoint => ({ text, citations: ids.map(cite) });

function comparison(over: Partial<RawComparison> = {}): RawComparison {
  return { matched: ['s1', 's2', 's3', 's4'], agreed: [], differences: [], unique: [], ...over };
}

const run = (over: Partial<RawComparison> = {}, sources = SOURCES) =>
  validateComparison({ sources, comparison: comparison(over) });

describe('coverage', () => {
  it('test_comparison_coverage_from_registry_buckets', () => {
    const out = run();
    expect(out.coverage).toEqual([
      { bucket: 'left', sourceIds: ['s1', 's2'] },
      { bucket: 'lean-left', sourceIds: [] },
      { bucket: 'center', sourceIds: ['s3'] },
      { bucket: 'lean-right', sourceIds: [] },
      { bucket: 'right', sourceIds: ['s4'] },
    ]);
    // s5 (lean-right) and s6 (lean-left) were retrieved but not matched: not listed, their buckets are gaps.
    expect(out.coverage.map((c) => c.bucket)).toEqual([...LEAN_BUCKETS]);
    expect(out.sources.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('caps a bucket at MAX_SOURCES_PER_BUCKET and sorts ids numerically', () => {
    const many = ['s10', 's2', 's9', 's1', 's11'].map((id) => source(id, 'left', id));
    const out = validateComparison({
      sources: [...many, source('s3', 'center')],
      comparison: comparison({ matched: ['s10', 's2', 's9', 's1', 's11', 's3', 's1'] }),
    });
    expect(out.coverage[0]).toEqual({ bucket: 'left', sourceIds: ['s1', 's2', 's9', 's10'] });
    expect(out.sources.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's9', 's10']);
  });

  it('test_comparison_ignores_model_buckets', () => {
    const base = comparison({
      agreed: [point('Approved Monday.', 's1', 's3')],
      unique: [point('Only the right says so.', 's4')],
    });
    const tampered = {
      ...base,
      lean: { s1: 'right' },
      agreed: [{ ...base.agreed[0], bucket: 'right' }],
      unique: [{ ...base.unique[0], bucket: 'left', lean: 'left' }],
      coverage: [{ bucket: 'right', sourceIds: ['s1', 's2', 's3'] }],
    } as unknown as RawComparison;
    const sourcesWithLean = SOURCES.map((s) => ({ ...s, lean: 'center' }));
    expect(validateComparison({ sources: sourcesWithLean, comparison: tampered })).toEqual(
      validateComparison({ sources: SOURCES, comparison: base }),
    );
  });
});

describe('citations', () => {
  it('test_comparison_citation_rules', () => {
    const good = cite('s3');
    const cases: [RawPoint['citations'][number], keyof ReturnType<typeof run>['stats']][] = [
      [{ sourceId: 's99', quote: good.quote }, 'unknownSource'],
      [{ sourceId: 's5', quote: good.quote }, 'unmatchedSource'],
      [{ sourceId: 's1', quote: Array.from({ length: 26 }, () => 'word').join(' ') }, 'quoteTooLong'],
      [{ sourceId: 's1', quote: 'The council rejected the bridge' }, 'quoteMismatch'],
    ];
    for (const [bad, stat] of cases) {
      const out = run({ agreed: [{ text: 'Approved Monday.', citations: [cite('s1'), bad, good] }] });
      expect(out.stats[stat], stat).toBe(1);
      expect(out.agreed[0]?.citations, stat).toEqual([cite('s1'), good]);
    }
  });

  it('de-duplicates on (sourceId, normalized quote)', () => {
    const out = run({
      agreed: [
        {
          text: 'Approved Monday.',
          citations: [cite('s1'), { sourceId: 's1', quote: '  THE council approved   the bridge on monday ' }, cite('s3')],
        },
      ],
    });
    expect(out.stats.duplicate).toBe(1);
    expect(out.agreed[0]?.citations).toEqual([cite('s1'), cite('s3')]);
  });
});

describe('points', () => {
  it('test_agreed_needs_two_buckets', () => {
    const out = run({ agreed: [point('Same bucket.', 's1', 's2'), point('Two buckets.', 's1', 's3')] });
    expect(out.stats.agreedOneBucket).toBe(1);
    expect(out.agreed).toEqual([{ text: 'Two buckets.', citations: [cite('s1'), cite('s3')] }]);
  });

  it('test_unique_needs_one_bucket', () => {
    const out = run({ unique: [point('Both sides.', 's1', 's4'), point('Right only.', 's4')] });
    expect(out.stats.uniqueManyBuckets).toBe(1);
    expect(out.unique).toEqual([{ text: 'Right only.', citations: [cite('s4')] }]);
  });

  it('test_differences_keep_kind_need_citation', () => {
    const out = run({
      differences: [
        { ...point('Framed as a win.', 's4'), kind: 'framing' },
        { text: 'Nothing backs this.', citations: [{ sourceId: 's99', quote: 'x' }, cite('s5')], kind: 'omission' },
      ],
    });
    expect(out.differences).toEqual([{ text: 'Framed as a win.', citations: [cite('s4')], kind: 'framing' }]);
    expect(out.stats.noCitation).toBe(1);
  });

  it('drops a point with empty text', () => {
    const out = run({ agreed: [point('   ', 's1', 's3')] });
    expect(out.agreed).toEqual([]);
    expect(out.stats.emptyText).toBe(1);
  });

  it('test_too_few_buckets_drops_points', () => {
    const out = run({
      matched: ['s1', 's2'],
      agreed: [point('Approved Monday.', 's1', 's2')],
      differences: [{ ...point('Framed.', 's1'), kind: 'emphasis' }],
      unique: [point('Left only.', 's1')],
    });
    expect(out.stats.tooFewBuckets).toBe(true);
    expect(out.agreed).toEqual([]);
    expect(out.differences).toEqual([]);
    expect(out.unique).toEqual([]);
    expect(out.coverage[0]).toEqual({ bucket: 'left', sourceIds: ['s1', 's2'] });
    expect(run().stats.tooFewBuckets).toBe(false);
  });

  it('test_points_capped_and_clipped', () => {
    const agreed = Array.from({ length: MAX_PERSPECTIVES_POINTS + 1 }, (_, i) => point(`Fact ${i}.`, 's1', 's3'));
    agreed[0] = point(` ${'a'.repeat(400)} `, 's1', 's3');
    const out = run({ agreed });
    expect(out.agreed).toHaveLength(MAX_PERSPECTIVES_POINTS);
    expect(out.stats.overLimit).toBe(1);
    expect(out.agreed[0]?.text).toBe('a'.repeat(280));
    expect(out.agreed.at(-1)?.text).toBe(`Fact ${MAX_PERSPECTIVES_POINTS - 1}.`);
  });
});

describe('shape', () => {
  it('test_validated_comparison_matches_schema', () => {
    const { stats: _stats, ...out } = run({
      matched: ['s1', 's2', 's3', 's4', 's5', 's6', 's1'],
      agreed: [point('Approved Monday.', 's1', 's3', 's4')],
      differences: [{ ...point('Framed as a win.', 's5'), kind: 'sourcing' }],
      unique: [point('Left only.', 's2')],
    });
    const result = PerspectivesResultSchema.parse({
      v: 1,
      checkedAt: '2026-10-15T12:00:00.000Z',
      model: 'fake-model',
      promptVersion: 1,
      registryVersion: 'fixture-1',
      list: 'cloud',
      story: {
        url: 'https://center-a.example/story',
        query: 'bridge vote',
        from: '2026-10-12T00:00:00.000Z',
        to: '2026-10-15T12:00:00.000Z',
      },
      ...out,
    });
    const ids = new Set(result.sources.map((s) => s.id));
    const cited = [...result.agreed, ...result.differences, ...result.unique].flatMap((p) => p.citations);
    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) expect(ids.has(c.sourceId)).toBe(true);
    expect(result.sources[0]).toEqual({
      id: 's1',
      url: 'https://left-a.example/story-s1',
      domain: 'left-a.example',
      title: 'Bridge vote, as told by left-a.example',
      pageAge: '2026-10-14T09:00:00Z',
      outletId: 'fx-left-a',
      outlet: 'Fixture left A',
      bucket: 'left',
    });
  });
});
