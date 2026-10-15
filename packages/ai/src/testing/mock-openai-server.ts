import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { NoiseLabel } from '@unalgorithm/protocol';
import { fencedPosts } from './fenced-posts.ts';

/**
 * A stand-in OpenAI-compatible provider for tests and local development. It reads the fenced posts out of the user
 * turn and answers each with a verdict, so nothing calls a real model. Test code only: the extension never imports it.
 *
 * It answers the fact-check prompts too, told apart by their wording (so on every response format): the claims prompt
 * gets the first sentence of the fenced post as its one claim, and the verdict prompt one `supported` verdict per claim,
 * citing the first two sources with the first 8 words of each source's text. It answers the perspectives prompts the same
 * way: the story prompt gets the fenced link title as its query, and the comparison prompt matches every source and
 * returns one agreed point citing the first two sources.
 *
 * Run it on its own with `node packages/ai/src/testing/mock-openai-server.ts --port 8788`.
 */

export interface MockVerdict {
  relevance: number;
  noise: NoiseLabel[];
  topics: string[];
  /** Default false. */
  isNews?: boolean;
  /** Default false. */
  hasCheckableClaims?: boolean;
}

export interface MockOpenAIOptions {
  /** Default 0: a random free port. */
  port?: number;
  /** Default '127.0.0.1'. */
  host?: string;
  /** Default 'mock-model'. */
  model?: string;
  /** Default: posts about automation or AI score 92, everything else 40. */
  verdict?: (postText: string) => MockVerdict;
}

export interface MockOpenAI {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** `${url}/v1` */
  baseUrl: string;
  /** Raw JSON body of every chat/completions request, in order. */
  bodies: string[];
  /** The next chat/completions call answers with this status and raw body. Each call queues one failure. */
  failNext(status: number, body: string): void;
  close(): Promise<void>;
}

/** Words of `buildClaimsUser` and `buildVerdictUser` (packages/research) that tell the fact-check prompts apart. */
export const CLAIMS_PHRASE = 'Pick out the checkable factual claims';
export const VERDICT_PHRASE = 'Judge these';
/** Words of `buildStoryUser` and `buildComparisonUser` (packages/research) that tell the perspectives prompts apart. */
export const STORY_PHRASE = 'Write a neutral search query';
export const COMPARISON_PHRASE = 'Compare how these sources';
const LINK_TAG = /<link_\w+[^>]*>\n([\s\S]*?)\n<\/link_/;
const FACTCHECK_POST_TAG = /<post_\w+[^>]*>\n([\s\S]*?)\n<\/post_/;
const CLAIM_TAG = /<claim_\w+ id="(c\d+)">/g;
const SOURCE_TAG = /<source_\w+ id="(s\d+)"[^>]*>\n([^\n]*)/g;

/** One claim: the first sentence of the fenced post, at most 200 characters. */
function claimsOf(user: string): { claim: string }[] {
  const text = FACTCHECK_POST_TAG.exec(user)?.[1]?.trim() ?? '';
  const first = (/^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text).slice(0, 200).trim();
  return first ? [{ claim: first }] : [];
}

/** One `supported` verdict per claim tag, citing the first two source tags with the first 8 words of each one's text. */
function verdictsOf(user: string) {
  const citations = firstTwoCitations(user);
  return [...user.matchAll(CLAIM_TAG)].map(([, claimId = '']) => ({
    claimId,
    verdict: 'supported',
    explanation: 'Test verdict.',
    citations,
  }));
}

/** The first two source tags, each cited with the first 8 words of its text. */
function firstTwoCitations(user: string) {
  return [...user.matchAll(SOURCE_TAG)].slice(0, 2).map(([, sourceId = '', text = '']) => ({
    sourceId,
    quote: text.trim().split(/\s+/).slice(0, 8).join(' '),
  }));
}

/** Every source matched, one agreed point citing the first two sources. */
function comparisonOf(user: string) {
  return {
    matched: [...user.matchAll(SOURCE_TAG)].map(([, id = '']) => id),
    agreed: [{ text: 'Test agreement.', citations: firstTwoCitations(user) }],
    differences: [],
    unique: [],
  };
}

function defaultVerdict(text: string): MockVerdict {
  const onTopic = /automat|AI/i.test(text);
  return { relevance: onTopic ? 92 : 40, noise: [], topics: onTopic ? ['automation'] : ['other'] };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  const json = /^\s*[[{]/.test(body);
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8' });
  res.end(body);
}

/** The user turn of a chat/completions body, or undefined when the body is not one. */
function userTurn(body: string): string | undefined {
  try {
    const messages = (JSON.parse(body) as { messages?: { role: string; content: unknown }[] }).messages;
    const content = messages?.find((m) => m.role === 'user')?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return undefined;
  }
}

export async function startMockOpenAI(opts: MockOpenAIOptions = {}): Promise<MockOpenAI> {
  const host = opts.host ?? '127.0.0.1';
  const model = opts.model ?? 'mock-model';
  const verdict = opts.verdict ?? defaultVerdict;
  const bodies: string[] = [];
  const failures: { status: number; body: string }[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && path.endsWith('/models')) return send(res, 200, JSON.stringify({ data: [{ id: model }] }));
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      return send(res, 404, JSON.stringify({ error: { message: 'Not found.' } }));
    }
    bodies.push(body);
    const failure = failures.shift();
    if (failure) return send(res, failure.status, failure.body);
    const user = userTurn(body);
    if (user === undefined) return send(res, 400, JSON.stringify({ error: { message: 'The body is not JSON.' } }));
    if (user.includes(CLAIMS_PHRASE)) {
      const claims = claimsOf(user);
      return answer(res, { claims }, claims.length);
    }
    if (user.includes(VERDICT_PHRASE)) {
      const verdicts = verdictsOf(user);
      return answer(res, { verdicts }, verdicts.length);
    }
    if (user.includes(STORY_PHRASE)) {
      const title = LINK_TAG.exec(user)?.[1]?.trim() ?? '';
      return answer(res, { query: title === '(no title)' ? '' : title }, 1);
    }
    if (user.includes(COMPARISON_PHRASE)) {
      const comparison = comparisonOf(user);
      return answer(res, comparison, comparison.matched.length);
    }
    const results = fencedPosts(user).map(({ id, text }) => {
      const v = verdict(text);
      return {
        id,
        topics: v.topics,
        noise: v.noise,
        reason: 'Test verdict.',
        relevance: v.relevance,
        isNews: v.isNews ?? false,
        hasCheckableClaims: v.hasCheckableClaims ?? false,
      };
    });
    answer(res, { results }, results.length);
  }

  /** A completion carrying `json`; fixed usage numbers so metering tests can assert exact amounts. */
  function answer(res: ServerResponse, json: unknown, items: number): void {
    send(
      res,
      200,
      JSON.stringify({
        model,
        choices: [{ message: { content: JSON.stringify(json) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 * items },
      }),
    );
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

  let closed: Promise<void> | undefined;
  return {
    url,
    baseUrl: `${url}/v1`,
    bodies,
    failNext(status, body) {
      failures.push({ status, body });
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets from fetch would otherwise hold the port open.
        server.closeAllConnections();
      });
      return closed;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--port');
  const port = at > 0 ? Number(process.argv[at + 1]) : 8788;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error('Usage: node packages/ai/src/testing/mock-openai-server.ts [--port 8788]');
    process.exit(1);
  }
  startMockOpenAI({ port }).then(
    (mock) => console.log(`mock AI provider on ${mock.baseUrl}`),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
