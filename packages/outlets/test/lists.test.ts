/**
 * Source lists (P3-72): the one runtime shape, the list rules, the lookups and the fictional fixture. Every outlet here
 * is on `.example`: no real outlet, no real lean.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  LEAN_BUCKETS,
  MAX_LIST_DOMAINS,
  MAX_LIST_OUTLETS,
  OfficialListSchema,
  PerspectivesListSchema,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  bundledCandidates,
  domainFromInput,
  type ListProblem,
  listProblems,
  listProblemText,
  officialSourceList,
  outletForHost,
  outletIdFromName,
  outletsIn,
  ownCopyOf,
  ownSourceList,
  sourceListFromWire,
  wireList,
} from '../src/index.ts';
import { FIXTURE_LIST, FIXTURE_MARKER, FIXTURE_OFFICIAL_LIST } from '../src/testing/fixture.ts';

/** The bundled candidates (169 outlets, no lean). */
function candidates() {
  const c = bundledCandidates();
  if (!c) throw new Error('The bundled candidate list is invalid.');
  return c;
}

const REPO_ROOT = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO_ROOT), 'utf8');

const outlet = (id: string, ...domains: string[]) => ({ id, domains });
/** `n` outlets with one domain each, then `extra` more domains on the first. */
function sized(n: number, extra = 0) {
  return Array.from({ length: n }, (_, i) =>
    outlet(`fx-${i}`, `outlet-${i}.example`, ...(i === 0 ? Array.from({ length: extra }, (_, j) => `extra-${j}.example`) : [])),
  );
}

describe('list rules', () => {
  it('test_list_problems_each_rule', () => {
    expect(listProblems(FIXTURE_LIST.outlets)).toEqual([]);
    expect(listProblems(FIXTURE_OFFICIAL_LIST.outlets)).toEqual([]);
    const candidates = bundledCandidates();
    expect(candidates).not.toBeNull();
    expect(listProblems(candidates?.outlets ?? [])).toEqual([]);
    expect(listProblems([])).toEqual([]);

    const problems = (outlets: { id: string; domains: string[] }[]): ListProblem[] => listProblems(outlets);
    expect(problems([outlet('fx-a', 'a.example'), outlet('fx-a', 'b.example')])).toEqual([
      { code: 'duplicate-id', outletId: 'fx-a' },
    ]);
    expect(problems([outlet('fx-a', 'a.example'), outlet('fx-b', 'b.example', 'a.example')])).toEqual([
      { code: 'domain-taken', outletId: 'fx-b' },
    ]);
    // An outlet may list the same address twice; only another outlet's address is a problem.
    expect(problems([outlet('fx-a', 'a.example', 'a.example')])).toEqual([]);
    expect(problems([outlet('fx-a', 'a.example'), outlet('fx-b', 'news.a.example')])).toEqual([
      { code: 'domain-nested', outletId: 'fx-b' },
    ]);
    // Nesting inside its own address is fine.
    expect(problems([outlet('fx-a', 'a.example', 'news.a.example')])).toEqual([]);

    expect(problems(sized(MAX_LIST_OUTLETS))).toEqual([]);
    expect(problems(sized(MAX_LIST_OUTLETS + 1))).toEqual([{ code: 'too-many-outlets', outletId: null }]);
    expect(problems(sized(200, MAX_LIST_DOMAINS - 200))).toEqual([]);
    expect(problems(sized(200, MAX_LIST_DOMAINS - 199))).toEqual([{ code: 'too-many-domains', outletId: null }]);
  });

  it('test_list_problem_text', () => {
    expect(listProblemText({ code: 'duplicate-id', outletId: 'fx-a' })).toBe('Two outlets have the id fx-a.');
    expect(listProblemText({ code: 'domain-taken', outletId: 'fx-b' })).toBe(
      'fx-b: another outlet already lists one of its web addresses.',
    );
    expect(listProblemText({ code: 'domain-nested', outletId: 'fx-b' })).toBe(
      "fx-b: one of its web addresses is inside another outlet's.",
    );
    expect(listProblemText({ code: 'too-many-outlets', outletId: null })).toBe('The list has more than 300 outlets.');
    expect(listProblemText({ code: 'too-many-domains', outletId: null })).toBe('The list has more than 400 web addresses.');
  });
});

