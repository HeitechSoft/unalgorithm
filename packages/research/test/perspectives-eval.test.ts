import { outletForHost } from '@unalgorithm/outlets';
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { LEAN_BUCKETS, type LeanBucket, type LinkStatus, type PerspectivesResult } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  MOCK_NOW,
  mockPerspectivesDepsFor,
  PERSPECTIVES_EVAL_SET,
  PERSPECTIVES_TRUST_GATES,
  type PerspectivesEvalItem,
  type PerspectivesEvalReport,
  perspectivesTrustGates,
  runPerspectivesEval,
  tracePerspectives,
} from '../eval/perspectives-score.ts';
import type { BucketHit } from '../src/coverage.ts';
import { publishedAt } from '../src/coverage.ts';
import type { LinkChecker } from '../src/factcheck.ts';
import { runPerspectives } from '../src/perspectives.ts';

const SET = PERSPECTIVES_EVAL_SET;
const byId = new Map(SET.map((i) => [i.id, i]));

const bucketOfUrl = (url: string) => outletForHost(FIXTURE_LIST, new URL(url).hostname)?.lean?.bucket;

/** One item through the mock deps, with a clone of every hit the searcher returned. */
async function mockRun(item: PerspectivesEvalItem, opts: Parameters<typeof mockPerspectivesDepsFor>[1] = {}) {
  const deps = mockPerspectivesDepsFor(SET, opts);
  const hits: BucketHit[] = [];
  const run = await runPerspectives(item.link, {
    ...deps,
    searcher: {
      model: deps.searcher.model,
      async search(req) {
        const res = await deps.searcher.search(req);
        hits.push(...structuredClone(res.hits));
        return res;
      },
    },
  });
  return { result: run.result, hits };
}

const citedUrls = (r: PerspectivesResult): string[] => {
  const ids = new Set([...r.agreed, ...r.differences, ...r.unique].flatMap((p) => p.citations.map((c) => c.sourceId)));
  return [...new Set(r.sources.filter((s) => ids.has(s.id)).map((s) => s.url))];
};

