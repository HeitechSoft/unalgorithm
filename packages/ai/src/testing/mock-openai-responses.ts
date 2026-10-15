import type { ResponsesUsage } from '../openai-responses.ts';
import {
  CLAIMS_PHRASE,
  COMPARISON_PHRASE,
  type MockVerdict,
  mockStructuredAnswer,
  STORY_PHRASE,
  VERDICT_PHRASE,
} from './mock-openai-server.ts';

/**
 * A stand-in for api.openai.com/v1/responses, for unit tests, the eval harness and E2E routes: pure functions and a
 * `fetch`. Usage numbers are fixed so metering tests can assert exact amounts. Test code only: the extension never
 * imports it.
 */

export type ResponsesRequestKind = 'classify' | 'claims' | 'research' | 'verdict' | 'story' | 'comparison' | 'unknown';

const STRUCTURED_USAGE: ResponsesUsage = { input_tokens: 1000, output_tokens: 100 };
const RESEARCH_USAGE: ResponsesUsage = { input_tokens: 20_000, output_tokens: 1500 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The user input of a Responses body: a string, or the text parts of its input items. */
function inputText(body: Record<string, unknown>): string {
  const input = body.input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const texts: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (typeof item.content === 'string') texts.push(item.content);
    else if (Array.isArray(item.content))
      for (const part of item.content) if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('\n');
}

/** A `web_search` tool → research; else by the prompt wording (the phrases of mock-openai-server.ts), else classify. */
export function responsesRequestKind(body: unknown): ResponsesRequestKind {
  if (!isRecord(body)) return 'unknown';
  if (Array.isArray(body.tools) && body.tools.some((t) => isRecord(t) && t.type === 'web_search')) return 'research';
  const user = inputText(body);
  if (user.includes(CLAIMS_PHRASE)) return 'claims';
  if (user.includes(VERDICT_PHRASE)) return 'verdict';
  if (user.includes(STORY_PHRASE)) return 'story';
  if (user.includes(COMPARISON_PHRASE)) return 'comparison';
  return 'classify';
}

function response(
  model: string,
  output: unknown[],
  usage: ResponsesUsage,
  status: 'completed' | 'incomplete' = 'completed',
): Record<string, unknown> {
  const input = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  return {
    id: 'resp_mock',
    object: 'response',
    created_at: 0,
    status,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    model,
    output,
    usage: {
      input_tokens: input,
      input_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
      output_tokens: out,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: input + out,
    },
  };
}

function message(text: string, annotations: unknown[]): Record<string, unknown> {
  return {
    type: 'message',
    id: 'msg_mock',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
  };
}

/** A structured-output answer carrying `json`. */
export function structuredResponse(
  json: unknown,
  opts: { model?: string; usage?: Partial<ResponsesUsage> } = {},
): Record<string, unknown> {
  return response(opts.model ?? 'gpt-5-mini', [message(JSON.stringify(json), [])], { ...STRUCTURED_USAGE, ...opts.usage });
}

/** A web-search research answer: these search calls, then one message whose text carries these `url_citation`s. */
export function researchResponse(opts: {
  searches: { urls: string[]; status?: 'completed' | 'failed' }[];
  text: string;
  citations: { url: string; title: string; start: number; end: number }[];
  status?: 'completed' | 'incomplete';
  model?: string;
}): Record<string, unknown> {
  const output: unknown[] = opts.searches.map((s, i) => ({
    type: 'web_search_call',
    id: `ws_mock_${i}`,
    status: s.status ?? 'completed',
    action: { type: 'search', query: 'mock query', sources: s.urls.map((url) => ({ type: 'url', url })) },
  }));
  output.push(
    message(
      opts.text,
      opts.citations.map((c) => ({
        type: 'url_citation',
        url: c.url,
        title: c.title,
        start_index: c.start,
        end_index: c.end,
      })),
    ),
  );
  return response(opts.model ?? 'gpt-5', output, RESEARCH_USAGE, opts.status);
}

/** The default structured answer to a non-research body: the same logic as the chat/completions mock. */
export function mockResponsesAnswer(body: unknown, verdict?: (postText: string) => MockVerdict): Record<string, unknown> {
  const { json } = mockStructuredAnswer(isRecord(body) ? inputText(body) : '', verdict);
  const model = isRecord(body) && typeof body.model === 'string' ? body.model : undefined;
  return structuredResponse(json, model ? { model } : {});
}

/**
 * A `fetch` that answers every request through `answer` and records each JSON body, in order. `answer` returns the
 * response body (sent with status 200) or a `Response` to send as it is (for errors).
 */
export function mockOpenAIResponsesFetch(
  answer: (kind: ResponsesRequestKind, body: unknown) => unknown,
): typeof fetch & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fn = async (_input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const text = typeof init.body === 'string' ? init.body : init.body ? await new Response(init.body).text() : '';
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (isRecord(parsed)) body = parsed;
    } catch {
      // Not JSON: recorded and answered as an empty body.
    }
    bodies.push(body);
    const out = answer(responsesRequestKind(body), body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(fn as typeof fetch, { bodies });
}

/** An OpenAI-style error response, for `mockOpenAIResponsesFetch` answers. */
export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
