import { once } from 'node:events';
import { createServer, globalAgent, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEgress,
  deniedAddress,
  type EgressOptions,
  nodeSend,
  type ProbeOutcome,
  type SendRequest,
  type SendResult,
} from '../src/net/egress.ts';

/** The two reviewed public stand-ins (scripts/ip-allowlist.txt); every other address is a documentation or special one. */
const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '93.184.216.35';
const DOC_ADDRESS = '192.0.2.1';

type Answer = { address: string; family: 4 | 6 };
const answer = (address: string): Answer => ({ address, family: address.includes(':') ? 6 : 4 });

/** A fake resolver and transport around createEgress: nothing leaves the process. */
function harness(
  dns: Record<string, string[]>,
  reply: (req: SendRequest) => SendResult | Promise<SendResult> = () => ({ status: 200, location: null }),
  options: Partial<EgressOptions> = {},
) {
  const lookups: string[] = [];
  const sends: SendRequest[] = [];
  const egress = createEgress({
    publicUrl: 'https://srv.test',
    version: '0.1.0',
    resolve: async (host) => {
      lookups.push(host);
      const answers = { 'srv.test': [DOC_ADDRESS], ...dns }[host];
      if (!answers) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return answers.map(answer);
    },
    send: async (req) => {
      sends.push(req);
      return reply(req);
    },
    ...options,
  });
  return { egress, lookups, sends };
}

const refused = (reason: string): ProbeOutcome => ({ kind: 'refused', reason }) as ProbeOutcome;

