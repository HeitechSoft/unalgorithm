/**
 * On-demand jobs (a fact-check now, perspectives in RM3) live only in this process's memory: a result carries claims
 * derived from a post, and post content is never stored (decision 3). Nothing here touches Postgres, graphile-worker or
 * the log; a restart loses every job. An ended job is forgotten after `ttlMs`, by an `unref()`ed timer even when no
 * further call comes, so the "at most 10 minutes" the privacy docs promise holds on a quiet server.
 */
import type { ClassifyResponse, FactcheckJob, WireError } from '@unalgorithm/protocol';

export type JobStatus = FactcheckJob['status'];
export type Settlement = NonNullable<ClassifyResponse['billing']>;
export type JobEnd<R> =
  | { status: 'done'; result: R; billing?: Settlement }
  | { status: 'failed'; error: WireError }
  | { status: 'cancelled' };
export interface JobView<R> {
  id: string;
  status: JobStatus;
  result?: R;
  error?: WireError;
  billing?: Settlement;
}
export interface JobStoreOptions {
  ttlMs: number;
  maxRunning: number;
  maxKeptPerUser: number;
  now?: () => number;
}
export interface JobStore<R> {
  /** A new running job, or why not: one running job per user ('busy-user'), maxRunning server-wide ('busy-server'). */
  start(userId: string): { ok: true; id: string; signal: AbortSignal } | { ok: false; reason: 'busy-user' | 'busy-server' };
  /** Ends a running job; a no-op for an unknown or already-ended one. */
  finish(id: string, end: JobEnd<R>): void;
  /** Forgets a job that never started work (its check was refused). */
  discard(id: string): void;
  /** The owner's view, or undefined (unknown, another user's, or expired). */
  view(id: string, userId: string): JobView<R> | undefined;
  /** The view once the job ends, or after `ms`, or when `signal` aborts, whichever is first. */
  waitFor(id: string, userId: string, ms: number, signal?: AbortSignal): Promise<JobView<R> | undefined>;
  /** Aborts a running job's signal (reason: a `JobCancelled` error); true when the owner's job was running. */
  cancel(id: string, userId: string): boolean;
  /** Aborts every running job with `reason` (the server is stopping). */
  abortAll(reason: unknown): void;
  /**
   * Resolves when no job is running, or after `ms`. A job counts as running until `finish`, so a caller that must
   * write after the run (usage row, releases) calls `finish` last (P3-19), and a stopping server's drain covers it.
   */
  drain(ms: number): Promise<void>;
  readonly running: number;
  /** Jobs held, running and ended (tests: expiry). */
  readonly size: number;
}

/** The reason a cancelled job's signal carries. */
export class JobCancelled extends Error {
  constructor() {
    super('The job was cancelled.');
    this.name = 'JobCancelled';
  }
}

interface Job<R> {
  id: string;
  userId: string;
  controller: AbortController;
  /** Set once the job ends. */
  end?: JobEnd<R>;
  endedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export function createJobStore<R>(opts: JobStoreOptions): JobStore<R> {
  const now = opts.now ?? Date.now;
  const jobs = new Map<string, Job<R>>();
  /** Called whenever a job ends or is forgotten: waiters re-check. */
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const forget = (job: Job<R>) => {
    if (job.timer) clearTimeout(job.timer);
    jobs.delete(job.id);
  };
  const prune = () => {
    const t = now();
    for (const job of jobs.values()) if (job.endedAt !== undefined && t - job.endedAt >= opts.ttlMs) forget(job);
  };
  const runningCount = () => {
    let n = 0;
    for (const job of jobs.values()) if (!job.end) n++;
    return n;
  };
  const owned = (id: string, userId: string) => {
    const job = jobs.get(id);
    return job && job.userId === userId ? job : undefined;
  };
  const toView = (job: Job<R>): JobView<R> => {
    const end = job.end;
    if (!end) return { id: job.id, status: 'running' };
    if (end.status === 'done') {
      return { id: job.id, status: 'done', result: end.result, ...(end.billing ? { billing: end.billing } : {}) };
    }
    if (end.status === 'failed') return { id: job.id, status: 'failed', error: end.error };
    return { id: job.id, status: 'cancelled' };
  };

  return {
    start(userId) {
      prune();
      let running = 0;
      for (const job of jobs.values()) {
        if (job.end) continue;
        if (job.userId === userId) return { ok: false, reason: 'busy-user' };
        running++;
      }
      if (running >= opts.maxRunning) return { ok: false, reason: 'busy-server' };
      const job: Job<R> = { id: crypto.randomUUID(), userId, controller: new AbortController() };
      jobs.set(job.id, job);
      return { ok: true, id: job.id, signal: job.controller.signal };
    },

    finish(id, end) {
      const job = jobs.get(id);
      if (!job || job.end) return;
      job.end = end;
      job.endedAt = now();
      job.timer = setTimeout(() => jobs.delete(id), opts.ttlMs);
      job.timer.unref?.();
      const ended = [...jobs.values()].filter((j) => j.userId === job.userId && j.endedAt !== undefined);
      ended.sort((a, b) => (a.endedAt as number) - (b.endedAt as number));
      for (const old of ended.slice(0, Math.max(0, ended.length - opts.maxKeptPerUser))) forget(old);
      notify();
    },

    discard(id) {
      const job = jobs.get(id);
      if (!job) return;
      forget(job);
      notify();
    },

    view(id, userId) {
      prune();
      const job = owned(id, userId);
      return job ? toView(job) : undefined;
    },

    waitFor(id, userId, ms, signal) {
      prune();
      const job = owned(id, userId);
      if (!job) return Promise.resolve(undefined);
      if (job.end || signal?.aborted) return Promise.resolve(toView(job));
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(check);
          signal?.removeEventListener('abort', done);
          const current = owned(id, userId);
          resolve(current ? toView(current) : undefined);
        };
        const check = () => {
          const current = jobs.get(id);
          if (!current || current.end) done();
        };
        const timer = setTimeout(done, ms);
        listeners.add(check);
        signal?.addEventListener('abort', done, { once: true });
      });
    },

    cancel(id, userId) {
      const job = owned(id, userId);
      if (!job || job.end) return false;
      job.controller.abort(new JobCancelled());
      return true;
    },

    abortAll(reason) {
      for (const job of jobs.values()) if (!job.end) job.controller.abort(reason);
    },

    drain(ms) {
      if (runningCount() === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        };
        const check = () => {
          if (runningCount() === 0) done();
        };
        const timer = setTimeout(done, ms);
        listeners.add(check);
      });
    },

    get running() {
      return runningCount();
    },
    get size() {
      return jobs.size;
    },
  };
}
