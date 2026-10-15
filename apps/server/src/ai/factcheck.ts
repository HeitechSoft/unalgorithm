/**
 * The server's fact-check routes as `FactcheckDeps` (F1, F12): the same `runFactcheck` the extension runs, with claims on
 * the `classify` route's model, research on the `research` route (Anthropic web search) or the admin's search provider,
 * and verdicts on the `synthesis` route. The one place both the job endpoints and `route-eval factcheck` build them.
 */
import { type AIClient, AIError } from '@unalgorithm/ai';
import {
  aiRetriever,
  createSearchProvider,
  type FactcheckDeps,
  type LinkChecker,
  type SearchProvider,
  searchRetriever,
} from '@unalgorithm/research';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { Logger } from '../log.ts';
import { type AiRoute, enabledRoute, resolveRoute } from './routes.ts';

export interface FactcheckRoutes {
  claims: AiRoute;
  /** Null when the admin's search provider researches instead of Anthropic web search. */
  research: AiRoute | null;
  synthesis: AiRoute;
}

/**
 * The routes that serve a fact-check, each past the guard and the eval gate (`resolveRoute`): classify, synthesis, and
 * research when no search provider is set. Otherwise `AIError` `not-available`, as for classify.
 */
export async function resolveFactcheckRoutes(db: Db, config: Config, log: Logger): Promise<FactcheckRoutes> {
  if (!config.factcheck.enabled) throw new AIError('not-available', 'Fact-check is off on this server.');
  const min = config.routeEvalMinAgreement;
  const claims = await resolveRoute(db, 'classify', min, log);
  const synthesis = await resolveRoute(db, 'synthesis', min, log);
  const research = config.factcheck.search === null ? await resolveRoute(db, 'research', min, log) : null;
  return { claims, research, synthesis };
}

/** The fact-check routes as stored, with no guard or eval gate (`route-eval`'s view); null when one is missing. */
export async function enabledFactcheckRoutes(db: Db, config: Config): Promise<FactcheckRoutes | null> {
  if (!config.factcheck.enabled) return null;
  const claims = await enabledRoute(db, 'classify');
  const synthesis = await enabledRoute(db, 'synthesis');
  const research = config.factcheck.search === null ? await enabledRoute(db, 'research') : null;
  if (!claims || !synthesis || research === undefined) return null;
  return { claims, research, synthesis };
}

/** The admin's search provider (`config.factcheck.search`), or null when Anthropic web search researches. */
export function searchProviderFor(config: Config, fetchImpl?: typeof fetch): SearchProvider | null {
  const search = config.factcheck.search;
  if (!search) return null;
  return createSearchProvider({ ...search, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/**
 * `FactcheckDeps` for the routes. One provider and key serve every route (`AI_PROVIDER` is single), so the synthesis
 * route's client asks for both the claims and the verdicts, each with its own route's model. In search mode the
 * research step has no model usage, so pricing it at the synthesis model costs nothing (P3-12).
 */
export function factcheckDepsFor(
  routes: FactcheckRoutes,
  rt: {
    ai: { clientFor(route: AiRoute): AIClient };
    search: SearchProvider | null;
    linkCheck?: LinkChecker;
    maxCostMicros?: number;
  },
): FactcheckDeps {
  const { research, synthesis } = routes;
  let retriever: FactcheckDeps['retriever'];
  let researchModel: string;
  if (rt.search) {
    retriever = searchRetriever(rt.search);
    researchModel = synthesis.model;
  } else if (research) {
    retriever = aiRetriever(rt.ai.clientFor(research), research.model);
    researchModel = research.model;
  } else {
    throw new AIError('not-available', 'No research route or search provider is configured.');
  }
  return {
    client: rt.ai.clientFor(synthesis),
    retriever,
    models: { claims: routes.claims.model, research: researchModel, verdict: synthesis.model },
    ...(rt.linkCheck ? { linkCheck: rt.linkCheck } : {}),
    ...(rt.maxCostMicros !== undefined ? { maxCostMicros: rt.maxCostMicros } : {}),
  };
}
