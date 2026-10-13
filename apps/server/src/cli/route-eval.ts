import { fileURLToPath } from 'node:url';
import { type AIClient, AIError } from '@unalgorithm/ai';
import { runClassifyEval } from '@unalgorithm/ai/eval';
import { formatApproxCost, PROMPT_VERSION } from '@unalgorithm/core';
import { costMicros } from '@unalgorithm/protocol';
import { clientForRoute } from '../ai/provider.ts';
import { enabledRoute, recordEval } from '../ai/routes.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';

/**
 * Opens the eval gate (R20): `node apps/server/src/cli/route-eval.ts` (or `pnpm route-eval`), with the server's own
 * environment, after the server has started once and stored its route. It classifies the eval set with the enabled
 * `classify` route, stores the measured agreement for this prompt version, and marks the route passed when the
 * agreement reaches `ROUTE_EVAL_MIN_AGREEMENT`. The minimum itself is not stored: the server compares the stored
 * agreement with its own minimum on every request. Output names items by id and short codes, never post text.
 * Exit code 0 when the route passed, 1 otherwise.
 */

export interface RouteEvalDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

const USAGE =
  'usage: node apps/server/src/cli/route-eval.ts (no options; the minimum agreement is ROUTE_EVAL_MIN_AGREEMENT, as the server reads it)';

export async function main(argv: readonly string[], deps: RouteEvalDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (argv.length > 0) {
    out(USAGE);
    return 1;
  }

  let config: Config;
  try {
    config = deps.config ?? loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }

  const handle = deps.db ?? openPostgres(config.databaseUrl);
  try {
    const route = await enabledRoute(handle.db, 'classify');
    if (!route) {
      out('no classify route: start the server once, and it stores the route its AI_* variables describe');
      return 1;
    }

    let client: AIClient;
    try {
      client = clientForRoute(route, config, deps.fetch ? { fetch: deps.fetch } : {});
    } catch (err) {
      // The routing guard refused the stored route; its reason names variables and the model, never a key.
      if (err instanceof AIError) {
        out(err.message);
        return 1;
      }
      throw err;
    }

    const report = await runClassifyEval(client, route.model);
    const min = config.routeEvalMinAgreement;
    const passed = report.agreement >= min;
    await recordEval(handle.db, route.id, { agreement: report.agreement, promptVersion: PROMPT_VERSION, passed });

    const micros = costMicros(report.model, report.usage);
    out(
      `route ${route.provider}/${route.model}: agreement ${report.agreement.toFixed(2)} (${report.passed}/${report.total}), ` +
        `min ${min.toFixed(2)}, ${passed ? 'PASSED' : 'FAILED'}, cost ${micros === undefined ? 'unknown' : formatApproxCost(micros)}`,
    );
    for (const failure of report.failures) out(`  ${failure.id}: ${failure.reason}`);
    return passed ? 0 : 1;
  } catch (err) {
    // A database or other unexpected error, by name and code only: a message can hold a host or post text.
    const { err_name, err_code } = queryErrorFields(err);
    out(`route-eval failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