describe('perspectives eval set v0', () => {
  it('test_perspectives_eval_set_v0_shape', () => {
    expect(SET).toHaveLength(10);
    expect(new Set(SET.map((i) => i.id)).size).toBe(10);
    const paired = SET.filter((i) => i.pair);
    expect(paired).toHaveLength(8);
    const mirrors = [
      ['left', 'right'],
      ['lean-left', 'lean-right'],
    ];
    for (const item of paired) {
      const twin = byId.get(item.pair ?? '');
      expect(twin?.pair, item.id).toBe(item.id);
      expect(twin?.expectCovered, item.id).toEqual(item.expectCovered);
      const pairBuckets = [bucketOfUrl(item.link.url), bucketOfUrl(twin?.link.url ?? '')].sort();
      expect(
        mirrors.map((m) => [...m].sort()),
        item.id,
      ).toContainEqual(pairBuckets);
    }
    expect(SET.some((i) => !i.expectCovered.includes('right'))).toBe(true);
    expect(SET.filter((i) => i.injected)).toHaveLength(1);
    for (const item of SET) {
      expect(bucketOfUrl(item.link.url), item.id).toBeDefined();
      expect(item.link.url, item.id).toMatch(/\/2026\/10\/1[234]\//);
      expect(publishedAt(null, item.link.url, MOCK_NOW), item.id).not.toBeNull();
      expect(item.expectCovered.length, item.id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('perspectives eval report', () => {
  it('test_perspectives_eval_mock_report', async () => {
    const report = await runPerspectivesEval(mockPerspectivesDepsFor(SET), SET);
    expect(report).toMatchObject({
      total: 10,
      provenance: 1,
      leanIntegrity: 1,
      coverageMatch: 1,
      pairsScored: 4,
      pairConsistency: 1,
      links: null,
      liveLinks: null,
      failures: [],
      providerErrors: [],
    });
    expect(report.citationsShown).toBeGreaterThanOrEqual(10);
    expect(report.sourcesShown).toBeGreaterThanOrEqual(10);
    expect(report.meanCostMicros).toBeGreaterThan(0);
  });

  it('test_perspectives_eval_provenance_and_lean_integrity', async () => {
    const item = SET[0] as PerspectivesEvalItem;
    const { result, hits } = await mockRun(item);
    const trace = tracePerspectives(result, hits, FIXTURE_LIST);
    expect(trace.shown).toBeGreaterThan(0);
    expect(trace).toEqual({
      shown: trace.shown,
      traced: trace.shown,
      sources: result.sources.length,
      leanOk: result.sources.length,
    });

    // A recorded hit no longer holds the quote cited from it.
    const cited = result.sources.find((s) => s.id === result.agreed[0]?.citations[0]?.sourceId);
    const doctoredHits = structuredClone(hits);
    const target = doctoredHits.find((h) => h.url === cited?.url);
    if (!target) throw new Error('expected the cited hit');
    target.snippets = ['Something else entirely.'];
    const untraced = tracePerspectives(result, doctoredHits, FIXTURE_LIST);
    expect(untraced.traced).toBeLessThan(untraced.shown);

    // A shown source whose bucket is not its outlet's.
    const doctored = structuredClone(result);
    const source = doctored.sources[0];
    if (!source) throw new Error('expected a source');
    source.bucket = LEAN_BUCKETS.find((b) => b !== source.bucket) as LeanBucket;
    const lean = tracePerspectives(doctored, hits, FIXTURE_LIST);
    expect(lean.leanOk).toBeLessThan(lean.sources);
  });

  it('test_perspectives_eval_model_lean_words_ignored', async () => {
    const item = SET[1] as PerspectivesEvalItem;
    const { result } = await mockRun(item, { leanWord: true });
    expect(result.agreed[0]?.text).toMatch(/left outlets/);
    expect(result.sources.length).toBeGreaterThan(0);
    for (const s of result.sources) expect(s.bucket, s.url).toBe(bucketOfUrl(s.url));

    const report = await runPerspectivesEval(mockPerspectivesDepsFor(SET, { leanWord: true }), SET);
    expect(report.leanIntegrity).toBe(1);
    expect(report.sourcesShown).toBeGreaterThanOrEqual(10);
  });

  it('test_perspectives_eval_gap_shown', async () => {
    for (const item of SET) {
      const { result } = await mockRun(item, { uncoverBucket: 'right' });
      expect(
        result.coverage.find((c) => c.bucket === 'right'),
        item.id,
      ).toEqual({ bucket: 'right', sourceIds: [] });
    }
    const report = await runPerspectivesEval(mockPerspectivesDepsFor(SET, { uncoverBucket: 'right' }), SET);
    const withoutRight = SET.filter((i) => !i.expectCovered.includes('right')).length;
    expect(report.coverageMatch).toBe(withoutRight / SET.length);
    expect(report.coverageMatch).toBeLessThan(1);
    expect(report.failures.filter((f) => f.reason.startsWith('coverage '))).toHaveLength(SET.length - withoutRight);
  });

  it('test_perspectives_eval_links', async () => {
    const isDead = (url: string) => /^right-[ab]\.example$/.test(new URL(url).hostname);
    const linkCheck: LinkChecker = async (urls) =>
      new Map(urls.map((u): [string, LinkStatus] => [u, isDead(u) ? 'dead' : 'live']));

    let all = 0;
    let alive = 0;
    for (const item of SET) {
      const urls = citedUrls((await mockRun(item)).result);
      all += urls.length;
      alive += urls.filter((u) => !isDead(u)).length;
    }
    const report = await runPerspectivesEval(mockPerspectivesDepsFor(SET), SET, { linkCheck });
    expect(report.links).toEqual({ live: alive, dead: all - alive, unknown: 0 });
    expect(report.liveLinks).toBe(alive / all);
    expect(report.liveLinks).toBeGreaterThan(0);
    expect(report.liveLinks).toBeLessThan(1);
    const dead = report.failures.filter((f) => f.reason.startsWith('dead link'));
    expect(dead.length).toBeGreaterThan(0);
    for (const f of dead) expect(f.reason).toMatch(/^dead link s\d+$/);
    for (const f of report.failures) expect(f.reason).not.toMatch(/https?:|\.example/);
  });
});

describe('perspectives trust gates', () => {
  const passing: PerspectivesEvalReport = {
    total: 20,
    provenance: 1,
    citationsShown: 20,
    leanIntegrity: 1,
    sourcesShown: 20,
    coverageMatch: 1,
    pairsScored: 4,
    pairConsistency: 1,
    links: { live: 97, dead: 3, unknown: 0 },
    liveLinks: 0.97,
    meanCostMicros: undefined,
    failures: [],
    providerErrors: [],
  };

  it('test_perspectives_trust_gates', () => {
    const ok = perspectivesTrustGates(passing);
    expect(ok.passed).toBe(true);
    expect(ok.provenance).toEqual({ value: 1, min: PERSPECTIVES_TRUST_GATES.provenance, passed: true });
    expect(ok.leanIntegrity.passed).toBe(true);
    expect(ok.liveLinks).toEqual({ value: 0.97, min: PERSPECTIVES_TRUST_GATES.liveLinks, passed: true });

    expect(perspectivesTrustGates({ ...passing, provenance: 0.95 })).toMatchObject({
      provenance: { passed: false },
      passed: false,
    });
    expect(perspectivesTrustGates({ ...passing, leanIntegrity: 0.95 })).toMatchObject({
      leanIntegrity: { passed: false },
      passed: false,
    });
    expect(perspectivesTrustGates({ ...passing, links: { live: 96, dead: 4, unknown: 0 } })).toMatchObject({
      liveLinks: { passed: false },
      passed: false,
    });
    expect(perspectivesTrustGates({ ...passing, links: null, liveLinks: null })).toMatchObject({
      liveLinks: { value: null, passed: null },
      passed: false,
    });

    // Every bucket a gap: nothing shown, so nothing measured and nothing passes.
    const gaps = perspectivesTrustGates({ ...passing, citationsShown: 0, sourcesShown: 0 });
    expect(gaps).toMatchObject({ provenance: { passed: null }, leanIntegrity: { passed: null }, passed: false });
    expect(perspectivesTrustGates({ ...passing, citationsShown: 0 })).toMatchObject({
      provenance: { passed: null },
      passed: false,
    });
    expect(perspectivesTrustGates({ ...passing, sourcesShown: 0 })).toMatchObject({
      leanIntegrity: { passed: null },
      passed: false,
    });
    // Too few answered links, or more unknown than answered, is not measured either.
    expect(perspectivesTrustGates({ ...passing, links: { live: 9, dead: 0, unknown: 0 } }).liveLinks.passed).toBeNull();
    expect(perspectivesTrustGates({ ...passing, links: { live: 97, dead: 3, unknown: 101 } }).liveLinks.passed).toBeNull();
  });
});
