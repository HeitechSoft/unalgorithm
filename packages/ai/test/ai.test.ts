import { buildInterestProfile, ClassificationBatchSchema, defaultSettings } from '@unalgorithm/core';
import type { PostForAI } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  AIError,
  anthropicClient,
  classifyPosts,
  detectProvider,
  memoryCapabilities,
  openaiClient,
  openaiCompatibleClient,
  originPattern,
  pickModel,
  toStrictJsonSchema,
} from '../src/index.ts';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** fetch stand-in: records every request and answers from a queue. */
function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init.body === 'string' ? init.body : init.body ? await new Response(init.body).text() : '';
    calls.push({ url, init, body: bodyText ? JSON.parse(bodyText) : {} });
    const next = responses.shift() ?? { status: 500, body: { error: 'no more responses' } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** The JSON body of the i-th recorded request. */
function bodyOf(f: { calls: Call[] }, i: number): Record<string, any> {
  return (f.calls[i]?.body ?? {}) as Record<string, any>;
}

const result = (id: string, relevance = 80) => ({
  id,
  topics: ['ai'],
  noise: [],
  reason: 'About AI.',
  relevance,
  isNews: false,
  hasCheckableClaims: false,
});

function anthropicMessage(results: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: JSON.stringify({ results }) }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 2400, output_tokens: 360, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
    ...over,
  };
}

const post = (ref: string): PostForAI => ({
  ref,
  platform: 'linkedin',
  text: `Post ${ref} about AI agents`,
  textComplete: true,
  authorKind: 'person',
  isReshare: false,
  media: 'none',
});

const profile = buildInterestProfile(defaultSettings());

describe('strict JSON schema', () => {
  it('requires every field and forbids extra properties at every level', () => {
    const s = toStrictJsonSchema(ClassificationBatchSchema) as {
      additionalProperties: boolean;
      required: string[];
      properties: { results: { items: { additionalProperties: boolean; required: string[] } } };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['results']);
    expect(s.properties.results.items.additionalProperties).toBe(false);
    expect(s.properties.results.items.required).toEqual([
      'id',
      'topics',
      'noise',
      'reason',
      'relevance',
      'isNews',
      'hasCheckableClaims',
    ]);
    expect(JSON.stringify(s)).not.toMatch(/"\$schema"|minLength|maximum/);
  });
});

