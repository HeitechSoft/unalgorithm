import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GoldenHealth, GoldenResult } from '../src/testing/golden.ts';
import { acceptable, flags, MUTATIONS, verdict } from '../src/testing/mutate.ts';
import { GOLDENS, readExpect } from './golden/goldens.ts';
import { runShard, type ShardJob, type ShardResult, type ShardRun } from './golden/mutation-shard.ts';

/**
 * The mutation suite (ADR 0009 §9, phase C): every golden page × every mutation that applies to it. A run that is
 * `silent` (decisions changed and nothing says so) or `over-hide` (a shown post is now hidden) fails, and so does a
 * false-positive probe that changes anything. The whole matrix is snapshotted, so a change in what survives, what is
 * flagged and by what shows up in review.
 *
 * Slices (one screen of Facebook's capture, two posts) are mutated as part of the whole page they came from
 * (`facebook/2026-10-home`): page-wide rules such as discovery's 3-item minimum need the whole page.
 *
 * Each page is parsed once and every mutation mounts a fresh copy of it. jsdom takes about half a second to read a
 * 300 KB capture, so the big pages' mutations are split into shards that run in worker threads, side by side.
 */
const PAGES = GOLDENS.filter((g) => !readExpect(g.name).setup.slice);

/**
 * Mutations of markup no golden holds yet: the 2026-10 capture script dropped `data-sdui-screen`, which it keeps from now
 * on. No adapter reads it; the mutation makes sure none starts to without a fallback.
 */
const WAITING_FOR_A_CAPTURE = ['drop-data-sdui-screen'];

/** A capture is big (jsdom reads it in about half a second); a page built from the builders is small. */
const isBig = (html: string) => html.length > 100_000;
const BIG = PAGES.filter((g) => isBig(g.html));
const SMALL = PAGES.filter((g) => !isBig(g.html));

/**
 * Node strips TypeScript in worker threads from 22.18; an older Node, or `MUTATION_WORKERS=0` (to debug a mutation),
 * runs every shard here, one after another.
 */
const WORKERS =
  process.env.MUTATION_WORKERS !== '0' && typeof (process.features as { typescript?: unknown }).typescript === 'string';
/** Worker threads at a time: one core is left for the rest of the test run, and each worker holds a page in memory. */
const LANES = Math.max(1, Math.min(12, availableParallelism() - 1));
/** Each big page's mutations, split so the lanes are used without starting workers they can't run. */
const SHARDS = Math.max(1, Math.min(3, Math.floor((LANES - 1) / Math.max(1, BIG.length))));

/** Shard `k` of `n`: every n-th change to the markup or labels, and for the first shard the route moves too. */
const shard = (name: string, n: number, k: number): ShardJob => ({
  name,
  ids: MUTATIONS.filter((m, i) => (m.route ? k === 0 : i % n === k)).map((m) => m.id),
  readBase: k === 0,
});

/** One worker per shard of a big page (those first: they take longest), and one for all the small pages. */
const WORKER_JOBS: ShardJob[][] = [
  ...BIG.flatMap((g) => Array.from({ length: SHARDS }, (_, k) => [shard(g.name, SHARDS, k)])),
  SMALL.map((g) => shard(g.name, 1, 0)),
];

function inWorker(jobs: ShardJob[]): Promise<ShardResult[]> {
  return new Promise((resolve, reject) => {
    // A path, not new URL(…, import.meta.url): under jsdom that resolves against http://localhost.
    const worker = new Worker(join(import.meta.dirname, 'golden/mutation-worker.ts'), { workerData: jobs, execArgv: [] });
    worker.once('message', (results: ShardResult[]) => {
      resolve(results);
      void worker.terminate();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`a mutation worker exited with ${code}`));
    });
  });
}

/** Run every worker's jobs, at most `LANES` workers at a time. */
async function runAll(work: readonly ShardJob[][]): Promise<ShardResult[]> {
  const results: ShardResult[][] = new Array(work.length);
  let next = 0;
  const lane = async () => {
    for (let i = next++; i < work.length; i = next++) results[i] = await inWorker(work[i] as ShardJob[]);
  };
  await Promise.all(Array.from({ length: Math.min(LANES, work.length) }, lane));
  return results.flat();
}

/** Every page's runs, in `MUTATIONS` order, and its unchanged decisions. */
const pages = new Map<string, { before: Record<string, string[]> | null; runs: Map<string, ShardRun> }>();

