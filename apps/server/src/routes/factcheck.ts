/**
 * Fact-check jobs (F11, F15, F17, F18): one public post in, a checked result out, on the job kit (`routes/jobs.ts`),
 * which owns the lifecycle, the holds, the usage row and the no-content logging. This module only says what a check is:
 * its request, its gates and limits, its routes and the shared `runFactcheck` pipeline with the link check and the cost
 * ceiling.
 */
import { AIError } from '@unalgorithm/ai';
import {
  type CreditPriceSchedule,
  FACTCHECK_COST_CEILING_MICROS,
  FACTCHECK_JOBS_PATH,
  type FactcheckJobRequest,
  FactcheckJobRequestSchema,
  FactcheckJobSchema,
  type FactcheckResult,
  factcheckJobCancelPath,
  factcheckJobPath,
  serverMayReceive,
} from '@unalgorithm/protocol';
import { runFactcheck } from '@unalgorithm/research';
import { factcheckDepsFor, resolveFactcheckRoutes } from '../ai/factcheck.ts';
import { checkFactcheckLimits, type LimitDeps } from '../ai/limits.ts';
import type { Config } from '../config.ts';
import type { App, AppDeps } from '../http/app.ts';
import type { JobStore } from '../jobs/memory-jobs.ts';
import { type JobOffer, jobOffer, mountJobRoutes } from './jobs.ts';

/** Fact-check on this server now, and on a billing server its price and the hold cap's cost ceiling. */
export type FactcheckOffer = JobOffer;

/**
 * Whether the server offers fact-check at `now`: `FACTCHECK=on`, and on a billing server a schedule entry in effect that
 * prices checks. `price` is advertised only by a billing server; the cost ceiling is the hold cap at our cost there
 * (`maxChargeMicros / multiplier`), else `FACTCHECK_COST_CEILING_MICROS`.
 */
export function factcheckOffer(
  config: Pick<Config, 'factcheck' | 'billing'>,
  schedule: CreditPriceSchedule,
  now: Date = new Date(),
): FactcheckOffer {
  return jobOffer(
    'factcheck',
    { enabled: config.factcheck.enabled, defaultCeilingMicros: FACTCHECK_COST_CEILING_MICROS, billing: config.billing },
    schedule,
    now,
  );
}

/** Mounts the fact-check job endpoints: start, poll and cancel. `limits` is the app's one `LimitDeps` (shared with classify). */
export function factcheckRoutes(
  app: App,
  deps: AppDeps & { priceSchedule: CreditPriceSchedule; factcheckJobs: JobStore<FactcheckResult> },
  limits: LimitDeps,
): void {
  const { config, db, log, ai, priceSchedule } = deps;
  const search = deps.search ?? null;
  mountJobRoutes<FactcheckJobRequest, FactcheckResult>(
    app,
    { ...deps, jobs: deps.factcheckJobs },
    {
      task: 'factcheck',
      paths: { start: FACTCHECK_JOBS_PATH, job: factcheckJobPath, cancel: factcheckJobCancelPath },
      request: FactcheckJobRequestSchema,
      view: FactcheckJobSchema,
      texts: {
        notOffered: 'Fact-check is not offered on this server.',
        start: 'The check is running',
        refused400: 'The request was not valid, or the post is not public',
        refused429: "Too many requests, a check already running, or today's limit is reached",
        unavailable503: 'Fact-check is not offered, no AI route is available, or the server is busy',
        busyUser: 'A check is already running for this account.',
        busyServer: 'The server is running as many checks as it can.',
      },
      refusedModel: config.factcheck.synthesisModel,
      offer: () => factcheckOffer(config, priceSchedule),
      // F18: only a public post is ever checked. The extension never sends another; nothing is metered.
      admit: ({ post }) => {
        if (!serverMayReceive(post)) throw new AIError('bad-request', 'Only a public post can be checked.');
      },
      limits: (account) => checkFactcheckLimits(limits, account),
      prepare: async (maxCostMicros, { post }) => {
        const routes = await resolveFactcheckRoutes(db.db, config, log);
        const factcheckDeps = factcheckDepsFor(routes, {
          ai,
          search,
          ...(deps.linkCheck ? { linkCheck: deps.linkCheck } : {}),
          maxCostMicros,
        });
        return {
          routeId: routes.synthesis.id,
          model: routes.synthesis.model,
          // Short ref, as classify's batches: the client's ref never reaches a model.
          run: async (signal, onUsage) => (await runFactcheck({ ...post, ref: 'p1' }, factcheckDeps, { signal, onUsage })).result,
        };
      },
      summary: (r) => ({ claims: r?.claims.length ?? 0, sources: r?.sources.length ?? 0 }),
    },
  );
}