describe('SSRF suite', () => {
  it('test_egress_refuses_private_and_special_addresses', async () => {
    const addresses = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '0.0.0.0',
      '0.1.2.3',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::FFFF:A9FE:A9FE',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::1',
      '::ffff:0:7f00:1',
      '172.17.0.1',
    ];
    for (const address of addresses) {
      const literal = address.includes(':') ? `http://[${address}]/` : `http://${address}:80/`;
      const { egress, sends } = harness({ 'evil.test': [address] });
      expect([address, await egress.probe(literal)]).toEqual([address, refused('address')]);
      expect([address, await egress.probe('http://evil.test/')]).toEqual([address, refused('address')]);
      expect(sends).toEqual([]);
    }
    const { egress, sends, lookups } = harness({});
    for (const url of ['http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://0x7f.1/', 'http://2130706433/']) {
      expect([url, await egress.probe(url)]).toEqual([url, refused('address')]);
    }
    expect(sends).toEqual([]);
    // Literals never go to DNS.
    expect(lookups.filter((host) => host !== 'srv.test')).toEqual([]);
    // Unparseable text is denied; the public stand-in is not.
    expect([deniedAddress('not-an-ip'), deniedAddress('fe80::1%eth0'), deniedAddress(PUBLIC_A)]).toEqual([true, true, false]);
  });

  it('test_egress_refuses_ports_other_than_80_and_443', async () => {
    const { egress, sends } = harness({});
    expect(await egress.probe('http://172.17.0.1:3000/')).toEqual(refused('port'));
    expect(await egress.probe(`http://${PUBLIC_A}:8443/`)).toEqual(refused('port'));
    expect(sends).toEqual([]);
    // The rule is the port list: http on 443 and https on 80 are allowed.
    expect(await egress.probe(`http://${PUBLIC_A}:443/`)).toEqual({ kind: 'status', status: 200 });
    expect(await egress.probe(`https://${PUBLIC_A}:80/`)).toEqual({ kind: 'status', status: 200 });
  });

  it('test_egress_refuses_host_public_ip_and_egress_deny', async () => {
    const own = harness({ 'srv.test': [PUBLIC_A], 'ok.test': [PUBLIC_A] });
    expect(await own.egress.probe('https://ok.test/')).toEqual(refused('address'));
    expect(await own.egress.probe(`http://[::ffff:${PUBLIC_A}]/`)).toEqual(refused('address'));
    expect(own.sends).toEqual([]);

    const deny = harness({ 'a.test': [PUBLIC_A], 'b.test': [PUBLIC_B] }, undefined, { deny: [`${PUBLIC_B}/32`] });
    expect(await deny.egress.probe('https://b.test/')).toEqual(refused('address'));
    expect(await deny.egress.probe('https://a.test/')).toEqual({ kind: 'status', status: 200 });
    expect(deny.sends.map((s) => s.address)).toEqual([PUBLIC_A]);
    expect(() => harness({}, undefined, { deny: ['not-an-ip'] })).toThrow(/entry 1/);

    // The host's own address never passes because its lookup failed.
    const dark = harness({ 'ok.test': [PUBLIC_A] }, undefined, { publicUrl: 'https://dark.test' });
    expect(await dark.egress.probe('https://ok.test/')).toEqual(refused('unresolved'));
    expect(await dark.egress.probe(`https://${PUBLIC_A}/`)).toEqual(refused('unresolved'));
    expect(dark.sends).toEqual([]);

    // Resolved once per 5 minutes.
    const cached = harness({ 'ok.test': [PUBLIC_A] });
    await cached.egress.probe('https://ok.test/');
    await cached.egress.probe('https://ok.test/');
    expect(cached.lookups.filter((h) => h === 'srv.test')).toHaveLength(1);
  });

  it('test_egress_refuses_mixed_dns_answers', async () => {
    const { egress, sends } = harness({ 'mixed.test': [PUBLIC_A, '10.0.0.5'] });
    expect(await egress.probe('https://mixed.test/')).toEqual(refused('address'));
    expect(sends).toEqual([]);
  });

  it('test_egress_refuses_bad_schemes_and_credentials', async () => {
    const { egress, sends } = harness({ 'ok.test': [PUBLIC_A] });
    for (const url of ['ftp://ok.test/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect([url, await egress.probe(url)]).toEqual([url, refused('scheme')]);
    }
    expect(await egress.probe('https://user:pw@ok.test/')).toEqual(refused('credentials'));
    expect(await egress.probe('https://user@ok.test/')).toEqual(refused('credentials'));
    expect(sends).toEqual([]);
  });

  it('test_egress_pins_resolved_address', async () => {
    const { egress, sends, lookups } = harness({ 'ok.test': [PUBLIC_B, PUBLIC_A], 'ok2.test': [PUBLIC_A, PUBLIC_B] }, (req) =>
      req.url.hostname === 'ok.test' ? { status: 301, location: 'https://ok2.test/next' } : { status: 200, location: null },
    );
    expect(await egress.probe('https://ok.test/a')).toEqual({ kind: 'status', status: 200 });
    expect(sends.map((s) => [s.url.href, s.address, s.family, s.method])).toEqual([
      ['https://ok.test/a', PUBLIC_B, 4, 'HEAD'],
      ['https://ok2.test/next', PUBLIC_A, 4, 'HEAD'],
    ]);
    expect(lookups.filter((h) => h === 'ok.test')).toHaveLength(1);
    expect(lookups.filter((h) => h === 'ok2.test')).toHaveLength(1);
    expect(sends[0]?.userAgent).toBe('UnAlgorithm-LinkCheck/0.1.0 (+https://srv.test)');
  });

  it('test_egress_rechecks_every_redirect', async () => {
    const internal = harness({ 'ok.test': [PUBLIC_A] }, () => ({ status: 302, location: 'http://10.0.0.1/' }));
    expect(await internal.egress.probe('https://ok.test/')).toEqual(refused('address'));
    expect(internal.sends).toHaveLength(1);

    const followed = harness({ 'ok.test': [PUBLIC_A], 'ok2.test': [PUBLIC_B] }, (req) =>
      req.url.hostname === 'ok.test' ? { status: 302, location: 'https://ok2.test/x' } : { status: 200, location: null },
    );
    expect(await followed.egress.probe('https://ok.test/')).toEqual({ kind: 'status', status: 200 });
    expect(followed.sends.map((s) => [s.url.href, s.address])).toEqual([
      ['https://ok.test/', PUBLIC_A],
      ['https://ok2.test/x', PUBLIC_B],
    ]);

    // Relative locations resolve against the hop; the fourth redirect is refused.
    const loop = harness({ 'ok.test': [PUBLIC_A] }, (req) => ({ status: 307, location: `/r${req.url.pathname.length}` }));
    expect(await loop.egress.probe('https://ok.test/')).toEqual(refused('redirects'));
    expect(loop.sends).toHaveLength(4);
  });

  it('test_egress_head_then_get_on_405', async () => {
    const { egress, sends } = harness({ 'ok.test': [PUBLIC_A] }, (req) => ({
      status: req.method === 'HEAD' ? 405 : 200,
      location: null,
    }));
    expect(await egress.probe('https://ok.test/')).toEqual({ kind: 'status', status: 200 });
    expect(sends.map((s) => [s.method, s.address])).toEqual([
      ['HEAD', PUBLIC_A],
      ['GET', PUBLIC_A],
    ]);
    // Retried once only.
    const twice = harness({ 'ok.test': [PUBLIC_A] }, () => ({ status: 501, location: null }));
    expect(await twice.egress.probe('https://ok.test/')).toEqual({ kind: 'status', status: 501 });
    expect(twice.sends).toHaveLength(2);
  });
});

