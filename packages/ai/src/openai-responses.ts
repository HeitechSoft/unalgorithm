import type { NormalizedUsage } from '@unalgorithm/protocol';
import { ZERO_USAGE } from '@unalgorithm/protocol';
import OpenAI from 'openai';
import { AIError, codeForStatus } from './errors.ts';
import { createSourceCollector, MAX_NOTES_CHARS, MAX_SNIPPET_CHARS } from './research-sources.ts';
import type {
  AIClient,
  Capabilities,
  CapabilityStore,
  ResearchRequest,
  ResearchResult,
  StructuredRequest,
  StructuredResult,
} from './types.ts';

export interface ResponsesUsage {
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
const DEFAULT_RESEARCH_TIMEOUT_MS = 120_000;

/**
 * Extra `max_output_tokens` for a reasoning model, whose reasoning tokens count against that limit; 0 for any other
 * model, so its request is unchanged (decision D58).
 */
function headroom(model: string, effort: 'low' | 'medium'): number {
  if (!/^(gpt-5|o\d)/.test(model)) return 0;
  return effort === 'low' ? 2_000 : 6_000;
}

/** The URL without the `utm_source` parameter OpenAI appends to search results and citations. */
function withoutUtmSource(url: string): string {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('utm_source')) return url;
    u.searchParams.delete('utm_source');
    return u.toString();
  } catch {
    return url;
  }
}

/** A sentence end: `.`, `!` or `?` followed by whitespace (so "3.5" and "a.example" never end one), or a newline. */
const SENTENCE_END = /[.!?]\s|\n/g;

/**
 * The text a `url_citation` stands for. A span that is a link marker (`([a.example](https://…))`) stands for the
 * sentence that ends where it starts, with markdown link syntax removed; any other span stands for itself. Trimmed and
 * clipped to MAX_SNIPPET_CHARS: an OpenAI source's quote base is what the research model wrote next to the citation
 * (decision D45), since the API returns no page text.
 */
