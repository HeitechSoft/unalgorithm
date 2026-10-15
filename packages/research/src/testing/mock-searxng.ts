import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SearchHit } from '../search.ts';

/**
 * A stand-in SearXNG instance for tests: answers `GET /search?format=json` in SearXNG's JSON shape and records each
 * query, so nothing searches the real web. Test code only: the extension never imports it.
 */

export interface MockSearxngOptions {
  /** Default: three hits on a.example, b.example and c.example (domains that never resolve). */
  hits?: (query: string) => SearchHit[];
}

export interface MockSearxng {
  /** `http://127.0.0.1:<port>`: the base URL to configure the SearXNG adapter with. */
  url: string;
  /** The `q` of every search, in order. */
  queries: string[];
  /** The next search answers with this status and raw body. Each call queues one failure. */
  failNext(status: number, body: string): void;
  close(): Promise<void>;
}

function defaultHits(query: string): SearchHit[] {
  const content = `Records show that ${query.slice(0, 80)}.`;
  return ['a', 'b', 'c'].map((letter, i) => ({
    url: `https://${letter}.example/record-${i + 1}`,
    title: `Record ${i + 1}`,
    snippet: content,
    published: null,
  }));
}

function send(res: ServerResponse, status: number, body: string): void {
  const json = /^\s*[[{]/.test(body);
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/plain; charset=utf-8' });
  res.end(body);
}

export async function startMockSearxng(opts: MockSearxngOptions = {}): Promise<MockSearxng> {
  const hits = opts.hits ?? defaultHits;
  const queries: string[] = [];
  const failures: { status: number; body: string }[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || url.pathname !== '/search') return send(res, 404, 'Not found.');
    // SearXNG answers 403 when the requested format isn't enabled.
    if (url.searchParams.get('format') !== 'json') return send(res, 403, 'Forbidden.');
    const query = url.searchParams.get('q') ?? '';
    queries.push(query);
    const failure = failures.shift();
    if (failure) return send(res, failure.status, failure.body);
    const results = hits(query).map((h) => ({
      url: h.url,
      title: h.title,
      content: h.snippet,
      publishedDate: h.published,
      engine: 'mock',
    }));
    send(res, 200, JSON.stringify({ query, number_of_results: results.length, results }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    queries,
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
