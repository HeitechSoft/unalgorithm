import Anthropic from '@anthropic-ai/sdk';
import { type NormalizedUsage, ZERO_USAGE } from '@unalgorithm/protocol';
import { AIError, codeForStatus } from './errors.ts';
import { anthropicCanDisableThinking } from './models.ts';
import type { AIClient, CapabilityStore, ModelInfo, StructuredRequest, StructuredResult } from './types.ts';

type MessageUsage = Anthropic.Messages.Usage;

/** Anthropic's input_tokens already exclude cache reads and writes. */
function normalize(u: MessageUsage | undefined): NormalizedUsage {
  if (!u) return ZERO_USAGE;
  return {
    uncachedInput: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
    estimated: false,
  };
}

function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError)
    return new AIError('timeout', 'Anthropic took too long to answer.', { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new AIError('network', "Couldn't reach Anthropic.", { cause: err });
  if (err instanceof Anthropic.APIError) {
    const message = err.message ?? '';
    const code = codeForStatus(err.status ?? 0, message);
    const retry = Number(err.headers?.get?.('retry-after'));
    return new AIError(code, message, {
      cause: err,
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterMs: retry * 1000 } : {}),
    });
  }
  return new AIError('unknown', String(err), { cause: err });
}

/**
 * The system prompt as cached text blocks. With a valid `cachePrefix` there are two breakpoints, so the part shared
 * by every user is written to the cache once and read by all of them; otherwise one. The blocks always join back to
 * exactly `req.system`.
 */
function systemBlocks(req: StructuredRequest): Anthropic.Messages.TextBlockParam[] {
  const cached = (text: string): Anthropic.Messages.TextBlockParam => ({
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' },
  });
  const prefix = req.cachePrefix;
  if (prefix && req.system.length > prefix.length && req.system.startsWith(prefix))
    return [cached(prefix), cached(req.system.slice(prefix.length))];
  return [cached(req.system)];
}

/**
 * Claude via the official SDK, always at api.anthropic.com: from the extension with the user's own key, or from a
 * server with its configured key. Structured output through `output_config.format`, a cached system prompt (split
 * after the shared rubric when the caller marks it), low effort, and thinking switched off where the model allows it
 * (classification needs no deliberation).
 */
export function anthropicClient(opts: { apiKey: string; capabilities: CapabilityStore; fetch?: typeof fetch }): AIClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // Both fixed here, so the SDK never falls back to ANTHROPIC_BASE_URL or ANTHROPIC_LOG in a server's environment:
    // one would send prompts to another host, the other would print every prompt and answer to the console.
    baseURL: 'https://api.anthropic.com',
    logLevel: 'off',
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    timeout: 30_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  async function call(req: StructuredRequest, attempt = 0): Promise<StructuredResult> {
    const capKey = `anthropic:${req.model}`;
    const caps = opts.capabilities.get(capKey) ?? {};
    const body: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      system: systemBlocks(req),
      messages: [{ role: 'user', content: req.user }],
      output_config: {
        format: { type: 'json_schema', schema: req.jsonSchema },
        ...(caps.noEffort ? {} : { effort: req.effort }),
      },
      ...(!caps.noThinkingParam && anthropicCanDisableThinking(req.model) ? { thinking: { type: 'disabled' as const } } : {}),
    };
    let msg: Anthropic.Messages.Message;
    try {
      msg = await client.messages.create(body, {
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      });
    } catch (err) {
      const e = toAIError(err);
      // Learn what this model rejects, remember it, and retry once without it.
      if (e.code === 'bad-request' && attempt === 0) {
        if (/effort/i.test(e.message) && !caps.noEffort) {
          opts.capabilities.set(capKey, { ...caps, noEffort: true });
          return call(req, attempt + 1);
        }
        if (/thinking/i.test(e.message) && !caps.noThinkingParam) {
          opts.capabilities.set(capKey, { ...caps, noThinkingParam: true });
          return call(req, attempt + 1);
        }
      }
      throw e;
    }
    const usage = normalize(msg.usage);
    if (msg.stop_reason === 'refusal') throw new AIError('refusal', 'The model declined this request.', { usage });
    if (msg.stop_reason === 'max_tokens') throw new AIError('truncated', 'The answer was cut off.', { usage });
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage, model: msg.model, mode: 'json-schema' };
  }

  return {
    kind: 'anthropic',
    structured: (req) => call(req),
    async listModels(signal) {
      try {
        const out: ModelInfo[] = [];
        for await (const m of client.models.list({ limit: 100 }, signal ? { signal } : {})) {
          out.push({ id: m.id, name: m.display_name ?? m.id, created: Date.parse(m.created_at) || 0 });
        }
        return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      } catch (err) {
        throw toAIError(err);
      }
    },
  };
}
