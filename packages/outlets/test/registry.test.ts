import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEAN_BUCKETS } from '@unalgorithm/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import {
  bundledRegistry,
  outletForHost,
  outletsIn,
  type Registry,
  RegistrySchema,
  registryProblems,
  registryReady,
  usableRegistry,
} from '../src/index.ts';
import { canonicalJson, signRegistry, verifyRegistry } from '../src/sign.ts';
import { FIXTURE_REGISTRY } from '../src/testing/fixture.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = new Date('2026-10-15T12:00:00Z');

function fixture(): Registry {
  return structuredClone(FIXTURE_REGISTRY);
}

/** The fixture as a reviewed registry (its panel has two members). */
function reviewed(): Registry {
  const reg = fixture();
  reg.meta.status = 'reviewed';
  return reg;
}

function outlet(reg: Registry, id: string) {
  const found = reg.outlets.find((o) => o.id === id);
  if (!found) throw new Error(`no outlet ${id}`);
  return found;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('schema and review rules', () => {
  it('test_fixture_registry_is_sound_and_test_only', () => {
    expect(registryProblems(FIXTURE_REGISTRY, TODAY)).toEqual([]);
    expect(usableRegistry(FIXTURE_REGISTRY)).toBeNull();
    expect(usableRegistry(FIXTURE_REGISTRY, { allowFixture: true })).toBe(FIXTURE_REGISTRY);
    expect(usableRegistry(null, { allowFixture: true })).toBeNull();
    for (const bucket of LEAN_BUCKETS) {
      expect(outletsIn(FIXTURE_REGISTRY, bucket).map((o) => o.id)).toEqual([`fx-${bucket}-a`, `fx-${bucket}-b`]);
    }
  });

  it('test_label_requires_evidence_reviewers_and_date', () => {
    const cases: [string, (reg: Registry) => void][] = [
      [
        'no evidence',
        (reg) => {
          const lean = outlet(reg, 'fx-left-a').lean;
          if (lean) lean.evidence = [];
        },
      ],
      [
        'one reviewer',
        (reg) => {
          const lean = outlet(reg, 'fx-left-a').lean;
          if (lean) lean.reviewers = ['fixture-a'];
        },
      ],
      [
        'reviewer not on the panel',
        (reg) => {
          const lean = outlet(reg, 'fx-left-a').lean;
          if (lean) lean.reviewers = ['fixture-a', 'someone-else'];
        },
      ],
      [
        'same reviewer twice',
        (reg) => {
          const lean = outlet(reg, 'fx-left-a').lean;
          if (lean) lean.reviewers = ['fixture-a', 'fixture-a'];
        },
      ],
      [
        'reviewed in the future',
        (reg) => {
          const lean = outlet(reg, 'fx-left-a').lean;
          if (lean) lean.reviewedOn = '2026-10-16';
        },
      ],
    ];
    for (const [name, change] of cases) {
      const reg = fixture();
      change(reg);
      const problems = registryProblems(reg, TODAY);
      expect(problems.length, name).toBeGreaterThan(0);
      expect(
        problems.some((p) => p.includes('fx-left-a')),
        `${name}: ${problems.join('; ')}`,
      ).toBe(true);
    }
  });

  it('test_draft_registry_has_no_labels', () => {
    const reg = fixture();
    reg.meta.status = 'draft';
    for (const o of reg.outlets) if (o.id !== 'fx-center-b') o.lean = null;
    expect(registryProblems(reg, TODAY)).toEqual(['outlets[fx-center-b].lean: draft registry has a lean label: fx-center-b']);
  });

  it('test_ids_domains_and_verified_facts', () => {
    const dupId = fixture();
    outlet(dupId, 'fx-left-b').id = 'fx-left-a';
    expect(registryProblems(dupId, TODAY).join('\n')).toContain('duplicate outlet id: fx-left-a');

    const twice = fixture();
    outlet(twice, 'fx-left-b').domains = ['left-a.example'];
    expect(registryProblems(twice, TODAY).join('\n')).toContain('domain listed by two outlets: fx-left-a, fx-left-b');

    const nested = fixture();
    outlet(nested, 'fx-left-b').domains = ['news.left-a.example'];
    expect(registryProblems(nested, TODAY).join('\n')).toContain("domain nested in another outlet's: fx-left-b, fx-left-a");

    const fact = {
      kind: 'founded' as const,
      text: 'Founded in 1999.',
      source: 'https://facts.example/x',
      checkedOn: '2026-01-01',
    };
    const unverifiedWithFact = fixture();
    outlet(unverifiedWithFact, 'fx-right-a').facts = [fact];
    expect(registryProblems(unverifiedWithFact, TODAY).join('\n')).toContain('unverified outlet lists facts: fx-right-a');

    const verifiedWithout = fixture();
    outlet(verifiedWithout, 'fx-right-a').verified = true;
    expect(registryProblems(verifiedWithout, TODAY).join('\n')).toContain('verified outlet lists no facts: fx-right-a');

    const verifiedWith = fixture();
    Object.assign(outlet(verifiedWith, 'fx-right-a'), { verified: true, facts: [fact] });
    expect(registryProblems(verifiedWith, TODAY)).toEqual([]);
  });

  it('test_outlet_for_host_suffix_match', () => {
    const at = (host: string) => outletForHost(FIXTURE_REGISTRY, host)?.id ?? null;
    expect(at('left-a.example')).toBe('fx-left-a');
    expect(at('www.left-a.example')).toBe('fx-left-a');
    expect(at('News.Left-A.example')).toBe('fx-left-a');
    expect(at('news.left-a.example')).toBe('fx-left-a');
    expect(at('lean-left-a.example')).toBe('fx-lean-left-a');
    expect(at('left-a.example.evil.example')).toBeNull();
    expect(at('elsewhere.example')).toBeNull();
  });

  it('test_fixture_names_only_example_domains', () => {
    const domain = fixture();
    outlet(domain, 'fx-center-a').domains = ['center-a.com'];
    expect(registryProblems(domain, TODAY).join('\n')).toContain('fixture names a non-.example host: fx-center-a');

    const evidence = fixture();
    const lean = outlet(evidence, 'fx-center-a').lean;
    if (lean) lean.evidence = [{ url: 'https://evidence.org/fx-center-a', note: 'x' }];
    expect(registryProblems(evidence, TODAY).join('\n')).toContain('fixture names a non-.example host: fx-center-a');
  });

  it('test_registry_ready_needs_reviewed_and_every_bucket', () => {
    expect(registryReady(reviewed(), TODAY)).toBe(true);
    expect(usableRegistry(reviewed())).not.toBeNull();

    const gap = reviewed();
    for (const o of gap.outlets) if (o.lean?.bucket === 'lean-right') o.lean = null;
    expect(registryProblems(gap, TODAY)).toEqual([]);
    expect(registryReady(gap, TODAY)).toBe(false);

    const draft = bundledRegistry();
    expect(draft).not.toBeNull();
    if (draft) expect(registryReady(draft, TODAY)).toBe(false);

    const broken = reviewed();
    outlet(broken, 'fx-left-b').id = 'fx-left-a';
    expect(registryReady(broken, TODAY)).toBe(false);

    const smallPanel = reviewed();
    smallPanel.meta.panel = smallPanel.meta.panel.slice(0, 1);
    expect(registryProblems(smallPanel, TODAY).join('\n')).toContain('reviewed registry needs a panel of at least 2');
    expect(registryReady(smallPanel, TODAY)).toBe(false);
  });
});

describe('signing', () => {
  it('test_sign_verify_round_trip_and_tamper', () => {
    const { pub, priv } = keyPair();
    const reg = reviewed();
    const sig = signRegistry(reg, priv);
    expect(verifyRegistry(reg, sig, pub)).toBe(true);

    const tampered = structuredClone(reg);
    const first = tampered.outlets[0];
    if (first) first.name = `${first.name.slice(0, -1)}Z`;
    expect(verifyRegistry(tampered, sig, pub)).toBe(false);

    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const shuffled = reverseKeys(reg);
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(reg));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(reg));
    expect(verifyRegistry(shuffled as Registry, sig, pub)).toBe(true);

    expect(verifyRegistry(reg, 'not a signature', pub)).toBe(false);
    expect(verifyRegistry(reg, sig, 'not a key')).toBe(false);
    expect(verifyRegistry(reg, sig, keyPair().pub)).toBe(false);
  });
});

