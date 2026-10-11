import type { NormalizedUsage } from '@unalgorithm/protocol';
import { AIError, codeForStatus } from './errors.ts';
import type { AIClient, CapabilityStore, StructuredMode, StructuredRequest, StructuredResult } from './types.ts';

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

const LADDER: StructuredMode[] = ['json-schema', 'json-schema-loose', 'json-object', 'prompt-only'];

function normalize(u: ChatUsage | undefined, chars: number): NormalizedUsage {
  if (!u?.prompt_tokens) {
    return { uncachedInput: Math.ceil(chars / 4), cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0, estimated: true };
  }
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    uncachedInput: Math.max(0, u.prompt_tokens - cached),
    cacheRead: cached,
    cacheWrite: 0,
    output: u.completion_tokens ?? 0,
    webSearches: 0,
    estimated: false,
  };
}

function responseFormat(mode: StructuredMode, req: StructuredRequest): Record<string, unknown> | undefined {
  switch (mode) {
    case 'json-schema':
      return { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: true } };
    case 'json-schema-loose':
      return { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema } };
    case 'json-object':
      return { type: 'json_object' };
    default:
      return undefined;
  }
}

/**
 * Any OpenAI-compatible server: Ollama, LM Studio, vLLM, Gemini's compatibility endpoint, OpenRouter, Groq,
 * HeitechSoft Private AI. A thin fetch client (no SDK quirks, no key required for local servers) that steps down
 * from strict JSON schema to plain JSON when a server doesn't support it, and remembers what worked.
 */
export function openaiCompatibleClient(opts: {
  baseUrl: string;
  apiKey?: string;
  capabilities: CapabilityStore;
  fetch?: typeof fetch;
  extraHeaders?: Record<string, string>;
}): AIClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return '';
    }
  })();
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    ...opts.extraHeaders,
  });

  async function request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await doFetch(`${base}${path}`, { ...init, headers: headers(), signal: combined });
    } catch (err) {
      if (timeout.aborted) throw new AIError('timeout', 'The AI server took too long to answer.', { cause: err });
      throw new AIError('network', `Couldn't reach ${host || 'the AI server'}.`, { cause: err });
    }
  }

  async function attempt(req: StructuredRequest, mode: StructuredMode): Promise<StructuredResult> {
    const format = responseFormat(mode, req);
    const system =
      mode === 'json-object' || mode === 'prompt-only'
        ? `${req.system}\n\nAnswer with only a JSON object matching this JSON schema, no other text:\n${JSON.stringify(req.jsonSchema)}`
        : req.system;
    const res = await request(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxOutputTokens,
          ...(format ? { response_format: format } : {}),
        }),
      },
      req.timeoutMs ?? 60_000,
      req.signal,
    );
    const raw = await res.text();
    if (!res.ok) throw new AIError(codeForStatus(res.status, raw, host), raw.slice(0, 300) || `HTTP ${res.status}`);
    let data: {
      model?: string;
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
      usage?: ChatUsage;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      throw new AIError('bad-request', 'The server did not return JSON.');
    }
    const usage = normalize(data.usage, system.length + req.user.length);
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new AIError('refusal', choice.message.refusal, { usage });
    if (choice?.finish_reason === 'length') throw new AIError('truncated', 'The answer was cut off.', { usage });
    return { text: choice?.message?.content ?? '', usage, model: data.model ?? req.model, mode };
  }

  return {
    kind: 'openai-compatible',
    async structured(req) {
      const capKey = `compat:${base}:${req.model}`;
      const learned = opts.capabilities.get(capKey)?.mode;
      const start = learned ? Math.max(0, LADDER.indexOf(learned)) : 0;
      let last: AIError | undefined;
      for (const mode of LADDER.slice(start)) {
        try {
          const result = await attempt(req, mode);
          if (mode !== learned) opts.capabilities.set(capKey, { ...opts.capabilities.get(capKey), mode });
          return result;
        } catch (err) {
          last = err instanceof AIError ? err : new AIError('unknown', String(err));
          // Only a rejected response_format is worth stepping down for.
          if (last.code !== 'bad-request') throw last;
        }
      }
      throw last ?? new AIError('unsupported', 'This server could not produce structured answers.');
    },
    async listModels(signal) {
      const res = await request('/models', { method: 'GET' }, 15_000, signal);
      const raw = await res.text();
      if (!res.ok) throw new AIError(codeForStatus(res.status, raw, host), raw.slice(0, 300) || `HTTP ${res.status}`);
      const data = JSON.parse(raw) as { data?: { id: string; created?: number }[]; models?: { name: string }[] };
      const list = data.data?.map((m) => ({ id: m.id, name: m.id, created: m.created ?? 0 })) ?? [];
      // Strip "models/" prefixes some providers use.
      return list.map((m) => ({ ...m, id: m.id.replace(/^models\//, ''), name: m.name.replace(/^models\//, '') }));
    },
  };
}
