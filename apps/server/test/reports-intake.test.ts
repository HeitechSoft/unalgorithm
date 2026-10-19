/**
 * `POST /v1/reports` (ADR 0009 §6): the one anonymous write route. Its own CORS for any extension page, refusals before
 * the body is read, the schema and the registry, the limits, and what a stored row keeps. Every report is fictional and
 * every address a documentation range (RFC 5737, RFC 3849).
 */
import {
  MAX_REPORT_BODY_BYTES,
  REPORT_ERRORS,
  REPORT_REF_PATTERN,
  REPORTS_PATH,
  ReportAcceptedSchema,
  reportRef,
} from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { problemReports, reportFloors } from '../src/db/schema.ts';
import { createApp } from '../src/http/app.ts';
import { hourOf, isListed, receiveReport } from '../src/reports/intake.ts';
import { createReportLimits } from '../src/reports/limits.ts';
import { NOT_FOUND } from '../src/routes/openapi.ts';
import { captureLog } from './support/log.ts';
import {
  insertReport,
  LISTED_GECKO_ID,
  LISTED_ORIGIN,
  MOZ_ORIGIN,
  report,
  reportApp,
  UNLISTED_ORIGIN,
} from './support/reports.ts';
import { scanAllTables } from './support/scan-tables.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const HOUR = 3_600_000;

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function app(env: Record<string, string | undefined> = {}) {
  const r = await reportApp(env);
  cleanup.push(() => r.t.close());
  return r;
}

async function expectAnswer(res: Response, status: number, body: unknown) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual(body);
}

/** Every stored row. */
const rows = (db: Awaited<ReturnType<typeof app>>['db']) => db.select().from(problemReports);

function preflight(a: Awaited<ReturnType<typeof app>>['app'], origin: string) {
  return a.request(REPORTS_PATH, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
}

describe('origins', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_preflight_from_any_extension', async () => {
    const r = await app();
    for (const origin of [LISTED_ORIGIN, UNLISTED_ORIGIN, MOZ_ORIGIN]) {
      const res = await preflight(r.app, origin);
      expect(res.status, origin).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin'), origin).toBe(origin);
      expect(res.headers.get('Access-Control-Allow-Methods'), origin).toBe('POST,OPTIONS');
      expect(res.headers.get('Access-Control-Allow-Headers'), origin).toBe('content-type');
      expect(res.headers.get('Access-Control-Allow-Credentials'), origin).toBeNull();
    }
    // A web page, or something shaped like an extension's origin, gets no CORS: it can't read an answer.
    for (const origin of [
      'https://www.linkedin.com',
      'chrome-extension://short',
      `chrome-extension://${'q'.repeat(32)}`,
      `${LISTED_ORIGIN}/`,
      'moz-extension://5D0C1F3A-7B2E-4C6D-9E8F-0A1B2C3D4E5F',
    ]) {
      expect((await preflight(r.app, origin)).headers.get('Access-Control-Allow-Origin'), origin).toBeNull();
    }
    // The report route's CORS is its own: the rest of /v1 still answers only listed extensions.
    const other = await r.app.request('/v1/classify', { method: 'OPTIONS', headers: { Origin: UNLISTED_ORIGIN } });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('test_report_refuses_web_and_missing_origin', async () => {
    const r = await app();
    for (const origin of [
      null,
      'https://www.linkedin.com',
      'http://127.0.0.1:8787',
      'null',
      `chrome-extension://${'z'.repeat(32)}`,
    ]) {
      await expectAnswer(await r.send(report('detection'), { origin }), 403, REPORT_ERRORS.origin);
    }
    expect(await rows(r.db)).toEqual([]);
  });

  it('test_report_listed_follows_extension_ids', () => {
    const ids = ['a'.repeat(32), LISTED_GECKO_ID];
    expect(isListed(`chrome-extension://${'a'.repeat(32)}`, undefined, ids)).toBe(true);
    // A Chrome origin is judged by its own id, never by what the report claims.
    expect(isListed(UNLISTED_ORIGIN, 'a'.repeat(32), ids)).toBe(false);
    expect(isListed(MOZ_ORIGIN, LISTED_GECKO_ID, ids)).toBe(true);
    expect(isListed(MOZ_ORIGIN, 'other@example.org', ids)).toBe(false);
    expect(isListed(MOZ_ORIGIN, undefined, ids)).toBe(false);
    // A Chromium id named as a Firefox client doesn't make a Firefox page listed.
    expect(isListed(MOZ_ORIGIN, 'a'.repeat(32), ids)).toBe(false);
    expect(isListed('https://example.org', LISTED_GECKO_ID, ids)).toBe(false);
  });
});

