/**
 * Every price reader on the server uses the stored book (PA-04, decisions PD1, PD8, PD9, PD10): `GET /prices.json`
 * publishes it as `/outlets.json` is published (public, cacheable, an ETag, no session, no admin), and discovery, the
 * fact-check offer and the billing module's holds read `prices.current()` at each use, so a change applies without a
 * restart. Changes are dated from the real clock (two days back), so no test depends on today's date. Anthropic is
 * `mockAnthropicFetch`: nothing here calls a real model.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AnthropicRequestKind, mockAnthropicFetch, structuredMessage } from '@unalgorithm/ai/testing/anthropic';
import {
  ADMIN_PRICES_PATH,
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceCard,
  type CreditPriceSchedule,
  DEFAULT_PRICE_BOOK,
  FACTCHECK_JOBS_PATH,
  FactcheckJobSchema,
  factcheckJobPath,
  PRICES_JSON_PATH,
  type PriceBook,
  PublishedPricesSchema,
  SERVER_INFO_PATH,
  ServerInfoSchema,
} from '@unalgorithm/protocol';
import { FACTCHECK_PROMPT_VERSION } from '@unalgorithm/research';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLE } from '../src/admin/access.ts';
import { clientForRoute } from '../src/ai/provider.ts';
import { priceChanges, user } from '../src/db/schema.ts';
import type { AppDeps } from '../src/http/app.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { serverPost } from './support/classify.ts';
import { seedPassingRoute } from './support/routes.ts';
import { DEV_EXTENSION_ORIGIN, postJson, signInDevice, signInWeb } from './support/sign-in.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestAppOptions, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const ADA = 'ada@example.com';
const TOM = 'tom@example.com';
const DAY_MS = 86_400_000;
const JSON_UTF8 = 'application/json; charset=utf-8';
const NOT_FOUND = { code: 'bad-request', message: 'Not found.' };
/** An address a proxy would add: never in a log line. */
const FORWARDED = { 'X-Forwarded-For': '203.0.113.7' };
const FIXTURE = fileURLToPath(new URL('./fixtures/billing-module/index.ts', import.meta.url));
const BILLING_ENV = { BILLING: 'module', BILLING_MODULE: FIXTURE };
const RELEASE_DOC = fileURLToPath(new URL('../../../docs/release.md', import.meta.url));

/** Anthropic as the provider and fact-check on: what a billing server that offers checks needs. */
const ANTHROPIC_ENV: Record<string, string | undefined> = {
  AI_PROVIDER: 'anthropic',
  AI_API_KEY: 'sk-ant-test-only-not-a-real-key',
  AI_MODEL: undefined,
  AI_BASE_URL: undefined,
  AI_DATA_POLICY: undefined,
  FACTCHECK: 'on',
};

/** A purchase change an admin saves: from $10, quick picks $10, $25 and $100, $25 preselected. */
const PURCHASE = {
  minMicros: 10_000_000,
  maxMicros: 1_000_000_000,
  presetsMicros: [10_000_000, 25_000_000, 100_000_000],
  defaultMicros: 25_000_000,
};

/** 00:00 UTC `days` days after today's (before it when negative), as a price date. */
const dayAhead = (days: number) =>
  new Date((Math.floor(Date.now() / DAY_MS) + days) * DAY_MS).toISOString().replace('.000Z', 'Z');

/** The code schedule's 2026-10-18 cards: the launch classify card, UnEcho Chamber's and fact-check's. */
const CODE_CARDS = (() => {
  const entry = CREDIT_PRICE_SCHEDULE.find((e) => e.effectiveFrom === '2026-10-18T00:00:00Z');
  if (!entry?.cards.factcheck || !entry.cards.perspectives) throw new Error('No 2026-10-18 entry with job cards.');
  return { classify: entry.cards.classify, factcheck: entry.cards.factcheck, perspectives: entry.cards.perspectives };
})();

