/**
 * The report route's limits (ADR 0009 §6) on their own, on a test clock: what an address and a network are, the hour,
 * day, minute and daily limits, `first_from_network`, and the salt that changes at midnight. Addresses are documentation
 * ranges (RFC 5737, RFC 3849).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createReportLimits,
  limitKey,
  MAX_NETWORK_KEYS,
  networkParts,
  REPORTS_PER_ADDRESS_DAY,
  REPORTS_PER_MINUTE,
  REPORTS_PER_NETWORK_DAY,
  type ReportLimitsOptions,
  type ReportPageKey,
} from '../src/reports/limits.ts';

const MIDNIGHT = Date.parse('2026-10-19T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LINKEDIN: ReportPageKey = { platform: 'linkedin', kind: 'detection' };

function limits(opts: Partial<ReportLimitsOptions> = {}) {
  return createReportLimits({ perHour: 6, dailyMax: 1_000_000, countSince: async () => 0, ...opts });
}

describe('networks', () => {
  it('test_network_parts', () => {
    expect(networkParts('192.0.2.10')).toEqual({ address: '4:192.0.2.10', network: '4:192.0.2' });
    // An IPv6 address is its /64, its network the /48, however it is written.
    for (const ip of ['2001:db8:1:2::10', '2001:0db8:0001:0002:0000:0000:0000:0010', '2001:db8:1:2:ffff:ffff:ffff:ffff']) {
      expect(networkParts(ip), ip).toEqual({ address: '6:2001:db8:1:2', network: '6:2001:db8:1' });
    }
    expect(networkParts('2001:db8::')).toEqual({ address: '6:2001:db8:0:0', network: '6:2001:db8:0' });
    expect(networkParts('::1')).toEqual({ address: '6:0:0:0:0', network: '6:0:0:0' });
    expect(networkParts('fe80::1%eth0')).toEqual({ address: '6:fe80:0:0:0', network: '6:fe80:0:0' });
    // An IPv4 address mapped into IPv6 (a dual-stack socket's) is the IPv4 address.
    expect(networkParts('::ffff:192.0.2.10')).toEqual(networkParts('192.0.2.10'));
    expect(networkParts('::ffff:c000:20a')).toEqual(networkParts('192.0.2.10'));
    // NAT64 keeps its own prefix.
    expect(networkParts('64:ff9b::192.0.2.10')).toEqual({ address: '6:64:ff9b:0:0', network: '6:64:ff9b:0' });
    for (const ip of [null, '', 'example.org', '999.1.1.1', '2001:db8::1::2']) {
      expect(networkParts(ip), String(ip)).toEqual({ address: 'unknown', network: 'unknown' });
    }
  });

  it('test_limit_keys_hold_no_address', () => {
    const salt = new Uint8Array(32).fill(7);
    const key = limitKey(salt, networkParts('192.0.2.10').address);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(limitKey(salt, '4:192.0.2.10')).toBe(key);
    expect(limitKey(new Uint8Array(32).fill(8), '4:192.0.2.10')).not.toBe(key);
  });
});

describe('limits', () => {
  it('test_hour_limit_per_address', async () => {
    const l = limits({ perHour: 2 });
    const at = MIDNIGHT + HOUR;
    expect((await l.admit('192.0.2.10', null, at)).ok).toBe(true);
    expect((await l.admit('192.0.2.11', null, at)).ok).toBe(true);
    // Same /24 but another address: its own hour.
    const third = await l.admit('192.0.2.10', null, at);
    expect(third.ok).toBe(true);
    const refused = await l.admit('192.0.2.10', null, at);
    expect(refused).toEqual({ ok: false, status: 429, retryAfterMs: 30 * MINUTE });
    // Refilled evenly: one more after half an hour.
    expect((await l.admit('192.0.2.10', null, at + 30 * MINUTE)).ok).toBe(true);
  });

  it('test_day_limits_per_address_and_network', async () => {
    const l = limits({ perHour: 1000 });
    const at = MIDNIGHT + 10 * HOUR;
    for (let i = 0; i < REPORTS_PER_ADDRESS_DAY; i++) {
      expect((await l.admit('192.0.2.10', null, at + i * MINUTE)).ok, String(i)).toBe(true);
    }
    const addressFull = await l.admit('192.0.2.10', null, at + HOUR);
    expect(addressFull).toEqual({ ok: false, status: 429, retryAfterMs: DAY - 11 * HOUR });
    // Two more addresses of the /24 fill the network's 60.
    for (const ip of ['192.0.2.11', '192.0.2.12']) {
      for (let i = 0; i < REPORTS_PER_ADDRESS_DAY; i++) expect((await l.admit(ip, null, at + HOUR)).ok).toBe(true);
    }
    expect(REPORTS_PER_NETWORK_DAY).toBe(3 * REPORTS_PER_ADDRESS_DAY);
    expect(await l.admit('192.0.2.13', null, at + HOUR)).toMatchObject({ ok: false, status: 429 });
    expect((await l.admit('198.51.100.13', null, at + HOUR)).ok).toBe(true);
    // A new UTC day starts every count again.
    expect((await l.admit('192.0.2.10', null, MIDNIGHT + DAY)).ok).toBe(true);
  });

  it('test_minute_limit_for_everyone', async () => {
    const l = limits();
    const at = MIDNIGHT + 5 * HOUR;
    for (let i = 0; i < REPORTS_PER_MINUTE; i++) {
      expect((await l.admit(`10.${i}.0.1`, null, at)).ok).toBe(true);
    }
    const refused = await l.admit('10.200.0.1', null, at);
    expect(refused).toMatchObject({ ok: false, status: 429 });
    expect(!refused.ok && refused.retryAfterMs).toBeLessThanOrEqual(MINUTE);
    expect((await l.admit('10.200.0.1', null, at + MINUTE)).ok).toBe(true);
  });

  it('test_daily_total_read_once_a_day', async () => {
    const countSince = vi.fn(async (since: Date) => (since.getTime() === MIDNIGHT ? 2 : 0));
    const l = limits({ dailyMax: 3, countSince });
    const at = MIDNIGHT + 20 * HOUR;
    expect((await l.admit('192.0.2.1', null, at)).ok).toBe(true);
    expect(await l.admit('198.51.100.1', null, at)).toEqual({ ok: false, status: 503, retryAfterMs: 4 * HOUR });
    expect(countSince).toHaveBeenCalledTimes(1);
    // The next day reads its own total.
    expect((await l.admit('198.51.100.1', null, MIDNIGHT + DAY)).ok).toBe(true);
    expect(countSince.mock.calls.map(([since]) => since.toISOString())).toEqual([
      '2026-10-19T00:00:00.000Z',
      '2026-10-20T00:00:00.000Z',
    ]);
  });

  it('test_daily_total_read_again_after_a_failure', async () => {
    let fail = true;
    const l = limits({
      countSince: async () => {
        if (fail) throw new Error('database down');
        return 0;
      },
    });
    await expect(l.admit('192.0.2.1', null, MIDNIGHT)).rejects.toThrow('database down');
    fail = false;
    expect((await l.admit('192.0.2.1', null, MIDNIGHT)).ok).toBe(true);
  });

  it('test_release_gives_back_what_was_taken', async () => {
    const l = limits({ perHour: 1, dailyMax: 1 });
    const first = await l.admit('192.0.2.1', LINKEDIN, MIDNIGHT);
    if (!first.ok) throw new Error('Refused.');
    expect(await l.admit('192.0.2.1', LINKEDIN, MIDNIGHT)).toMatchObject({ ok: false, status: 503 });
    first.release();
    first.release();
    const again = await l.admit('192.0.2.1', LINKEDIN, MIDNIGHT);
    expect(again.ok).toBe(true);
  });
});

describe('networks of the day', () => {
  it('test_first_from_network', async () => {
    const l = limits();
    const first = (ip: string, page: ReportPageKey | null) =>
      l.admit(ip, page, MIDNIGHT + HOUR).then((a) => (a.ok ? a.firstFromNetwork : null));
    expect(await first('192.0.2.10', LINKEDIN)).toBe(true);
    // The same /24: another address, then the same one.
    expect(await first('192.0.2.11', LINKEDIN)).toBe(false);
    expect(await first('192.0.2.10', LINKEDIN)).toBe(false);
    expect(await first('198.51.100.1', LINKEDIN)).toBe(true);
    // Another kind or platform counts on its own, so a wrong call first doesn't take a detection report's bit.
    expect(await first('192.0.2.10', { platform: 'linkedin', kind: 'wrong-call' })).toBe(true);
    expect(await first('192.0.2.10', { platform: 'facebook', kind: 'detection' })).toBe(true);
    // Not the detection version a report names, which a sender can change at will: still the same network.
    expect(await first('192.0.2.10', LINKEDIN)).toBe(false);
    // A report about no page is never a network's first.
    expect(await first('203.0.113.1', null)).toBe(false);
    // The next day, the network is new again.
    const tomorrow = await l.admit('192.0.2.10', LINKEDIN, MIDNIGHT + DAY);
    expect(tomorrow.ok && tomorrow.firstFromNetwork).toBe(true);
  });

  it('test_first_from_network_is_capped', async () => {
    const l = limits();
    let at = MIDNIGHT;
    for (let i = 0; i < MAX_NETWORK_KEYS; i++) {
      // Well under the minute limit, so every one is admitted.
      at += 1000;
      const a = await l.admit(`10.${i >> 8}.${i & 0xff}.1`, LINKEDIN, at);
      if (!a.ok || !a.firstFromNetwork) throw new Error(`Network ${i} was not first.`);
    }
    expect(at).toBeLessThan(MIDNIGHT + DAY);
    // Past the cap, a new network is admitted but never counts as first.
    const past = await l.admit('172.16.0.1', LINKEDIN, at + 1000);
    expect(past).toMatchObject({ ok: true, firstFromNetwork: false });
  });

  it('test_salt_changes_at_midnight', async () => {
    const salts = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const l = createReportLimits({
      perHour: 6,
      dailyMax: 100,
      countSince: async () => 0,
      random: () => salts.shift() ?? new Uint8Array(32),
    });
    await l.admit('192.0.2.10', LINKEDIN, MIDNIGHT + 23 * HOUR);
    const today = l.keys();
    expect(today).toContain(limitKey(new Uint8Array(32).fill(1), '4:192.0.2.10'));
    await l.admit('192.0.2.10', LINKEDIN, MIDNIGHT + DAY);
    const tomorrow = l.keys();
    expect(tomorrow).toContain(limitKey(new Uint8Array(32).fill(2), '4:192.0.2.10'));
    // Yesterday's keys are gone with yesterday's salt.
    expect(tomorrow.filter((key) => today.includes(key) && key !== 'linkedin|detection')).toEqual([]);
    for (const key of [...today, ...tomorrow]) expect(key).not.toContain('192.0.2');
  });
});
