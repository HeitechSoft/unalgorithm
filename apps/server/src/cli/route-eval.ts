import { fileURLToPath } from 'node:url';
import { runClassifyEval } from '@unalgorithm/ai/eval';
import { formatApproxCost, PROMPT_VERSION } from '@unalgorithm/core';
import { costMicros, FACTCHECK_COST_CEILING_MICROS, FACTCHECK_TYPICAL_COST_MICROS, PRICE_CARDS } from '@unalgorithm/protocol';
import type { FactcheckDeps, SearchProvider } from '@unalgorithm/research';
import { FACTCHECK_EVAL_SET, type FactcheckEvalReport, PROVIDER_ERROR_CODES, runFactcheckEval } from '@unalgorithm/research/eval';
import { enabledFactcheckRoutes, type FactcheckRoutes, factcheckDepsFor, searchProviderFor } from '../ai/factcheck.ts';
import { clientForRoute } from '../ai/provider.ts';
import {
  type AiRoute,
  configuredRoute,
  configuredRoutes,
  enabledRoute,
  MODEL_VARIABLE,
  RouteConfigError,
  type RouteSpec,
  type RouteTask,
  recordEval,
  routePromptVersion,
  sameRoute,
} from '../ai/routes.ts';
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
 * `route-eval factcheck` does the same for the fact-check routes (F12): it runs the fact-check eval set with claims on
 * the classify route's model, research on the `research` route (or the search provider) and verdicts on the
 * `synthesis` route, and records the result on `synthesis` and `research`. It passes when the agreement reaches the same
 * minimum and every shown citation traces to a source. Running it is the operator's choice to spend (decision D16): it
 * prints the estimate and never prompts.
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
  /** Fact-check research by search instead of Anthropic web search. Default: `searchProviderFor(config, fetch)`. */
  search?: SearchProvider | null;
  /** The fact-check eval's deps. Default: `factcheckDepsFor` on the routes, with the cost ceiling and no link check. */
  factcheckDeps?: (routes: FactcheckRoutes) => FactcheckDeps;
}

const USAGE =
  'usage: node apps/server/src/cli/route-eval.ts [factcheck] (no options; the minimum agreement is ROUTE_EVAL_MIN_AGREEMENT, as the server reads it)';

const FACTCHECK_OFF = 'FACTCHECK is off: set FACTCHECK=on and start the server once first';

type Out = (line: string) => void;

