import { codeForStatus, describeError } from '@unalgorithm/ai';
import {
  type AIErrorCode,
  FACTCHECK_JOBS_PATH,
  FACTCHECK_POLL_WAIT_MS,
  type FactcheckJob,
  FactcheckJobSchema,
  type FactcheckResult,
  factcheckJobCancelPath,
  factcheckJobPath,
  PERSPECTIVES_JOBS_PATH,
  type PerspectivesJobRequest,
  PerspectivesJobSchema,
  type PerspectivesResult,
  type PostForAI,
  perspectivesJobCancelPath,
  perspectivesJobPath,
  ServerErrorSchema,
} from '@unalgorithm/protocol';
import type { z } from 'zod';
import type { BgError } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import type { ServerAccount } from './server-auth.ts';
import { noteRefused, noteSettlement } from './server-balance.ts';
import { type ServerHttpDeps, type ServerResult, serverRequest } from './server-http.ts';

/**
 * Server jobs on the person's UnAlgorithm server (P3-21, generic over the task since P3-37): start a job with the
 * device's token, long-poll it until it ends, and cancel it when the tab closes or the deadline passes. Errors carry the
 * extension's own words for the server's error code, never the server's text.
 */

/**
 * Counted from before the start POST: > the server's 240 s pipeline deadline (plus hold, settle and row), and with the
 * final cancel still < an MV3 service worker's 5-minute limit for the content script's message. Serves every task.
 */
export const FACTCHECK_SERVER_DEADLINE_MS = 280_000;
const START_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = FACTCHECK_POLL_WAIT_MS + 10_000;
const CANCEL_TIMEOUT_MS = 5_000;

type Note = { settlement: typeof noteSettlement; refused: typeof noteRefused };
type RunOpts = { signal: AbortSignal; http?: Partial<ServerHttpDeps>; note?: Note };
type JobTaskId = 'factcheck' | 'perspectives';
/** A job's view as the server returns it, whatever the task (`jobSchemaFor`). */
type ServerJobView<R> = Omit<FactcheckJob, 'result'> & { result?: R };

/** What the generic client needs to know about one server task. */
export interface ServerJobTask<R> {
  paths: { start: string; job(id: string): string; cancel(id: string): string };
  /** The job view's schema for this task. */
  schema: z.ZodType<ServerJobView<R>>;
  /** The word the fixed texts use: "This {noun} was stopped." */
  noun: 'check' | 'comparison';
  message(code: AIErrorCode, title: string): string;
}
export type ServerJobResult<R> = { ok: true; result: R } | { ok: false; error: BgError };
export type ServerFactcheckResult = ServerJobResult<FactcheckResult>;
export type ServerPerspectivesResult = ServerJobResult<PerspectivesResult>;

export const FACTCHECK_TASK: ServerJobTask<FactcheckResult> = {
  paths: { start: FACTCHECK_JOBS_PATH, job: factcheckJobPath, cancel: factcheckJobCancelPath },
  schema: FactcheckJobSchema,
  noun: 'check',
  message: (code, title) => jobServerMessage('factcheck', code, title),
};

export const PERSPECTIVES_TASK: ServerJobTask<PerspectivesResult> = {
  paths: { start: PERSPECTIVES_JOBS_PATH, job: perspectivesJobPath, cancel: perspectivesJobCancelPath },
  schema: PerspectivesJobSchema,
  noun: 'comparison',
  message: (code, title) => jobServerMessage('perspectives', code, title),
};

export function runFactcheckViaServer(account: ServerAccount, post: PostForAI, opts: RunOpts): Promise<ServerFactcheckResult> {
  return runJobViaServer(account, FACTCHECK_TASK, { v: 1, post }, opts);
}

/**
 * Other perspectives on the server: only the shared link (URL and link-card title), the platform and, on Facebook, the
 * audience leave the browser. The body is built field by field, `link` too, so nothing else on the caller's objects
 * (post text included) can ride along.
 */
export function runPerspectivesViaServer(
  account: ServerAccount,
  req: Omit<PerspectivesJobRequest, 'v'>,
  opts: RunOpts,
): Promise<ServerPerspectivesResult> {
  const body: PerspectivesJobRequest = {
    v: 1,
    link: { url: req.link.url, ...(req.link.title !== undefined ? { title: req.link.title } : {}) },
    platform: req.platform,
    ...(req.audience ? { audience: req.audience } : {}),
  };
  return runJobViaServer(account, PERSPECTIVES_TASK, body, opts);
}