describe('source lists', () => {
  it('test_official_source_list_and_lookups', () => {
    expect(OfficialListSchema.parse(FIXTURE_OFFICIAL_LIST)).toEqual(FIXTURE_OFFICIAL_LIST);
    const list = officialSourceList(FIXTURE_OFFICIAL_LIST);
    expect(list).toEqual(FIXTURE_LIST);
    expect(list.kind).toBe('cloud');
    expect(list.version).toBe('1');
    expect(list.outlets).toHaveLength(10);
    expect(list.outlets[0]).toEqual({
      id: 'fx-left-a',
      name: 'Fixture Left A',
      domains: ['left-a.example'],
      lean: { bucket: 'left' },
    });
    // The run's list carries the bucket and nothing else of a lean: no evidence, no country, no day.
    expect(JSON.stringify(list)).not.toContain('evidence');
    expect(JSON.stringify(list)).not.toContain('changedOn');

    expect(outletForHost(FIXTURE_LIST, 'www.left-a.example')?.id).toBe('fx-left-a');
    expect(outletForHost(FIXTURE_LIST, 'news.right-b.example')?.id).toBe('fx-right-b');
    expect(outletForHost(FIXTURE_LIST, 'left-a.example.')?.id).toBe('fx-left-a');
    expect(outletForHost(FIXTURE_LIST, 'elsewhere.example')).toBeNull();
    expect(outletForHost(FIXTURE_LIST, '')).toBeNull();
    expect(outletsIn(FIXTURE_LIST, 'left').map((o) => o.id)).toEqual(['fx-left-a', 'fx-left-b']);
    for (const bucket of LEAN_BUCKETS) {
      expect(outletsIn(FIXTURE_LIST, bucket).map((o) => o.id)).toEqual([`fx-${bucket}-a`, `fx-${bucket}-b`]);
    }
    // Outlets with no lean are in no bucket; the caller's outlet type comes back.
    const unlabelled = { outlets: FIXTURE_OFFICIAL_LIST.outlets.map((o) => ({ ...o, lean: null })) };
    expect(outletsIn(unlabelled, 'left')).toEqual([]);
    expect(outletForHost(FIXTURE_OFFICIAL_LIST, 'center-b.example')?.changedOn).toBe('2026-01-15');
  });

  it('test_domain_and_id_from_input', () => {
    expect(domainFromInput('https://www.NYTimes.com/section?x=1')).toBe('nytimes.com');
    expect(domainFromInput('  apnews.com ')).toBe('apnews.com');
    expect(domainFromInput('www.ledevoir.com/politique')).toBe('ledevoir.com');
    expect(domainFromInput('news.example.')).toBe('news.example');
    expect(domainFromInput('not a site')).toBeNull();
    expect(domainFromInput('localhost')).toBeNull();
    expect(domainFromInput('ftp://files.example')).toBeNull();
    expect(domainFromInput('')).toBeNull();

    expect(outletIdFromName('Le Devoir')).toBe('le-devoir');
    expect(outletIdFromName('À')).toBe('');
    expect(outletIdFromName('  The   Globe & Mail ')).toBe('the-globe-mail');
    expect(outletIdFromName('Radio-Canada Info')).toBe('radio-canada-info');
    expect(outletIdFromName('x'.repeat(50))).toBe('x'.repeat(40));
    expect(outletIdFromName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('test_own_source_list_shape', () => {
    // P3-76: the person's own list as a run reads it. Map order doesn't matter: outlets come back sorted by id.
    const own = ownSourceList({
      b: { name: 'FX Center', domains: ['fx-center.example'], bucket: 'center' },
      a: { name: 'FX Unlabelled', domains: ['fx-unlabelled.example', 'fx-u.example'], bucket: null },
    });
    expect(own).toEqual({
      kind: 'own',
      version: '',
      outlets: [
        { id: 'a', name: 'FX Unlabelled', domains: ['fx-unlabelled.example', 'fx-u.example'], lean: null },
        { id: 'b', name: 'FX Center', domains: ['fx-center.example'], lean: { bucket: 'center' } },
      ],
    });
    expect(ownSourceList({})).toEqual({ kind: 'own', version: '', outlets: [] });
  });

  it('test_own_copy_from_cloud_or_candidates', () => {
    const at = 1_760_000_000_000;
    // The Cloud's list with a lean: every outlet's name, web addresses and bucket, never its evidence.
    const fromCloud = ownCopyOf(FIXTURE_OFFICIAL_LIST, candidates(), at);
    expect(Object.keys(fromCloud).sort()).toEqual(FIXTURE_OFFICIAL_LIST.outlets.map((o) => o.id).sort());
    expect(Object.keys(fromCloud)).toHaveLength(10);
    for (const o of FIXTURE_OFFICIAL_LIST.outlets) {
      expect(fromCloud[o.id]).toStrictEqual({ name: o.name, domains: o.domains, bucket: o.lean?.bucket ?? null, addedAt: at });
    }
    expect(JSON.stringify(fromCloud)).not.toContain('evidence');
    expect(JSON.stringify(fromCloud)).not.toContain('changedOn');
    // A copy, not the Cloud's own arrays.
    expect(fromCloud['fx-left-a']?.domains).not.toBe(FIXTURE_OFFICIAL_LIST.outlets[0]?.domains);

    // A Cloud list with no lean, or none stored: the candidates, every bucket null.
    const noLean = { ...FIXTURE_OFFICIAL_LIST, outlets: FIXTURE_OFFICIAL_LIST.outlets.map((o) => ({ ...o, lean: null })) };
    for (const official of [noLean, null]) {
      const copy = ownCopyOf(official, candidates(), at);
      expect(Object.keys(copy)).toHaveLength(169);
      expect(Object.keys(copy).sort()).toEqual(
        candidates()
          .outlets.map((o) => o.id)
          .sort(),
      );
      for (const entry of Object.values(copy)) {
        expect(entry.bucket).toBeNull();
        expect(entry.addedAt).toBe(at);
      }
      // Every copy is a list the rules accept, so the editor can save it as it is.
      expect(listProblems(ownSourceList(copy).outlets)).toEqual([]);
    }
  });

  it('test_wire_list_round_trip', () => {
    // P3-77 (D102): what a comparison request carries. Outlets with a lean, by web addresses and bucket only.
    const wire = wireList(FIXTURE_LIST);
    expect(wire).not.toBeNull();
    expect(PerspectivesListSchema.safeParse(wire).success).toBe(true);
    expect(wire?.kind).toBe('cloud');
    expect(wire?.version).toBe('1');
    expect(wire?.outlets).toHaveLength(10);
    for (const o of wire?.outlets ?? []) expect(Object.keys(o).sort()).toEqual(['bucket', 'domains']);
    expect(wire?.outlets[0]).toStrictEqual({ bucket: 'center', domains: ['center-a.example'] });
    const text = JSON.stringify(wire);
    for (const o of FIXTURE_LIST.outlets) {
      expect(text).not.toContain(o.name);
      expect(text).not.toContain(`"${o.id}"`);
    }
    expect(text).not.toContain('evidence');

    // Sorted by id, whatever the list's order; outlets with no lean left out; a copy of the domains.
    const own = ownSourceList({
      'fx-z': { name: 'FX Zulu', domains: ['zulu.example', 'zulu-news.example'], bucket: 'right' },
      'fx-a': { name: 'FX Alpha', domains: ['alpha.example'], bucket: 'left' },
      'fx-m': { name: 'FX Mike', domains: ['mike.example'], bucket: null },
    });
    expect(wireList(own)).toStrictEqual({
      kind: 'own',
      version: '',
      outlets: [
        { bucket: 'left', domains: ['alpha.example'] },
        { bucket: 'right', domains: ['zulu.example', 'zulu-news.example'] },
      ],
    });
    expect(wireList({ ...own, outlets: [...own.outlets].reverse() })).toStrictEqual(wireList(own));
    expect(wireList(own)?.outlets[1]?.domains).not.toBe(own.outlets[2]?.domains);

    // No lean at all, or over a cap: null.
    expect(wireList({ ...FIXTURE_LIST, outlets: FIXTURE_LIST.outlets.map((o) => ({ ...o, lean: null })) })).toBeNull();
    expect(wireList(ownSourceList({}))).toBeNull();
    const tooMany = Array.from({ length: MAX_LIST_OUTLETS + 1 }, (_, i) => ({
      id: `fx-${i}`,
      name: `FX ${i}`,
      domains: [`outlet-${i}.example`],
      lean: { bucket: 'center' as const },
    }));
    expect(wireList({ kind: 'own', version: '', outlets: tooMany })).toBeNull();
    expect(wireList({ kind: 'own', version: '', outlets: tooMany.slice(1) })).not.toBeNull();

    // Back on a server: ids o1…o10 in the wire's order, each named by its first web address, the same buckets.
    const back = sourceListFromWire(wire as NonNullable<typeof wire>);
    expect(back.kind).toBe('cloud');
    expect(back.version).toBe('1');
    expect(back.outlets.map((o) => o.id)).toEqual(Array.from({ length: 10 }, (_, i) => `o${i + 1}`));
    expect(back.outlets.map((o) => o.name)).toEqual(wire?.outlets.map((o) => o.domains[0]));
    expect(back.outlets.map((o) => o.lean?.bucket)).toEqual(wire?.outlets.map((o) => o.bucket));
    for (const bucket of LEAN_BUCKETS) {
      expect(
        outletsIn(back, bucket)
          .flatMap((o) => o.domains)
          .sort(),
      ).toEqual(
        outletsIn(FIXTURE_LIST, bucket)
          .flatMap((o) => o.domains)
          .sort(),
      );
    }
    expect(listProblems(back.outlets)).toEqual([]);
    expect(sourceListFromWire(wireList(own) as NonNullable<ReturnType<typeof wireList>>).outlets[1]).toStrictEqual({
      id: 'o2',
      name: 'zulu.example',
      domains: ['zulu.example', 'zulu-news.example'],
      lean: { bucket: 'right' },
    });
  });

  it('test_fixture_names_only_example_hosts', () => {
    const hosts = FIXTURE_OFFICIAL_LIST.outlets.flatMap((o) => [
      ...o.domains,
      ...(o.lean?.evidence.map((e) => new URL(e.url).hostname) ?? []),
    ]);
    expect(hosts.length).toBeGreaterThan(10);
    for (const host of hosts) expect(host.endsWith('.example'), host).toBe(true);
    for (const o of FIXTURE_OFFICIAL_LIST.outlets) {
      expect(o.lean, o.id).not.toBeNull();
      for (const e of o.lean?.evidence ?? []) expect(e.note, o.id).toContain(FIXTURE_MARKER);
    }
    expect(FIXTURE_MARKER).toBe('UA-FIXTURE-OUTLETS-DO-NOT-SHIP');
  });
});

describe('no registry gate', () => {
  it('test_no_registry_gate_left', () => {
    for (const file of ['package.json', 'apps/extension/package.json', '.github/workflows/ci.yml']) {
      const text = read(file);
      expect(text, file).not.toContain('outlets:check');
      expect(text, file).not.toContain('outlets/src/cli.ts');
    }
    expect(existsSync(new URL('packages/outlets/src/sign.ts', REPO_ROOT))).toBe(false);
    expect(existsSync(new URL('packages/outlets/src/cli.ts', REPO_ROOT))).toBe(false);
    const pkg = JSON.parse(read('packages/outlets/package.json')) as { exports: Record<string, string> };
    expect(Object.keys(pkg.exports)).toEqual(['.', './testing']);
  });
});
