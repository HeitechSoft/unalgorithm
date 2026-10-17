/** The "Other perspectives" contract: fictional fixture outlets only. */
import { describe, expect, it } from 'vitest';
import {
  FactcheckJobSchema,
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_LIST_DOMAINS,
  MAX_LIST_OUTLETS,
  PERSPECTIVES_COST_CEILING_MICROS,
  PERSPECTIVES_JOBS_PATH,
  PerspectivesJobRequestSchema,
  PerspectivesJobSchema,
  type PerspectivesList,
  PerspectivesListSchema,
  type PerspectivesResult,
  PerspectivesResultSchema,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  ServerInfoSchema,
} from '../src/index.ts';

const AT = '2026-10-15T12:00:00Z';
const source = (n: number, bucket: (typeof LEAN_BUCKETS)[number]) => ({
  id: `s${n}`,
  url: `https://outlet${n}.example/story`,
  domain: `outlet${n}.example`,
  title: `Fixture story ${n}`,
  pageAge: null,
  outletId: `fixture-outlet-${n}`,
  outlet: `Fixture Outlet ${n}`,
  bucket,
});
const point = (text: string, sourceId = 's1') => ({ text, citations: [{ sourceId, quote: 'a short quote' }] });

const RESULT: PerspectivesResult = {
  v: 1,
  checkedAt: AT,
  model: 'claude-sonnet-5-5',
  promptVersion: 1,
  registryVersion: 'fixture-1',
  list: 'cloud',
  story: { url: 'https://news.example.com/a', query: 'Fixture story', from: '2026-10-12T12:00:00Z', to: AT },
  coverage: LEAN_BUCKETS.map((bucket, i) => ({ bucket, sourceIds: i === 4 ? [] : [`s${i + 1}`] })),
  agreed: [point('All outlets report the vote.')],
  differences: [{ ...point('One outlet leads with the cost.', 's2'), kind: 'emphasis' }],
  unique: [point('Only one outlet names the committee.', 's3')],
  sources: [source(1, 'left'), source(2, 'lean-left'), source(3, 'center'), source(4, 'lean-right')],
};
const ok = (r: unknown) => PerspectivesResultSchema.safeParse(r).success;

/** A list as a request carries it: fictional `.example` outlets, web addresses and buckets only. */
const LIST: PerspectivesList = {
  kind: 'cloud',
  version: '57',
  outlets: [
    { bucket: 'left', domains: ['left-a.example'] },
    { bucket: 'center', domains: ['center-a.example', 'center-a-news.example'] },
  ],
};

/**
 * `outlets` outlets and `domains` web addresses in all (the first outlets get two each), every address `length`
 * characters long (at least 20), unique.
 */
function sizedList(outlets: number, domains: number, length = 20): PerspectivesList {
  const domain = (i: number) => {
    const head = `d${i}-`;
    return `${head}${'a'.repeat(length - head.length - '.example'.length)}.example`;
  };
  let n = 0;
  return {
    kind: 'cloud',
    version: '1',
    outlets: Array.from({ length: outlets }, (_, i) => ({
      bucket: LEAN_BUCKETS[i % LEAN_BUCKETS.length] as LeanBucket,
      domains: Array.from({ length: i < domains - outlets ? 2 : 1 }, () => domain(n++)),
    })),
  };
}

