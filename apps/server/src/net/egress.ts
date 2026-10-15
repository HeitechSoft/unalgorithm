/**
 * The one SSRF-safe egress fetcher (R51, brought forward into RM2): a URL a search engine, and so anyone on the web,
 * chose is probed for its status only. Every hop is checked and pinned before a connection: http(s) on 80/443 only, no
 * credentials, every DNS answer outside the denied ranges and the host's own addresses, the first answer pinned so the
 * hop never resolves again, redirects re-checked. Nothing is logged (URLs can carry claim words) and no body is read.
 *
 * Admin-configured fetches (alert webhook, search provider, AI endpoint) stay exempt and never come through here.
 */
import { promises as dnsPromises } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, isIPv4 } from 'node:net';
import type { LinkStatus } from '@unalgorithm/protocol';

export type EgressRefusal = 'scheme' | 'credentials' | 'port' | 'address' | 'unresolved' | 'redirects';
export type ProbeOutcome = { kind: 'status'; status: number } | { kind: 'refused'; reason: EgressRefusal } | { kind: 'failed' };
export interface SendRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  method: 'HEAD' | 'GET';
  signal: AbortSignal;
  userAgent: string;
}
export interface SendResult {
  status: number;
  location: string | null;
}
export interface EgressOptions {
  /** PUBLIC_URL: its host's addresses are refused too, and it is named in the User-Agent. */
  publicUrl: string;
  /** EGRESS_DENY (P3-14): more IPs or CIDR ranges to refuse. */
  deny?: readonly string[];
  version: string;
  /** Default: dns.promises.lookup(host, { all: true, verbatim: true }). */
  resolve?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
  /** Default: nodeSend. */
  send?: (req: SendRequest) => Promise<SendResult>;
  /** Per probe, all hops included. Default 5_000. */
  timeoutMs?: number;
  /** Default 3. */
  maxRedirects?: number;
}
export interface Egress {
  probe(url: string, signal?: AbortSignal): Promise<ProbeOutcome>;
  /** P3-11's LinkChecker. */
  checkLinks(urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, LinkStatus>>;
}

/** At most this many distinct URLs are probed per check; the rest stay `unknown`. */
const MAX_LINKS = 12;
const LINK_CONCURRENCY = 4;
/** How long the `publicUrl` host's addresses are cached. */
const PUBLIC_ADDRESS_TTL_MS = 5 * 60_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const DENIED_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];
const DENIED_V6 = [
  '::/128',
  '::1/128',
  '::/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2001:db8::/32',
  '2002::/16',
  '3fff::/20',
  'fc00::/7',
  'fe80::/10',
  'fec0::/10',
  'ff00::/8',
];

interface Canonical {
  family: 4 | 6;
  text: string;
}

/** The eight hextets of a valid IPv6 text (zone-free), or null. */
function hextets(text: string): number[] | null {
  let s = text;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => Number.parseInt(g, 16));
}

