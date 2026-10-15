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
  type PostForAI,
  ServerErrorSchema,
} from '@unalgorithm/protocol';
import type { BgError } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import type { ServerAccount } from './server-auth.ts';
import { noteRefused, noteSettlement } from './server-balance.ts';
import { type ServerHttpDeps, type ServerResult, serverRequest } from './server-http.ts';

/**
 * Fact-check on the person's UnAlgorithm server (P3-21): start a job with the device's token, long-poll it until it
 * ends, and cancel it when the tab closes or the deadline passes. Errors carry the extension's own fact-check words for
 * the server's error code, never the server's text.
 */

/**
 * Counted from before the start POST: > the server's 240 s pipeline deadline (plus hold, settle and row), and with the
 * final cancel still < an MV3 service worker's 5-minute limit for the content script's message.
 */
export const FACTCHECK_SERVER_DEADLINE_MS = 280_000;
const START_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = FACTCHECK_POLL_WAIT_MS + 10_000;
const CANCEL_TIMEOUT_MS = 5_000;

type Note = { settlement: typeof noteSettlement; refused: typeof noteRefused };
export type ServerFactcheckResult = { ok: true; result: FactcheckResult } | { ok: false; error: BgError };

const fail = (code: AIErrorCode, message: string): ServerFactcheckResult => ({ ok: false, error: { code, message } });
const STOPPED = (): ServerFactcheckResult => fail('timeout', 'This check was stopped.');
const TOO_LONG = (): ServerFactcheckResult => fail('timeout', 'This check took too long, so it was stopped. Try again.');
const LOST = (): ServerFactcheckResult => fail('unknown', 'The server lost this check (it may have restarted). Try again.');

export async function runFactcheckViaServer(
  account: ServerAccount,
  post: PostForAI,
  opts: { signal: AbortSignal; http?: Partial<ServerHttpDeps>; note?: Note },
): Promise<ServerFactcheckResult> {
  const { origin, deviceId } = account;
  const { signal } = opts;
  const http = opts.http ?? {};
  const note = opts.note ?? { settlement: noteSettlement, refused: noteRefused };
  const { title } = serverLabel(origin);
  const deadline = Date.now() + FACTCHECK_SERVER_DEADLINE_MS;

  /** A refusal in fact-check words; a 402 also records the empty balance. */
  const refusal = async (code: AIErrorCode): Promise<ServerFactcheckResult> => {
    if (code === 'insufficient-credits') await note.refused(origin, deviceId).catch(() => undefined);
    return fail(code, factcheckServerMessage(code, title));
  };
  /** A request that didn't come back 2xx. */
  const failure = (r: Exclude<ServerResult, { ok: true }>): Promise<ServerFactcheckResult> => {
    if ('reason' in r) {
      if (r.reason === 'aborted') return Promise.resolve(STOPPED());
      if (r.reason === 'auth') return Promise.resolve(fail('auth-required', describeError('auth-required', title)));
      return Promise.resolve(fail('network', describeError('network')));
    }
    const wire = ServerErrorSchema.safeParse(r.body);
    return refusal(wire.success ? wire.data.code : codeForStatus(r.status, '', new URL(origin).hostname));
  };

  if (signal.aborted) return STOPPED();
  const started = await serverRequest(
    origin,
    FACTCHECK_JOBS_PATH,
    { method: 'POST', body: { v: 1, post }, timeoutMs: START_TIMEOUT_MS, signal },
    http,
  );
  if (!started.ok) return failure(started);
  let job: FactcheckJob | undefined = parseJob(started.body);
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
        factcheckJobPath(id),
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
    if (!ended) await serverRequest(origin, factcheckJobCancelPath(id), { method: 'POST', timeoutMs: CANCEL_TIMEOUT_MS }, http);
  }
}

function parseJob(body: unknown): FactcheckJob | undefined {
  const job = FactcheckJobSchema.safeParse(body);
  return job.success ? job.data : undefined;
}

/** The fact-check words for a server's error code; the server's own text is never shown. */
export function factcheckServerMessage(code: AIErrorCode, title: string): string {
  switch (code) {
    case 'cap-reached':
      return "You've reached today's fact-check limit on this server.";
    case 'rate-limit':
      return 'A check is already running. Try again in a minute.';
    case 'truncated':
      // The server's cost ceiling and a model answer cut off at its token limit share this code (P3-11).
      return 'This check stopped before it finished, so nothing was charged.';
    case 'not-available':
      return "This server doesn't offer fact-check right now.";
    default:
      return describeError(code, title);
  }
}
