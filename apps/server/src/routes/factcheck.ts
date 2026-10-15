/**
 * Fact-check jobs (F11, F15, F17, F18): a signed-in device posts one public post, the server checks the gates (enabled,
 * offered, public, limits, routes), asks billing for a hold, answers 202 with a job id, and runs the shared
 * `runFactcheck` pipeline in the background, with the link check and the cost ceiling. The device polls the job and may
 * cancel it. Every refusal happens before any model call.
 *
 * A job's result lives only in the in-memory job store (`jobs/memory-jobs.ts`), never in Postgres or graphile-worker:
 * a restart loses running jobs, and their holds are released (a stop) or expire in the module (a crash). The job's usage
 * row holds counts and costs only, and no log line carries a provider message, a claim, a URL or a post field.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { AIError, describeError } from '@unalgorithm/ai';
import {
  addUsage,
  type CreditPriceSchedule,
  costMicros,
  FACTCHECK_COST_CEILING_MICROS,
  FACTCHECK_JOBS_PATH,
  FACTCHECK_POLL_WAIT_MS,
  type FactcheckJob,
  FactcheckJobRequestSchema,
  FactcheckJobSchema,
  type FactcheckResult,
  factcheckJobCancelPath,
  factcheckJobPath,
  type JobPrice,
  jobPriceAt,
  type NormalizedUsage,
  serverMayReceive,
  taskPriceAt,
  type WireError,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { type FactcheckDeps, type FactcheckRun, runFactcheck } from '@unalgorithm/research';
import { type FactcheckRoutes, factcheckDepsFor, resolveFactcheckRoutes } from '../ai/factcheck.ts';
import { checkFactcheckLimits, type LimitDeps } from '../ai/limits.ts';
import { recordUsageEvent } from '../ai/metering.ts';
import { requireDevice } from '../auth/bearer.ts';
import { runWithBilling, type SettleRequest } from '../billing/provider.ts';
import type { Config } from '../config.ts';
import type { App, AppDeps } from '../http/app.ts';
import { JobCancelled, type JobEnd, type JobStore, type JobView } from '../jobs/memory-jobs.ts';
import { errorFields } from '../log.ts';
import { wireCodeFor } from './classify.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

/** Fact-check on this server now, and on a billing server its price and the hold cap's cost ceiling. */
export type FactcheckOffer = { offered: false } | { offered: true; price: JobPrice | null; maxCostMicros: number };

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
  if (!config.factcheck.enabled) return { offered: false };
  if (config.billing === 'off') return { offered: true, price: null, maxCostMicros: FACTCHECK_COST_CEILING_MICROS };
  const price = jobPriceAt(now, 'factcheck', schedule);
  const task = taskPriceAt(now, 'factcheck', schedule);
  if (price === null || !task.offered || task.card.maxChargeMicros === undefined) return { offered: false };
  return { offered: true, price, maxCostMicros: Math.floor(task.card.maxChargeMicros / task.card.multiplier) };
}

/** What the calls of one job spent: every call, and the calls that answered (`ok`). Costs are null once one is unpriced. */
interface Spend {
  calls: number;
  failedCalls: number;
  usage: NormalizedUsage;
  okUsage: NormalizedUsage;
  cost: number | null;
  okCost: number | null;
}

const plus = (a: number | null, b: number | undefined): number | null => (a === null || b === undefined ? null : a + b);

const JobParamsSchema = z.object({ id: z.string().min(1).max(64) });
const PollQuerySchema = z.object({ wait: z.string().max(8).optional() });

