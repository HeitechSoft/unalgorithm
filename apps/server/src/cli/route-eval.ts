import { fileURLToPath } from 'node:url';
import { runClassifyEval } from '@unalgorithm/ai/eval';
import { formatApproxCost, PROMPT_VERSION } from '@unalgorithm/core';
import { costMicros } from '@unalgorithm/protocol';
import { clientForRoute } from '../ai/provider.ts';
import { configuredRoute, enabledRoute, RouteConfigError, type RouteSpec, recordEval, sameRoute } from '../ai/routes.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';

/**
 * Opens the eval gate (R20): `node apps/server/src/cli/route-eval.ts` (or `pnpm route-eval`), with the server's own
 * environment, after the server has started once with it and stored its route. It classifies the eval set with the
 * enabled `classify` route, stores the measured agreement for this prompt version, and marks the route passed when the
 * agreement reaches `ROUTE_EVAL_MIN_AGREEMENT`. The minimum itself is not stored: the server compares the stored
 * agreement with its own minimum on every request. Output names items by id and short codes, never post text.
 * Exit code 0 when the route passed, 1 otherwise.
 *
 * It refuses a stored route that is not the one its own AI_* variables describe: `AI_API_KEY` would go to another
 * provider's endpoint, and the next start replaces that route anyway. A run the provider failed (busy, unreachable,
 * a refused key) measured the provider, not the model, so it stores nothing and a passed route stays passed.
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
  let wanted: RouteSpec;
  try {
    config = deps.config ?? loadConfig(process.env);
    wanted = configuredRoute(config);
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof RouteConfigError)) throw err;
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

    const name = `${route.provider}/${route.model}`;
    if (!sameRoute(route, wanted)) {
      // Provider and model only: a base URL can hold credentials.
      out(
        `the stored classify route (${name}) is not the one AI_PROVIDER, AI_MODEL, AI_BASE_URL and AI_DATA_POLICY ` +
          `describe (${wanted.provider}/${wanted.model}): start the server with this environment first`,
      );
      return 1;
    }

    // The stored route is the configured one, which `configuredRoute` already passed through the routing guard.
    const client = clientForRoute(route, config, deps.fetch ? { fetch: deps.fetch } : {});
    const report = await runClassifyEval(client, route.model);
    const micros = costMicros(report.model, report.usage);
    const cost = `cost ${micros === undefined ? 'unknown' : formatApproxCost(micros)}`;
    if (report.providerErrors.length > 0) {
      out(
        `route ${name}: not evaluated (provider errors: ${report.providerErrors.join(', ')}), stored result unchanged, ${cost}`,
      );
      return 1;
    }

    const min = config.routeEvalMinAgreement;
    const passed = report.agreement >= min;
    await recordEval(handle.db, route.id, { agreement: report.agreement, promptVersion: PROMPT_VERSION, passed });
    out(
      `route ${name}: agreement ${report.agreement.toFixed(2)} (${report.passed}/${report.total}), ` +
        `min ${min.toFixed(2)}, ${passed ? 'PASSED' : 'FAILED'}, ${cost}`,
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
