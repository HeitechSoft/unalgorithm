/**
 * The AI gateway: `POST /v1/classify` (R19, R21, R22, R23). A signed-in device sends up to 12 posts and its interest
 * profile; the server builds the prompts itself with the `packages/core` builders the extension uses and calls its
 * route's model through `packages/ai`. There is no prompt field, so the server cannot be used as an open model proxy.
 * Facebook posts that are not public never reach a model. A request with posts to send passes the limits first (rate,
 * spend breaker, daily cap; R24). Every request that reaches the handler goes through the billing seam (a failed call is
 * never charged) and leaves exactly one usage row, written in `finally`.
 *
 * Nothing about a request body is logged or kept: not the text, the profile, the refs or the locale. Neither is a
 * provider's error message, which can echo prompt text: a device gets `describeError` text for a code, never the
 * provider's own words.
 */
import { createRoute } from '@hono/zod-openapi';
import { AIError, type ClassifyOutcome, classifyPosts, describeError, POST_ERROR_CODES } from '@unalgorithm/ai';
import { PROMPT_VERSION } from '@unalgorithm/core';
import {
  type AIErrorCode,
  CLASSIFY_PATH,
  ClassifyRequestSchema,
  type ClassifyResponse,
  ClassifyResponseSchema,
  costMicros,
  type PostClassificationResult,
  type PostForAI,
  serverMayReceive,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { checkLimits, createRateLimiter, type LimitDeps } from '../ai/limits.ts';
import { recordUsageEvent, type UsageOutcome } from '../ai/metering.ts';
import { type AiRoute, resolveRoute } from '../ai/routes.ts';
import { requireDevice } from '../auth/bearer.ts';
import { runWithBilling, type SettleInput } from '../billing/provider.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json } from './openapi.ts';

/**
 * The deadline of a whole request: under the extension's own request timeout and the proxy's 60 s read timeout, so a
 * provider retry or the sequential calls of a refusal split cannot keep a request running for a minute.
 */
export const CLASSIFY_DEADLINE_MS = 25_000;
/** The limit of each model call, inside the deadline. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * The code a device sees for a provider's error code. The provider is the server's, not the person's: whatever the
 * operator must fix (a key, a model, a blocked endpoint) is `not-available`, never "your key" and never the extension's
 * advice for a person's own setup (such as the Ollama hint for `origin-blocked`, which a self-hosted endpoint on
 * 127.0.0.1 can trigger with a 403). Whatever may pass by itself is `overloaded`. A total record: a new code does not
 * compile until it is mapped here.
 */
const WIRE_CODES: Record<AIErrorCode, AIErrorCode> = {
  auth: 'not-available',
  permission: 'not-available',
  'no-key': 'not-available',
  'model-not-found': 'not-available',
  'no-model': 'not-available',
  unsupported: 'not-available',
  quota: 'not-available',
  'origin-blocked': 'not-available',
  'host-permission': 'not-available',
  'auth-required': 'not-available',
  'not-available': 'not-available',
  'rate-limit': 'overloaded',
  overloaded: 'overloaded',
  network: 'overloaded',
  unknown: 'overloaded',
  timeout: 'timeout',
  'insufficient-credits': 'insufficient-credits',
  'cap-reached': 'cap-reached',
  // About one post only: answered per post, never as the whole request's error.
  refusal: 'refusal',
  truncated: 'truncated',
  'context-overflow': 'context-overflow',
  'bad-request': 'bad-request',
};

export function wireCodeFor(providerCode: AIErrorCode): AIErrorCode {
  return WIRE_CODES[providerCode];
}

/**
 * R23: a Facebook post goes to a model only when its audience is `public`. Friends-only, custom, unknown and missing
 * audiences are all excluded; CL1 has no opt-in to send them.
 */
export function excludeNonPublic(posts: readonly PostForAI[]): { kept: PostForAI[]; excluded: PostForAI[] } {
  const kept: PostForAI[] = [];
  const excluded: PostForAI[] = [];
  for (const p of posts) (serverMayReceive(p) ? kept : excluded).push(p);
  return { kept, excluded };
}

/** A post that gets no classification and no error: excluded, or refused by the model. */
const declined = (p: PostForAI): PostClassificationResult => ({ ref: p.ref, status: 'declined' });

/** The posts a model classified in a run. */
function okCount(outcome: ClassifyOutcome): number {
  let n = 0;
  for (const r of outcome.byRef.values()) if (r.ok) n++;
  return n;
}

/** CL1-13's rules: no call is `refused-before-call`; otherwise by how many of the requested posts succeeded. */
function usageOutcomeOf(outcome: ClassifyOutcome | undefined, postsRequested: number, postsOk: number): UsageOutcome {
  if (!outcome || outcome.calls === 0) return 'refused-before-call';
  if (postsOk === postsRequested) return 'ok';
  return postsOk > 0 ? 'partial' : 'failed';
}

/** Mounts `POST /v1/classify` on the app. */
export function classifyRoutes(app: App, deps: AppDeps): void {
  const { config, db, log, billing, ai } = deps;
  const deadlineMs = deps.classifyDeadlineMs ?? CLASSIFY_DEADLINE_MS;
  // One per app, so the rate buckets and the breaker's log state last as long as the server process.
  const limits: LimitDeps = {
    db: db.db,
    config,
    limiter: createRateLimiter({ perMinute: config.userRequestsPerMinute }),
    log,
  };

  app.openapi(
    createRoute({
      method: 'post',
      path: CLASSIFY_PATH,
      // Before the body is read: a caller without a device learns nothing about its request.
      middleware: [requireDevice(deps)] as const,
      // Required: without it, a body that is not declared JSON would skip validation and reach the handler as `{}`.
      request: { body: { content: json(ClassifyRequestSchema), required: true } },
      responses: {
        200: { description: 'One result per post, in request order', content: json(ClassifyResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No valid device token'),
        402: errorResponse('The balance is empty'),
        429: errorResponse("Too many requests this minute (rate-limit), or today's limit is reached (cap-reached)"),
        500: errorResponse('The server failed'),
        503: errorResponse('The AI provider is busy, or no AI route is available'),
        504: errorResponse('The AI provider took too long'),
      },
    }),
    async (c) => {
      const started = performance.now();
      c.header('Cache-Control', 'no-store');
      const rid = c.get('rid');
      const { userId, deviceId } = c.get('account');
      // Unknown fields (a prompt, a system message, a model, an author's name) were stripped by the schema.
      const { posts, profile } = c.req.valid('json');
      const { kept, excluded } = excludeNonPublic(posts);
      // Read in `finally`, so the usage row reflects how far the request got.
      let route: AiRoute | undefined;
      let outcome: ClassifyOutcome | undefined;
      // Set once the limits let the request through: its posts count toward the daily cap until its row is written.
      let releaseLimits: (() => void) | undefined;

      try {
        if (kept.length === 0) {
          const source = { kind: 'server', model: config.ai.model, promptVersion: PROMPT_VERSION };
          const body: ClassifyResponse = { v: 1, results: posts.map(declined), source };
          return c.json(body, 200);
        }

        // R24, once there is something to send: the rate limit, the spend breaker and the daily cap. A refusal is
        // metered below as `refused-before-call`.
        releaseLimits = await checkLimits(limits, { userId }, kept.length);

        const served = await resolveRoute(db.db, 'classify', config.routeEvalMinAgreement, log);
        route = served;

        // Short ids keep the prompt small, as the extension's own batches do; the client's refs never reach a model.
        const shortId = (i: number) => `p${i + 1}`;
        const shortIds = new Map(kept.map((p, i) => [p, shortId(i)]));
        const remapped = kept.map((p, i) => ({ ...p, ref: shortId(i) }));

        // One deadline for the whole request; a client that disconnects stops the calls too, so nobody pays for an
        // answer that no one reads.
        const deadline = AbortSignal.timeout(deadlineMs);
        const call = async () =>
          (outcome = await classifyPosts(ai.clientFor(served), remapped, {
            model: served.model,
            profile,
            timeoutMs: CALL_TIMEOUT_MS,
            signal: AbortSignal.any([c.req.raw.signal, deadline]),
          }));
        // Nothing to charge when no post succeeded: billing releases the request instead.
        const toSettle = (o: ClassifyOutcome): SettleInput | null => {
          const ok = okCount(o);
          if (ok === 0) return null;
          return {
            userId,
            requestId: rid,
            task: 'classify',
            model: served.model,
            chargeableUsage: o.okUsage,
            costMicros: costMicros(served.model, o.okUsage) ?? null,
            posts: ok,
          };
        };
        const { result, billing: settled } = await runWithBilling(
          billing,
          { userId, deviceId, task: 'classify', requestId: rid },
          call,
          toSettle,
          log,
        );

        const errors: AIError[] = [];
        const results = posts.map((p): PostClassificationResult => {
          const id = shortIds.get(p);
          if (id === undefined) return declined(p);
          const r = result.byRef.get(id);
          if (r?.ok) return { ref: p.ref, status: 'ok', classification: r.classification };
          const error = r?.error ?? new AIError('unknown', 'No answer for this post.');
          errors.push(error);
          if (error.code === 'refusal') return declined(p);
          return { ref: p.ref, status: 'error', message: describeError(wireCodeFor(error.code), config.instanceName) };
        });

        // No post succeeded: when the cause is the provider, not the posts, the whole request fails so the extension
        // pauses or retries. The error carries `describeError` text only: no provider message and no cause, which the
        // error log would otherwise reach.
        if (okCount(result) === 0) {
          if (deadline.aborted) throw new AIError('timeout', describeError('timeout', config.instanceName));
          const code = errors[0]?.code;
          if (code !== undefined && !POST_ERROR_CODES.has(code) && errors.every((e) => e.code === code)) {
            log.warn('classify.provider_error', { rid, provider_code: code });
            const wire = wireCodeFor(code);
            const retryAfterMs = errors[0]?.retryAfterMs;
            throw new AIError(wire, describeError(wire, config.instanceName), retryAfterMs ? { retryAfterMs } : {});
          }
        }

        const body: ClassifyResponse = {
          v: 1,
          results,
          source: { kind: 'server', model: served.model, promptVersion: PROMPT_VERSION },
          // Only a billing provider that charges answers with a balance; a self-hosted server shows none.
          ...(settled ? { billing: settled } : {}),
        };
        return c.json(body, 200);
      } finally {
        // The route's model, never the one a provider echoes: a dated id has no price card and would hide the spend.
        const model = route?.model ?? config.ai.model;
        const postsOk = outcome ? okCount(outcome) : 0;
        const usageOutcome = usageOutcomeOf(outcome, posts.length, postsOk);
        await recordUsageEvent(
          db.db,
          {
            requestId: rid,
            userId,
            deviceId,
            routeId: route?.id ?? null,
            task: 'classify',
            model,
            outcome: usageOutcome,
            postsRequested: posts.length,
            postsOk,
            calls: outcome?.calls ?? 0,
            failedCalls: outcome?.failedCalls ?? 0,
            usage: outcome?.usage ?? ZERO_USAGE,
            okUsage: outcome?.okUsage ?? ZERO_USAGE,
          },
          log,
        );
        // Only now: from here on the row counts the posts.
        releaseLimits?.();
        log.info('classify.done', {
          rid,
          posts_requested: posts.length,
          posts_ok: postsOk,
          excluded: excluded.length,
          model,
          outcome: usageOutcome,
          ms: Math.round(performance.now() - started),
        });
      }
    },
  );
}
