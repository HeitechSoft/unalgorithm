import Anthropic from '@anthropic-ai/sdk';
import {
  addUsage,
  FactcheckSourceSchema,
  MAX_RETRIEVED_SOURCES,
  type NormalizedUsage,
  type RetrievedSource,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { AIError, codeForStatus } from './errors.ts';
import { anthropicCanDisableThinking } from './models.ts';
import type {
  AIClient,
  Capabilities,
  CapabilityStore,
  ModelInfo,
  ResearchRequest,
  ResearchResult,
  StructuredRequest,
  StructuredResult,
} from './types.ts';

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
function systemBlocks(req: { system: string; cachePrefix?: string | undefined }): Anthropic.Messages.TextBlockParam[] {
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

const DEFAULT_RESEARCH_TIMEOUT_MS = 120_000;
const MAX_RESEARCH_CONTINUATIONS = 2;
const MAX_NOTES_CHARS = 8_000;
const MAX_URL_CHARS = 2_048;
const MAX_SNIPPET_CHARS = 600;

/** The `www.`-less lowercased hostname of an http(s) URL of sane length, or undefined. */
function sourceDomain(url: string): string | undefined {
  if (url.length > MAX_URL_CHARS) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Sources, notes and search errors from a research answer, in content order. Sources come only from search results
 * (a citation never creates one); cited passages become their snippets. `encrypted_content` is never read.
 */
function parseResearch(blocks: readonly Anthropic.Messages.ContentBlock[]): {
  notes: string;
  sources: RetrievedSource[];
  searchErrors: string[];
  /** Search result blocks that came back as results rather than errors. */
  searchesOk: number;
} {
  const byUrl = new Map<string, RetrievedSource>();
  const seen = new Set<string>();
  const searchErrors: string[] = [];
  let notes = '';
  let searchesOk = 0;
  for (const block of blocks) {
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) {
        searchErrors.push(block.content.error_code);
        continue;
      }
      searchesOk++;
      for (const r of block.content) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        if (byUrl.size >= MAX_RETRIEVED_SOURCES) continue;
        const domain = sourceDomain(r.url);
        if (!domain) continue;
        const source = {
          id: `s${byUrl.size + 1}`,
          url: r.url,
          domain,
          title: (r.title ?? '').slice(0, 300),
          pageAge: r.page_age ? r.page_age.slice(0, 64) : null,
        };
        if (!FactcheckSourceSchema.safeParse(source).success) continue;
        byUrl.set(r.url, { ...source, snippets: [] });
      }
    } else if (block.type === 'text') {
      notes += block.text;
      for (const c of block.citations ?? []) {
        if (c.type !== 'web_search_result_location') continue;
        const source = byUrl.get(c.url);
        const snippet = (c.cited_text ?? '').slice(0, MAX_SNIPPET_CHARS);
        if (source && snippet && !source.snippets.includes(snippet)) source.snippets.push(snippet);
      }
    }
  }
  return { notes: notes.slice(0, MAX_NOTES_CHARS), sources: [...byUrl.values()], searchErrors, searchesOk };
}

/**
 * Claude via the official SDK, always at api.anthropic.com: from the extension with the user's own key, or from a
 * server with its configured key. Structured output through `output_config.format`, a cached system prompt (split
 * after the shared rubric when the caller marks it), low effort, and thinking switched off where the model allows it
 * (classification needs no deliberation). Research uses the server-side web search tool instead of a format.
 */