export async function runJobViaServer<R>(
  account: ServerAccount,
  task: ServerJobTask<R>,
  body: unknown,
  opts: RunOpts,
): Promise<ServerJobResult<R>> {
  const { origin, deviceId } = account;
  const { signal } = opts;
  const http = opts.http ?? {};
  const note = opts.note ?? { settlement: noteSettlement, refused: noteRefused };
  const { title } = serverLabel(origin);
  const deadline = Date.now() + FACTCHECK_SERVER_DEADLINE_MS;

  const fail = (code: AIErrorCode, message: string): ServerJobResult<R> => ({ ok: false, error: { code, message } });
  const STOPPED = () => fail('timeout', `This ${task.noun} was stopped.`);
  const TOO_LONG = () => fail('timeout', `This ${task.noun} took too long, so it was stopped. Try again.`);
  const LOST = () => fail('unknown', `The server lost this ${task.noun} (it may have restarted). Try again.`);
  const parseJob = (raw: unknown): ServerJobView<R> | undefined => {
    const parsed = task.schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };

  /** A refusal in the task's words; a 402 also records the empty balance. */
  const refusal = async (code: AIErrorCode): Promise<ServerJobResult<R>> => {
    if (code === 'insufficient-credits') await note.refused(origin, deviceId).catch(() => undefined);
    return fail(code, task.message(code, title));
  };
  /** A request that didn't come back 2xx. */
  const failure = (r: Exclude<ServerResult, { ok: true }>): Promise<ServerJobResult<R>> => {
    if ('reason' in r) {
      if (r.reason === 'aborted') return Promise.resolve(STOPPED());
      if (r.reason === 'auth') return Promise.resolve(fail('auth-required', describeError('auth-required', title)));
      return Promise.resolve(fail('network', describeError('network')));
    }
    const wire = ServerErrorSchema.safeParse(r.body);
    return refusal(wire.success ? wire.data.code : codeForStatus(r.status, '', new URL(origin).hostname));
  };

  if (signal.aborted) return STOPPED();
  // Not cut off by the run's `signal`: once sent, the server may already hold the job, and an aborted fetch would lose
  // its id, the only way to cancel it. A tab closed meanwhile is seen below, and the job cancelled.
  const started = await serverRequest(origin, task.paths.start, { method: 'POST', body, timeoutMs: START_TIMEOUT_MS }, http);
  if (!started.ok) return failure(started);
  let job = parseJob(started.body);
  if (!job) return fail('unknown', describeError('unknown'));
  const id = job.id;

  // Until a status other than `running` is seen, the job may still hold credit on the server: every way out cancels it.
  let ended = false;
  try {
    while (job.status === 'running') {
      const left = deadline - Date.now();
      if (signal.aborted) return STOPPED();
      if (left <= 0) return TOO_LONG();
      const polled = await serverRequest(
        origin,
        task.paths.job(id),
        { query: { wait: '1' }, timeoutMs: Math.min(POLL_TIMEOUT_MS, left), signal },
        http,
      );
      if (!polled.ok) {
        if (polled.status === 404) {
          ended = true; // Nothing left on the server to cancel.
          return LOST();
        }
        // A poll cut off by the deadline is the deadline, not the network.
        if ('reason' in polled && polled.reason === 'network' && Date.now() >= deadline) return TOO_LONG();
        return failure(polled);
      }
      job = parseJob(polled.body);
      if (job?.id !== id) return fail('unknown', describeError('unknown'));
    }
    ended = true;

    if (job.billing) await note.settlement(origin, deviceId, job.billing).catch(() => undefined);
    if (job.status === 'done' && job.result) return { ok: true, result: job.result };
    if (job.status === 'failed' && job.error) return refusal(job.error.code);
    return STOPPED();
  } finally {
    // Sent without the run's `signal`: after a tab close it is already aborted, and the request would never leave.
    if (!ended) await serverRequest(origin, task.paths.cancel(id), { method: 'POST', timeoutMs: CANCEL_TIMEOUT_MS }, http);
  }
}

/** The fact-check words for a server's error code (RM2's texts). */
export function factcheckServerMessage(code: AIErrorCode, title: string): string {
  return jobServerMessage('factcheck', code, title);
}

/** A task's words for a server's error code; the server's own text is never shown. Perspectives copy is a draft (D37). */
export function jobServerMessage(task: JobTaskId, code: AIErrorCode, title: string): string {
  const fc = task === 'factcheck';
  switch (code) {
    case 'cap-reached':
      return fc
        ? "You've reached today's fact-check limit on this server."
        : "You've reached today's limit for checks and comparisons on this server.";
    case 'rate-limit':
      return fc
        ? 'A check is already running. Try again in a minute.'
        : 'A check or comparison is already running. Try again in a minute.';
    case 'truncated':
      // The server's cost ceiling and a model answer cut off at its token limit share this code (P3-11).
      return `This ${fc ? 'check' : 'comparison'} stopped before it finished, so nothing was charged.`;
    case 'not-available':
      return fc ? "This server doesn't offer fact-check right now." : "This server doesn't offer Other perspectives right now.";
    default:
      return describeError(code, title);
  }
}
