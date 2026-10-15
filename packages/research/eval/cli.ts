/**
 * `pnpm eval:factcheck`: scores `runFactcheck` on the eval set and prints the report as JSON.
 *
 * - No flags: against a deterministic mock, the full set. Spends nothing and never reads ANTHROPIC_API_KEY.
 * - `--live`: against Anthropic on the key in ANTHROPIC_API_KEY, the 5 smoke items; `--all` runs the whole set. This
 *   spends real money on that account: run it only with the key owner's approval.
 *
 * Exit 0 when every shown citation traces to a retrieved source, no provider error happened and, for a live run, the
 * mean cost is within ±25 % of FACTCHECK_TYPICAL_COST_MICROS; 1 otherwise; 2 for a usage error.
 */
import { fileURLToPath } from 'node:url';
import { anthropicClient, memoryCapabilities } from '@unalgorithm/ai';
import { formatPrice } from '@unalgorithm/core';
import { FACTCHECK_TYPICAL_COST_MICROS } from '@unalgorithm/protocol';
import { FACTCHECK_MODELS, type FactcheckDeps } from '../src/factcheck.ts';
import { aiRetriever } from '../src/retriever.ts';
import { FACTCHECK_EVAL_SET, type FactcheckEvalReport, mockDepsFor, runFactcheckEval } from './score.ts';

export const COST_TOLERANCE = 0.25;

export interface CliDeps {
  /** Builds the deps of a live run; default: the Anthropic client and its web-search retriever. */
  liveDeps?: (apiKey: string) => FactcheckDeps;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function anthropicDeps(apiKey: string): FactcheckDeps {
  const client = anthropicClient({ apiKey, capabilities: memoryCapabilities() });
  return { client, retriever: aiRetriever(client, FACTCHECK_MODELS.research) };
}

export function passes(report: FactcheckEvalReport, live: boolean): boolean {
  if (report.provenance !== 1 || report.providerErrors.length > 0) return false;
  if (!live) return true;
  const cost = report.meanCostMicros;
  return cost !== undefined && Math.abs(cost - FACTCHECK_TYPICAL_COST_MICROS) <= FACTCHECK_TYPICAL_COST_MICROS * COST_TOLERANCE;
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const unknown = argv.filter((a) => a !== '--live' && a !== '--all');
  if (unknown.length > 0) {
    err(`Unknown option ${unknown[0]}. Usage: pnpm eval:factcheck [--live [--all]]`);
    return 2;
  }
  const live = argv.includes('--live');

  let report: FactcheckEvalReport;
  if (live) {
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      err('A live run needs ANTHROPIC_API_KEY in the environment.');
      return 2;
    }
    const items = argv.includes('--all') ? FACTCHECK_EVAL_SET : FACTCHECK_EVAL_SET.filter((i) => i.smoke);
    out(
      `Live run: ${items.length} checks, about ${formatPrice(items.length * FACTCHECK_TYPICAL_COST_MICROS)} on your Anthropic account.`,
    );
    report = await runFactcheckEval((deps.liveDeps ?? anthropicDeps)(apiKey), items);
  } else {
    report = await runFactcheckEval(mockDepsFor(FACTCHECK_EVAL_SET));
  }
  out(JSON.stringify(report, null, 2));
  return passes(report, live) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