/**
 * A book whose newest entry, in effect from two days before the clock, prices fact-check at 2× (Sonnet, $0.12 a check)
 * with a hold cap of `capMicros`; the code schedule's entries before it stay as they are.
 */
function bookWithFactcheckCap(capMicros: number): PriceBook {
  const from = dayAhead(-2);
  const factcheck: CreditPriceCard = { ...CODE_CARDS.factcheck, multiplier: 2, maxChargeMicros: capMicros };
  const schedule: CreditPriceSchedule = [
    ...CREDIT_PRICE_SCHEDULE.filter((e) => Date.parse(e.effectiveFrom) < Date.parse(from)),
    { effectiveFrom: from, cards: { ...CODE_CARDS, factcheck } },
  ];
  return { ...DEFAULT_PRICE_BOOK, schedule };
}

/** Apps a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

/** A test server (with the fixture billing module unless `billing` is false) where Ada is the admin, signed in. */
async function pricesApp(opts: { billing?: boolean } = {}) {
  const billing = opts.billing ?? true;
  const config = testConfig({ SIGNUP_ALLOWLIST: ADA, ...(billing ? BILLING_ENV : {}) });
  const t = await createTestApp({ config, ...(billing ? { billingModule: fixtureModule } : {}) });
  cleanup.push(() => t.close());
  const admin = await signInWeb(t.app, t.outbox, ADA);
  await t.deps.db.db.update(user).set({ role: ADMIN_ROLE }).where(eq(user.email, ADA));
  const [row] = await t.deps.db.db.select({ id: user.id }).from(user).where(eq(user.email, ADA));
  if (!row) throw new Error('No account.');
  const get = (headers: Record<string, string> = {}) => Promise.resolve(t.app.request(PRICES_JSON_PATH, { headers }));
  /** Ada saves the purchase amounts on the Pricing page's route: the book goes to version 2 (the seed row, then it). */
  const savePurchase = async () => {
    const res = await postJson(
      t.app,
      ADMIN_PRICES_PATH,
      { action: 'purchase', baseVersion: '0', purchase: PURCHASE },
      { Origin: TEST_PUBLIC_URL, Cookie: admin },
    );
    expect(res.status, await res.clone().text()).toBe(200);
  };
  return { t, admin, adaId: row.id, get, savePurchase };
}

/** The headers every answer of `/prices.json` carries, a 304 included. */
function expectPublicHeaders(res: Response) {
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  expect(res.headers.getSetCookie()).toEqual([]);
}

async function discovery(t: TestApp) {
  const res = await t.app.request(SERVER_INFO_PATH);
  expect(res.status).toBe(200);
  return ServerInfoSchema.parse(await res.json());
}