describe('bodies', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_refuses_what_is_not_a_report', async () => {
    const r = await app();
    const body = JSON.stringify(report('detection'));
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) {
      await expectAnswer(await r.send(body, { contentType }), 400, REPORT_ERRORS.invalid);
    }
    await expectAnswer(await r.send('{"v":1,', {}), 400, REPORT_ERRORS.invalid);
    // A report the schema refuses gets the same fixed words: never a zod issue or a value from the body.
    for (const bad of [
      { ...report('detection'), v: 2 },
      { ...report('detection'), id: 'not-a-uuid' },
      { ...report('wrong-call'), post: undefined },
      { ...report('correction'), page: report('detection').page },
      { ...report('other'), choices: [] },
      [],
      null,
    ]) {
      await expectAnswer(await r.send(bad), 400, REPORT_ERRORS.invalid);
    }
    expect(await rows(r.db)).toEqual([]);
  });

  it('test_report_over_16_kib_is_413', async () => {
    const r = await app();
    const big = JSON.stringify({ ...report('detection'), padding: 'x'.repeat(17 * 1024) });
    expect(big.length).toBeGreaterThan(MAX_REPORT_BODY_BYTES);
    const res = await r.send(big);
    await expectAnswer(res, 413, REPORT_ERRORS.tooLarge);
    // The page can read the refusal.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(LISTED_ORIGIN);
    // Unknown keys are stripped, so the same report with a little padding is stored.
    const small = await r.send({ ...report('detection'), padding: 'x'.repeat(1024) });
    expect(small.status).toBe(201);
  });

  it('test_reports_off_is_404', async () => {
    const t = await createTestApp({ config: testConfig() });
    cleanup.push(() => t.close());
    expect(t.deps.config.reports.enabled).toBe(false);
    const res = await t.app.request(REPORTS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: UNLISTED_ORIGIN },
      body: JSON.stringify(report('detection')),
    });
    await expectAnswer(res, 404, NOT_FOUND);
    // Off, the path is any other /v1 path: no CORS for an extension the server doesn't list.
    expect((await preflight(t.app, UNLISTED_ORIGIN)).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('storing', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_stored_then_same_ref_for_same_id', async () => {
    const r = await app({ REPORTS_PER_HOUR: '1' });
    const sent = report('detection');
    const first = await r.send(sent);
    expect(first.status).toBe(201);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const { ref } = ReportAcceptedSchema.parse(await first.json());
    expect(ref).toMatch(REPORT_REF_PATTERN);

    // Try again: the same reference, and no limit taken (this address may send one an hour).
    const again = await r.send(sent);
    expect(again.headers.get('Cache-Control')).toBe('no-store');
    await expectAnswer(again, 200, { ok: true, ref });
    expect(await rows(r.db)).toHaveLength(1);
    expect((await r.send(report('other'))).status).toBe(429);
  });

  it('test_report_row_keeps_what_the_adr_lists', async () => {
    const r = await app();
    const before = Date.now();
    const sent = report('detection');
    expect((await r.send(sent)).status).toBe(201);
    const [row] = await rows(r.db);
    if (!row) throw new Error('No row.');
    // On the hour, the hour it arrived in.
    expect(row.receivedAt.getTime() % HOUR).toBe(0);
    expect(row.receivedAt.getTime()).toBe(hourOf(before).getTime());
    expect(row).toMatchObject({
      id: sent.id,
      kind: 'detection',
      from: 'popup',
      channel: 'chrome-store',
      listed: true,
      extension: '0.4.1',
      browser: 'chrome',
      browserMajor: 141,
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.2',
      adapterOrder: 2026010002,
      topic: 'ad-label-near-miss',
      choices: ['ads-showing'],
      firstFromNetwork: true,
      unknownCodes: 0,
      message: null,
      contact: null,
      handledAt: null,
      handledBy: null,
      resolution: null,
    });
    expect(row.details).toEqual({ page: sent.page, health: sent.health, detection: sent.detection });
  });

  it('test_report_topics', async () => {
    const r = await app();
    const topicOf = async (sent: ReturnType<typeof report>) => {
      expect((await r.send(sent)).status).toBe(201);
      const [row] = await r.db.select({ topic: problemReports.topic }).from(problemReports).where(eq(problemReports.id, sent.id));
      return row?.topic;
    };
    const health = (issues: string[]) => ({ status: 'broken', issues, degraded: [] });
    // The first issue in priority order, whatever order the extension sent them in.
    expect(await topicOf(report('detection', { health: health(['route-new', 'no-ads-seen', 'adapter-error']) }))).toBe(
      'adapter-error',
    );
    expect(await topicOf(report('detection', { health: health([]), choices: ['wanted-hidden', 'other'] }))).toBe('wanted-hidden');
    expect(await topicOf(report('wrong-call'))).toBe('suggested');
    expect(await topicOf(report('correction'))).toBe('factcheck');
    expect(await topicOf(report('other', { choices: ['credits'] }))).toBe('credits');
  });

  it('test_report_keeps_only_registry_codes', async () => {
    const r = await app();
    // A name or a slug in every place a code, key or id goes: the pattern lets each through, the registry doesn't.
    const sent = report('wrong-call', {
      from: 'jane-doe',
      choices: ['should-show', 'jane-doe'],
      health: { status: 'degraded', issues: ['jane-doe', 'over-filtering'], degraded: ['janeDoe', 'relationship'] },
      detection: {
        counts: { posts: 3, janeDoe: 1 },
        hiddenBy: { suggested: 1, 'jane-doe': 1 },
        detectors: { 'li.follow-button': 1, 'li.jane-doe': 1, 'fb.follow-button': 1 },
        landmarks: { main: 1, janeDoe: 1 },
        observations: { 'li.ad-cue': 1, 'li.jane-doe': 1 },
        errors: { inspect: 1, janeDoe: 1 },
        strategy: 'li.jane-doe',
      },
      post: {
        reason: 'jane-doe',
        source: 'rule',
        evidence: [
          { detector: 'li.header.suggested', strength: 'strong' },
          { detector: 'li.jane-doe', strength: 'weak' },
        ],
        authorKind: 'person',
        relationship: 'not-followed',
        media: 'none',
        text: 'long',
        module: 'jane-doe',
      },
    });
    expect((await r.send(sent)).status).toBe(201);
    const [row] = await rows(r.db);
    if (!row) throw new Error('No row.');
    // from, a choice, an issue, a degraded signal, 6 record keys and the other platform's detector, the strategy, the
    // post's reason, an evidence detector and the module.
    expect(row.unknownCodes).toBe(15);
    expect(row.from).toBe('unknown');
    expect(row.choices).toEqual(['should-show']);
    expect(row.topic).toBe('unknown');
    expect(row.details).toMatchObject({
      health: { issues: ['over-filtering'], degraded: ['relationship'] },
      detection: {
        counts: { posts: 3 },
        hiddenBy: { suggested: 1 },
        detectors: { 'li.follow-button': 1 },
        landmarks: { main: 1 },
        observations: { 'li.ad-cue': 1 },
        errors: { inspect: 1 },
      },
      post: { reason: 'unknown', evidence: [{ detector: 'li.header.suggested', strength: 'strong' }] },
    });
    for (const [table, json] of await scanAllTables(r.t.deps.db)) expect(json.toLowerCase(), table).not.toMatch(/jane/);
  });

  it('test_report_message_cleaned_and_contact_lowercased', async () => {
    const r = await app();
    const message =
      'Wrong ‮date‬​: write to bob.smith@example.org or call 613-555-0142, see https://news.example.org/a?b=1 @bobsmith';
    const sent = report('correction', {
      correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud', message, contact: ' Ann@Example.ORG' },
    });
    // The schema refuses a link in the words, with a scheme or without one (a host with a path, a profile address),
    // so these are cleaned by the extension's rules first: only the server's own pass is tested here, on what the
    // extension would have let through.
    expect((await r.send(sent)).status).toBe(400);
    for (const link of ['news.example.org/a?b=1', 'linkedin.com/in/bobsmith', '/in/bobsmith', 'profile.php?id=100001234567']) {
      const words = { feature: 'factcheck', promptVersion: 3, via: 'cloud', message: `See ${link}` };
      expect((await r.send(report('correction', { correction: words }))).status, link).toBe(400);
    }
    const plain = message.replace('https://news.example.org/a?b=1', 'news.example.org');
    expect(
      (
        await r.send(
          report('correction', {
            correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud', message: plain, contact: 'Ann@Example.ORG' },
          }),
        )
      ).status,
    ).toBe(201);
    const [row] = await rows(r.db);
    if (!row) throw new Error('No row.');
    expect(row.message).not.toMatch(/[‪-‮​]/);
    expect(row.message).not.toContain('bob.smith@example.org');
    expect(row.message).not.toContain('613-555-0142');
    expect(row.message).not.toContain('@bobsmith');
    expect(row.message).toContain('[email]');
    // A host with a subdomain keeps only its site.
    expect(row.message).not.toContain('news.example.org');
    expect(row.message).toContain('[link: example.org]');
    expect(row.contact).toBe('ann@example.org');
    // The words and the address live in their own columns, never in the details.
    expect(row.details).toEqual({ correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud' } });
    // Nothing but invisible characters is no message.
    const empty = report('correction', {
      correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud', message: '​​' },
    });
    await expectAnswer(await r.send(empty), 400, REPORT_ERRORS.invalid);
  });

  it('test_unlisted_correction_refused_and_unlisted_detection_kept', async () => {
    const r = await app();
    await expectAnswer(await r.send(report('correction'), { origin: UNLISTED_ORIGIN }), 403, REPORT_ERRORS.unlisted);
    // Firefox: the page's UUID says nothing, so the add-on id the report names decides.
    await expectAnswer(await r.send(report('correction'), { origin: MOZ_ORIGIN }), 403, REPORT_ERRORS.unlisted);
    const moz = report('correction', {
      env: { extension: '0.4.1', channel: 'firefox-store', browser: 'firefox', browserMajor: 158, client: 'other@example.org' },
    });
    await expectAnswer(await r.send(moz, { origin: MOZ_ORIGIN }), 403, REPORT_ERRORS.unlisted);
    expect(await rows(r.db)).toEqual([]);

    const detection = report('detection');
    expect((await r.send(detection, { origin: UNLISTED_ORIGIN })).status).toBe(201);
    const listedMoz = report('correction', {
      env: { extension: '0.4.1', channel: 'firefox-store', browser: 'firefox', browserMajor: 158, client: LISTED_GECKO_ID },
    });
    expect((await r.send(listedMoz, { origin: MOZ_ORIGIN })).status).toBe(201);
    const stored = await rows(r.db);
    expect(stored.find((row) => row.id === detection.id)).toMatchObject({ listed: false, message: null, contact: null });
    expect(stored.find((row) => row.id === listedMoz.id)).toMatchObject({ listed: true, contact: 'ann@example.org' });
  });

  it('test_report_private_window_and_no_page', async () => {
    const r = await app();
    const sent = report('detection', { private: true, page: undefined, health: undefined, detection: undefined, choices: [] });
    expect((await r.send(sent)).status).toBe(201);
    const [row] = await rows(r.db);
    expect(row).toMatchObject({ platform: null, adapter: null, adapterOrder: null, topic: null, firstFromNetwork: false });
    expect(row?.details).toEqual({ private: true });
  });

  it('test_report_below_floor_stored_handled', async () => {
    const r = await app();
    await r.db.insert(reportFloors).values({
      platform: 'linkedin',
      adapter: 'linkedin@2026.10.5',
      adapterOrder: 2026010005,
      setAt: new Date(),
    });
    const old = report('detection');
    const current = report('detection', { page: { ...report('detection').page, adapter: 'linkedin@2026.10.5' } });
    expect((await r.send(old)).status).toBe(201);
    expect((await r.send(current)).status).toBe(201);
    const stored = await rows(r.db);
    const oldRow = stored.find((row) => row.id === old.id);
    expect(oldRow).toMatchObject({ resolution: 'older-version', handledBy: null });
    expect(oldRow?.handledAt?.getTime()).toBe(oldRow?.receivedAt.getTime());
    expect(stored.find((row) => row.id === current.id)).toMatchObject({ resolution: null, handledAt: null });
  });

  it('test_report_ref_collision_draws_again', async () => {
    const r = await app();
    const taken = reportRef(new Uint8Array([0, 0, 0, 0, 1]));
    await insertReport(r.db, hourOf(Date.now()), { ref: taken });
    const draws = [new Uint8Array([0, 0, 0, 0, 1]), new Uint8Array([0, 0, 0, 0, 1]), new Uint8Array([0, 0, 0, 0, 2])];
    const { log, events } = captureLog();
    const limits = createReportLimits({ perHour: 6, dailyMax: 10, countSince: async () => 0 });
    const deps = { db: r.db, config: r.t.deps.config, log, limits, random: () => draws.shift() ?? new Uint8Array(5) };
    const answer = await receiveReport(deps, { body: report('other'), origin: LISTED_ORIGIN, ip: null });
    expect(answer).toEqual({
      outcome: 'accepted',
      status: 201,
      body: { ok: true, ref: reportRef(new Uint8Array([0, 0, 0, 0, 2])) },
    });
    expect(draws).toEqual([]);
    expect(events().filter((e) => e.event === 'report.received')).toHaveLength(1);
  });

  it('test_report_lost_race_answers_stored_ref', async () => {
    const r = await app();
    const sent = report('other');
    const { log } = captureLog();
    let taken = 0;
    const limits = createReportLimits({ perHour: 6, dailyMax: 2, countSince: async () => 0 });
    // The same id stored by another request while this one was being admitted.
    const racing = {
      async admit(...args: Parameters<typeof limits.admit>) {
        const admission = await limits.admit(...args);
        await insertReport(r.db, hourOf(Date.now()), { id: sent.id, kind: 'other', platform: null, adapter: null });
        if (admission.ok) taken += 1;
        return admission;
      },
      keys: () => limits.keys(),
    };
    const answer = await receiveReport(
      { db: r.db, config: r.t.deps.config, log, limits: racing },
      { body: sent, origin: LISTED_ORIGIN, ip: null },
    );
    expect(answer.outcome).toBe('accepted');
    expect(answer.status).toBe(200);
    expect(await rows(r.db)).toHaveLength(1);
    expect(taken).toBe(1);
    // What the lost race took was given back: the daily limit of 2 still allows two more.
    for (let i = 0; i < 2; i++) {
      const next = await receiveReport(
        { db: r.db, config: r.t.deps.config, log, limits },
        { body: report('other'), origin: LISTED_ORIGIN, ip: null },
      );
      expect(next.status).toBe(201);
    }
  });

  it('test_report_log_line_holds_codes_only', async () => {
    const r = await app();
    expect((await r.send(report('detection'))).status).toBe(201);
    expect((await r.send(report('correction'))).status).toBe(201);
    const lines = r.t.events().filter((e) => e.event === 'report.received');
    expect(lines).toEqual([
      {
        t: expect.any(String),
        level: 'info',
        event: 'report.received',
        kind: 'detection',
        platform: 'linkedin',
        adapter: 'linkedin@2026.10.2',
        topic: 'ad-label-near-miss',
        listed: true,
      },
      {
        t: expect.any(String),
        level: 'info',
        event: 'report.received',
        kind: 'correction',
        platform: null,
        adapter: null,
        topic: 'factcheck',
        listed: true,
      },
    ]);
    const all = r.t.lines.join('\n');
    expect(all).not.toContain('ann@example.org');
    expect(all).not.toContain('2024');
  });
});