export function citedText(text: string, start: number, end: number): string {
  const span = text.slice(start, end);
  let out = span;
  if (span.includes('http') || /^\s*\(?\[/.test(span)) {
    const before = text.slice(0, Math.max(0, start)).replace(/\s+$/, '');
    let from = 0;
    for (const m of before.matchAll(SENTENCE_END)) if (m.index < before.length - 1) from = m.index + m[0].length;
    out = before
      .slice(from)
      .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  return out.trim().slice(0, MAX_SNIPPET_CHARS);
}

/**
 * OpenAI's Responses API: strict JSON schema for structured calls, the `web_search` tool for research. `store: false`:
 * responses are not kept on OpenAI's side.
 */
export function openaiClient(opts: { apiKey: string; capabilities: CapabilityStore; fetch?: typeof fetch }): AIClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    timeout: 30_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  /** One `responses.create`. When the model rejects `reasoning.effort`, remember that and retry once without it. */
  async function createLearning(
    model: string,
    build: (caps: Capabilities) => OpenAI.Responses.ResponseCreateParamsNonStreaming,
    options: OpenAI.RequestOptions,
  ): Promise<OpenAI.Responses.Response> {
    const capKey = `openai:${model}`;
    for (let attempt = 0; ; attempt++) {
      const caps = opts.capabilities.get(capKey) ?? {};
      try {
        return await client.responses.create(build(caps), options);
      } catch (err) {
        const e = toAIError(err);
        if (e.code === 'bad-request' && attempt === 0 && /reasoning|effort/i.test(e.message) && !caps.noEffort) {
          opts.capabilities.set(capKey, { ...caps, noEffort: true });
          continue;
        }
        throw e;
      }
    }
  }

  /** Throws `truncated` or `refusal` for a response that carries no usable answer. */
  function checkFinished(resp: OpenAI.Responses.Response, usage: NormalizedUsage): void {
    if (resp.status === 'incomplete') throw new AIError('truncated', 'The answer was cut off.', { usage });
    for (const item of resp.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type === 'refusal')
            throw new AIError('refusal', part.refusal || 'The model declined this request.', { usage });
        }
      }
    }
  }

  async function structured(req: StructuredRequest): Promise<StructuredResult> {
    const resp = await createLearning(
      req.model,
      (caps) => ({
        model: req.model,
        instructions: req.system,
        input: req.user,
        max_output_tokens: req.maxOutputTokens + headroom(req.model, req.effort),
        store: false,
        prompt_cache_key: 'unalgorithm-classify-v1',
        text: { format: { type: 'json_schema', name: req.schemaName, schema: req.jsonSchema, strict: true } },
        ...(caps.noEffort ? {} : { reasoning: { effort: req.effort } }),
      }),
      { ...(req.signal ? { signal: req.signal } : {}), ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}) },
    );
    const usage = normalize(resp.usage as ResponsesUsage | undefined);
    checkFinished(resp, usage);
    return { text: resp.output_text ?? '', usage, model: resp.model, mode: 'json-schema' };
  }

  /**
   * Free-text research with the `web_search` tool, in one call. Sources come only from completed searches; each
   * `url_citation` adds the text it stands for as a snippet of its source. `blockedDomains` is not sent (the API has
   * no such filter): the caller drops blocked sources and validation drops blocked citations.
   */
  async function research(req: ResearchRequest): Promise<ResearchResult> {
    let resp: OpenAI.Responses.Response;
    try {
      resp = await createLearning(
        req.model,
        (caps) => ({
          model: req.model,
          instructions: req.system,
          input: req.user,
          tools: [
            {
              type: 'web_search',
              // No location fields: no location is sent, and OpenAI does not assume one.
              user_location: { type: 'approximate' },
              ...(req.allowedDomains?.length ? { filters: { allowed_domains: [...req.allowedDomains] } } : {}),
            },
          ],
          max_tool_calls: req.maxSearches,
          include: ['web_search_call.action.sources'],
          store: false,
          max_output_tokens: req.maxOutputTokens + headroom(req.model, req.effort),
          ...(caps.noEffort ? {} : { reasoning: { effort: req.effort } }),
        }),
        // Never retried by the SDK: a retry would repeat searches already billed.
        {
          maxRetries: 0,
          timeout: req.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS,
          ...(req.signal ? { signal: req.signal } : {}),
        },
      );
    } catch (err) {
      const e = toAIError(err);
      if (e.code === 'bad-request' && /web.?search|tool/i.test(e.message))
        throw new AIError('unsupported', `Web search is not available with this key or model: ${e.message}`, {
          usage: ZERO_USAGE,
          cause: e,
        });
      throw e;
    }

    const collector = createSourceCollector(withoutUtmSource);
    const searchErrors: string[] = [];
    let searches = 0;
    let notes = '';
    for (const item of resp.output ?? []) {
      if (item.type === 'web_search_call') {
        if (item.status === 'failed') searchErrors.push('failed');
        if (item.status !== 'completed' || item.action?.type !== 'search') continue;
        searches++;
        for (const s of item.action.sources ?? [])
          collector.addResult({ url: withoutUtmSource(s.url), title: '', pageAge: null });
      } else if (item.type === 'message') {
        for (const part of item.content) {
          if (part.type !== 'output_text') continue;
          notes += part.text;
          for (const a of part.annotations ?? []) {
            if (a.type === 'url_citation') collector.addSnippet(a.url, citedText(part.text, a.start_index, a.end_index), a.title);
          }
        }
      }
    }
    const usage = { ...normalize(resp.usage as ResponsesUsage | undefined), webSearches: searches };
    checkFinished(resp, usage);
    const sources = collector.sources();
    if (!sources.length && searchErrors.length && !searches)
      throw new AIError('overloaded', 'Web search is unavailable right now.', { usage });
    return { notes: notes.slice(0, MAX_NOTES_CHARS), sources, usage, model: resp.model, searchErrors };
  }

  return {
    kind: 'openai',
    structured,
    research,
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