describe('gate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'outlets-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(argv: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = [];
    const code = await main(argv, { out: (line) => lines.push(line) });
    return { code, out: lines.join('\n') };
  }

  function write(name: string, value: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return path;
  }

  it('test_check_gate_outcomes', async () => {
    const { pub, priv } = keyPair();
    const pubPath = write('panel.pub.pem', pub);
    const keyPath = write('panel.key.pem', priv);
    const missingSig = join(dir, 'none.sig');

    // The shipped draft passes.
    expect((await run(['check'])).code).toBe(0);

    // A draft with a label fails, naming the outlet.
    const labelled = fixture();
    labelled.meta.status = 'draft';
    for (const o of labelled.outlets.slice(1)) o.lean = null;
    const labelledRun = await run(['check', '--file', write('labelled.json', labelled), '--sig', missingSig, '--pub', pubPath]);
    expect(labelledRun.code).toBe(1);
    expect(labelledRun.out).toContain('draft registry has a lean label: fx-left-a');

    // A fixture is never bundled.
    const fixtureRun = await run([
      'check',
      '--file',
      write('fixture.json', FIXTURE_REGISTRY),
      '--sig',
      missingSig,
      '--pub',
      pubPath,
    ]);
    expect(fixtureRun.code).toBe(1);

    // A reviewed registry needs a signature that verifies.
    const reviewedPath = write('reviewed.json', reviewed());
    expect((await run(['check', '--file', reviewedPath, '--sig', missingSig, '--pub', pubPath])).code).toBe(1);
    const badSig = write('bad.sig', signRegistry(fixture(), priv));
    expect((await run(['check', '--file', reviewedPath, '--sig', badSig, '--pub', pubPath])).code).toBe(1);

    // Signed with the panel key whose public half is passed: it ships.
    const sigPath = join(dir, 'reviewed.sig');
    const signRun = await run(['sign', '--key', keyPath, '--file', reviewedPath, '--sig', sigPath]);
    expect(signRun.code).toBe(0);
    expect(signRun.out).not.toContain('PRIVATE');
    expect((await run(['verify', reviewedPath, '--sig', sigPath, '--pub', pubPath])).code).toBe(0);
    expect((await run(['check', '--file', reviewedPath, '--sig', sigPath, '--pub', pubPath])).code).toBe(0);
    // ...but not without the public key.
    expect((await run(['check', '--file', reviewedPath, '--sig', sigPath, '--pub', join(dir, 'none.pem')])).code).toBe(1);

    // sign refuses anything but a sound reviewed registry.
    expect((await run(['sign', '--key', keyPath, '--file', write('draft.json', labelled), '--sig', sigPath])).code).toBe(1);
    // validate reports problems.
    expect((await run(['validate', write('bad.json', { meta: {}, outlets: [] })])).code).toBe(1);
    expect((await run(['validate'])).code).toBe(0);
  });

  it('test_shipped_registry_is_draft_without_labels', () => {
    const raw = JSON.parse(readFileSync(join(PKG, 'data', 'registry.json'), 'utf8')) as unknown;
    const reg = RegistrySchema.parse(raw);
    expect(reg.meta.status).toBe('draft');
    expect(reg.outlets.every((o) => o.lean === null)).toBe(true);
    expect(registryProblems(raw)).toEqual([]);
    expect(bundledRegistry()).toEqual(reg);
    expect(usableRegistry(bundledRegistry())).toBeNull();
  });

  it('test_browser_entry_has_no_node_imports', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/(?:from|import)\s*\(?\s*['"]node:/);
      expect(source, file).not.toMatch(/require\(/);
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), m[1] ?? '');
        if (target.endsWith('.ts')) visit(target);
      }
    };
    visit(join(PKG, 'src', 'index.ts'));
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });
});
