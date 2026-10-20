import { type GoldenResult, judgeGolden, loadGolden, mountGolden, readGoldenPage } from '../../src/testing/golden.ts';
import { MUTATIONS, type MutationBase, runMutation, type Verdict } from '../../src/testing/mutate.ts';
import { GOLDENS, readExpect } from './goldens.ts';

/** Part of the mutation suite: some mutations of one golden page. */
export interface ShardJob {
  name: string;
  /** Mutation ids, in `MUTATIONS` order. */
  ids: string[];
  /**
   * Read the unchanged page too: one shard per page does, so its decisions are checked against the golden in this very
   * environment, and it takes the route moves, which judge that read at other addresses. The other shards start from
   * the golden's own result, which golden.test.ts keeps true.
   */
  readBase: boolean;
}

export interface ShardRun {
  id: string;
  changed: number;
  verdict: Verdict | null;
  flags: string[];
}

export interface ShardResult {
  name: string;
  /** The unchanged page's decisions as this shard read them, or null when it didn't read them. */
  before: Record<string, string[]> | null;
  runs: ShardRun[];
}

/** Parse the page once, then mount a fresh copy for each mutation and read it again. */
export function runShard(job: ShardJob): ShardResult {
  const golden = GOLDENS.find((g) => g.name === job.name);
  if (!golden) throw new Error(`no golden named ${job.name}`);
  const { setup, notes: _notes, ...expected } = readExpect(golden.name);
  const template = loadGolden(golden.html, setup);
  let unchanged: MutationBase['unchanged'];
  let before: GoldenResult = expected;
  if (job.readBase) {
    const mounted = mountGolden(template, setup);
    const read = readGoldenPage(golden.adapter, setup);
    unchanged = { mounted, read };
    before = judgeGolden(golden.adapter, setup, mounted, read);
  }
  const base: MutationBase = { adapter: golden.adapter, setup, template, before, ...(unchanged ? { unchanged } : {}) };
  const runs = MUTATIONS.filter((m) => job.ids.includes(m.id)).map((m): ShardRun => {
    const run = runMutation(base, m);
    return { id: m.id, changed: run.changed, verdict: run.verdict, flags: run.flags };
  });
  return { name: job.name, before: job.readBase ? before.decisions : null, runs };
}
