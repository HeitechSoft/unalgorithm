/**
 * The Firefox profile's only way out (ADR 0008): an HTTP proxy that Firefox's own prefs send every request through,
 * the extension background's included. WebDriver BiDi sees and intercepts only tab requests in Firefox, so this is
 * where the Firefox specs answer and record what the background sends, as Playwright's context routes do in Chromium.
 *
 * Nothing leaves the computer unless a test routes it. Plain HTTP goes to the first route that answers it (the most
 * recent first); with no route it is dropped. HTTPS arrives as `CONNECT host:443`: a host some route names gets the
 * connection decrypted with this run's self-signed certificate, which Firefox accepts because the session sets
 * `acceptInsecureCerts`, and its requests go through the same routes; any other host is refused with 403.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';

/** One request the proxy saw, plain HTTP or decrypted HTTPS, whatever happened to it. */
export interface EgressRequest {
  method: string;
  /** Absolute: `http://127.0.0.1:4100/v1/classify`, `https://api.anthropic.com/v1/messages`. */
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The body as text; empty without one. */
  body: string;
}

/** A canned answer. */
export interface EgressResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * What a route does with a request: forward it to its own address (plain HTTP only), abort it (the connection is
 * dropped, so the page or background sees a network error), answer it, or leave it to the next route (`undefined`).
 */
export type EgressAnswer = 'forward' | 'abort' | EgressResponse | undefined;
export type EgressHandler = (request: EgressRequest) => EgressAnswer | Promise<EgressAnswer>;

export interface EgressProxy {
  /** The port on 127.0.0.1 the profile's proxy prefs name. */
  port: number;
  /** Every request in the order it arrived, answered or not. */
  requests: EgressRequest[];
  /** Every `host:port` a CONNECT was refused for: HTTPS that would have left the computer. */
  refused: string[];
  /**
   * Sends requests whose URL starts with `prefix` (or matches the pattern) to `handler`. The newest route is asked
   * first. Returns a function that removes the route.
   */
  route(prefix: string | RegExp, handler: EgressHandler): () => void;
  close(): Promise<void>;
}

interface Route {
  matches(url: string): boolean;
  /** Whether a CONNECT to this host is let through and decrypted, so the route can see its requests. */
  covers(host: string): boolean;
  handler: EgressHandler;
}

/** The hosts the run's certificate names; a route for any other HTTPS host fails loudly. */
export const TLS_HOSTS = ['api.anthropic.com', 'api.openai.com', 'api.search.brave.com', 'cloud.unalgorithm.app'];

let certificate: { key: Buffer; cert: Buffer } | undefined;

/**
 * A self-signed certificate for `TLS_HOSTS`, made once per run with the openssl CLI (Node can't make one) in a
 * temporary folder that is deleted at once. Valid for a day; nothing trusts it but a session with `acceptInsecureCerts`.
 */
function runCertificate(): { key: Buffer; cert: Buffer } {
  if (certificate) return certificate;
  const dir = mkdtempSync(join(tmpdir(), 'ua-e2e-tls-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=unAlgorithm e2e',
        '-addext',
        `subjectAltName=${TLS_HOSTS.map((h) => `DNS:${h}`).join(',')}`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'pipe' },
    );
    certificate = { key: readFileSync(key), cert: readFileSync(cert) };
    return certificate;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function routeFor(prefix: string | RegExp, handler: EgressHandler): Route {
  if (typeof prefix !== 'string') {
    return { matches: (url) => prefix.test(url), covers: (host) => prefix.test(`https://${host}/`), handler };
  }
  const origin = URL.canParse(prefix) ? new URL(prefix).origin : undefined;
  return { matches: (url) => url.startsWith(prefix), covers: (host) => origin === `https://${host}`, handler };
}

/** Hop-by-hop headers a proxy must not pass on (RFC 9110 §7.6.1), plus the proxy's own. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export async function startEgressProxy(): Promise<EgressProxy> {
  const routes: Route[] = [];
  const requests: EgressRequest[] = [];
  const refused: string[] = [];
  const sockets = new Set<Socket>();
  /** The host each decrypted connection was opened for. */
  const tlsHosts = new WeakMap<Socket, string>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const tlsHost = tlsHosts.get(req.socket);
    // A proxied plain-HTTP request carries its absolute URL; a decrypted one only its path.
    const url = tlsHost ? `https://${tlsHost}${req.url ?? '/'}` : (req.url ?? '');
    const request: EgressRequest = { method: req.method ?? 'GET', url, headers: { ...req.headers }, body };
    requests.push(request);

    for (const route of [...routes].reverse()) {
      if (!route.matches(url)) continue;
      const answer = await route.handler(request);
      if (answer === undefined) continue;
      if (answer === 'abort') return void req.socket.destroy();
      if (answer === 'forward') return forward(request, res, Buffer.concat(chunks));
      res.writeHead(answer.status, answer.headers ?? {});
      return void res.end(answer.body ?? '');
    }
    req.socket.destroy();
  }

  /** Passes a plain-HTTP request on to its own address and the answer back. */
  function forward(request: EgressRequest, res: ServerResponse, body: Buffer): void {
    const target = new URL(request.url);
    if (target.protocol !== 'http:') throw new Error(`Only plain HTTP can be forwarded: ${request.url}`);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.once('error', () => res.socket?.destroy());
    upstream.end(body);
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => req.socket.destroy());
  };
  const server: Server = createServer(onRequest);
  /** Serves the decrypted connections; never listens itself. */
  const tlsServer: Server = createServer(onRequest);

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req: IncomingMessage, socket: Socket) => {
    const target = req.url ?? '';
    const host = target.replace(/:\d+$/, '');
    const routed = TLS_HOSTS.includes(host) && routes.some((r) => r.covers(host));
    if (!routed) {
      refused.push(target);
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const { key, cert } = runCertificate();
    const tls = new TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] });
    tlsHosts.set(tls, host);
    tls.once('error', () => socket.destroy());
    tlsServer.emit('connection', tls);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    requests,
    refused,
    route(prefix, handler) {
      const host = typeof prefix === 'string' && prefix.startsWith('https://') ? new URL(prefix).hostname : undefined;
      if (host && !TLS_HOSTS.includes(host)) throw new Error(`The run's certificate does not name ${host}; add it to TLS_HOSTS.`);
      const route = routeFor(prefix, handler);
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at !== -1) routes.splice(at, 1);
      };
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Firefox prefs that send every request of the profile, 127.0.0.1 included, through the proxy on `port`; the
 * extension background's requests honour them too.
 */
export function proxyPrefs(port: number): Record<string, unknown> {
  return {
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': port,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': port,
    'network.proxy.share_proxy_settings': false,
    'network.proxy.no_proxies_on': '',
    'network.proxy.allow_hijacking_localhost': true,
  };
}
