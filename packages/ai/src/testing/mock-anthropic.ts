import { fencedPosts } from './fenced-posts.ts';

/**
 * A stand-in for api.anthropic.com/v1/messages, shared by unit tests, the eval harness and the Chromium E2E. Pure
 * functions and a `fetch`, no `node:http`, so it runs in Vitest and inside Playwright routes alike. Usage numbers are
 * fixed so metering tests can assert exact amounts. Test code only: the extension never imports it.
 */

export type AnthropicRequestKind = 'classify' | 'claims' | 'research' | 'verdict' | 'story' | 'comparison' | 'unknown';

const STRUCTURED_USAGE = { input_tokens: 1000, output_tokens: 100 };
const RESEARCH_USAGE = { input_tokens: 20_000, output_tokens: 1500 };
const DEFAULT_SEARCHES = 3;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `tools` present → research; else by the top-level property of output_config.format.schema:
 *  `results` → classify, `claims` → claims, `verdicts` → verdict, `query` → story, `matched` → comparison. */
export function requestKind(body: unknown): AnthropicRequestKind {
  if (!isRecord(body)) return 'unknown';
  if (Array.isArray(body.tools) && body.tools.length) return 'research';
  const config = body.output_config;
  const format = isRecord(config) ? config.format : undefined;
  const schema = isRecord(format) ? format.schema : undefined;
  const props = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  if ('results' in props) return 'classify';
  if ('claims' in props) return 'claims';
  if ('verdicts' in props) return 'verdict';
  if ('query' in props) return 'story';
  if ('matched' in props) return 'comparison';
  return 'unknown';
}

function message(model: string, content: unknown[], stopReason: string, usage: Record<string, unknown>) {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  };
}

/** A structured-output answer carrying `json`. */
export function structuredMessage(json: unknown, opts: { model?: string } = {}): Record<string, unknown> {
  return message(
    opts.model ?? 'claude-haiku-5-5',
    [{ type: 'text', text: JSON.stringify(json), citations: null }],
    'end_turn',
    STRUCTURED_USAGE,
  );
}

/** A web-search research answer: one search with these results (and/or a failed search), then cited notes. */
export function researchMessage(opts: {
  results: { url: string; title: string; pageAge?: string | null }[];
  notes: { text: string; cites?: { url: string; citedText: string }[] }[];
  searches?: number;
  model?: string;
  stopReason?: 'end_turn' | 'pause_turn';
  searchError?: string;
}): Record<string, unknown> {
  const content: unknown[] = [
    { type: 'server_tool_use', id: 'srvtoolu_mock', name: 'web_search', input: { query: 'mock query' } },
  ];
  if (opts.results.length)
    content.push({
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_mock',
      content: opts.results.map((r, i) => ({
        type: 'web_search_result',
        url: r.url,
        title: r.title,
        page_age: r.pageAge ?? null,
        encrypted_content: `MOCK-ENCRYPTED-CONTENT-${i}`,
      })),
    });
  if (opts.searchError)
    content.push({
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_mock',
      content: { type: 'web_search_tool_result_error', error_code: opts.searchError },
    });
  for (const note of opts.notes)
    content.push({
      type: 'text',
      text: note.text,
      citations: note.cites?.length
        ? note.cites.map((c) => ({
            type: 'web_search_result_location',
            url: c.url,
            title: null,
            cited_text: c.citedText,
            encrypted_index: 'MOCK-ENCRYPTED-INDEX',
          }))
        : null,
    });
  return message(opts.model ?? 'claude-sonnet-5-5', content, opts.stopReason ?? 'end_turn', {
    ...RESEARCH_USAGE,
    server_tool_use: { web_search_requests: opts.searches ?? DEFAULT_SEARCHES },
  });
}

/** The text of the first user turn of a messages body. */
function userText(body: unknown): string {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
  const user: unknown = messages.find((m) => isRecord(m) && m.role === 'user');
  const content = isRecord(user) ? user.content : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : '')).join('');
}

/** Classification batch for the fenced posts in a classify request (reuses `fencedPosts`). */
export function classifyMessage(
  body: unknown,
  verdict: (postText: string) => { relevance: number; isNews: boolean; hasCheckableClaims: boolean },
): Record<string, unknown> {
  const results = fencedPosts(userText(body)).map(({ id, text }) => {
    const v = verdict(text);
    return {
      id,
      topics: ['other'],
      noise: [],
      reason: 'Test verdict.',
      relevance: v.relevance,
      isNews: v.isNews,
      hasCheckableClaims: v.hasCheckableClaims,
    };
  });
  const model = isRecord(body) && typeof body.model === 'string' ? body.model : undefined;
  return structuredMessage({ results }, model ? { model } : {});
}

/** A `fetch` that answers every request through `reply` and records each JSON body, in order. */
export function mockAnthropicFetch(
  reply: (body: Record<string, unknown>, kind: AnthropicRequestKind) => { status: number; body: unknown },
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
    const out = reply(body, requestKind(body));
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(fn as typeof fetch, { bodies });
}