describe('link check', () => {
  it('test_check_links_status_mapping_and_limits', async () => {
    const statusOf: Record<string, number> = { '/ok': 200, '/gone': 404, '/removed': 410, '/busy': 503, '/moved': 304 };
    const never = new Promise<SendResult>(() => {});
    const { egress, sends } = harness(
      { 'ok.test': [PUBLIC_A], 'evil.test': ['10.0.0.1'] },
      (req) => (req.url.pathname === '/slow' ? never : { status: statusOf[req.url.pathname] ?? 200, location: null }),
      { timeoutMs: 50 },
    );
    const urls = [
      'https://ok.test/ok',
      'https://ok.test/gone',
      'https://ok.test/removed',
      'https://evil.test/x',
      'https://nx.test/x',
      'https://ok.test/busy',
      'https://ok.test/slow',
      'https://ok.test/ok',
      'https://ok.test/moved',
    ];
    const result = await egress.checkLinks(urls, new AbortController().signal);
    expect(Object.fromEntries(result)).toEqual({
      'https://ok.test/ok': 'live',
      'https://ok.test/gone': 'dead',
      'https://ok.test/removed': 'dead',
      'https://evil.test/x': 'dead',
      'https://nx.test/x': 'unknown',
      'https://ok.test/busy': 'unknown',
      'https://ok.test/slow': 'unknown',
      'https://ok.test/moved': 'live',
    });
    // Duplicates are probed once.
    expect(sends.filter((s) => s.url.pathname === '/ok')).toHaveLength(1);

    // At most 12 probed, 4 at a time; a 13th is unknown without a probe.
    let inFlight = 0;
    let peak = 0;
    const many = harness({ 'ok.test': [PUBLIC_A] }, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { status: 200, location: null };
    });
    const thirteen = Array.from({ length: 13 }, (_, i) => `https://ok.test/p${i}`);
    const limited = await many.egress.checkLinks(thirteen, new AbortController().signal);
    expect(many.sends.map((s) => s.url.href)).toEqual(thirteen.slice(0, 12));
    expect(limited.get(thirteen[12] ?? '')).toBe('unknown');
    expect([...limited.values()].filter((s) => s === 'live')).toHaveLength(12);
    expect(peak).toBe(4);
  });

  it('test_check_links_abort_leaves_unfinished_unknown', async () => {
    const controller = new AbortController();
    const { egress, sends } = harness({ 'ok.test': [PUBLIC_A] }, (req) =>
      req.url.pathname === '/ok' ? { status: 200, location: null } : new Promise<SendResult>(() => {}),
    );
    const urls = ['https://ok.test/ok', ...Array.from({ length: 5 }, (_, i) => `https://ok.test/hang${i}`)];
    const pending = egress.checkLinks(urls, controller.signal);
    await vi.waitFor(() => expect(sends.filter((s) => s.url.pathname !== '/ok')).toHaveLength(4));
    controller.abort();
    const result = await pending;
    expect(result.get('https://ok.test/ok')).toBe('live');
    expect(urls.slice(1).map((u) => result.get(u))).toEqual(Array(5).fill('unknown'));
    expect(sends).toHaveLength(5);
  });
});

