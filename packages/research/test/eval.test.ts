import { AIError } from '@unalgorithm/ai';
import { FACTCHECK_VERDICTS, PostForAISchema } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../eval/cli.ts';
import { FACTCHECK_EVAL_SET } from '../eval/factcheck-set.ts';
import { mockDepsFor, runFactcheckEval } from '../eval/score.ts';

const SET = FACTCHECK_EVAL_SET;
const byId = new Map(SET.map((i) => [i.id, i]));

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
    expect(live.lines[0]).toBe(`Live run: ${SET.length} checks, about $2.88 on your Anthropic account.`);
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