/** The address as checked: IPv4-mapped IPv6 becomes IPv4; IPv6 is written out in full. Null when unparseable. */
function canonical(address: string): Canonical | null {
  if (address.includes('%')) return null;
  const family = isIP(address);
  if (family === 4) return { family: 4, text: address };
  if (family !== 6) return null;
  const h = hextets(address);
  if (!h) return null;
  if (h.slice(0, 5).every((g) => g === 0) && h[5] === 0xffff) {
    const [hi = 0, lo = 0] = h.slice(6);
    return { family: 4, text: [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.') };
  }
  return { family: 6, text: h.map((g) => g.toString(16)).join(':') };
}

function subnetList(ranges: readonly string[], type: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const range of ranges) {
    const [net = '', prefix = ''] = range.split('/');
    list.addSubnet(net, Number(prefix), type);
  }
  return list;
}

const deniedV4 = subnetList(DENIED_V4, 'ipv4');
const deniedV6 = subnetList(DENIED_V6, 'ipv6');

function inList(list: BlockList, c: Canonical): boolean {
  return list.check(c.text, c.family === 4 ? 'ipv4' : 'ipv6');
}

/** True when `address` (IPv4 or IPv6 text) may never be reached. Unparseable text is denied. */
export function deniedAddress(address: string, extra?: BlockList): boolean {
  const c = canonical(address.trim().toLowerCase());
  if (!c) return true;
  if (c.family === 4) {
    if (deniedV4.check(c.text, 'ipv4')) return true;
  } else {
    // Only global unicast (2000::/3) may pass, so an embedding or special range missing from the list is denied.
    const first = Number.parseInt(c.text.split(':')[0] ?? '0', 16);
    if ((first & 0xe000) !== 0x2000) return true;
    if (deniedV6.check(c.text, 'ipv6')) return true;
  }
  return extra ? inList(extra, c) : false;
}

/** EGRESS_DENY entries (an IP or `ip/prefix`) as a BlockList; a bad entry throws without echoing it. */
export function denyList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  entries.forEach((entry, i) => {
    const [ip = '', prefix, ...more] = entry.trim().split('/');
    const c = canonical(ip.toLowerCase());
    const max = c?.family === 4 ? 32 : 128;
    const bits = prefix === undefined ? max : /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
    if (!c || more.length || !(bits >= 0 && bits <= max))
      throw new Error(`egress deny entry ${i + 1} is not an IP or CIDR range`);
    list.addSubnet(c.text, bits, c.family === 4 ? 'ipv4' : 'ipv6');
  });
  return list;
}

/** `URL.hostname` keeps the brackets on an IPv6 literal: `[::1]` → `::1`. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function defaultResolve(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
  const answers = await dnsPromises.lookup(host, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

class Aborted extends Error {}

/** Settles with `promise`, or rejects with Aborted as soon as `signal` aborts (a hung lookup or send cannot hold a probe). */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

type HopCheck = { ok: true; address: string; family: 4 | 6 } | { ok: false; reason: EgressRefusal };