describe('resolve', () => {
  const ARTICLE = 'https://news.example.com/a?utm_source=y';

  it('test_resolve_no_redirect', async () => {
    const { egress, sends } = harness({ 'news.example.com': [PUBLIC_A] });
    expect(await egress.resolve(ARTICLE)).toEqual({ kind: 'resolved', url: ARTICLE, status: 200, hops: 0 });
    expect(sends).toHaveLength(1);
  });

  it('test_resolve_follows_pinned_redirects', async () => {
    const { egress, sends } = harness({ 'short.example': [PUBLIC_B], 'news.example.com': [PUBLIC_A] }, (req) =>
      req.url.hostname === 'short.example' ? { status: 301, location: ARTICLE } : { status: 200, location: null },
    );
    expect(await egress.resolve('https://short.example/x')).toEqual({ kind: 'resolved', url: ARTICLE, status: 200, hops: 1 });
    expect(sends.map((s) => [s.url.href, s.address, s.method])).toEqual([
      ['https://short.example/x', PUBLIC_B, 'HEAD'],
      [ARTICLE, PUBLIC_A, 'HEAD'],
    ]);
  });

  it('test_resolve_final_status_any', async () => {
    const { egress } = harness({ 'short.example': [PUBLIC_B], 'news.example.com': [PUBLIC_A] }, (req) =>
      req.url.hostname === 'short.example' ? { status: 302, location: ARTICLE } : { status: 403, location: null },
    );
    expect(await egress.resolve('https://short.example/x')).toEqual({ kind: 'resolved', url: ARTICLE, status: 403, hops: 1 });
    // A redirect status without a Location is the end of the chain, reported as it is.
    const bare = harness({ 'news.example.com': [PUBLIC_A] }, () => ({ status: 302, location: null }));
    expect(await bare.egress.resolve(ARTICLE)).toEqual({ kind: 'resolved', url: ARTICLE, status: 302, hops: 0 });
  });

  it('test_resolve_refuses_private_redirect_targets', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::ffff:127.0.0.1']) {
      const { egress, sends } = harness({ 'short.example': [PUBLIC_B], 'inside.example': [address] }, () => ({
        status: 302,
        location: 'https://inside.example/secret',
      }));
      expect([address, await egress.resolve('https://short.example/x')]).toEqual([address, refused('address')]);
      expect(sends.map((s) => s.url.hostname)).toEqual(['short.example']);
      expect(await egress.resolveLink('https://short.example/x', new AbortController().signal)).toBeNull();
    }
  });

  it('test_resolve_refuses_scheme_port_and_too_many_redirects', async () => {
    const to = (location: string) =>
      harness({ 'short.example': [PUBLIC_B], 'news.example.com': [PUBLIC_A] }, (req) =>
        req.url.hostname === 'short.example' ? { status: 301, location } : { status: 200, location: null },
      );
    const ftp = to('ftp://news.example.com/a');
    expect(await ftp.egress.resolve('https://short.example/x')).toEqual(refused('scheme'));
    const port = to('https://news.example.com:8080/a');
    expect(await port.egress.resolve('https://short.example/x')).toEqual(refused('port'));
    for (const h of [ftp, port]) expect(h.sends).toHaveLength(1);

    const loop = harness({ 'short.example': [PUBLIC_B] }, (req) => ({ status: 307, location: `/r${req.url.pathname.length}` }));
    expect(await loop.egress.resolve('https://short.example/x')).toEqual(refused('redirects'));
    expect(loop.sends).toHaveLength(4);
  });

  it('test_resolve_failures_and_abort', async () => {
    const dns = { 'short.example': [PUBLIC_B], 'news.example.com': [PUBLIC_A] };
    const rejecting = harness(dns, () => Promise.reject(new Error('ECONNRESET')));
    expect(await rejecting.egress.resolve(ARTICLE)).toEqual({ kind: 'failed' });

    const slow = harness(dns, () => new Promise<SendResult>(() => {}), { timeoutMs: 30 });
    expect(await slow.egress.resolve(ARTICLE)).toEqual({ kind: 'failed' });

    // The timeout covers every hop: a redirect then a hang still fails.
    const slowSecond = harness(
      dns,
      (req) => (req.url.hostname === 'short.example' ? { status: 301, location: ARTICLE } : new Promise<SendResult>(() => {})),
      { timeoutMs: 30 },
    );
    expect(await slowSecond.egress.resolve('https://short.example/x')).toEqual({ kind: 'failed' });

    const badLocation = harness(dns, () => ({ status: 302, location: 'http://[bad' }));
    expect(await badLocation.egress.resolve(ARTICLE)).toEqual({ kind: 'failed' });

    const controller = new AbortController();
    controller.abort();
    const aborted = harness(dns);
    expect(await aborted.egress.resolve(ARTICLE, controller.signal)).toEqual({ kind: 'failed' });
    expect(aborted.sends).toEqual([]);

    // Aborted while the first hop is in flight: no request to the redirect target follows.
    const midway = new AbortController();
    const hanging = harness(dns, () => new Promise<SendResult>(() => {}));
    const pending = hanging.egress.resolve('https://short.example/x', midway.signal);
    await vi.waitFor(() => expect(hanging.sends).toHaveLength(1));
    midway.abort();
    expect(await pending).toEqual({ kind: 'failed' });
    expect(hanging.sends).toHaveLength(1);
  });

  it('test_resolve_link_never_throws', async () => {
    const signal = () => new AbortController().signal;
    const ok = harness({ 'short.example': [PUBLIC_B], 'news.example.com': [PUBLIC_A] }, (req) =>
      req.url.hostname === 'short.example' ? { status: 301, location: ARTICLE } : { status: 200, location: null },
    );
    expect(await ok.egress.resolveLink('https://short.example/x', signal())).toBe(ARTICLE);
    expect(await ok.egress.resolveLink('ftp://short.example/x', signal())).toBeNull();
    expect(await ok.egress.resolveLink('not a url', signal())).toBeNull();

    const failing = harness({ 'news.example.com': [PUBLIC_A] }, () => Promise.reject(new Error('boom')));
    expect(await failing.egress.resolveLink(ARTICLE, signal())).toBeNull();

    // Even a resolver that throws synchronously never rejects.
    const throwing = createEgress({
      publicUrl: 'https://srv.test',
      version: '0.1.0',
      resolve: () => {
        throw new Error('sync');
      },
      send: () => {
        throw new Error('sync');
      },
    });
    await expect(throwing.resolveLink(ARTICLE, signal())).resolves.toBeNull();
  });
});