export function anthropicClient(opts: { apiKey: string; capabilities: CapabilityStore; fetch?: typeof fetch }): AIClient {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    // All three fixed here, so the SDK never falls back to ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL or ANTHROPIC_LOG in
    // a server's environment: the first would send a second credential, perhaps another account's, the second would
    // send prompts to another host, the third would print every prompt and answer to the console. No option stops the
    // SDK reading ANTHROPIC_CUSTOM_HEADERS, so a server refuses to start while it is set.
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    logLevel: 'off',
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
    timeout: 30_000,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  /** `thinking: disabled` where the model allows it and has not rejected the parameter before. */
  const thinkingParam = (model: string, caps: Capabilities) =>
    !caps.noThinkingParam && anthropicCanDisableThinking(model) ? { thinking: { type: 'disabled' as const } } : {};

  /**
   * One `messages.create`. When the model rejects `effort` or `thinking`, remember that and retry once without it.
   * `build` makes the body from what is known about the model; `options` gives the request options for each attempt.
   */
  async function createLearning(
    model: string,
    build: (caps: Capabilities) => Anthropic.Messages.MessageCreateParamsNonStreaming,
    options: () => Anthropic.RequestOptions,
  ): Promise<Anthropic.Messages.Message> {
    const capKey = `anthropic:${model}`;
    for (let attempt = 0; ; attempt++) {
      const caps = opts.capabilities.get(capKey) ?? {};
      try {
        return await client.messages.create(build(caps), options());
      } catch (err) {
        const e = toAIError(err);
        if (e.code === 'bad-request' && attempt === 0) {
          if (/effort/i.test(e.message) && !caps.noEffort) {
            opts.capabilities.set(capKey, { ...caps, noEffort: true });
            continue;
          }
          if (/thinking/i.test(e.message) && !caps.noThinkingParam) {
            opts.capabilities.set(capKey, { ...caps, noThinkingParam: true });
            continue;
          }
        }
        throw e;
      }
    }
  }

  async function structured(req: StructuredRequest): Promise<StructuredResult> {
    const msg = await createLearning(
      req.model,
      (caps) => ({
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: systemBlocks(req),
        messages: [{ role: 'user', content: req.user }],
        output_config: {
          format: { type: 'json_schema', schema: req.jsonSchema },
          ...(caps.noEffort ? {} : { effort: req.effort }),
        },
        ...thinkingParam(req.model, caps),
      }),
      () => ({
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
      }),
    );
    const usage = normalize(msg.usage);
    if (msg.stop_reason === 'refusal') throw new AIError('refusal', 'The model declined this request.', { usage });
    if (msg.stop_reason === 'max_tokens') throw new AIError('truncated', 'The answer was cut off.', { usage });
    const text = msg.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, usage, model: msg.model, mode: 'json-schema' };
  }

  /**
   * Free-text research with web search. A paused turn is continued (at most twice, while searches and time remain)
   * by sending the assistant content back; usage is summed over every call and carried by every error.
   */
  async function research(req: ResearchRequest): Promise<ResearchResult> {
    const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_RESEARCH_TIMEOUT_MS);
    const blocks: Anthropic.Messages.ContentBlock[] = [];
    let usage = ZERO_USAGE;
    let model = req.model;
    for (let continuation = 0; ; continuation++) {
      const messages: Anthropic.Messages.MessageParam[] = [{ role: 'user', content: req.user }];
      if (blocks.length)
        messages.push({ role: 'assistant', content: blocks as unknown as Anthropic.Messages.ContentBlockParam[] });
      const tool: Anthropic.Messages.WebSearchTool20260209 = {
        type: 'web_search_20260209',
        name: 'web_search',
        max_uses: req.maxSearches - usage.webSearches,
        allowed_callers: ['direct'],
        ...(req.allowedDomains?.length
          ? { allowed_domains: [...req.allowedDomains] }
          : req.blockedDomains.length
            ? { blocked_domains: [...req.blockedDomains] }
            : {}),
      };
      let msg: Anthropic.Messages.Message;
      try {
        msg = await createLearning(
          req.model,
          (caps) => ({
            model: req.model,
            max_tokens: req.maxOutputTokens,
            system: systemBlocks(req),
            messages,
            tools: [tool],
            ...(caps.noEffort ? {} : { output_config: { effort: req.effort } }),
            ...thinkingParam(req.model, caps),
          }),
          // Never retried by the SDK: a retry would repeat searches already billed without recording their usage.
          () => ({
            maxRetries: 0,
            timeout: Math.max(1, deadline - Date.now()),
            ...(req.signal ? { signal: req.signal } : {}),
          }),
        );
      } catch (err) {
        const e = toAIError(err);
        if (e.code === 'bad-request' && /web.?search/i.test(e.message))
          throw new AIError('unsupported', `Web search is not available with this key: ${e.message}`, { usage, cause: e });
        throw new AIError(e.code, e.message, {
          usage,
          cause: e.cause ?? e,
          ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
        });
      }
      usage = addUsage(usage, normalize(msg.usage));
      model = msg.model;
      if (msg.stop_reason === 'refusal') throw new AIError('refusal', 'The model declined this request.', { usage });
      if (msg.stop_reason === 'max_tokens') throw new AIError('truncated', 'The answer was cut off.', { usage });
      blocks.push(...msg.content);
      const more =
        msg.stop_reason === 'pause_turn' &&
        continuation < MAX_RESEARCH_CONTINUATIONS &&
        usage.webSearches < req.maxSearches &&
        Date.now() < deadline;
      if (!more) break;
    }
    const parsed = parseResearch(blocks);
    if (!parsed.sources.length && parsed.searchErrors.length && !parsed.searchesOk) {
      if (parsed.searchErrors.some((c) => c === 'unavailable' || c === 'too_many_requests'))
        throw new AIError('overloaded', 'Web search is unavailable right now.', { usage });
      throw new AIError('bad-request', `Web search failed: ${parsed.searchErrors.join(', ')}.`, { usage });
    }
    return { notes: parsed.notes, sources: parsed.sources, searchErrors: parsed.searchErrors, usage, model };
  }

  return {
    kind: 'anthropic',
    structured,
    research,
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
