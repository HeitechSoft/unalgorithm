/**
 * The published source list's contract (P3-72): fictional `.example` outlets only. The outlets package's own tests
 * also parse its fixture, `FIXTURE_OFFICIAL_LIST`, with this schema (the protocol imports no other package).
 */
import { describe, expect, it } from 'vitest';
import {
  BUCKET_LABELS,
  CLOUD_ORIGIN,
  LEAN_BUCKETS,
  LIST_KINDS,
  MAX_LIST_OUTLETS,
  type OfficialList,
  OfficialListSchema,
  type OfficialOutlet,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  OUTLETS_PAGE_PATH,
  OutletDomainSchema,
  OutletIdSchema,
  SOURCE_LIST_PAGE_URL,
} from '../src/index.ts';

const outlet = (n: number): OfficialOutlet => ({
  id: `fx-outlet-${n}`,
  name: `Fixture Outlet ${n}`,
  domains: [`outlet-${n}.example`],
  country: n % 2 === 0 ? 'US' : 'CA',
  lean: {
    bucket: LEAN_BUCKETS[n % LEAN_BUCKETS.length] ?? 'center',
    evidence: [{ url: `https://evidence.example/fx-outlet-${n}`, note: 'Fictional evidence for tests.' }],
  },
  changedOn: '2026-01-15',
});

const LIST: OfficialList = {
  v: 1,
  version: '1',
  updatedAt: '2026-01-15T00:00:00.000Z',
  license: 'CC-BY-4.0',
  outlets: [1, 2, 3, 4, 5].map(outlet),
};

const ok = (list: unknown) => OfficialListSchema.safeParse(list).success;
const withOutlet = (over: Record<string, unknown>) => ({ ...LIST, outlets: [{ ...outlet(1), ...over }] });

describe('official list', () => {
  it('test_official_list_schema_accepts_and_refuses', () => {
    expect(OfficialListSchema.parse(LIST)).toEqual(LIST);
    // No lean at all is fine (the seed import); `updatedAt` is null before the first change.
    expect(ok({ ...LIST, updatedAt: null, outlets: [{ ...outlet(1), lean: null }] })).toBe(true);

    // A lean needs evidence (decision D93), over HTTPS.
    expect(ok(withOutlet({ lean: { bucket: 'left', evidence: [] } }))).toBe(false);
    expect(ok(withOutlet({ lean: { bucket: 'left' } }))).toBe(false);
    const http = { bucket: 'left', evidence: [{ url: 'http://evidence.example/a', note: 'Plain HTTP.' }] };
    expect(ok(withOutlet({ lean: http }))).toBe(false);
    expect(ok(withOutlet({ lean: { bucket: 'far-left', evidence: outlet(1).lean?.evidence } }))).toBe(false);

    // One domain regex: no `www.`, lowercased.
    expect(ok(withOutlet({ domains: ['www.outlet-1.example'] }))).toBe(false);
    expect(ok(withOutlet({ domains: ['Outlet-1.example'] }))).toBe(false);
    expect(ok(withOutlet({ id: 'Fx Outlet' }))).toBe(false);

    // The caps and the literals.
    const many = Array.from({ length: MAX_LIST_OUTLETS + 1 }, (_, i) => outlet(i));
    expect(ok({ ...LIST, outlets: many })).toBe(false);
    expect(ok({ ...LIST, outlets: many.slice(0, MAX_LIST_OUTLETS) })).toBe(true);
    expect(ok({ ...LIST, v: 2 })).toBe(false);
    expect(ok({ ...LIST, license: 'CC0' })).toBe(false);
    expect(ok({ ...LIST, version: 'v1' })).toBe(false);

    // Not strict: a newer server's extra field is dropped, not refused.
    const newer = { ...LIST, publisher: 'A newer server' };
    expect(OfficialListSchema.parse(newer)).toEqual(LIST);
  });

  it('test_list_fields_and_paths', () => {
    expect(LIST_KINDS).toEqual(['cloud', 'own']);
    expect(OutletIdSchema.safeParse('le-devoir').success).toBe(true);
    expect(OutletIdSchema.safeParse('x').success).toBe(false);
    expect(OutletDomainSchema.safeParse('apnews.com').success).toBe(true);
    expect(OutletDomainSchema.safeParse('www.apnews.com').success).toBe(false);
    expect(Object.isFrozen(BUCKET_LABELS)).toBe(true);
    expect(LEAN_BUCKETS.map((b) => BUCKET_LABELS[b])).toEqual(['Left', 'Leans left', 'Center', 'Leans right', 'Right']);
    expect([OUTLETS_JSON_PATH, OUTLET_CHANGES_JSON_PATH, OUTLETS_PAGE_PATH]).toEqual([
      '/outlets.json',
      '/outlets/changes.json',
      '/outlets',
    ]);
    expect(CLOUD_ORIGIN).toBe('https://cloud.unalgorithm.app');
    expect(SOURCE_LIST_PAGE_URL).toBe('https://cloud.unalgorithm.app/outlets');
  });
});
