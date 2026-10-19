/**
 * The report route's abuse limits (ADR 0009 §6), kept without a stored address. Everything here lives in memory and is
 * keyed by an HMAC-SHA-256 of the network under a random salt that is replaced at each UTC midnight and never written
 * anywhere, so neither a key nor the stored `first_from_network` bit can be turned back into an address. A restart
 * resets the limits, which is acceptable: the daily total, the one limit that matters for cost, is read back from the
 * database.
 *
 * In the order they are checked:
 * 1. the server's daily total, `REPORTS_DAILY_MAX` (503 until 00:00 UTC);
 * 2. 120 reports a minute from everyone together;
 * 3. per address (an IPv6 address by its /64), `REPORTS_PER_HOUR` an hour and 20 a day;
 * 4. per network, a /24 (IPv4) or /48 (IPv6), 60 a day.
 *
 * The day limits are counters that start again at 00:00 UTC, with the salt. The minute and hour limits are token
 * buckets (`createRateLimiter`), so a burst is allowed and refills evenly.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { PlatformId, ReportKind } from '@unalgorithm/protocol';
import { createRateLimiter, type RateLimiter } from '../ai/limits.ts';
import { utcDayStart } from '../ai/metering.ts';

/** Reports one address may send in a UTC day, whatever `REPORTS_PER_HOUR` allows. */
export const REPORTS_PER_ADDRESS_DAY = 20;
/** Reports one /24 or /48 may send in a UTC day. */
export const REPORTS_PER_NETWORK_DAY = 60;
/** Reports a minute from everyone together. */
export const REPORTS_PER_MINUTE = 120;
/** At most this many networks are remembered for `first_from_network` in a day; past it, no report counts as first. */
export const MAX_NETWORK_KEYS = 50_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const SALT_BYTES = 32;

/** The address and the network a limit counts a request under, before they are keyed. Never stored or logged. */
export interface NetworkParts {
  address: string;
  network: string;
}

/** An address's 8 groups of 16 bits, or null when it is not an IPv6 address. A zone (`%eth0`) is ignored. */
function ipv6Groups(text: string): number[] | null {
  let s = text.split('%')[0] ?? '';
  if (!isIPv6(s)) return null;
  // A dotted IPv4 tail (`::ffff:192.0.2.1`, `64:ff9b::192.0.2.1`) as its two groups.
  s = s.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a: string, b: string, c: string, d: string) => {
    const hi = (Number(a) << 8) | Number(b);
    const lo = (Number(c) << 8) | Number(d);
    return `${hi.toString(16)}:${lo.toString(16)}`;
  });
  const [head = '', tail] = s.split('::') as [string, string | undefined];
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * What the limits count `ip` under: an IPv4 address and its /24, or an IPv6 /64 and its /48 (one household or office
 * gets a /64 or a /48, and changes the rest at will). An IPv4 address mapped into IPv6 counts as IPv4. Anything else,
 * or no address (a request without a socket, in tests), shares one `unknown` key.
 */