describe('limits', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_report_429_per_address_with_retry_after', async () => {
    const r = await app({ TRUST_PROXY: 'one-hop', REPORTS_PER_HOUR: '2' });
    for (let i = 0; i < 2; i++) expect((await r.send(report('other'), { ip: '192.0.2.10' })).status).toBe(201);
    const refused = await r.send(report('other'), { ip: '192.0.2.10' });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual(REPORT_ERRORS.rateLimit);
    const wait = Number(refused.headers.get('Retry-After'));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30 * 60);
    expect(refused.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After');
    // Another network is not held back; the same IPv6 /64 is one address.
    expect((await r.send(report('other'), { ip: '198.51.100.7' })).status).toBe(201);
    expect((await r.send(report('other'), { ip: '2001:db8:1:2::10' })).status).toBe(201);
    expect((await r.send(report('other'), { ip: '2001:db8:1:2:ffff::1' })).status).toBe(201);
    expect((await r.send(report('other'), { ip: '2001:db8:1:2:abcd::9' })).status).toBe(429);
    expect((await r.send(report('other'), { ip: '2001:db8:1:3::10' })).status).toBe(201);
  });

  it('test_report_503_at_daily_cap', async () => {
    const r = await app({ TRUST_PROXY: 'one-hop', REPORTS_DAILY_MAX: '2' });
    expect((await r.send(report('other'), { ip: '192.0.2.1' })).status).toBe(201);
    expect((await r.send(report('other'), { ip: '198.51.100.1' })).status).toBe(201);
    const full = await r.send(report('other'), { ip: '203.0.113.1' });
    await expectAnswer(full, 503, REPORT_ERRORS.unavailable);
    const now = Date.now();
    const midnight = Math.ceil((now + 1) / 86_400_000) * 86_400_000;
    const wait = Number(full.headers.get('Retry-After'));
    expect(Math.abs(wait - (midnight - now) / 1000)).toBeLessThan(5);
    // A repeat of a stored report still gets its reference.
    const [stored] = await rows(r.db);
    expect((await r.send({ ...report('other'), id: stored?.id })).status).toBe(200);
    // After a restart the day's total is read back from the database.
    const restarted = createApp({ ...r.t.deps });
    const res = await restarted.request(REPORTS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: LISTED_ORIGIN },
      body: JSON.stringify(report('other')),
    });
    expect(res.status).toBe(503);
  });
});
