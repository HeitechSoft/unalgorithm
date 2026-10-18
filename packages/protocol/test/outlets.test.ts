/**
 * The published source list's contract (P3-72): fictional `.example` outlets only. The outlets package's own tests
 * also parse its fixture, `FIXTURE_OFFICIAL_LIST`, with this schema (the protocol imports no other package).
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  AdminOutletsSchema,
  BUCKET_LABELS,
  CLOUD_ORIGIN,
  LEAN_BUCKETS,
  LIST_KINDS,
  MAX_LIST_OUTLETS,
  type OfficialList,
  OfficialListSchema,
  type OfficialOutlet,
  OUTLET_CHANGE_ACTIONS,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  OUTLETS_PAGE_PATH,
  OutletChangedSchema,
  OutletChangeRequestSchema,
  OutletDomainSchema,
  OutletIdSchema,
  OutletInputSchema,
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

describe('admin contract', () => {
  const { changedOn: _changedOn, ...input } = outlet(1);

  it('test_outlet_change_request_shapes', () => {
    expect(ADMIN_OUTLETS_PATH).toBe('/v1/admin/outlets');
    expect(ADMIN_OUTLETS_IMPORT_PATH).toBe('/v1/admin/outlets/import');
    expect(OUTLET_CHANGE_ACTIONS).toEqual(['import', 'add', 'edit', 'remove']);
    const parses = (req: unknown) => OutletChangeRequestSchema.safeParse(req).success;

    // The three actions an admin sends.
    expect(OutletChangeRequestSchema.parse({ action: 'add', baseVersion: '0', outlet: input })).toEqual({
      action: 'add',
      baseVersion: '0',
      outlet: input,
    });
    expect(parses({ action: 'edit', baseVersion: '12', outlet: { ...input, lean: null } })).toBe(true);
    expect(parses({ action: 'remove', baseVersion: '13', id: 'fx-outlet-1' })).toBe(true);

    // An import is the server's own action, never a request; an unknown one is refused too.
    expect(parses({ action: 'import', baseVersion: '0', outlet: input })).toBe(false);
    expect(parses({ action: 'rename', baseVersion: '0', outlet: input })).toBe(false);
    // Every change names the version the admin's page showed.
    expect(parses({ action: 'add', outlet: input })).toBe(false);
    expect(parses({ action: 'remove', id: 'fx-outlet-1' })).toBe(false);
    expect(parses({ action: 'add', baseVersion: 'v1', outlet: input })).toBe(false);
    // The server sets `changedOn`; other extra fields are refused as well.
    expect(parses({ action: 'add', baseVersion: '0', outlet: { ...input, changedOn: '2026-01-15' } })).toBe(false);
    expect(OutletInputSchema.safeParse({ ...input, changedOn: '2026-01-15' }).success).toBe(false);
    expect(parses({ action: 'add', baseVersion: '0', outlet: input, note: 'Extra.' })).toBe(false);
    expect(parses({ action: 'remove', baseVersion: '0', id: 'fx-outlet-1', outlet: input })).toBe(false);
    // The input's own rules: a lean only with evidence, over HTTPS.
    expect(parses({ action: 'add', baseVersion: '0', outlet: { ...input, lean: { bucket: 'left', evidence: [] } } })).toBe(false);

    // What the admin page reads, and the answer to a change.
    const change = { seq: 1, at: '2026-01-15T10:00:00.000Z', action: 'add', outletId: 'fx-outlet-1', before: null };
    const page = { list: LIST, changes: [{ ...change, after: outlet(1), by: 'ada@example.com' }] };
    expect(AdminOutletsSchema.parse(page)).toEqual(page);
    expect(AdminOutletsSchema.safeParse({ list: LIST, changes: [{ ...change, after: outlet(1), by: null }] }).success).toBe(true);
    expect(
      AdminOutletsSchema.safeParse({ list: LIST, changes: [{ ...change, action: 'rename', after: null, by: null }] }).success,
    ).toBe(false);
    expect(OutletChangedSchema.parse({ ok: true, version: '3' })).toEqual({ ok: true, version: '3' });
    expect(OutletChangedSchema.safeParse({ ok: true, version: 3 }).success).toBe(false);
  });
});