export function networkParts(ip: string | null): NetworkParts {
  if (ip !== null && isIPv4(ip)) {
    return { address: `4:${ip}`, network: `4:${ip.split('.').slice(0, 3).join('.')}` };
  }
  const groups = ip === null ? null : ipv6Groups(ip);
  if (groups) {
    const mapped = groups.slice(0, 6).join(',') === '0,0,0,0,0,65535';
    if (mapped) {
      const [hi = 0, lo = 0] = groups.slice(6);
      return networkParts(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    const hex = (n: number) => groups.slice(0, n).map((g) => g.toString(16));
    return { address: `6:${hex(4).join(':')}`, network: `6:${hex(3).join(':')}` };
  }
  return { address: 'unknown', network: 'unknown' };
}

/** `part` keyed under `salt`: hex HMAC-SHA-256, so no key held in memory names an address. */
export function limitKey(salt: Uint8Array, part: string): string {
  return createHmac('sha256', salt).update(part).digest('hex');
}

/**
 * What `first_from_network` is counted under: the platform a report is about and its kind; null for a report about no
 * page. Not the detection version, which a sender can vary at will: one network gets one bit a day per platform and
 * kind, so the report alerts (detection reports only) count it once however its reports differ.
 */
export interface ReportPageKey {
  platform: PlatformId;
  kind: ReportKind;
}

export type Admission =
  | {
      ok: true;
      /** The first report of its kind today, about this platform, from this /24 or /48. */
      firstFromNetwork: boolean;
      /** Gives back what this admission took, for a report that was not stored after all (an id stored meanwhile). */
      release(): void;
    }
  /** 429 for a rate limit, 503 once the server's daily total is reached; `retryAfterMs` says when to try again. */
  | { ok: false; status: 429 | 503; retryAfterMs: number };

export interface ReportLimits {
  /** Checks every limit for a report from `ip` at `now`, and takes from each when all of them allow it. */
  admit(ip: string | null, page: ReportPageKey | null, now?: number): Promise<Admission>;
  /** Every key the limits hold now, for the tests that no key holds an address. */
  keys(): string[];
}

export interface ReportLimitsOptions {
  /** `REPORTS_PER_HOUR`. */
  perHour: number;
  /** `REPORTS_DAILY_MAX`. */
  dailyMax: number;
  /**
   * The reports stored since `since` (00:00 UTC): today's total, read on the day's first report and after a restart,
   * then counted in memory.
   */
  countSince(since: Date): Promise<number>;
  /** Tests only: the salt's random bytes. Default: `crypto.randomBytes`. */
  random?: (size: number) => Uint8Array;
}

/** One UTC day's state: its salt, and every limit counted under it. */
interface Day {
  start: number;
  salt: Uint8Array;
  minute: RateLimiter;
  hourly: RateLimiter;
  addressDay: Map<string, number>;
  networkDay: Map<string, number>;
  /** `platform|kind` to the networks seen today for it. */
  networks: Map<string, Set<string>>;
  networkKeys: number;
  /** Today's stored reports, with those admitted and not yet stored; null until read from the database. */
  total: number | null;
  reading?: Promise<number>;
}

/** The global minute bucket's key: there is one. */
const EVERYONE = 'everyone';

export function createReportLimits(opts: ReportLimitsOptions): ReportLimits {
  const random = opts.random ?? ((size: number) => randomBytes(size));
  let day: Day | undefined;

  /** The day `now` falls in; a new day brings a new salt and forgets every count and network of the last one. */
  function dayOf(now: number): Day {
    const start = utcDayStart(new Date(now)).getTime();
    if (day?.start !== start) {
      day = {
        start,
        salt: random(SALT_BYTES),
        minute: createRateLimiter({ perMinute: REPORTS_PER_MINUTE }),
        hourly: createRateLimiter({ max: opts.perHour, windowMs: HOUR_MS }),
        addressDay: new Map(),
        networkDay: new Map(),
        networks: new Map(),
        networkKeys: 0,
        total: null,
      };
    }
    return day;
  }

  return {
    async admit(ip, page, now = Date.now()) {
      const d = dayOf(now);
      if (d.total === null) {
        if (!d.reading) {
          const reading = opts.countSince(new Date(d.start));
          d.reading = reading;
          // A failed read is tried again by the next report rather than kept.
          reading.catch(() => {
            if (d.reading === reading) d.reading = undefined;
          });
        }
        const counted = await d.reading;
        d.total ??= counted;
      }
      // From here on nothing awaits, so two requests at once never both take the last report of a limit.
      const untilMidnight = d.start + DAY_MS - now;
      if (d.total >= opts.dailyMax) return { ok: false, status: 503, retryAfterMs: untilMidnight };

      const parts = networkParts(ip);
      const address = limitKey(d.salt, parts.address);
      const network = limitKey(d.salt, parts.network);
      const minute = d.minute.take(EVERYONE, now);
      if (!minute.ok) return { ok: false, status: 429, retryAfterMs: minute.retryAfterMs };
      const hourly = d.hourly.take(address, now);
      if (!hourly.ok) {
        d.minute.refund(EVERYONE, now);
        return { ok: false, status: 429, retryAfterMs: hourly.retryAfterMs };
      }
      const addressToday = d.addressDay.get(address) ?? 0;
      const networkToday = d.networkDay.get(network) ?? 0;
      if (addressToday >= REPORTS_PER_ADDRESS_DAY || networkToday >= REPORTS_PER_NETWORK_DAY) {
        d.minute.refund(EVERYONE, now);
        d.hourly.refund(address, now);
        return { ok: false, status: 429, retryAfterMs: untilMidnight };
      }

      d.addressDay.set(address, addressToday + 1);
      d.networkDay.set(network, networkToday + 1);
      d.total += 1;
      let firstFromNetwork = false;
      if (page) {
        const pageKey = `${page.platform}|${page.kind}`;
        const seen = d.networks.get(pageKey) ?? new Set<string>();
        if (!seen.has(network) && d.networkKeys < MAX_NETWORK_KEYS) {
          seen.add(network);
          d.networks.set(pageKey, seen);
          d.networkKeys += 1;
          firstFromNetwork = true;
        }
      }

      let released = false;
      return {
        ok: true,
        firstFromNetwork,
        release() {
          // Only into the same day: a new day has forgotten what this took.
          if (released || day !== d) return;
          released = true;
          d.minute.refund(EVERYONE, now);
          d.hourly.refund(address, now);
          d.addressDay.set(address, Math.max(0, (d.addressDay.get(address) ?? 0) - 1));
          d.networkDay.set(network, Math.max(0, (d.networkDay.get(network) ?? 0) - 1));
          if (d.total !== null) d.total = Math.max(0, d.total - 1);
        },
      };
    },

    keys() {
      if (!day) return [];
      return [
        ...day.addressDay.keys(),
        ...day.networkDay.keys(),
        ...[...day.networks.values()].flatMap((set) => [...set]),
        ...day.networks.keys(),
      ];
    },
  };
}
