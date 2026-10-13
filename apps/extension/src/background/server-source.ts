import { AIError, type ClassifyOutcome, codeForStatus, describeError, isAIError, type PostOutcome } from '@unalgorithm/ai';
import { type AISourceConfig, SOURCE_LIMITS } from '@unalgorithm/core';
import {
  CLASSIFY_PATH,
  ClassifyRequestSchema,
  type ClassifyResponse,
  ClassifyResponseSchema,
  type InterestProfile,
  type PostForAI,
  ServerErrorSchema,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { serverLabel } from '../lib/server-label.ts';
import { getAccessToken, markNeedsSignIn } from './server-auth.ts';

/**
 * The `server` AI source (R25): one `POST /v1/classify` per batch to an UnAlgorithm server, with the signed-in device's
 * token. The server builds the prompts, calls its own model and meters the request, so the extension sees no token
 * usage. Posts arrive here with `pk_` refs (`toPostRef`), and Facebook posts that aren't public never arrive at all.
 *
 * A failed request is every post's error, never a throw, so `classifyItems` caches, pauses and retries exactly as it
 * does for the other sources. Errors carry the extension's own words for the server's error code, never the server's
 * text, so a server cannot put its own instructions on the extension's screens.
 */

type ServerSource = Extract<AISourceConfig, { kind: 'server' }>;

/** The ledger's model for a request the server never answered, so never named one. */
const NO_MODEL = 'server';

export async function classifyViaServer(
  cfg: ServerSource,
  posts: PostForAI[],
  opts: { profile: InterestProfile; profileHash: string; locale: string },
  deps: { fetch?: typeof fetch; getAccessToken?: typeof getAccessToken } = {},
): Promise<ClassifyOutcome> {
  const doFetch = deps.fetch ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const token = deps.getAccessToken ?? getAccessToken;
  const outcome = (byRef: Map<string, PostOutcome>, model: string, failed: boolean): ClassifyOutcome => ({
    byRef,
    usage: ZERO_USAGE,
    okUsage: ZERO_USAGE,
    model,
    calls: 1,
    failedCalls: failed ? 1 : 0,
  });

  try {
    const base = new URL(cfg.baseUrl);
    const { title } = serverLabel(base.origin);
    const request = ClassifyRequestSchema.safeParse({ v: 1, posts, ...opts });
    if (!request.success) throw new AIError('bad-request', describeError('bad-request', title));
    const body = JSON.stringify(request.data);

    /** One attempt with `bearer`, read to the end within the source's timeout. */
    const send = async (bearer: string) => {
      const signal = AbortSignal.timeout(SOURCE_LIMITS.server.timeoutMs);
      try {
        const res = await doFetch(new URL(CLASSIFY_PATH, base.origin).href, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body,
          credentials: 'omit',
          redirect: 'error',
          signal,
        });
        return { res, text: await res.text() };
      } catch (err) {
        if (signal.aborted) throw new AIError('timeout', describeError('timeout', title), { cause: err });
        throw new AIError('network', describeError('network'), { cause: err });
      }
    };

    let reply = await send(await token(base.origin));
    if (reply.res.status === 401) {
      // The access token was revoked or ran out early: one refresh, one retry (the refresh itself is single-flight).
      reply = await send(await token(base.origin, { forceRefresh: true }));
      if (reply.res.status === 401) {
        await markNeedsSignIn(base.origin).catch(() => undefined);
        throw new AIError('auth-required', describeError('auth-required', title));
      }
    }
    if (!reply.res.ok) throw errorFor(reply.res, reply.text, base, title);

    const answer = ClassifyResponseSchema.safeParse(parseJson(reply.text));
    if (!answer.success) throw new AIError('unknown', describeError('unknown'));
    return outcome(resultsByRef(posts, answer.data), answer.data.source.model, false);
  } catch (err) {
    const e = isAIError(err) ? err : new AIError('unknown', describeError('unknown'), { cause: err });
    return outcome(new Map(posts.map((p) => [p.ref, { ok: false, error: e }])), NO_MODEL, true);
  }
}

/** Each sent post's result; a post the server left out of its answer gets an error rather than nothing. */
function resultsByRef(posts: PostForAI[], answer: ClassifyResponse): Map<string, PostOutcome> {
  const sent = new Set(posts.map((p) => p.ref));
  const byRef = new Map<string, PostOutcome>();
  for (const r of answer.results) {
    if (!sent.has(r.ref) || byRef.has(r.ref)) continue;
    if (r.status === 'ok') byRef.set(r.ref, { ok: true, classification: r.classification });
    else if (r.status === 'declined') byRef.set(r.ref, { ok: false, error: new AIError('refusal', describeError('refusal')) });
    else byRef.set(r.ref, { ok: false, error: new AIError('unknown', describeError('unknown')) });
  }
  for (const ref of sent)
    if (!byRef.has(ref)) byRef.set(ref, { ok: false, error: new AIError('unknown', 'No answer for this post.') });
  return byRef;
}

/** A non-2xx answer: the server's error code when it sent one (CL1-06), otherwise the status, as for any provider. */
function errorFor(res: Response, text: string, base: URL, title: string): AIError {
  const wire = ServerErrorSchema.safeParse(parseJson(text));
  const code = wire.success ? wire.data.code : codeForStatus(res.status, text, base.hostname);
  const retryAfter = Number(res.headers.get('retry-after'));
  return new AIError(
    code,
    describeError(code, title),
    Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {},
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
