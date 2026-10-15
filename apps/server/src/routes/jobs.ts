/**
 * The on-demand job endpoints (F11), one kit for every job task (fact-check, perspectives): a signed-in device posts one
 * request, the server checks the gates (offered, the request itself, limits, routes), asks billing for a hold, answers
 * 202 with a job id, and runs the task's pipeline in the background under its cost ceiling. The device polls the job and
 * may cancel it. Every refusal happens before any model call. A task is a `JobSpec`; `mountJobRoutes` owns the lifecycle.
 *
 * A job's result lives only in the in-memory job store (`jobs/memory-jobs.ts`), never in Postgres or graphile-worker:
 * a restart loses running jobs, and their holds are released (a stop) or expire in the module (a crash). The job's usage
 * row holds counts and costs only, and no log line carries a provider message, a claim, a URL or a post field: the
 * `<task>.done` line holds the spec's `summary`, which is counts only.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { AIError, describeError } from '@unalgorithm/ai';
import {
  addUsage,
  type CreditPriceSchedule,
  type CreditTask,
  costMicros,
  FACTCHECK_POLL_WAIT_MS,
  type JobPrice,
  jobPriceAt,
  type NormalizedUsage,
  taskPriceAt,
  type WireError,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { recordUsageEvent } from '../ai/metering.ts';
import { requireDevice } from '../auth/bearer.ts';
import { runWithBilling, type SettleRequest } from '../billing/provider.ts';
import type { Config } from '../config.ts';
import type { App, AppDeps } from '../http/app.ts';
import { JobAbandoned, JobCancelled, type JobEnd, type JobStore, type JobView } from '../jobs/memory-jobs.ts';
import { errorFields } from '../log.ts';
import { wireCodeFor } from './classify.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

export type JobTask = Exclude<CreditTask, 'classify'>;

/** One model call's usage, as the research pipelines report it. */
export type OnUsage = (u: { model: string; usage: NormalizedUsage; failed: boolean }) => void;

/** The run of one admitted request, on the route that names its usage row and its settlement. */
export interface JobRun<R> {
  routeId: string;
  model: string;
  run(signal: AbortSignal, onUsage: OnUsage): Promise<R>;
}

export interface JobSpec<Req, R> {
  /** Billing task and usage-row task. */
  task: JobTask;
  paths: { start: string; job(id: string): string; cancel(id: string): string };
  /** The request body and job view schemas (OpenAPI too). */
  request: z.ZodType<Req>;
  view: z.ZodType;
  /** OpenAPI descriptions (`start`: 202, `refused400`, `refused429`, `unavailable503`) and AIError messages. */
  texts: {
    notOffered: string;
    start: string;
    refused400: string;
    refused429: string;
    unavailable503: string;
    busyUser: string;
    busyServer: string;
  };
  /**
   * The model a `refused-before-call` row names when `limits` or `prepare` refused before a `JobRun` existed (route id
   * null): `usage_events.model` is NOT NULL.
   */
  refusedModel: string;
  /** Offered now, and the cost ceiling for a run. */
  offer(): { offered: false } | { offered: true; maxCostMicros: number };
  /** Request-level refusal, before anything is metered (F18). Throws AIError('bad-request'). */
  admit(req: Req): void;
  /** The per-user limits; resolves to `release`, called after the usage row. */
  limits(account: { userId: string }): Promise<() => void>;
  /** Routes past the guard and eval gate, and the run over this request; throws AIError('not-available'). */
  prepare(maxCostMicros: number, req: Req): Promise<JobRun<R>>;
  /** Counts for the `<task>.done` log line: never text, never a URL. */
  summary(result: R | undefined): Record<string, number>;
}

/** A job task on this server now, and on a billing server its price and the hold cap's cost ceiling. */
export type JobOffer = { offered: false } | { offered: true; price: JobPrice | null; maxCostMicros: number };

/**
 * Whether the server offers `task` at `now`: not enabled → not offered; `BILLING=off` → offered, no price, the default
 * ceiling; a billing server → offered only with a card in effect for `task` (`jobPriceAt`), the ceiling being the hold
 * cap at our cost (`floor(maxChargeMicros / multiplier)`).
 */