// jsdom reads the 300 KB LinkedIn captures slowly: the timeout is about the machine, not the code.
describe('mutation suite', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    const results = WORKERS ? await runAll(WORKER_JOBS) : WORKER_JOBS.flat().map(runShard);
    for (const r of results) {
      const page = pages.get(r.name) ?? { before: null, runs: new Map<string, ShardRun>() };
      page.before ??= r.before;
      for (const run of r.runs) page.runs.set(run.id, run);
      pages.set(r.name, page);
    }
  }, 180_000);

  it.each(PAGES.map((g) => [g.name] as const))('%s: no mutation is silent or hides more', (name) => {
    const page = pages.get(name);
    // The unchanged page must read as its golden says, or every verdict is against the wrong baseline.
    expect(page?.before).toEqual(readExpect(name).decisions);
    const bad = MUTATIONS.flatMap((m) => {
      const v = page?.runs.get(m.id)?.verdict ?? null;
      return v !== null && !acceptable(v, m) ? [`${m.id}: ${v}`] : [];
    });
    expect(bad).toEqual([]);
  });

  it('the verdict matrix', () => {
    const line = (name: string, run: ShardRun | undefined) => {
      if (!run?.verdict) return `  ${name}: -`;
      const shown = run.flags.slice(0, 4).join(', ') + (run.flags.length > 4 ? ', …' : '');
      return `  ${name}: ${run.verdict}${shown ? ` (${shown})` : ''}`;
    };
    const matrix = MUTATIONS.map((m) =>
      [
        `${m.id} (${m.group}, ${m.expect}): ${m.title}`,
        ...PAGES.map((g) => line(g.name, pages.get(g.name)?.runs.get(m.id))),
      ].join('\n'),
    ).join('\n');
    expect(`\n${matrix}\n`).toMatchSnapshot();
  });

  it('every mutation applies to at least one page', () => {
    const unused = MUTATIONS.filter((m) => PAGES.every((g) => !pages.get(g.name)?.runs.get(m.id)?.verdict)).map((m) => m.id);
    expect(unused).toEqual(WAITING_FOR_A_CAPTURE);
  });
});

describe('verdicts', () => {
  const OK: GoldenHealth = { status: 'ok', issues: [] };
  /** A page with these rows on every preset, healthy unless `health` says otherwise. */
  const page = (rows: string[], more: { health?: GoldenHealth; observations?: Record<string, number> } = {}): GoldenResult => ({
    decisions: { light: rows, balanced: rows, calm: rows },
    ids: rows.map(() => null),
    idsStable: true,
    health: { light: more.health ?? OK, balanced: more.health ?? OK, calm: more.health ?? OK },
    discovery: null,
    page: { route: 'feed', runs: 'controller', homeSignature: 'strong', signedIn: true, loadMore: true },
    emitted: { detectors: {}, observations: more.observations ?? {} },
    errors: {},
  });
  const before = page(['-', 'show/followed', 'sponsored/unknown', 'panel']);

  it('survives when every row shows or hides for the same reason, whatever else changed', () => {
    const after = page(['-', 'show/unknown', 'sponsored/not-followed', 'panel'], {
      observations: { 'li.slot.age.structure': 3 },
    });
    expect(verdict(before, after, { expect: 'same' })).toBe('survived');
  });

  it('is flagged when an ad shows again and the page says why, and silent when it says nothing', () => {
    const shown = ['-', 'show/followed', 'show/unknown', 'panel'];
    const degraded = page(shown, { health: { status: 'degraded', issues: ['fallback-discovery'] } });
    expect(verdict(before, degraded, { expect: 'same-or-flagged' })).toBe('flagged');
    expect(flags(before, degraded)).toEqual(['status degraded', 'fallback-discovery']);
    const observed = page(shown, { observations: { 'li.label.promoted.near': 1 } });
    expect(verdict(before, observed, { expect: 'same-or-flagged' })).toBe('flagged');
    expect(verdict(before, page(shown), { expect: 'same-or-flagged' })).toBe('silent');
  });

  it('is over-hide when a shown row is hidden, unless the mutation may hide more', () => {
    const hidden = page(['-', 'not-followed/not-followed', 'sponsored/unknown', 'panel'], {
      health: { status: 'degraded', issues: ['fallback-discovery'] },
    });
    expect(verdict(before, hidden, { expect: 'same-or-flagged' })).toBe('over-hide');
    expect(verdict(before, hidden, { expect: 'may-hide-more' })).toBe('survived');
    // A row that was not an item and is now a hidden post is hidden more, too.
    expect(verdict(before, page(['sponsored/unknown', 'show/followed', 'sponsored/unknown', 'panel']), { expect: 'same' })).toBe(
      'over-hide',
    );
  });

  it('accepts a flagged change only where the mutation allows one', () => {
    expect(acceptable('survived', { expect: 'same' })).toBe(true);
    expect(acceptable('flagged', { expect: 'same' })).toBe(false);
    expect(acceptable('flagged', { expect: 'same-or-flagged' })).toBe(true);
    for (const v of ['silent', 'over-hide'] as const) expect(acceptable(v, { expect: 'may-hide-more' })).toBe(false);
  });
});