/** Mounts the fact-check job endpoints: start, poll and cancel. `limits` is the app's one `LimitDeps` (shared with classify). */
export function factcheckRoutes(
  app: App,
  deps: AppDeps & { priceSchedule: CreditPriceSchedule; factcheckJobs: JobStore<FactcheckResult> },
  limits: LimitDeps,
): void {
  const { config, db, log, billing, ai, priceSchedule, factcheckJobs: jobs } = deps;
  const search = deps.search ?? null;
  const stopping = deps.stopping;
  const failure = (code: WireError['code']): WireError => ({ code, message: describeError(code, config.instanceName) });
  const answer = (view: JobView<FactcheckResult>): FactcheckJob => ({ v: 1, ...view });

  /** A request refused after the cheap gates: one `refused-before-call` row, as classify meters its refusals. */
  const recordRefused = (rid: string, userId: string, deviceId: string, routes: FactcheckRoutes | undefined) =>
    recordUsageEvent(
      db.db,
      {
        requestId: rid,
        userId,
        deviceId,
        routeId: routes?.synthesis.id ?? null,
        task: 'factcheck',
        model: routes?.synthesis.model ?? config.factcheck.synthesisModel,
        outcome: 'refused-before-call',
        postsRequested: 1,
        postsOk: 0,
        calls: 0,
        failedCalls: 0,
        usage: ZERO_USAGE,
        okUsage: ZERO_USAGE,
        costMicros: 0,
        chargeableCostMicros: 0,
      },
      log,
    );

  app.openapi(
    createRoute({
      method: 'post',
      path: FACTCHECK_JOBS_PATH,
      middleware: [requireDevice(deps)] as const,
      request: { body: { content: json(FactcheckJobRequestSchema), required: true } },
      responses: {
        202: { description: 'The check is running', content: json(FactcheckJobSchema) },
        400: errorResponse('The request was not valid, or the post is not public'),
        401: errorResponse('No valid device token'),
        402: errorResponse('The balance is empty'),
        429: errorResponse("Too many requests, a check already running, or today's limit is reached"),
        500: errorResponse('The server failed'),
        503: errorResponse('Fact-check is not offered, no AI route is available, or the server is busy'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const rid = c.get('rid');
      const { userId, deviceId } = c.get('account');
      // Unknown fields (a prompt, a model) were stripped by the schema.
      const { post } = c.req.valid('json');

      const offer = factcheckOffer(config, priceSchedule);
      if (!offer.offered) throw new AIError('not-available', 'Fact-check is not offered on this server.');
      // F18: only a public post is ever checked. The extension never sends another; nothing is metered.
      if (!serverMayReceive(post)) throw new AIError('bad-request', 'Only a public post can be checked.');

      let releaseLimits: (() => void) | undefined;
      let routes: FactcheckRoutes | undefined;
      let factcheckDeps: FactcheckDeps;
      try {
        releaseLimits = await checkFactcheckLimits(limits, { userId });
        routes = await resolveFactcheckRoutes(db.db, config, log);
        factcheckDeps = factcheckDepsFor(routes, {
          ai,
          search,
          ...(deps.linkCheck ? { linkCheck: deps.linkCheck } : {}),
          maxCostMicros: offer.maxCostMicros,
        });
      } catch (err) {
        await recordRefused(rid, userId, deviceId, routes);
        releaseLimits?.();
        throw err;
      }
      const served = routes;
      const release = releaseLimits;

      const job = jobs.start(userId);
      if (!job.ok) {
        await recordRefused(rid, userId, deviceId, served);
        release();
        if (job.reason === 'busy-user') throw new AIError('rate-limit', 'A check is already running for this account.');
        throw new AIError('overloaded', 'The server is running as many checks as it can.');
      }
      const jobId = job.id;
      const startedAt = performance.now();

      const spend: Spend = { calls: 0, failedCalls: 0, usage: ZERO_USAGE, okUsage: ZERO_USAGE, cost: 0, okCost: 0 };
      const onUsage = ({ model, usage, failed }: { model: string; usage: NormalizedUsage; failed: boolean }) => {
        const cost = costMicros(model, usage);
        spend.calls++;
        spend.usage = addUsage(spend.usage, usage);
        spend.cost = plus(spend.cost, cost);
        if (failed) {
          spend.failedCalls++;
          return;
        }
        spend.okUsage = addUsage(spend.okUsage, usage);
        spend.okCost = plus(spend.okCost, cost);
      };

      // Resolved once billing let the check through: from then on the job runs in the background.
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const call = () => {
        markStarted();
        // Short ref, as classify's batches: the client's ref never reaches a model.
        return runFactcheck({ ...post, ref: 'p1' }, factcheckDeps, { signal: job.signal, onUsage });
      };
      // A failed or cancelled job never settles: `runWithBilling` releases its hold.
      const toSettle = (_run: FactcheckRun): SettleRequest => ({
        userId,
        requestId: jobId,
        task: 'factcheck',
        model: served.synthesis.model,
        chargeableUsage: spend.okUsage,
        costMicros: spend.okCost,
        posts: 1,
      });
      const run = runWithBilling(billing, { userId, deviceId, task: 'factcheck', requestId: jobId }, call, toSettle, log);

      try {
        await Promise.race([started, run]);
      } catch (err) {
        // Refused by billing (402) before any call: no job is left, and the request is metered as refused.
        jobs.discard(jobId);
        await recordRefused(rid, userId, deviceId, served);
        release();
        throw err;
      }

      const finishJob = async () => {
        let end: JobEnd<FactcheckResult> = { status: 'failed', error: failure('unknown') };
        let result: FactcheckResult | undefined;
        try {
          const { result: done, billing: settled } = await run;
          result = done.result;
          end = { status: 'done', result, ...(settled ? { billing: settled } : {}) };
        } catch (err) {
          if (err instanceof JobCancelled || (job.signal.aborted && job.signal.reason instanceof JobCancelled)) {
            end = { status: 'cancelled' };
          } else {
            // `describeError` text only: a provider's message can echo the post.
            end = { status: 'failed', error: failure(err instanceof AIError ? wireCodeFor(err.code) : 'unknown') };
          }
        } finally {
          const outcome = end.status === 'done' ? 'ok' : 'failed';
          try {
            await recordUsageEvent(
              db.db,
              {
                requestId: jobId,
                userId,
                deviceId,
                routeId: served.synthesis.id,
                task: 'factcheck',
                model: served.synthesis.model,
                outcome,
                postsRequested: 1,
                postsOk: 0,
                calls: spend.calls,
                failedCalls: spend.failedCalls,
                usage: spend.usage,
                okUsage: spend.okUsage,
                costMicros: spend.cost,
                chargeableCostMicros: end.status === 'done' ? spend.okCost : 0,
              },
              log,
            );
            // Only now: from here on the row counts the check.
            release();
            log.info('factcheck.done', {
              rid: jobId,
              outcome: end.status,
              claims: result?.claims.length ?? 0,
              sources: result?.sources.length ?? 0,
              cost_micros: spend.cost,
              ms: Math.round(performance.now() - startedAt),
            });
          } finally {
            // Last: a job counts as running until here, so a stopping server's drain waits for the row and the release.
            jobs.finish(jobId, end);
          }
        }
      };
      void finishJob().catch((err: unknown) => log.error('factcheck.finish_failed', { rid: jobId, ...errorFields(err) }));

      return c.json(answer({ id: jobId, status: 'running' }), 202);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: factcheckJobPath('{id}'),
      middleware: [requireDevice(deps)] as const,
      request: { params: JobParamsSchema, query: PollQuerySchema },
      responses: {
        200: { description: "The job's state, and its result once done", content: json(FactcheckJobSchema) },
        401: errorResponse('No valid device token'),
        404: errorResponse('No such job for this account, or it has expired'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId } = c.get('account');
      const { id } = c.req.valid('param');
      const { wait } = c.req.valid('query');
      const view =
        wait === '1'
          ? await jobs.waitFor(
              id,
              userId,
              FACTCHECK_POLL_WAIT_MS,
              AbortSignal.any(stopping ? [c.req.raw.signal, stopping] : [c.req.raw.signal]),
            )
          : jobs.view(id, userId);
      if (!view) return c.json(NOT_FOUND, 404);
      return c.json(answer(view), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: factcheckJobCancelPath('{id}'),
      middleware: [requireDevice(deps)] as const,
      request: { params: JobParamsSchema },
      responses: {
        202: {
          description: 'Cancelling: the job ends as cancelled unless it has already ended',
          content: json(FactcheckJobSchema),
        },
        401: errorResponse('No valid device token'),
        404: errorResponse('No such job for this account, or it has expired'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const { userId } = c.get('account');
      const { id } = c.req.valid('param');
      if (!jobs.view(id, userId)) return c.json(NOT_FOUND, 404);
      jobs.cancel(id, userId);
      const view = jobs.view(id, userId);
      if (!view) return c.json(NOT_FOUND, 404);
      return c.json(answer(view), 202);
    },
  );
}