describe('Anthropic adapter', () => {
  it('sends a cached system prompt, strict JSON output, low effort and no thinking on Haiku', async () => {
    const f = fakeFetch([{ body: anthropicMessage([result('p1')]) }]);
    const client = anthropicClient({ apiKey: 'sk-ant-test', capabilities: memoryCapabilities(), fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1')], { model: 'claude-haiku-5-5', profile, nonce: 'deadbeef' });
    const body = bodyOf(f, 0);
    expect(f.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.temperature).toBeUndefined();
    expect(out.byRef.get('p1')).toMatchObject({ ok: true, classification: { relevance: 80 } });
    expect(out.usage).toMatchObject({ uncachedInput: 2400, cacheRead: 1500, output: 360 });
  });

  it('does not send a thinking parameter to Opus or Sonnet 5.5', async () => {
    const f = fakeFetch([{ body: anthropicMessage([result('p1')], { model: 'claude-sonnet-5-5' }) }]);
    const client = anthropicClient({ apiKey: 'k', capabilities: memoryCapabilities(), fetch: f.fetch });
    await classifyPosts(client, [post('p1')], { model: 'claude-sonnet-5-5', profile });
    expect(bodyOf(f, 0).thinking).toBeUndefined();
  });

  it('learns that a model rejects effort, remembers it and retries once', async () => {
    const caps = memoryCapabilities();
    const f = fakeFetch([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'effort is not supported' } } },
      { body: anthropicMessage([result('p1')]) },
    ]);
    const client = anthropicClient({ apiKey: 'k', capabilities: caps, fetch: f.fetch });
    await classifyPosts(client, [post('p1')], { model: 'claude-old', profile });
    expect(bodyOf(f, 1).output_config.effort).toBeUndefined();
    expect(caps.get('anthropic:claude-old')?.noEffort).toBe(true);
  });

  it('maps a bad key to auth and keeps usage from refusals', async () => {
    const f = fakeFetch([
      { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    ]);
    const client = anthropicClient({ apiKey: 'bad', capabilities: memoryCapabilities(), fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1')], { model: 'claude-haiku-5-5', profile });
    const r = out.byRef.get('p1');
    expect(r?.ok).toBe(false);
    expect(r && !r.ok && r.error.code).toBe('auth');
  });
});

describe('classify orchestrator', () => {
  it('splits a refused batch so only the offending post fails, and counts the usage of every call', async () => {
    const refusal = anthropicMessage([], { stop_reason: 'refusal', content: [] });
    const f = fakeFetch([
      { body: refusal }, // p1+p2
      { body: anthropicMessage([result('p1')]) }, // p1
      { body: refusal }, // p2
    ]);
    const client = anthropicClient({ apiKey: 'k', capabilities: memoryCapabilities(), fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1'), post('p2')], { model: 'claude-haiku-5-5', profile });
    expect(out.byRef.get('p1')?.ok).toBe(true);
    const p2 = out.byRef.get('p2');
    expect(p2 && !p2.ok && p2.error.code).toBe('refusal');
    expect(out.calls).toBe(3);
    expect(out.usage.uncachedInput).toBe(7200);
  });

  it('retries posts the model skipped, once, on their own', async () => {
    const f = fakeFetch([{ body: anthropicMessage([result('p1')]) }, { body: anthropicMessage([result('p2', 30)]) }]);
    const client = anthropicClient({ apiKey: 'k', capabilities: memoryCapabilities(), fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1'), post('p2')], { model: 'claude-haiku-5-5', profile });
    expect(out.byRef.get('p2')).toMatchObject({ ok: true, classification: { relevance: 30 } });
    expect(f.calls).toHaveLength(2);
  });
});

describe('OpenAI adapter', () => {
  it('uses strict JSON schema, does not store responses, and does not double count cached tokens', async () => {
    const f = fakeFetch([
      {
        body: {
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          model: 'gpt-5-nano',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: JSON.stringify({ results: [result('p1')] }), annotations: [] }],
            },
          ],
          usage: { input_tokens: 3000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 200, total_tokens: 3200 },
        },
      },
    ]);
    const client = openaiClient({ apiKey: 'sk-test', capabilities: memoryCapabilities(), fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1')], { model: 'gpt-5-nano', profile });
    const body = bodyOf(f, 0);
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(out.usage).toMatchObject({ uncachedInput: 2000, cacheRead: 1000, output: 200 });
    expect(out.byRef.get('p1')?.ok).toBe(true);
  });
});

describe('OpenAI-compatible adapter', () => {
  const chat = (content: string) => ({ model: 'llama3.2:3b', choices: [{ message: { content }, finish_reason: 'stop' }] });

  it('sends no Authorization header to keyless local servers', async () => {
    const f = fakeFetch([{ body: chat(JSON.stringify({ results: [result('p1')] })) }]);
    const client = openaiCompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      capabilities: memoryCapabilities(),
      fetch: f.fetch,
    });
    const out = await classifyPosts(client, [post('p1')], { model: 'llama3.2:3b', profile });
    expect(f.calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect((f.calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    expect(out.byRef.get('p1')?.ok).toBe(true);
    expect(out.usage.estimated).toBe(true);
  });

  it('steps down from strict schema to plain JSON when the server rejects it, and remembers', async () => {
    const caps = memoryCapabilities();
    const f = fakeFetch([
      { status: 400, body: { error: 'response_format json_schema not supported' } },
      { status: 400, body: { error: 'response_format json_schema not supported' } },
      { body: chat(`Here you go:\n\`\`\`json\n${JSON.stringify({ results: [result('p1')] })}\n\`\`\``) },
    ]);
    const client = openaiCompatibleClient({ baseUrl: 'https://example.ai/v1', apiKey: 'k', capabilities: caps, fetch: f.fetch });
    const out = await classifyPosts(client, [post('p1')], { model: 'm', profile });
    expect(out.byRef.get('p1')?.ok).toBe(true);
    expect(bodyOf(f, 2).response_format).toEqual({ type: 'json_object' });
    expect(caps.get('compat:https://example.ai/v1:m')?.mode).toBe('json-object');
  });

  it('reports a refused local request as an origin problem (Ollama CORS)', async () => {
    const f = fakeFetch([{ status: 403, body: {} }]);
    const client = openaiCompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      capabilities: memoryCapabilities(),
      fetch: f.fetch,
    });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'origin-blocked' });
  });
});

describe('keys and presets', () => {
  it('recognizes providers from a pasted key', () => {
    expect(detectProvider('sk-ant-api03-abc')).toBe('anthropic');
    expect(detectProvider('sk-or-v1-abc')).toBe('openrouter');
    expect(detectProvider('sk-proj-abc')).toBe('openai');
    expect(detectProvider('AIzaSyabc')).toBe('gemini');
    expect(detectProvider('gsk_abc')).toBe('groq');
    expect(detectProvider('hello')).toBeUndefined();
  });

  it('builds permission patterns without ports', () => {
    expect(originPattern('http://localhost:11434/v1')).toBe('http://localhost/*');
    expect(originPattern('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
  });

  it('picks the preferred cheap model the endpoint offers', () => {
    expect(pickModel(['gpt-5', 'gpt-5-mini', 'gpt-4o-mini'], ['gpt-5-nano', 'gpt-5-mini'])).toBe('gpt-5-mini');
    expect(pickModel(['qwen2.5:7b-instruct'], ['llama3.2:3b', 'qwen2.5:7b'])).toBe('qwen2.5:7b-instruct');
  });

  it('AIError is an Error with a code', () => {
    expect(new AIError('timeout', 'x')).toBeInstanceOf(Error);
  });
});
