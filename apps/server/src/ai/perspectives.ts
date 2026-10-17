/**
 * UnEcho Chamber on the server (F22): the offer rule and `PerspectivesDeps` on the fact-check routes. Perspectives has
 * no route or eval of its own in RM3 (decision D33): it is served on the routes past the fact-check eval, with the story
 * query and the searches on the classify route's model and the comparison on the synthesis route.
 */
import { type AIClient, AIError } from '@unalgorithm/ai';
import type { SourceList } from '@unalgorithm/outlets';
import { type CreditPriceSchedule, PERSPECTIVES_COST_CEILING_MICROS } from '@unalgorithm/protocol';
import {
  aiBucketSearcher,
  type BucketSearcher,
  type PerspectivesDeps,
  providerBucketSearcher,
  type SearchProvider,
} from '@unalgorithm/research';
import type { Config } from '../config.ts';
import { type JobOffer, jobOffer } from '../routes/jobs.ts';
import type { FactcheckRoutes } from './factcheck.ts';
import type { AiRoute } from './routes.ts';

/** Not offered without a source list; otherwise P3-33's rule for the `perspectives` task. */
export function perspectivesOffer(
  config: Pick<Config, 'perspectives' | 'billing'>,
  schedule: CreditPriceSchedule,
  registry: SourceList | null,
  now: Date = new Date(),
): JobOffer {
  if (!registry) return { offered: false };
  return jobOffer(
    'perspectives',
    { enabled: config.perspectives.enabled, defaultCeilingMicros: PERSPECTIVES_COST_CEILING_MICROS, billing: config.billing },
    schedule,
    now,
  );
}

/**
 * The pipeline on the fact-check routes (resolved by `resolveFactcheckRoutes`, so the guard and eval gate apply). The
 * searches go to the admin's search provider, else to Anthropic web search on the research route's client, asked for
 * the classify route's cheaper model (as `factcheckDepsFor` asks the synthesis client for the claims model).
 */
export function perspectivesDepsFor(
  routes: FactcheckRoutes,
  rt: {
    ai: { clientFor(route: AiRoute): AIClient };
    search: SearchProvider | null;
    registry: SourceList;
    resolveLink?: (url: string, signal: AbortSignal) => Promise<string | null>;
    maxCostMicros?: number;
  },
): PerspectivesDeps {
  const { claims, research, synthesis } = routes;
  let searcher: BucketSearcher;
  if (rt.search) searcher = providerBucketSearcher(rt.search);
  else if (research) searcher = aiBucketSearcher(rt.ai.clientFor(research), claims.model);
  else throw new AIError('not-available', 'No research route or search provider is configured.');
  return {
    client: rt.ai.clientFor(synthesis),
    searcher,
    registry: rt.registry,
    models: { query: claims.model, search: claims.model, compare: synthesis.model },
    ...(rt.resolveLink ? { resolveLink: rt.resolveLink } : {}),
    ...(rt.maxCostMicros !== undefined ? { maxCostMicros: rt.maxCostMicros } : {}),
  };
}
