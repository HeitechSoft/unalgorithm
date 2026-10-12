import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { NoiseLabel } from '@unalgorithm/protocol';

/**
 * A stand-in OpenAI-compatible provider for tests and local development. It reads the fenced posts out of the user
 * turn and answers each with a verdict, so nothing calls a real model. Test code only: the extension never imports it.
 *
 * Run it on its own with `node packages/ai/src/testing/mock-openai-server.ts --port 8788`.
 */

export interface MockVerdict {
  relevance: number;
  noise: NoiseLabel[];
  topics: string[];
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

/** Matches `buildUserPrompt`'s fenced posts: the id and the text of each. */
const POST_TAG = /<post_\w+ id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/post_/g;

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
    const results = [...user.matchAll(POST_TAG)].map(([, id, text = '']) => {
      const v = verdict(text);
      return {
        id,
        topics: v.topics,
        noise: v.noise,
        reason: 'Test verdict.',
        relevance: v.relevance,
        isNews: false,
        hasCheckableClaims: false,
      };
    });
    send(
      res,
      200,
      JSON.stringify({
        model,
        choices: [{ message: { content: JSON.stringify({ results }) }, finish_reason: 'stop' }],
        // Fixed numbers so metering tests can assert exact usage.
        usage: { prompt_tokens: 1000, completion_tokens: 50 * results.length },
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
