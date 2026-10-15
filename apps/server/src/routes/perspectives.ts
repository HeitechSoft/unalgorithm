/**
 * Other perspectives jobs (F22, F18): one shared link in, a comparison of its coverage across the registry's lean
 * buckets out, on the job kit (`routes/jobs.ts`), which owns the lifecycle, the holds, the usage row and the no-content
 * logging. The request is the link alone (URL and link-card title) with the platform and audience: the schema is strict,
 * so a body carrying post text or any other field is refused, never stripped. The link is never logged or stored.
 */
import { AIError } from '@unalgorithm/ai';
import type { Registry } from '@unalgorithm/outlets';
import {
  type CreditPriceSchedule,
  PERSPECTIVES_JOBS_PATH,
  type PerspectivesJobRequest,
  PerspectivesJobRequestSchema,
  PerspectivesJobSchema,
  type PerspectivesResult,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  serverMayReceive,
} from '@unalgorithm/protocol';
import { runPerspectives } from '@unalgorithm/research';
import { resolveFactcheckRoutes } from '../ai/factcheck.ts';
import { checkJobLimits, type LimitDeps } from '../ai/limits.ts';
import { perspectivesDepsFor, perspectivesOffer } from '../ai/perspectives.ts';
import type { App, AppDeps } from '../http/app.ts';
import type { JobStore } from '../jobs/memory-jobs.ts';
import { mountJobRoutes } from './jobs.ts';

/** Mounts the perspectives job endpoints: start, poll and cancel. `limits` is the app's one `LimitDeps`. */
export function perspectivesRoutes(
  app: App,
  deps: AppDeps & {
    priceSchedule: CreditPriceSchedule;
    perspectivesJobs: JobStore<PerspectivesResult>;
    /** A usable registry, or null: then perspectives is not offered. */
    outlets: Registry | null;
  },
  limits: LimitDeps,
): void {
  const { config, db, log, ai, priceSchedule, outlets } = deps;
  const search = deps.search ?? null;
  mountJobRoutes<PerspectivesJobRequest, PerspectivesResult>(
    app,
    { ...deps, jobs: deps.perspectivesJobs },
    {
      task: 'perspectives',
      paths: { start: PERSPECTIVES_JOBS_PATH, job: perspectivesJobPath, cancel: perspectivesJobCancelPath },
      // Strict (F18): a `text`, `post` or any other field answers 400 before anything is metered.
      request: PerspectivesJobRequestSchema,
      view: PerspectivesJobSchema,
      texts: {
        notOffered: 'Other perspectives is not offered on this server.',
        start: 'The comparison is running',
        refused400: 'The request was not valid, or the post is not public',
        refused429: "Too many requests, a comparison already running, or today's limit is reached",
        unavailable503: 'Other perspectives is not offered, no AI route is available, or the server is busy',
        busyUser: 'A comparison is already running for this account.',
        busyServer: 'The server is running as many comparisons as it can.',
      },
      // The comparison runs on the synthesis route (P3-33).
      refusedModel: config.factcheck.synthesisModel,
      offer: () => perspectivesOffer(config, priceSchedule, outlets),
      // F18: only a public post's link is ever compared; nothing is metered for another.
      admit: (req) => {
        if (!serverMayReceive(req)) throw new AIError('bad-request', 'Only a public post can be compared.');
      },
      limits: (account) => checkJobLimits(limits, account),
      prepare: async (maxCostMicros, req) => {
        // `offer` refused without a registry, so it is here.
        const registry = outlets as Registry;
        const routes = await resolveFactcheckRoutes(db.db, config, log);
        const pDeps = perspectivesDepsFor(routes, {
          ai,
          search,
          registry,
          ...(deps.resolveLink ? { resolveLink: deps.resolveLink } : {}),
          maxCostMicros,
        });
        return {
          routeId: routes.synthesis.id,
          model: routes.synthesis.model,
          run: async (signal, onUsage) => (await runPerspectives(req.link, pDeps, { signal, onUsage })).result,
        };
      },
      summary: (r) => ({
        sources: r?.sources.length ?? 0,
        gaps: r?.coverage.filter((c) => !c.sourceIds.length).length ?? 0,
        points: (r?.agreed.length ?? 0) + (r?.differences.length ?? 0) + (r?.unique.length ?? 0),
      }),
    },
  );
}
