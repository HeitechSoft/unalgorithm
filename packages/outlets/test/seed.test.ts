/**
 * The shipped candidate list (`data/candidates.json`): outlets an agent listed by name, web address and country, for a
 * source list's admins to start from. It can never hold a lean (only people set leans). Other tests use the fictional
 * fixture; this file checks the shipped data itself.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bundledCandidates, CandidatesSchema, listBalance, listProblems } from '../src/index.ts';

const FILE = new URL('../data/candidates.json', import.meta.url);
const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { meta: unknown; outlets: Record<string, unknown>[] };

/** `data/registry.json` on c17f91b, as [id, name, domains, country] per outlet, hashed: the same outlets, in order. */
const OUTLETS_ON_C17F91B = '1ea0f5c8a182b0d99cd9e4528c6f3bb8315cca04372ec9070aa050959496b9b3';

describe('candidates', () => {
  it('test_candidates_never_hold_a_lean', () => {
    expect(CandidatesSchema.parse(raw)).toEqual(raw);
    for (const o of raw.outlets) expect(o.lean, String(o.id)).toBeNull();

    const first = raw.outlets[0] ?? {};
    const leaned = { ...first, lean: { bucket: 'center' } };
    expect(CandidatesSchema.safeParse({ ...raw, outlets: [leaned] }).success).toBe(false);
    const evidenced = { ...first, lean: { bucket: 'center', evidence: [{ url: 'https://evidence.example/a', note: 'n' }] } };
    expect(CandidatesSchema.safeParse({ ...raw, outlets: [evidenced] }).success).toBe(false);
    expect(CandidatesSchema.safeParse({ ...raw, outlets: [{ ...first, lean: 'center' }] }).success).toBe(false);
    // Strict: no field the old registry had, and nothing new.
    expect(CandidatesSchema.safeParse({ ...raw, outlets: [{ ...first, verified: false }] }).success).toBe(false);
    expect(CandidatesSchema.safeParse({ ...raw, outlets: [{ ...first, facts: [] }] }).success).toBe(false);
    expect(CandidatesSchema.safeParse({ ...raw, meta: { ...(raw.meta as object), status: 'draft' } }).success).toBe(false);

    const candidates = bundledCandidates();
    expect(candidates).not.toBeNull();
    expect(listProblems(candidates?.outlets ?? [])).toEqual([]);
    expect(listBalance(candidates ?? { outlets: [] })).toMatchObject({ empty: true, warnings: [] });
    expect(candidates?.meta).toEqual({
      license: 'CC-BY-4.0',
      updatedOn: '2026-10-15',
      notice: 'Candidate outlets for a source list: name, web addresses and country only. No leans: only people set leans.',
    });
  });

  it('test_candidates_same_outlets_as_before', () => {
    const outlets = bundledCandidates()?.outlets ?? [];
    expect(outlets).toHaveLength(169);
    expect(outlets.filter((o) => o.country === 'US')).toHaveLength(114);
    expect(outlets.filter((o) => o.country === 'CA')).toHaveLength(55);
    const ids = outlets.map((o) => o.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);

    const pick = (id: string) => outlets.find((o) => o.id === id);
    expect(pick('associated-press')).toEqual({
      id: 'associated-press',
      name: 'Associated Press',
      domains: ['apnews.com'],
      country: 'US',
      lean: null,
    });
    expect(pick('le-devoir')).toEqual({
      id: 'le-devoir',
      name: 'Le Devoir',
      domains: ['ledevoir.com'],
      country: 'CA',
      lean: null,
    });
    expect(pick('ms-now')).toEqual({ id: 'ms-now', name: 'MS NOW', domains: ['ms.now', 'msnbc.com'], country: 'US', lean: null });

    const tuples = JSON.stringify(outlets.map((o) => [o.id, o.name, o.domains, o.country]));
    expect(createHash('sha256').update(tuples).digest('hex')).toBe(OUTLETS_ON_C17F91B);
  });
});