describe('public JSON', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_public_prices_shape_and_headers', async () => {
    const { t, get } = await pricesApp();
    const res = await get({ Origin: 'https://any.example' });

    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    expect(res.headers.get('content-type')).toBe(JSON_UTF8);
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"prices-[0-9a-f]{16}"$/);
    expect(etag).toBe(t.prices.published().etag);
    const body = await res.json();
    expect(PublishedPricesSchema.parse(body)).toEqual(body);
    expect(body).toEqual({ v: 1, version: '0', updatedAt: null, ...DEFAULT_PRICE_BOOK });
    // Nothing was stored to answer it.
    expect(await t.deps.db.db.select({ seq: priceChanges.seq }).from(priceChanges)).toEqual([]);
  });

  it('test_public_prices_not_modified_on_matching_etag', async () => {
    const { get, savePurchase } = await pricesApp();
    const tag = (await get()).headers.get('etag') ?? '';
    expect(tag).not.toBe('');

    for (const header of [tag, `W/${tag}`, `"prices-0000000000000000", ${tag}`, '*']) {
      const res = await get({ 'If-None-Match': header });
      expect(res.status, header).toBe(304);
      expect(await res.text(), header).toBe('');
      expect(res.headers.get('etag'), header).toBe(tag);
      expectPublicHeaders(res);
    }
    // Another tag gets the body.
    expect((await get({ 'If-None-Match': '"prices-0000000000000000"' })).status).toBe(200);

    await savePurchase();
    const res = await get({ 'If-None-Match': tag });
    expect(res.status).toBe(200);
    expectPublicHeaders(res);
    const newer = res.headers.get('etag');
    expect(newer).not.toBe(tag);
    const body = PublishedPricesSchema.parse(await res.json());
    expect(body.version).toBe('2');
    expect(body.updatedAt).not.toBeNull();
    expect(body.purchase).toEqual(PURCHASE);
    // The new tag is the one that matches now.
    expect((await get({ 'If-None-Match': newer ?? '' })).status).toBe(304);
  });

  it('test_public_prices_ignore_session_and_hold_no_admin', async () => {
    const { t, admin, adaId, get, savePurchase } = await pricesApp();
    await savePurchase();

    const from = t.lines.length;
    const anonymous = await get(FORWARDED);
    const signedIn = await get({ ...FORWARDED, Cookie: admin });
    const notModified = await get({ ...FORWARDED, Cookie: admin, 'If-None-Match': anonymous.headers.get('etag') ?? '' });

    expect(anonymous.status).toBe(200);
    expect(signedIn.status).toBe(200);
    expect(notModified.status).toBe(304);
    for (const res of [anonymous, signedIn, notModified]) expectPublicHeaders(res);
    const text = await anonymous.text();
    expect(await signedIn.text()).toBe(text);
    expect(signedIn.headers.get('etag')).toBe(anonymous.headers.get('etag'));
    // No history and no admin (PD9).
    expect(text).not.toContain(ADA);
    expect(text).not.toContain(adaId);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['autoReload', 'purchase', 'schedule', 'starterCredit', 'updatedAt', 'v', 'version'].sort(),
    );

    // Only the app's `http` line for each, which holds no address.
    const lines = t.lines.slice(from);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((e) => [e.event, e.method, e.path, e.status])).toEqual([
      ['http', 'GET', PRICES_JSON_PATH, 200],
      ['http', 'GET', PRICES_JSON_PATH, 200],
      ['http', 'GET', PRICES_JSON_PATH, 304],
    ]);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['event', 'level', 'method', 'ms', 'path', 'rid', 'status', 't']);
    }
    expect(lines.filter((line) => ['203.0.113.7', '127.0.0.1', ADA, adaId].some((w) => line.includes(w)))).toEqual([]);
  });

  it('test_public_prices_absent_without_billing', async () => {
    const { get, savePurchase } = await pricesApp({ billing: false });
    // Not even once an admin saved prices: a server that charges nothing publishes none.
    for (const step of [async () => {}, savePurchase]) {
      await step();
      const res = await get();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});

/**
 * A billing server (the fixture module) on `mockAnthropicFetch`, fact-check on and its routes past their eval, with
 * Tom's device signed in. Every check finds no claim, so a job ends at once; `holds` collects each hold the module
 * answers.
 */
async function billedFactcheckApp(options: TestAppOptions = {}) {
  const config = testConfig({ SIGNUP_ALLOWLIST: TOM, ...ANTHROPIC_ENV, ...BILLING_ENV });
  const fetch = mockAnthropicFetch((_body, kind: AnthropicRequestKind) =>
    kind === 'claims'
      ? { status: 200, body: structuredMessage({ claims: [] }) }
      : { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'unexpected request' } } },
  );
  const ai: AppDeps['ai'] = { clientFor: (r) => clientForRoute(r, config, { fetch }) };
  const t = await createTestApp({ config, ai, billingModule: fixtureModule, ...options });
  cleanup.push(() => t.close());
  const base = { provider: 'anthropic', baseUrl: null, dataPolicy: 'vendor-zdr' };
  const db = t.deps.db.db;
  await seedPassingRoute(db, { ...base, task: 'classify', model: 'claude-haiku-5-5', effort: 'low' });
  const factcheck = { ...base, effort: 'medium', model: 'claude-sonnet-5-5', evalPromptVersion: FACTCHECK_PROMPT_VERSION };
  await seedPassingRoute(db, { ...factcheck, task: 'research' });
  await seedPassingRoute(db, { ...factcheck, task: 'synthesis' });
  const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;
  const headers = { Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` };

  const holds: number[] = [];
  const check = t.provider.check.bind(t.provider);
  t.provider.check = async (ctx) => {
    const decision = await check(ctx);
    if (decision.kind === 'hold') holds.push(decision.amountMicros);
    return decision;
  };

  /** Runs one fact-check job to its end. */
  const runCheck = async () => {
    const post = await serverPost('check', 'The bridge opened in 1932 and cost $10 million to build.');
    const res = await postJson(t.app, FACTCHECK_JOBS_PATH, { v: 1, post }, headers);
    expect(res.status, await res.clone().text()).toBe(202);
    const { id } = FactcheckJobSchema.parse(await res.json());
    for (;;) {
      const polled = await t.app.request(`${factcheckJobPath(id)}?wait=1`, { headers });
      const job = FactcheckJobSchema.parse(await polled.json());
      if (job.status !== 'running') return job;
    }
  };
  return { t, holds, runCheck };
}

describe('readers', { timeout: PGLITE_TIMEOUT }, () => {
  it('test_offers_and_discovery_read_the_store', async () => {
    const { t, holds, runCheck } = await billedFactcheckApp({ priceBook: bookWithFactcheckCap(300_000) });

    const info = await discovery(t);
    expect(info.capabilities.factcheck).toBe(true);
    expect(info.jobPrices?.factcheck).toEqual({ typicalMicros: 240_000, maxMicros: 300_000 });
    expect((await runCheck()).status).toBe('done');
    expect(holds).toEqual([300_000]);

    // A row written outside this process (a direct insert): the copy follows it on refresh, without a restart.
    await t.deps.db.db.insert(priceChanges).values({ action: 'seed', book: bookWithFactcheckCap(350_000) });
    await t.prices.refresh();
    expect((await discovery(t)).jobPrices?.factcheck).toEqual({ typicalMicros: 240_000, maxMicros: 350_000 });
    expect((await runCheck()).status).toBe('done');
    expect(holds).toEqual([300_000, 350_000]);
  });

  it('test_discovery_classify_price_on_billing_servers', async () => {
    const billed = await pricesApp();
    expect((await discovery(billed.t)).classifyPrice).toEqual({ microsPer1000Posts: 146_000 });
    // The document as sent: the field is there, not added by parsing.
    const raw = (await (await billed.t.app.request(SERVER_INFO_PATH)).json()) as Record<string, unknown>;
    expect(raw.classifyPrice).toEqual({ microsPer1000Posts: 146_000 });

    const free = await pricesApp({ billing: false });
    const info = (await (await free.t.app.request(SERVER_INFO_PATH)).json()) as Record<string, unknown>;
    expect(info).not.toHaveProperty('classifyPrice');
    expect(ServerInfoSchema.parse(info).classifyPrice).toBeUndefined();
  });

  it('test_release_doc_prices_section', () => {
    const doc = readFileSync(RELEASE_DOC, 'utf8').replaceAll('\r\n', '\n');
    const start = doc.indexOf('\n## Prices\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = doc.indexOf('\n## ', start + 1);
    const section = end < 0 ? doc.slice(start) : doc.slice(start, end);
    for (const term of ['/admin/prices', '/prices.json', 'price_changes', 'DEFAULT_PRICE_BOOK', 'host.prices']) {
      expect(section, term).toContain(term);
    }
    expect(section).toContain("unAlgorithm Cloud's procedure");
    expect(doc).not.toContain('\n## Changing a price card\n');
    expect(doc).not.toContain('MULTIPLIERS');
    expect(doc).not.toContain('multiplier schedule');
    expect(doc).not.toContain('### The starter credit\n');
  });
});
