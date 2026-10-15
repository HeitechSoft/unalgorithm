import { clipText } from '@unalgorithm/core';
import {
  type DIFFERENCE_KINDS,
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_CITATIONS_PER_CLAIM,
  MAX_PERSPECTIVES_POINTS,
  MAX_SOURCES_PER_BUCKET,
  type PerspectivesResult,
  type PerspectivesSource,
  type RetrievedCoverageSource,
} from '@unalgorithm/protocol';
import { citationProblem, decodeQuote, normalizeQuote, sourceOrder } from './validate.ts';

/**
 * The last gate between the comparison model and the person, as `validateVerdicts` is for fact-check: citations only to
 * sources retrieved and matched in this run, quotes found word for word in that source's text, "agreed" only across two
 * lean buckets, "unique" only from one. Buckets come from the retrieved sources (set by code from the registry), never
 * from the model. Pure: no model call, no fetch, no clock.
 */

export interface RawPoint {
  text: string;
  citations: { sourceId: string; quote: string }[];
}

export interface RawComparison {
  /** Source ids the model judged to cover the same story. */
  matched: string[];
  agreed: RawPoint[];
  differences: (RawPoint & { kind: (typeof DIFFERENCE_KINDS)[number] })[];
  unique: RawPoint[];
}

export interface ComparisonStats {
  unknownSource: number;
  unmatchedSource: number;
  quoteTooLong: number;
  quoteMismatch: number;
  duplicate: number;
  agreedOneBucket: number;
  uniqueManyBuckets: number;
  noCitation: number;
  emptyText: number;
  overLimit: number;
  /** True when fewer than 2 buckets had matched coverage, so every point was dropped. */
  tooFewBuckets: boolean;
}

type Citation = { sourceId: string; quote: string };
type Point = { text: string; citations: Citation[] };

const MAX_POINT_CHARS = 280;

export function validateComparison(input: { sources: readonly RetrievedCoverageSource[]; comparison: RawComparison }): {
  coverage: PerspectivesResult['coverage'];
  agreed: PerspectivesResult['agreed'];
  differences: PerspectivesResult['differences'];
  unique: PerspectivesResult['unique'];
  sources: PerspectivesResult['sources'];
  stats: ComparisonStats;
} {
  const stats: ComparisonStats = {
    unknownSource: 0,
    unmatchedSource: 0,
    quoteTooLong: 0,
    quoteMismatch: 0,
    duplicate: 0,
    agreedOneBucket: 0,
    uniqueManyBuckets: 0,
    noCitation: 0,
    emptyText: 0,
    overLimit: 0,
    tooFewBuckets: false,
  };
  const byId = new Map(input.sources.map((s) => [s.id, s]));
  const byOrder = (a: RetrievedCoverageSource, b: RetrievedCoverageSource) => sourceOrder(a.id) - sourceOrder(b.id);

  // Rule 1: the matched set, retrieved sources only.
  const matchedIds = new Set<string>();
  for (const id of input.comparison.matched) {
    if (byId.has(id)) matchedIds.add(id);
    else stats.unknownSource++;
  }

  // Rule 2: coverage per registry bucket. A source past a bucket's cap is treated as unmatched, so it is neither
  // listed nor citable.
  const matched = new Map<string, RetrievedCoverageSource>();
  const coverage = LEAN_BUCKETS.map((bucket) => {
    const inBucket = [...matchedIds]
      .map((id) => byId.get(id) as RetrievedCoverageSource)
      .filter((s) => s.bucket === bucket)
      .sort(byOrder)
      .slice(0, MAX_SOURCES_PER_BUCKET);
    for (const s of inBucket) matched.set(s.id, s);
    return { bucket, sourceIds: inBucket.map((s) => s.id) };
  });
  const sources = [...matched.values()].sort(byOrder).map(
    ({ id, url, domain, title, pageAge, outletId, outlet, bucket }): PerspectivesSource => ({
      id,
      url,
      domain,
      title,
      pageAge,
      outletId,
      outlet,
      bucket,
    }),
  );

  // Rule 5: one side alone is not a comparison.
  if (coverage.filter((c) => c.sourceIds.length > 0).length < 2) {
    stats.tooFewBuckets = true;
    return { coverage, agreed: [], differences: [], unique: [], sources, stats };
  }

  // Rules 3 and 4: a point's text and kept citations, with the buckets those citations span; null when dropped.
  const check = (raw: RawPoint): { point: Point; buckets: Set<LeanBucket> } | null => {
    const text = clipText(raw.text.trim(), MAX_POINT_CHARS);
    if (!text) {
      stats.emptyText++;
      return null;
    }
    const seen = new Set<string>();
    const citations: Citation[] = [];
    const buckets = new Set<LeanBucket>();
    for (const c of raw.citations) {
      if (!byId.has(c.sourceId)) {
        stats.unknownSource++;
        continue;
      }
      const source = matched.get(c.sourceId);
      if (!source) {
        stats.unmatchedSource++;
        continue;
      }
      const problem = citationProblem(c.quote, source.snippets);
      if (problem) {
        stats[problem]++;
        continue;
      }
      const quote = decodeQuote(c.quote);
      const key = `${source.id}\u0000${normalizeQuote(quote)}`;
      if (seen.has(key) || citations.length >= MAX_CITATIONS_PER_CLAIM) {
        stats.duplicate++;
        continue;
      }
      seen.add(key);
      citations.push({ sourceId: source.id, quote });
      buckets.add(source.bucket);
    }
    if (citations.length === 0) {
      stats.noCitation++;
      return null;
    }
    return { point: { text, citations }, buckets };
  };

  const cap = <T>(points: T[]): T[] => {
    stats.overLimit += Math.max(0, points.length - MAX_PERSPECTIVES_POINTS);
    return points.slice(0, MAX_PERSPECTIVES_POINTS);
  };

  const agreed: Point[] = [];
  for (const raw of input.comparison.agreed) {
    const checked = check(raw);
    if (!checked) continue;
    if (checked.buckets.size < 2) stats.agreedOneBucket++;
    else agreed.push(checked.point);
  }
  const unique: Point[] = [];
  for (const raw of input.comparison.unique) {
    const checked = check(raw);
    if (!checked) continue;
    if (checked.buckets.size > 1) stats.uniqueManyBuckets++;
    else unique.push(checked.point);
  }
  const differences: PerspectivesResult['differences'] = [];
  for (const raw of input.comparison.differences) {
    const checked = check(raw);
    if (checked) differences.push({ ...checked.point, kind: raw.kind });
  }

  return { coverage, agreed: cap(agreed), differences: cap(differences), unique: cap(unique), sources, stats };
}
