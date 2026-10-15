/**
 * The shipped draft seed (`data/registry.json`): candidate outlets for the review panel, no labels, facts only with an
 * opened source. Other tests use the fictional fixture; this file checks the shipped data itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { type Registry, RegistrySchema, registryProblems, registryReady, usableRegistry } from '../src/index.ts';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'registry.json');
const raw: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
const seed: Registry = RegistrySchema.parse(raw);

describe('Draft seed', () => {
  it('test_seed_is_sound_and_passes_gate', async () => {
    expect(registryProblems(raw)).toEqual([]);
    const lines: string[] = [];
    expect(await main(['check', '--file', FILE], { out: (l) => lines.push(l) })).toBe(0);
  });

  it('test_seed_is_draft_without_labels', () => {
    expect(seed.meta.status).toBe('draft');
    expect(seed.meta.version).toBe('0.0.0-draft');
    expect(seed.meta.panel).toEqual([]);
    for (const o of seed.outlets) expect(o.lean, o.id).toBeNull();
    const ids = seed.outlets.map((o) => o.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('test_seed_facts_only_with_sources', () => {
    const updatedOn = seed.meta.updatedOn;
    for (const o of seed.outlets) {
      if (!o.verified) {
        expect(o.facts, o.id).toEqual([]);
        continue;
      }
      expect(o.facts.length, o.id).toBeGreaterThan(0);
      for (const f of o.facts) {
        expect(new URL(f.source).protocol, o.id).toBe('https:');
        expect(f.checkedOn <= updatedOn, o.id).toBe(true);
      }
    }
  });

  it('test_seed_countries_and_size', () => {
    for (const o of seed.outlets) expect(['US', 'CA'], o.id).toContain(o.country);
    expect(seed.outlets.length).toBeGreaterThanOrEqual(100);
    expect(seed.outlets.filter((o) => o.country === 'US').length).toBeGreaterThanOrEqual(30);
    expect(seed.outlets.filter((o) => o.country === 'CA').length).toBeGreaterThanOrEqual(30);
  });

  it('test_seed_keeps_perspectives_hidden', () => {
    expect(registryReady(seed)).toBe(false);
    expect(usableRegistry(seed, { allowFixture: true })).toBeNull();
  });
});
