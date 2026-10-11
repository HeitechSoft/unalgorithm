import type { NormalizedUsage } from '@unalgorithm/protocol';
import { ZERO_USAGE } from '@unalgorithm/protocol';
import OpenAI from 'openai';
import { AIError, codeForStatus } from './errors.ts';
import type { AIClient, CapabilityStore, StructuredRequest, StructuredResult } from './types.ts';

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** OpenAI's input_tokens include cached tokens: subtract them so uncached input is never double counted. */
function normalize(u: ResponsesUsage | undefined): NormalizedUsage {
  if (!u) return ZERO_USAGE;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    uncachedInput: Math.max(0, (u.input_tokens ?? 0) - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: u.output_tokens ?? 0,
    webSearches: 0,
    estimated: false,
  };
}

function toAIError(err: unknown): AIError {
  if (err instanceof AIError) return err;
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return new AIError('timeout', 'OpenAI took too long to answer.', { cause: err });
  if (err instanceof OpenAI.APIConnectionError) return new AIError('network', "Couldn't reach OpenAI.", { cause: err });
  if (err instanceof OpenAI.APIError) {
    return new AIError(codeForStatus(err.status ?? 0, err.message ?? ''), err.message ?? 'OpenAI error', { cause: err });
  }
  return new AIError('unknown', String(err), { cause: err });
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;

/** OpenAI's Responses API with strict JSON schema. `store: false`: responses are not kept on OpenAI's side. */
export function openaiClient(opts: { apiKey: string; capabilities: CapabilityStore; fetch?: typeof fetch }): AIClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    timeout: 30_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  async function call(req: StructuredRequest, attempt = 0): Promise<StructuredResult> {
    const capKey = `openai:${req.model}`;
    const caps = opts.capabilities.get(capKey) ?? {};
    let resp: OpenAI.Responses.Response;
    try {
      resp = await client.responses.create(
        {
          model: req.model,
          instructions: req.system,
          input: req.user,
          max_output_tokens: req.maxOutputTokens,
          store: false,
          prompt_cache_key: 'unalgorithm-classify-v1',
          text: { format: { type: 'json_schema', name: req.schemaName, schema: req.jsonSchema, strict: true } },
          ...(caps.noEffort ? {} : { reasoning: { effort: req.effort } }),
        },
        { ...(req.signal ? { signal: req.signal } : {}), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) },
      );
    } catch (err) {
      const e = toAIError(err);
      if (e.code === 'bad-request' && attempt === 0 && /reasoning|effort/i.test(e.message) && !caps.noEffort) {
        opts.capabilities.set(capKey, { ...caps, noEffort: true });
        return call(req, attempt + 1);
      }
      throw e;
    }
    const usage = normalize(resp.usage as ResponsesUsage | undefined);
    if (resp.status === 'incomplete') throw new AIError('truncated', 'The answer was cut off.', { usage });
    for (const item of resp.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'refusal')
            throw new AIError('refusal', part.refusal || 'The model declined this request.', { usage });
        }
      }
    }
    return { text: resp.output_text ?? '', usage, model: resp.model, mode: 'json-schema' };
  }

  return {
    kind: 'openai',
    structured: (req) => call(req),
    async listModels(signal) {
      try {
        const list = await client.models.list(signal ? { signal } : {});
        const ids: { id: string; created: number }[] = [];
        for await (const m of list) if (CHAT_MODEL.test(m.id)) ids.push({ id: m.id, created: m.created });
        return ids.sort((a, b) => b.created - a.created).map((m) => ({ id: m.id, name: m.id, created: m.created }));
      } catch (err) {
        throw toAIError(err);
      }
    },
  };
}