export function jobOffer(
  task: JobTask,
  o: { enabled: boolean; defaultCeilingMicros: number; billing: Config['billing'] },
  schedule: CreditPriceSchedule,
  now: Date = new Date(),
): JobOffer {
  if (!o.enabled) return { offered: false };
  if (o.billing === 'off') return { offered: true, price: null, maxCostMicros: o.defaultCeilingMicros };
  const price = jobPriceAt(now, task, schedule);
  const priced = taskPriceAt(now, task, schedule);
  if (price === null || !priced.offered || priced.card.maxChargeMicros === undefined) return { offered: false };
  return { offered: true, price, maxCostMicros: Math.floor(priced.card.maxChargeMicros / priced.card.multiplier) };
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

/** Mounts a job task's endpoints: start, poll and cancel. */
export function mountJobRoutes<Req, R>(app: App, deps: AppDeps & { jobs: JobStore<R> }, spec: JobSpec<Req, R>): void {
  const { config, db, log, billing, jobs } = deps;
  const stopping = deps.stopping;
  const { task } = spec;
  const failure = (code: WireError['code']): WireError => ({ code, message: describeError(code, config.instanceName) });
  const answer = (view: JobView<R>) => ({ v: 1 as const, ...view });

  /** A request refused after the cheap gates: one `refused-before-call` row, as classify meters its refusals. */
  const recordRefused = (rid: string, userId: string, deviceId: string, served: JobRun<R> | undefined) =>
    recordUsageEvent(
      db.db,
      {
        requestId: rid,
        userId,
        deviceId,
        routeId: served?.routeId ?? null,
        task,
        model: served?.model ?? spec.refusedModel,
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
      path: spec.paths.start,
      middleware: [requireDevice(deps)] as const,
      request: { body: { content: json(spec.request), required: true } },
      responses: {
        202: { description: spec.texts.start, content: json(spec.view) },
        400: errorResponse(spec.texts.refused400),
        401: errorResponse('No valid device token'),
        402: errorResponse('The balance is empty'),
        429: errorResponse(spec.texts.refused429),
        500: errorResponse('The server failed'),
        503: errorResponse(spec.texts.unavailable503),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const rid = c.get('rid');
      const { userId, deviceId } = c.get('account');
      // Unknown fields (a prompt, a model) were stripped by the schema.
      const req = c.req.valid('json') as Req;

      const offer = spec.offer();
      if (!offer.offered) throw new AIError('not-available', spec.texts.notOffered);
      // Nothing is metered for a request the task refuses outright (F18: only a public post).
      spec.admit(req);

      let releaseLimits: (() => void) | undefined;
      let prepared: JobRun<R> | undefined;
      try {
        releaseLimits = await spec.limits({ userId });
        prepared = await spec.prepare(offer.maxCostMicros, req);
      } catch (err) {
        await recordRefused(rid, userId, deviceId, prepared);
        releaseLimits?.();
        throw err;
      }
      const served = prepared;
      const release = releaseLimits;

      // Checked in the same tick as `jobs.start`: a stopping server aborted its jobs when the stop began, so a job
      // started after that would never be aborted, would outlive the drain and leave its hold open as the database closes.
      if (stopping?.aborted) {
        await recordRefused(rid, userId, deviceId, served);
        release();
        throw new AIError('overloaded', 'The server is stopping.');
      }
      const job = jobs.start(userId);
      if (!job.ok) {
        await recordRefused(rid, userId, deviceId, served);
        release();
        if (job.reason === 'busy-user') throw new AIError('rate-limit', spec.texts.busyUser);
        throw new AIError('overloaded', spec.texts.busyServer);
      }
      const jobId = job.id;
      const startedAt = performance.now();

      const spend: Spend = { calls: 0, failedCalls: 0, usage: ZERO_USAGE, okUsage: ZERO_USAGE, cost: 0, okCost: 0 };
      const onUsage: OnUsage = ({ model, usage, failed }) => {
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

      // Resolved once billing let the job through: from then on it runs in the background.
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => (markStarted = resolve));
      const call = () => {
        markStarted();
        return served.run(job.signal, onUsage);
      };
      // A failed or cancelled job never settles: `runWithBilling` releases its hold.
      const toSettle = (): SettleRequest => ({
        userId,
        requestId: jobId,
        task,
        model: served.model,
        chargeableUsage: spend.okUsage,
        costMicros: spend.okCost,
        posts: 1,
      });
      const run = runWithBilling(billing, { userId, deviceId, task, requestId: jobId }, call, toSettle, log);

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
        let end: JobEnd<R> = { status: 'failed', error: failure('unknown') };
        let result: R | undefined;
        try {
          const { result: done, billing: settled } = await run;
          result = done;
          end = { status: 'done', result: done, ...(settled ? { billing: settled } : {}) };
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
                routeId: served.routeId,
                task,
                model: served.model,
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
            // Only now: from here on the row counts the job.
            release();
            log.info(`${task}.done`, {
              rid: jobId,
              outcome: end.status,
              // Nobody polled it for `abandonAfterMs`: cancelled by the store, never charged (P3-52).
              ...(job.signal.reason instanceof JobAbandoned ? { abandoned: true } : {}),
              ...spec.summary(result),
              cost_micros: spend.cost,
              ms: Math.round(performance.now() - startedAt),
            });
          } finally {
            // Last: a job counts as running until here, so a stopping server's drain waits for the row and the release.
            jobs.finish(jobId, end);
          }
        }
      };
      void finishJob().catch((err: unknown) => log.error(`${task}.finish_failed`, { rid: jobId, ...errorFields(err) }));

      return c.json(answer({ id: jobId, status: 'running' }), 202);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: spec.paths.job('{id}'),
      middleware: [requireDevice(deps)] as const,
      request: { params: JobParamsSchema, query: PollQuerySchema },
      responses: {
        200: { description: "The job's state, and its result once done", content: json(spec.view) },
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
      path: spec.paths.cancel('{id}'),
      middleware: [requireDevice(deps)] as const,
      request: { params: JobParamsSchema },
      responses: {
        202: {
          description: 'Cancelling: the job ends as cancelled unless it has already ended',
          content: json(spec.view),
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