describe('contract', () => {
  it('test_perspectives_result_schema_buckets_and_points', () => {
    expect(PerspectivesResultSchema.parse(RESULT)).toEqual(RESULT);
    expect(ok({ ...RESULT, coverage: RESULT.coverage.slice(0, 4) })).toBe(false);
    expect(ok({ ...RESULT, coverage: [...RESULT.coverage].reverse() })).toBe(false);
    expect(ok({ ...RESULT, coverage: RESULT.coverage.map((c, i) => (i === 0 ? { ...c, bucket: 'far-left' } : c)) })).toBe(false);
    expect(ok({ ...RESULT, agreed: [{ text: 'No citation.', citations: [] }] })).toBe(false);
    expect(ok({ ...RESULT, sources: [{ ...source(1, 'left'), bucket: 'far-left' }] })).toBe(false);
  });

  it('test_perspectives_request_link_only', () => {
    const body = { v: 1, link: { url: 'https://news.example.com/a', title: 'T' }, platform: 'linkedin', list: LIST };
    const accepts = (b: unknown) => PerspectivesJobRequestSchema.safeParse(b).success;
    expect(PerspectivesJobRequestSchema.parse(body)).toEqual(body);
    expect(accepts({ ...body, link: { url: body.link.url } })).toBe(true);
    expect(accepts({ ...body, text: 'The post text.' })).toBe(false);
    expect(accepts({ ...body, post: { text: 'The post text.' } })).toBe(false);
    expect(accepts({ ...body, link: { ...body.link, text: 'The post text.' } })).toBe(false);
    expect(accepts({ ...body, link: { url: 'javascript:alert(1)' } })).toBe(false);
    expect(accepts({ ...body, link: { url: `https://news.example.com/${'a'.repeat(2048)}` } })).toBe(false);
    expect(PERSPECTIVES_JOBS_PATH).toBe('/v1/jobs/perspectives');
    expect(perspectivesJobPath('j')).toBe('/v1/jobs/perspectives/j');
    expect(perspectivesJobCancelPath('j')).toBe('/v1/jobs/perspectives/j/cancel');
  });

  it('test_perspectives_request_carries_capped_list', () => {
    // P3-77 (D102): the chosen list travels with the request, as web addresses and buckets only, capped.
    const body = { v: 1, link: { url: 'https://news.example.com/a', title: 'T' }, platform: 'linkedin', list: LIST };
    const accepts = (b: unknown) => PerspectivesJobRequestSchema.safeParse(b).success;
    const withList = (list: unknown) => ({ ...body, list });
    expect(PerspectivesJobRequestSchema.parse(body)).toEqual(body);
    expect(PerspectivesListSchema.parse(LIST)).toEqual(LIST);
    expect(accepts({ v: 1, link: body.link, platform: 'linkedin' })).toBe(false);

    // The caps: 300 outlets, 400 web addresses in all, 10 per outlet, and at least one outlet.
    expect(accepts(withList(sizedList(MAX_LIST_OUTLETS, MAX_LIST_DOMAINS)))).toBe(true);
    expect(accepts(withList(sizedList(MAX_LIST_OUTLETS + 1, MAX_LIST_OUTLETS + 1)))).toBe(false);
    expect(accepts(withList(sizedList(MAX_LIST_OUTLETS, MAX_LIST_DOMAINS + 1)))).toBe(false);
    const eleven = { bucket: 'left', domains: Array.from({ length: 11 }, (_, i) => `d${i}.example`) };
    expect(accepts(withList({ ...LIST, outlets: [eleven] }))).toBe(false);
    expect(accepts(withList({ ...LIST, outlets: [] }))).toBe(false);
    // Never a name, an id, evidence or an outlet without a lean; only the two kinds.
    const [first] = LIST.outlets;
    expect(accepts(withList({ ...LIST, outlets: [{ ...first, name: 'Fixture Left A' }] }))).toBe(false);
    expect(accepts(withList({ ...LIST, outlets: [{ ...first, id: 'fx-left-a' }] }))).toBe(false);
    expect(accepts(withList({ ...LIST, outlets: [{ ...first, evidence: [] }] }))).toBe(false);
    expect(accepts(withList({ ...LIST, outlets: [{ ...first, bucket: null }] }))).toBe(false);
    expect(accepts(withList({ ...LIST, kind: 'panel' }))).toBe(false);
    expect(accepts(withList({ ...LIST, kind: 'own', version: '' }))).toBe(true);
    expect(accepts(withList({ ...LIST, outlets: [{ ...first, domains: ['www.left-a.example'] }] }))).toBe(false);

    // The largest list fits the server's 128 KB `/v1` body limit (raising a cap fails here first).
    const largest = sizedList(MAX_LIST_OUTLETS, MAX_LIST_DOMAINS, 253);
    const request = withList(largest);
    expect(largest.outlets).toHaveLength(300);
    expect(largest.outlets.flatMap((o) => o.domains)).toHaveLength(400);
    expect(largest.outlets.every((o) => o.domains.every((d) => d.length === 253))).toBe(true);
    expect(accepts(request)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeLessThan(128 * 1024);
  });

  it('test_job_schema_for_both_tasks', () => {
    const id = '0b6f8a1e-9a4c-4c1e-8f2a-3d5b7c9e1f20';
    const error = { code: 'unknown', message: 'Something went wrong.' };
    const factcheck = { v: 1, checkedAt: AT, model: 'claude-sonnet-5-5', promptVersion: 1, claims: [], sources: [] };
    for (const [schema, result] of [
      [PerspectivesJobSchema, RESULT],
      [FactcheckJobSchema, factcheck],
    ] as const) {
      const accepts = (j: object) => schema.safeParse({ v: 1, id, ...j }).success;
      expect(accepts({ status: 'done', result })).toBe(true);
      expect(accepts({ status: 'done' })).toBe(false);
      expect(accepts({ status: 'failed', error })).toBe(true);
      expect(accepts({ status: 'failed' })).toBe(false);
      expect(accepts({ status: 'running' })).toBe(true);
      expect(accepts({ status: 'cancelled' })).toBe(true);
      expect(accepts({ status: 'running', result })).toBe(false);
    }
    // Each job carries its own task's result only.
    expect(PerspectivesJobSchema.safeParse({ v: 1, id, status: 'done', result: factcheck }).success).toBe(false);
    expect(FactcheckJobSchema.safeParse({ v: 1, id, status: 'done', result: RESULT }).success).toBe(false);
  });

  it('test_server_info_optional_perspectives_fields', () => {
    const rm2 = {
      v: 1,
      name: 'Example server',
      version: '0.1.0',
      source: 'https://github.com/example/unalgorithm/tree/v0.1.0',
      billing: true,
      capabilities: { classify: true, sync: true, factcheck: true },
      jobPrices: { factcheck: { typicalMicros: 240_000, maxMicros: 400_000 } },
      auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
      limits: { maxPostsPerRequest: 12 },
    };
    expect(ServerInfoSchema.parse(rm2)).toEqual(rm2);
    const rm3 = {
      ...rm2,
      capabilities: { ...rm2.capabilities, perspectives: true },
      jobPrices: { perspectives: { typicalMicros: 270_000, maxMicros: 500_000 } },
    };
    expect(ServerInfoSchema.parse(rm3)).toEqual(rm3);
  });

  it('test_perspectives_ceiling_is_cap_at_cost', () => {
    expect(PERSPECTIVES_COST_CEILING_MICROS * 2).toBe(500_000);
  });
});
