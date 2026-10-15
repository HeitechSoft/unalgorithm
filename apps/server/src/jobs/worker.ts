/**
 * Background jobs, run by graphile-worker inside the server process (R7: at first). Modules register named tasks and
 * cron schedules on a registry while the server starts; `startJobs` then runs them on the server's own Postgres pool.
 * With no task registered nothing starts (the server registers its own, `auth.purge-expired`). graphile-worker creates
 * and migrates its `graphile_worker` schema itself when it starts.
 *
 * A job's payload holds ids and numbers only. Log lines name the task and the job, never graphile-worker's messages or
 * an error's message, and a failed job hands graphile-worker an error without the original message, since
 * graphile-worker keeps the message of the last failure in its jobs table.
 */
import {
  type LogFunctionFactory,
  type ParsedCronItem,
  parseCronItems,
  run,
  type Task,
  type TaskList,
  Logger as WorkerLogger,
} from 'graphile-worker';
import type { DbHandle } from '../db/client.ts';
import { type ErrorFields, errorFields, type Logger } from '../log.ts';

/** A job's payload holds ids and numbers only, never post content or an email address. */
export type JobHandler = (payload: unknown, ctx: { signal: AbortSignal; log: Logger }) => Promise<void>;

export interface JobRegistry {
  /** Registers a task. Names are lowercase dotted (`billing.expire-lots`): /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/. */
  task(name: string, handler: JobHandler): void;
  /** Runs a registered task on a 5-field cron schedule, in UTC. No backfill of missed runs. */
  cron(task: string, match: string): void;
}

export interface RunningJobs {
  /** Stops taking jobs and waits for running ones (graphile-worker's graceful shutdown). Safe to call twice. */
  stop(): Promise<void>;
  /** Queues one job now; tests only in CL2 (no public one-off job API until a feature needs one). */
  addJob(task: string, payload: Record<string, string | number | boolean | null>): Promise<void>;
}

const TASK_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

interface Registered {
  handlers: Map<string, JobHandler>;
  /** One schedule per task: graphile-worker tells cron items apart by their identifier, which is the task. */
  schedules: Map<string, ParsedCronItem[]>;
  /** Set by `startJobs`: the registry takes no more tasks or schedules, and starts once. */
  started: boolean;
}

/** What each registry holds, out of reach of the modules that register on it. */
const registries = new WeakMap<JobRegistry, Registered>();

export function createJobRegistry(): JobRegistry {
  const state: Registered = { handlers: new Map(), schedules: new Map(), started: false };
  const assertOpen = () => {
    if (state.started) throw new Error('Jobs have started: the registry takes no more tasks or schedules.');
  };
  const registry: JobRegistry = {
    task(name, handler) {
      assertOpen();
      if (!TASK_NAME.test(name)) throw new TypeError(`A task name is lowercase and dotted, like billing.expire-lots: '${name}'.`);
      if (state.handlers.has(name)) throw new TypeError(`The task ${name} is already registered.`);
      state.handlers.set(name, handler);
    },
    cron(task, match) {
      assertOpen();
      if (!state.handlers.has(task)) throw new TypeError(`The task ${task} is not registered.`);
      if (state.schedules.has(task)) throw new TypeError(`The task ${task} already has a schedule.`);
      // Parsed now, so a bad schedule fails here rather than when the server starts.
      state.schedules.set(task, parseCronItems([{ task, match, identifier: task, options: { backfillPeriod: 0 } }]));
    },
  };
  registries.set(registry, state);
  return registry;
}

const NO_JOBS: RunningJobs = { stop: async () => {}, addJob: async () => {} };

/**
 * Starts the registered tasks and schedules on the server's own pool (no second connection string): one job at a
 * time, and no signal handlers, since `index.ts` owns SIGTERM and SIGINT. The registry is frozen from here on.
 */
export async function startJobs(db: DbHandle, registry: JobRegistry, log: Logger): Promise<RunningJobs> {
  const state = registries.get(registry);
  if (!state) throw new TypeError('startJobs takes a registry made by createJobRegistry.');
  if (state.started) throw new Error('This job registry has already started.');
  state.started = true;

  if (state.handlers.size === 0) return NO_JOBS;
  if (db.kind === 'pglite') {
    // PGlite has no LISTEN/NOTIFY across connections. Tests call handlers directly.
    log.warn('jobs.disabled', { reason: 'pglite' });
    return NO_JOBS;
  }

  const taskList: TaskList = {};
  for (const [task, handler] of state.handlers) taskList[task] = wrapHandler(task, handler, log);
  const parsedCronItems = [...state.schedules.values()].flat();
  const runner = await run({
    pgPool: db.pool,
    taskList,
    // Always an array: without one, graphile-worker reads a crontab file from the working directory.
    parsedCronItems,
    concurrency: 1,
    noHandleSignals: true,
    logger: new WorkerLogger(logFactory(log)),
  });
  log.info('jobs.started', { tasks: state.handlers.size, schedules: parsedCronItems.length });

  let stopping: Promise<void> | undefined;
  // Settles once the runner has stopped, asked to or not. A runner that stops by itself (its worker failing to release
  // a job, say) runs no more jobs until the server restarts.
  const stopped = runner.promise.then(
    () => {
      if (!stopping) log.error('jobs.stopped_unexpectedly');
    },
    (err: unknown) => log.error('jobs.stopped_unexpectedly', errorFields(err)),
  );
  return {
    stop: () =>
      (stopping ??= runner.stop().then(
        () => stopped,
        // Rejects when the runner had already stopped by itself, or failed to release its connections.
        (err: unknown) => {
          log.warn('jobs.stop_failed', errorFields(err));
          return stopped;
        },
      )),
    addJob: async (task, payload) => {
      await runner.addJob(task, payload);
    },
  };
}

/** What graphile-worker gets for a failed job: the error's name and code, not its message. */
class JobFailedError extends Error {
  override name = 'JobFailedError';
}

function failure({ err_name, err_code }: ErrorFields): JobFailedError {
  return new JobFailedError(err_code === undefined ? err_name : `${err_name} ${err_code}`);
}

/** Logs how each run of a task ended. A throw is passed on, so graphile-worker retries the job. */
function wrapHandler(task: string, handler: JobHandler, log: Logger): Task {
  const taskLog = log.child({ task });
  return async (payload, helpers) => {
    const started = performance.now();
    const job_id = helpers.job.id;
    try {
      await handler(payload, { signal: helpers.abortSignal, log: taskLog });
    } catch (err) {
      const fields = errorFields(err);
      taskLog.error('jobs.task.failed', { job_id, ...fields });
      throw failure(fields);
    }
    taskLog.info('jobs.task.done', { job_id, ms: Math.round(performance.now() - started) });
  };
}

/** graphile-worker's own lines, as `jobs.log` with the task and job they concern: never its message, which is free text. */
function logFactory(log: Logger): LogFunctionFactory {
  return (scope) => (level, _message, meta) => {
    const error = meta?.error;
    log[level === 'warning' ? 'warn' : level]('jobs.log', {
      task: scope.taskIdentifier,
      job_id: scope.jobId,
      ...(error ? errorFields(error) : {}),
    });
  };
}