describe('transport', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  it('test_node_send_pins_address_and_reads_status_only', async () => {
    let connections = 0;
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://elsewhere.invalid/next' });
        res.end();
      } else {
        // Headers, then a body that never ends.
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('partial');
      }
    });
    server.on('connection', () => connections++);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    // The shared keep-alive agent is never used: its pool is keyed by host and port, not by the pinned address.
    const pooled = vi.spyOn(globalAgent, 'createConnection');

    const send = (path: string) =>
      nodeSend({
        url: new URL(`http://pinned.invalid:${port}${path}`),
        address: '127.0.0.1',
        family: 4,
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
        userAgent: 'UnAlgorithm-LinkCheck/0.1.0 (+https://srv.test)',
      });

    expect(await send('/redirect')).toEqual({ status: 302, location: 'http://elsewhere.invalid/next' });
    const getHang = await nodeSend({
      url: new URL(`http://pinned.invalid:${port}/hang`),
      address: '127.0.0.1',
      family: 4,
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
      userAgent: 'UnAlgorithm-LinkCheck/0.1.0 (+https://srv.test)',
    });
    expect(getHang).toEqual({ status: 200, location: null });

    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers['user-agent']).toBe('UnAlgorithm-LinkCheck/0.1.0 (+https://srv.test)');
      expect(headers.accept).toBe('*/*');
      expect(headers.host).toBe(`pinned.invalid:${port}`);
    }
    // A fresh connection per request: no pooled socket is reused.
    expect(connections).toBe(2);
    expect(pooled).not.toHaveBeenCalled();
    pooled.mockRestore();
  });
});