export function createEgress(opts: EgressOptions): Egress {
  const resolve = opts.resolve ?? defaultResolve;
  const send = opts.send ?? nodeSend;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const extra = denyList(opts.deny ?? []);
  const publicUrl = new URL(opts.publicUrl);
  const publicHost = bareHost(publicUrl.hostname);
  const userAgent = `UnAlgorithm-LinkCheck/${opts.version} (+${opts.publicUrl})`;

  let ownCache: { list: BlockList; at: number } | null = null;
  /** The `publicUrl` host's addresses, resolved at most once per 5 minutes; null when they were never resolved. */
  async function ownAddresses(signal: AbortSignal): Promise<BlockList | null> {
    if (ownCache && Date.now() - ownCache.at < PUBLIC_ADDRESS_TTL_MS) return ownCache.list;
    let answers: { address: string }[];
    if (isIP(publicHost)) answers = [{ address: publicHost }];
    else {
      try {
        answers = await raceAbort(resolve(publicHost), signal);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        answers = [];
      }
    }
    const list = new BlockList();
    let added = 0;
    for (const { address } of answers) {
      const c = canonical(address.toLowerCase());
      if (!c) continue;
      list.addAddress(c.text, c.family === 4 ? 'ipv4' : 'ipv6');
      added++;
    }
    // A failed lookup never lets the host's own address through: a stale answer is kept, else the hop is refused.
    if (!added) return ownCache?.list ?? null;
    ownCache = { list, at: Date.now() };
    return list;
  }

  async function checkHop(url: URL, signal: AbortSignal): Promise<HopCheck> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
    if (url.username || url.password) return { ok: false, reason: 'credentials' };
    if (url.port !== '' && url.port !== '80' && url.port !== '443') return { ok: false, reason: 'port' };

    const host = bareHost(url.hostname);
    const literal = isIP(host);
    let answers: { address: string; family: 4 | 6 }[];
    if (literal) answers = [{ address: host, family: literal === 6 ? 6 : 4 }];
    else {
      try {
        answers = await raceAbort(resolve(host), signal);
      } catch (err) {
        if (err instanceof Aborted) throw err;
        return { ok: false, reason: 'unresolved' };
      }
      if (!answers.length) return { ok: false, reason: 'unresolved' };
    }
    // Every answer must pass: one private answer refuses the hop (no mixed-answer rebinding).
    if (answers.some((a) => deniedAddress(a.address, extra))) return { ok: false, reason: 'address' };
    const own = await ownAddresses(signal);
    if (!own) return { ok: false, reason: 'unresolved' };
    for (const a of answers) {
      const c = canonical(a.address.toLowerCase());
      if (!c || inList(own, c)) return { ok: false, reason: 'address' };
    }
    const [pinned] = answers;
    if (!pinned) return { ok: false, reason: 'unresolved' };
    return { ok: true, address: pinned.address, family: pinned.family };
  }

  async function runProbe(raw: string, signal: AbortSignal): Promise<ProbeOutcome> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { kind: 'refused', reason: 'scheme' };
    }
    for (let redirects = 0; ; ) {
      const hop = await checkHop(url, signal);
      if (!hop.ok) return { kind: 'refused', reason: hop.reason };
      const request = (method: 'HEAD' | 'GET') =>
        raceAbort(send({ url, address: hop.address, family: hop.family, method, signal, userAgent }), signal);
      let result = await request('HEAD');
      if (result.status === 405 || result.status === 501) result = await request('GET');
      if (!REDIRECTS.has(result.status) || !result.location) return { kind: 'status', status: result.status };
      redirects++;
      if (redirects > maxRedirects) return { kind: 'refused', reason: 'redirects' };
      try {
        url = new URL(result.location, url);
      } catch {
        return { kind: 'failed' };
      }
    }
  }

  async function probe(url: string, signal?: AbortSignal): Promise<ProbeOutcome> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await runProbe(url, combined);
    } catch {
      return { kind: 'failed' };
    }
  }

  async function checkLinks(urls: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, LinkStatus>> {
    const unique = [...new Set(urls)];
    const statuses = new Map<string, LinkStatus>(unique.map((u) => [u, 'unknown']));
    const queue = unique.slice(0, MAX_LINKS);
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined && !signal.aborted; next = queue.shift()) {
        const outcome = await probe(next, signal);
        if (!signal.aborted) statuses.set(next, linkStatus(outcome));
      }
    };
    await Promise.all(Array.from({ length: LINK_CONCURRENCY }, worker));
    return statuses;
  }

  return { probe, checkLinks };
}

function linkStatus(outcome: ProbeOutcome): LinkStatus {
  if (outcome.kind === 'status') {
    if (outcome.status >= 200 && outcome.status <= 399) return 'live';
    return outcome.status === 404 || outcome.status === 410 ? 'dead' : 'unknown';
  }
  if (outcome.kind === 'refused') {
    // A source pointing at a bad scheme, credentials, a port or a denied address is bogus.
    return outcome.reason === 'unresolved' || outcome.reason === 'redirects' ? 'unknown' : 'dead';
  }
  return 'unknown';
}

/**
 * One request to the pinned address, status and `Location` only: a fresh socket (`agent: false`, so no pooled socket
 * pinned elsewhere is reused), the hostname kept for Host and TLS verification, no cookie or authorization, no redirect
 * following and no body read.
 */
export function nodeSend(req: SendRequest): Promise<SendResult> {
  const { address, family } = req;
  const lib = req.url.protocol === 'https:' ? https : http;
  return new Promise<SendResult>((resolve, reject) => {
    let settled = false;
    const request = lib.request(
      req.url,
      {
        method: req.method,
        agent: false,
        headers: { 'user-agent': req.userAgent, accept: '*/*' },
        signal: req.signal,
        lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          options.all ? cb(null, [{ address, family }]) : cb(null, address, family)) as never,
      },
      (res) => {
        settled = true;
        const location = res.headers.location;
        resolve({ status: res.statusCode ?? 0, location: typeof location === 'string' ? location : null });
        res.destroy();
      },
    );
    request.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    request.end();
  });
}
