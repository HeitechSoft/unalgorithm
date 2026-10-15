import { AIError } from '@unalgorithm/ai';
import {
  FACTCHECK_VERDICTS,
  type FactcheckResult,
  type LinkStatus,
  PostForAISchema,
  type RetrievedSource,
} from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../eval/cli.ts';
import { FACTCHECK_EVAL_SET } from '../eval/factcheck-set.ts';
import {
  type FactcheckEvalReport,
  mockDepsFor,
  runFactcheckEval,
  TRUST_GATES,
  traceCitations,
  trustGates,
} from '../eval/score.ts';
import type { FactcheckDeps, LinkChecker } from '../src/factcheck.ts';

const SET = FACTCHECK_EVAL_SET;
const byId = new Map(SET.map((i) => [i.id, i]));

describe('set v1', () => {
  it('test_eval_set_v1_pairs_and_spread', () => {
    expect(SET).toHaveLength(56);
    expect(new Set(SET.map((i) => i.id)).size).toBe(56);
    expect(SET.filter((i) => i.smoke)).toHaveLength(5);
    const paired = SET.filter((i) => i.pair);
    expect(paired).toHaveLength(40);
    for (const item of paired) {
      const twin = byId.get(item.pair ?? '');
      expect(twin?.pair, item.id).toBe(item.id);
      expect(twin?.expect, item.id).toEqual(item.expect);
    }
    const firsts = paired.filter((i) => i.id < (i.pair ?? '')).map((i) => i.expect[0]);
    expect(firsts).toHaveLength(20);
    for (const verdict of FACTCHECK_VERDICTS) {
      expect(firsts.filter((v) => v === verdict).length, verdict).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('report v1', () => {
  it('test_eval_mock_report_v1', async () => {
    const report = await runFactcheckEval(mockDepsFor(SET));
    expect(report).toMatchObject({
      provenance: 1,
      citationsShown: 112,
      pairsScored: 20,
      pairConsistency: 1,
      links: null,
      liveLinks: null,
    });
  });

  it('test_eval_strict_provenance_rechecks_retrieved', async () => {
    const source = { id: 's1', url: 'https://a.example.com/x', domain: 'a.example.com', title: 'A', pageAge: null };
    const result: FactcheckResult = {
      v: 1,
      checkedAt: '2026-10-15T12:00:00.000Z',
      model: 'mock',
      promptVersion: 1,
      claims: [
        {
          id: 'c1',
          claim: 'A claim.',
          verdict: 'supported',
          explanation: 'Because.',
          citations: [{ sourceId: 's1', quote: 'Alpha beta gamma' }],
        },
      ],
      sources: [source],
    };
    const recorded: RetrievedSource = { ...source, snippets: ['Alpha beta gamma'] };
    expect(traceCitations(result, [recorded])).toEqual({ shown: 1, traced: 1 });
    expect(traceCitations(result, [{ ...recorded, url: 'https://b.example.com/x' }])).toEqual({ shown: 1, traced: 0 });
    expect(traceCitations(result, [{ ...recorded, snippets: ['Delta epsilon'] }])).toEqual({ shown: 1, traced: 0 });
    expect(traceCitations(result, [])).toEqual({ shown: 1, traced: 0 });

    // A retriever that changes its sources after returning them (here: during the verdict call) cannot change what
    // was recorded, so the shown URL no longer traces.
    const items = SET.slice(0, 2);
    const base = mockDepsFor(items);
    let returned: RetrievedSource[] = [];
    const structured = base.client.structured.bind(base.client);
    const deps: FactcheckDeps = {
      ...base,
      retriever: {
        async retrieve(req) {
          const res = await base.retriever.retrieve(req);
          returned = res.sources;
          return res;
        },
      },
      client: {
        ...base.client,
        structured(req) {
          if (req.schemaName === 'factcheck_verdicts' && req.user.includes('fc-02')) {
            for (const s of returned) s.url = `https://moved.example.net/${s.id}`;
          }
          return structured(req);
        },
      },
    };
    const report = await runFactcheckEval(deps, items);
    expect(report.citationsShown).toBe(4);
    expect(report.provenance).toBe(0.5);
  });

  it('test_eval_links_counted_after_run', async () => {
    const halfDead: LinkChecker = async (urls) =>
      new Map(urls.map((u): [string, LinkStatus] => [u, u.includes('.example.com/') ? 'dead' : 'live']));
    const report = await runFactcheckEval(mockDepsFor(SET), SET, { linkCheck: halfDead });
    expect(report.links).toEqual({ live: 56, dead: 56, unknown: 0 });
    expect(report.liveLinks).toBe(0.5);
    expect(report.citationsShown).toBe(112);
    expect(report.failures).toContainEqual({ id: 'fc-01', reason: 'dead link s1' });
    for (const f of report.failures) expect(f.reason).not.toContain('http');

    const rejecting: LinkChecker = async () => {
      throw new Error('egress down');
    };
    const broken = await runFactcheckEval(mockDepsFor(SET), SET, { linkCheck: rejecting, linkTimeoutMs: 50 });
    expect(broken.links).toEqual({ live: 0, dead: 0, unknown: 112 });
    expect(broken.liveLinks).toBeNull();
    expect(trustGates(broken).liveLinks.passed).toBeNull();
  });

  it('test_eval_run_has_no_link_check', async () => {
    const depsChecks: string[][] = [];
    const evalChecks: string[][] = [];
    const deps: FactcheckDeps = {
      ...mockDepsFor(SET),
      linkCheck: async (urls) => {
        depsChecks.push([...urls]);
        return new Map(urls.map((u): [string, LinkStatus] => [u, 'dead']));
      },
    };
    const report = await runFactcheckEval(deps, SET, {
      linkCheck: async (urls) => {
        evalChecks.push([...urls]);
        return new Map(urls.map((u): [string, LinkStatus] => [u, 'dead']));
      },
    });
    expect(depsChecks).toEqual([]);
    expect(evalChecks).toHaveLength(SET.length);
    // Dead citations were counted, not dropped by the run.
    expect(report.citationsShown).toBe(112);
    expect(report.links).toEqual({ live: 0, dead: 112, unknown: 0 });
    expect(report.liveLinks).toBe(0);
  });
});

function gateReport(over: Partial<FactcheckEvalReport> = {}): FactcheckEvalReport {
  return {
    total: 56,
    agreement: 1,
    pairConsistency: 0.95,
    pairsScored: 20,
    provenance: 1,
    citationsShown: 40,
    droppedCitationRate: 0,
    links: { live: 97, dead: 3, unknown: 0 },
    liveLinks: 0.97,
    meanCostMicros: 120_000,
    failures: [],
    providerErrors: [],
    ...over,
  };
}

describe('gates', () => {
  it('test_trust_gates_thresholds', () => {
    expect(TRUST_GATES).toEqual({ slantFlip: 0.95, provenance: 1, liveLinks: 0.97, minPairs: 20, minCited: 20 });
    const ok = trustGates(gateReport());
    expect(ok.passed).toBe(true);
    expect(ok.slantFlip).toEqual({ value: 0.95, min: 0.95, passed: true });
    expect(ok.liveLinks).toEqual({ value: 0.97, min: 0.97, passed: true });

    expect(trustGates(gateReport({ pairConsistency: 0.9 })).passed).toBe(false);
    expect(trustGates(gateReport({ provenance: 0.99 })).passed).toBe(false);
    expect(trustGates(gateReport({ links: { live: 96, dead: 4, unknown: 0 }, liveLinks: 0.96 })).passed).toBe(false);
    const noLinks = trustGates(gateReport({ links: null, liveLinks: null }));
    expect(noLinks.passed).toBe(false);
    expect(noLinks.liveLinks).toEqual({ value: null, min: 0.97, passed: null });

    const fewPairs = trustGates(gateReport({ pairsScored: 5 }));
    expect(fewPairs.slantFlip.passed).toBeNull();
    expect(fewPairs.passed).toBe(false);

    const nothingCited = trustGates(gateReport({ citationsShown: 0, provenance: 1 }));
    expect(nothingCited.provenance).toEqual({ value: 1, min: 1, passed: null });
    expect(nothingCited.passed).toBe(false);

    expect(trustGates(gateReport({ links: { live: 10, dead: 0, unknown: 0 }, liveLinks: 1 })).liveLinks.passed).toBeNull();
    expect(trustGates(gateReport({ links: { live: 30, dead: 0, unknown: 40 }, liveLinks: 1 })).liveLinks.passed).toBeNull();
  });

  it('test_trust_gates_one_flip_allowed', async () => {
    const live: LinkChecker = async (urls) => new Map(urls.map((u): [string, LinkStatus] => [u, 'live']));
    const flip = (ids: string[]) =>
      mockDepsFor(SET, { verdict: (item) => (ids.includes(item.id) ? 'needs-context' : item.expect[0]) });

    const one = await runFactcheckEval(flip(['fc-26']), SET, { linkCheck: live });
    expect(one.pairsScored).toBe(20);
    expect(one.pairConsistency).toBe(0.95);
    expect(trustGates(one).slantFlip.passed).toBe(true);
    expect(trustGates(one).passed).toBe(true);

    const two = await runFactcheckEval(flip(['fc-26', 'fc-40']), SET, { linkCheck: live });
    expect(two.pairConsistency).toBe(0.9);
    expect(trustGates(two).slantFlip.passed).toBe(false);
    expect(trustGates(two).passed).toBe(false);
  });
});

describe('set', () => {
  it('test_eval_set_items_are_valid_and_unique', () => {
    expect(new Set(SET.map((i) => i.id)).size).toBe(SET.length);
    expect(new Set(SET.map((i) => i.post.text)).size).toBe(SET.length);
    for (const item of SET) {
      expect(PostForAISchema.safeParse({ ...item.post, ref: item.id }).success, item.id).toBe(true);
      expect(item.expect.length, item.id).toBeGreaterThan(0);
      for (const v of item.expect) expect(FACTCHECK_VERDICTS).toContain(v);
    }
  });

  it('test_eval_set_pairs_are_symmetric_with_same_expectations', () => {
    const paired = SET.filter((i) => i.pair);
    expect(paired.length).toBeGreaterThanOrEqual(8);
    for (const item of paired) {
      const twin = byId.get(item.pair ?? '');
      expect(twin?.pair, item.id).toBe(item.id);
      expect(twin?.expect).toEqual(item.expect);
    }
  });

  it('test_eval_set_covers_verdicts_smoke_and_injection', () => {
    expect(new Set(SET.map((i) => i.expect[0]))).toEqual(new Set(FACTCHECK_VERDICTS));
    expect(SET.filter((i) => i.smoke)).toHaveLength(5);
    expect(SET.filter((i) => i.injected).length).toBeGreaterThanOrEqual(2);
  });
});

describe('scoring', () => {
  it('test_run_eval_mock_scores_full_agreement_and_provenance', async () => {
    const report = await runFactcheckEval(mockDepsFor(SET));
    expect(report).toMatchObject({
      total: SET.length,
      agreement: 1,
      pairConsistency: 1,
      provenance: 1,
      droppedCitationRate: 0,
      failures: [],
      providerErrors: [],
    });
    expect(report.meanCostMicros).toBeGreaterThan(0);
  });

  it('test_run_eval_flags_pair_disagreement', async () => {
    const deps = mockDepsFor(SET, { verdict: (item) => (item.id === 'fc-16' ? 'disputed' : item.expect[0]) });
    const report = await runFactcheckEval(deps);
    expect(report.pairConsistency).toBeLessThan(1);
    const pairFailure = report.failures.find((f) => f.reason.includes('pair'));
    expect(`${pairFailure?.id} ${pairFailure?.reason}`).toMatch(/fc-15.*fc-16|fc-16.*fc-15/);
    expect(report.failures).toContainEqual({ id: 'fc-16', reason: 'verdict disputed not supported' });
  });

  it('test_run_eval_excludes_provider_errors', async () => {
    const deps = mockDepsFor(SET, {
      fail: (item) => (item.id === 'fc-03' ? new AIError('overloaded', 'Busy.') : undefined),
    });
    const report = await runFactcheckEval(deps);
    expect(report.providerErrors).toEqual(['overloaded']);
    expect(report.agreement).toBe(1);
    expect(report.failures).toContainEqual({ id: 'fc-03', reason: 'error overloaded' });
  });

  it('runs only the given items, one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    const base = mockDepsFor(SET);
    const deps = {
      ...base,
      retriever: {
        async retrieve(req: Parameters<typeof base.retriever.retrieve>[0]) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
          return base.retriever.retrieve(req);
        },
      },
    };
    const report = await runFactcheckEval(deps, SET.slice(0, 4));
    expect(report.total).toBe(4);
    expect(maxActive).toBe(1);
  });
});

/** Live deps backed by the mock, counting the checks run (one claims call per item). */
function countingLive(opts: Parameters<typeof mockDepsFor>[1] = {}) {
  const keys: string[] = [];
  let checks = 0;
  const lines: string[] = [];
  const deps: CliDeps = {
    liveDeps(apiKey) {
      keys.push(apiKey);
      lines.push('<deps built>');
      const d = mockDepsFor(SET, opts);
      const structured = d.client.structured.bind(d.client);
      return {
        ...d,
        client: {
          ...d.client,
          structured(req) {
            if (req.schemaName === 'factcheck_claims') checks++;
            return structured(req);
          },
        },
      };
    },
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
  return { deps, keys, lines, checks: () => checks };
}

describe('cli', () => {
  it('test_cli_mock_never_reads_key', async () => {
    const env = new Proxy({} as Record<string, string | undefined>, {
      get(_t, prop) {
        if (prop === 'ANTHROPIC_API_KEY') throw new Error('read the key');
        return undefined;
      },
    });
    const lines: string[] = [];
    const code = await main([], env, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ total: SET.length, provenance: 1 });
  });

  it('test_cli_live_without_key_exits_2', async () => {
    const live = countingLive();
    expect(await main(['--live'], {}, live.deps)).toBe(2);
    expect(live.keys).toEqual([]);
    expect(live.checks()).toBe(0);
    expect(live.lines).toHaveLength(1);
    expect(live.lines[0]).toContain('ANTHROPIC_API_KEY');
  });

  it('test_cli_live_runs_smoke_subset_and_prints_spend_first', async () => {
    const live = countingLive();
    const code = await main(['--live'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, live.deps);
    expect(code).toBe(0);
    expect(live.keys).toEqual(['sk-ant-test']);
    expect(live.checks()).toBe(5);
    expect(live.lines[0]).toBe('Live run: 5 checks, about $0.60 on your Anthropic account.');
    expect(JSON.parse(live.lines.slice(2).join('\n'))).toMatchObject({ total: 5 });
  });

  it('test_cli_live_all_runs_full_set', async () => {
    const live = countingLive();
    await main(['--live', '--all'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, live.deps);
    expect(live.checks()).toBe(SET.length);
    expect(live.lines[0]).toBe(`Live run: ${SET.length} checks, about $6.72 on your Anthropic account.`);
  });

  it('test_cli_exit_code_follows_cost_gate', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };
    // The mock's own usage costs about 113,000 micros per check: inside ±25 % of 120,000.
    expect(await main(['--live'], env, countingLive().deps)).toBe(0);
    // Twice the research tokens and searches: about 218,000 micros, outside.
    const dear = countingLive({ researchUsage: { uncachedInput: 60_000, output: 3_000, webSearches: 6 } });
    expect(await main(['--live'], env, dear.deps)).toBe(1);
    // A third: about 43,000 micros, outside below.
    const cheap = countingLive({ researchUsage: { uncachedInput: 10_000, output: 500, webSearches: 1 } });
    expect(await main(['--live'], env, cheap.deps)).toBe(1);
  });

  it('exits 2 on an unknown flag', async () => {
    const lines: string[] = [];
    expect(await main(['--liv'], {}, { out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(2);
  });
});