export async function main(argv: readonly string[], deps: RouteEvalDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const factcheck = argv.length === 1 && argv[0] === 'factcheck';
  if (argv.length > 0 && !factcheck) {
    out(USAGE);
    return 1;
  }

  let config: Config;
  let wanted: RouteSpec[];
  try {
    config = deps.config ?? loadConfig(process.env);
    if (factcheck && !config.factcheck.enabled) {
      out(FACTCHECK_OFF);
      return 1;
    }
    wanted = factcheck ? configuredRoutes(config) : [configuredRoute(config)];
  } catch (err) {
    if (!(err instanceof ConfigError || err instanceof RouteConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }

  const handle = deps.db ?? openPostgres(config.databaseUrl);
  try {
    return factcheck
      ? await factcheckEval(handle, config, wanted, deps, out)
      : await classifyEval(handle, config, wanted, deps, out);
  } catch (err) {
    // A database or other unexpected error, by name and code only: a message can hold a host or post text.
    const { err_name, err_code } = queryErrorFields(err);
    out(`route-eval failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

/** Why a stored route is refused: provider and model only, since a base URL can hold credentials. */
function notConfigured(task: RouteTask, route: AiRoute, wanted: RouteSpec): string {
  return (
    `the stored ${task} route (${route.provider}/${route.model}) is not the one AI_PROVIDER, ${MODEL_VARIABLE[task]}, ` +
    `AI_BASE_URL and AI_DATA_POLICY describe (${wanted.provider}/${wanted.model}): start the server with this environment first`
  );
}

function costText(micros: number | undefined): string {
  return `cost ${micros === undefined ? 'unknown' : formatApproxCost(micros)}`;
}

async function classifyEval(
  handle: DbHandle,
  config: Config,
  [wanted]: RouteSpec[],
  deps: RouteEvalDeps,
  out: Out,
): Promise<number> {
  const route = await enabledRoute(handle.db, 'classify');
  if (!route || !wanted) {
    out('no classify route: start the server once, and it stores the route its AI_* variables describe');
    return 1;
  }
  if (!sameRoute(route, wanted)) {
    out(notConfigured('classify', route, wanted));
    return 1;
  }

  const name = `${route.provider}/${route.model}`;
  // The stored route is the configured one, which `configuredRoute` already passed through the routing guard.
  const client = clientForRoute(route, config, deps.fetch ? { fetch: deps.fetch } : {});
  const report = await runClassifyEval(client, route.model);
  const cost = costText(costMicros(report.model, report.usage));
  if (report.providerErrors.length > 0) {
    out(`route ${name}: not evaluated (provider errors: ${report.providerErrors.join(', ')}), stored result unchanged, ${cost}`);
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
}

/** Whether a fact-check eval passed: agreement at least `minAgreement`, and every shown citation traced to a source. */
export function factcheckEvalPassed(
  report: Pick<FactcheckEvalReport, 'agreement' | 'provenance'>,
  minAgreement: number,
): boolean {
  return report.agreement >= minAgreement && report.provenance === 1;
}

/** The stored route for a configured task, out of the fact-check routes. */
function storedFor(routes: FactcheckRoutes, task: RouteTask): AiRoute | null {
  if (task === 'classify') return routes.claims;
  return task === 'research' ? routes.research : routes.synthesis;
}

/** Items that measured the provider rather than the model (`error overloaded`, ...), left out of every ratio. */
function providerErrorItems(report: FactcheckEvalReport): number {
  const codes: ReadonlySet<string> = PROVIDER_ERROR_CODES;
  return report.failures.filter((f) => f.reason.startsWith('error ') && codes.has(f.reason.slice('error '.length))).length;
}

async function factcheckEval(
  handle: DbHandle,
  config: Config,
  wanted: RouteSpec[],
  deps: RouteEvalDeps,
  out: Out,
): Promise<number> {
  const routes = await enabledFactcheckRoutes(handle.db, config);
  for (const spec of wanted) {
    const task = spec.task as RouteTask;
    const route = routes ? storedFor(routes, task) : ((await enabledRoute(handle.db, task)) ?? null);
    if (!route) {
      out(`no ${task} route: start the server once with FACTCHECK=on, and it stores the routes its AI_* variables describe`);
      return 1;
    }
    if (!sameRoute(route, spec)) {
      out(notConfigured(task, route, spec));
      return 1;
    }
  }
  // Every configured route is stored (checked above), so this is only a guard for the type.
  if (!routes) throw new Error('The fact-check routes were not found.');

  const { claims, research, synthesis } = routes;
  const name = `${synthesis.provider}/${synthesis.model}`;
  const items = FACTCHECK_EVAL_SET;
  const priced = [claims, synthesis, research].every((r) => r === null || PRICE_CARDS[r.model] !== undefined);
  const estimate = priced ? `, ${formatApproxCost(items.length * FACTCHECK_TYPICAL_COST_MICROS)}` : '';
  out(`fact-check eval: ${items.length} checks on ${name}${estimate}`);

  const fcDeps =
    deps.factcheckDeps?.(routes) ??
    factcheckDepsFor(routes, {
      ai: { clientFor: (route) => clientForRoute(route, config, deps.fetch ? { fetch: deps.fetch } : {}) },
      search: deps.search === undefined ? searchProviderFor(config, deps.fetch) : deps.search,
      // No link check: the eval's URLs are synthetic (RM4 measures live links).
      maxCostMicros: FACTCHECK_COST_CEILING_MICROS,
    });
  const report = await runFactcheckEval(fcDeps, items);
  const scored = report.total - providerErrorItems(report);
  const cost = costText(report.meanCostMicros === undefined ? undefined : report.meanCostMicros * scored);
  if (report.providerErrors.length > 0) {
    out(
      `route synthesis ${name}: not evaluated (provider errors: ${report.providerErrors.join(', ')}), ` +
        `stored result unchanged, ${cost}`,
    );
    return 1;
  }

  const min = config.routeEvalMinAgreement;
  const passed = factcheckEvalPassed(report, min);
  const result = { agreement: report.agreement, promptVersion: routePromptVersion('synthesis'), passed };
  await recordEval(handle.db, synthesis.id, result);
  if (research) await recordEval(handle.db, research.id, result);
  out(
    `route synthesis ${name}: agreement ${report.agreement.toFixed(2)} (${Math.round(report.agreement * scored)}/${scored}), ` +
      `provenance ${report.provenance.toFixed(2)}, pairs ${report.pairConsistency.toFixed(2)}, min ${min.toFixed(2)}, ` +
      `${passed ? 'PASSED' : 'FAILED'}, ${cost}`,
  );
  // By item id and short codes only, never post text.
  for (const failure of report.failures) out(`  ${failure.id}: ${failure.reason}`);
  return passed ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
