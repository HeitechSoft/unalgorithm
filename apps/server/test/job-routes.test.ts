/**
 * The job-endpoint kit (P3-33): `mountJobRoutes` with a fake `JobSpec` (task `perspectives`, an injected job store and a
 * fake billing provider), `jobOffer` for any job task, and the fact-check routes re-mounted on the kit with their OpenAPI
 * paths unchanged. The RM2 fact-check suites are the regression proof of the lifecycle; nothing here calls a model.
 */
import { readFileSync } from 'node:fs';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { AIError } from '@unalgorithm/ai';
import { CREDIT_PRICE_SCHEDULE, costMicros, jobSchemaFor, ZERO_USAGE } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { LimitDeps } from '../src/ai/limits.ts';
import type { BillingProvider } from '../src/billing/provider.ts';
import { usageEvents } from '../src/db/schema.ts';
import type { AppEnv } from '../src/http/app.ts';
import { createJobStore, type JobStore } from '../src/jobs/memory-jobs.ts';
import { factcheckRoutes } from '../src/routes/factcheck.ts';
import { type JobRun, type JobSpec, jobOffer, mountJobRoutes } from '../src/routes/jobs.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { DEV_EXTENSION_ORIGIN, postJson, signInDevice } from './support/sign-in.ts';
import { createTestApp, testConfig } from './support/test-app.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

const TOM = 'tom@example.com';
const START = '/v1/jobs/kit-test';
const jobPath = (id: string) => `${START}/${id}`;
const cancelPath = (id: string) => `${START}/${id}/cancel`;
const MODEL = 'claude-sonnet-5-5';
const USAGE = { ...ZERO_USAGE, uncachedInput: 1000, output: 100 };

interface Result {
  n: number;
}
const RequestSchema = z.object({ v: z.literal(1), x: z.string().max(100) });
type Req = z.infer<typeof RequestSchema>;
const ViewSchema = jobSchemaFor(z.object({ n: z.number() }));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface KitOptions {
  offered?: boolean;
  limitsFail?: boolean;
  prepareFail?: boolean;
  /** The run's outcome. Default: resolves with `{ n: 3 }` after one priced call. */
  run?: 'resolve' | 'reject';
}

/** A fake billing provider: always a hold, and counts of its settles and releases. */
function fakeBilling() {
  const counts = { checks: 0, settles: 0, releases: 0 };
  const provider: BillingProvider = {
    id: 'fake',
    advertised: true,
    check: async () => {
      counts.checks++;
      return { kind: 'hold', holdId: 'h1', amountMicros: 500_000 };
    },
    settle: async () => {
      counts.settles++;
      return { chargedMicros: 1, balanceMicros: 0 };
    },
    release: async () => {
      counts.releases++;
    },
    balance: async () => null,
  };
  return { provider, counts };
}

/** The test app with the kit mounted on a fake spec, an injected job store watching `finish`, and a signed-in device. */
async function kitApp(opts: KitOptions = {}) {
  const billing = fakeBilling();
  const t = await createTestApp({ config: testConfig({ SIGNUP_ALLOWLIST: TOM }), billing: billing.provider });
  cleanup.push(t.close);
  const calls: string[] = [];
  let releases = 0;
  /** At each `finish`: the releases so far and the job's rows (run then, so it sees the database as it was). */
  const atFinish: { releases: number; rows: Promise<(typeof usageEvents.$inferSelect)[]> }[] = [];
  const store = createJobStore<Result>({ ttlMs: 60_000, maxRunning: 4, maxKeptPerUser: 5 });
  const jobs: JobStore<Result> = {
    ...store,
    finish: (id, end) => {
      // `execute()` now: a drizzle query is lazy until awaited, and awaited only after the job ended it would also see
      // a row written after `finish`.
      const rows = t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.requestId, id)).execute();
      atFinish.push({ releases, rows });
      store.finish(id, end);
    },
    get running() {
      return store.running;
    },
    get size() {
      return store.size;
    },
  };
  const spec: JobSpec<Req, Result> = {
    task: 'perspectives',
    paths: { start: START, job: jobPath, cancel: cancelPath },
    request: RequestSchema,
    view: ViewSchema,
    texts: {
      notOffered: 'Not offered.',
      start: 'Running',
      refused400: 'Not valid',
      refused429: 'Too many',
      unavailable503: 'Unavailable',
      busyUser: 'Busy user.',
      busyServer: 'Busy server.',
    },
    refusedModel: 'refused-model',
    offer: () => (opts.offered === false ? { offered: false } : { offered: true, maxCostMicros: 250_000 }),
    admit: (req) => {
      calls.push('admit');
      if (req.x === 'bad') throw new AIError('bad-request', 'Refused.');
    },
    limits: async () => {
      calls.push('limits');
      if (opts.limitsFail) throw new AIError('rate-limit', 'Limited.');
      return () => {
        releases++;
        calls.push('release');
      };
    },
    prepare: async (maxCostMicros): Promise<JobRun<Result>> => {
      calls.push(`prepare:${maxCostMicros}`);
      if (opts.prepareFail) throw new AIError('not-available', 'No route.');
      return {
        routeId: t.route.id,
        model: MODEL,
        run: async (_signal, onUsage) => {
          onUsage({ model: MODEL, usage: USAGE, failed: false });
          if (opts.run === 'reject') throw new Error('boom');
          return { n: 3 };
        },
      };
    },
    summary: (r) => ({ things: r?.n ?? 0 }),
  };
  // Before the first request: routes are fixed once the app has answered one.
  mountJobRoutes(t.app, { ...t.deps, jobs }, spec);
  const token = (await signInDevice(t.app, t.outbox, TOM)).access_token;
  const headers = { Origin: DEV_EXTENSION_ORIGIN, Authorization: `Bearer ${token}` };
  const start = (x = 'hello') => postJson(t.app, START, { v: 1, x }, headers);
  const rows = () => t.deps.db.db.select().from(usageEvents).where(eq(usageEvents.task, 'perspectives'));
  /** Polls (`?wait=1`) until the job has ended. */
  const ended = async (id: string) => {
    for (;;) {
      const res = await t.app.request(`${jobPath(id)}?wait=1`, { headers });
      expect(res.status).toBe(200);
      const view = ViewSchema.parse(await res.json());
      if (view.status !== 'running') return view;
    }
  };
  return { ...t, calls, billing: billing.counts, atFinish, start, rows, ended, releases: () => releases };
}

/** The keys every log line carries, whatever the event. */
const BASE_KEYS = ['t', 'level', 'event'];

describe('the job kit', () => {
  it(
    'test_job_kit_offer_first: a task not offered answers 503 before admit, limits or prepare',
    async () => {
      const t = await kitApp({ offered: false });
      const res = await t.start();
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('not-available');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(t.calls).toEqual([]);
      expect(await t.rows()).toEqual([]);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_job_kit_order_and_refused_row: admit before limits; one refused row and one release on a refusal',
    async () => {
      const refusedByAdmit = await kitApp();
      expect((await refusedByAdmit.start('bad')).status).toBe(400);
      expect(refusedByAdmit.calls).toEqual(['admit']);
      expect(await refusedByAdmit.rows()).toEqual([]);

      const byPrepare = await kitApp({ prepareFail: true });
      expect((await byPrepare.start()).status).toBe(503);
      expect(byPrepare.calls).toEqual(['admit', 'limits', 'prepare:250000', 'release']);
      const prepRows = await byPrepare.rows();
      expect(prepRows).toHaveLength(1);
      expect(prepRows[0]).toMatchObject({
        outcome: 'refused-before-call',
        model: 'refused-model',
        routeId: null,
        calls: 0,
        chargeableCostMicros: 0,
      });
      expect(byPrepare.releases()).toBe(1);
      expect(byPrepare.billing.checks).toBe(0);

      const byLimits = await kitApp({ limitsFail: true });
      expect((await byLimits.start()).status).toBe(429);
      expect(byLimits.calls).toEqual(['admit', 'limits']);
      const limitRows = await byLimits.rows();
      expect(limitRows).toHaveLength(1);
      expect(limitRows[0]).toMatchObject({ outcome: 'refused-before-call', model: 'refused-model', routeId: null });
    },
    PGLITE_TIMEOUT * 3,
  );

  it(
    'test_job_kit_row_and_release_before_done: the row and the release come before the job ends, done or failed',
    async () => {
      const ok = await kitApp();
      const res = await ok.start();
      expect(res.status).toBe(202);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { id } = ViewSchema.parse(await res.json());
      const view = await ok.ended(id);
      expect(view).toMatchObject({ status: 'done', result: { n: 3 } });
      expect(ok.atFinish).toHaveLength(1);
      const [done] = ok.atFinish;
      expect(done?.releases).toBe(1);
      const doneRows = await done?.rows;
      expect(doneRows).toHaveLength(1);
      expect(doneRows?.[0]).toMatchObject({
        requestId: id,
        task: 'perspectives',
        model: MODEL,
        routeId: ok.route.id,
        outcome: 'ok',
        calls: 1,
        chargeableCostMicros: costMicros(MODEL, USAGE),
      });
      expect(ok.billing).toEqual({ checks: 1, settles: 1, releases: 0 });

      const failing = await kitApp({ run: 'reject' });
      const started = await failing.start();
      expect(started.status).toBe(202);
      const failedId = ViewSchema.parse(await started.json()).id;
      expect(await failing.ended(failedId)).toMatchObject({ status: 'failed', error: { code: 'unknown' } });
      const [failed] = failing.atFinish;
      expect(failed?.releases).toBe(1);
      const failedRows = await failed?.rows;
      expect(failedRows).toHaveLength(1);
      expect(failedRows?.[0]).toMatchObject({ outcome: 'failed', chargeableCostMicros: 0, calls: 1 });
      // The hold was released, never settled.
      expect(failing.billing).toEqual({ checks: 1, settles: 0, releases: 1 });
    },
    PGLITE_TIMEOUT * 2,
  );

  it(
    'test_job_kit_done_log_keys: the <task>.done line holds rid, outcome, cost_micros, ms and the summary only',
    async () => {
      const t = await kitApp();
      const res = await t.start('a post text that must never be logged');
      const { id } = ViewSchema.parse(await res.json());
      await t.ended(id);
      const done = t.events().filter((e) => e.event === 'perspectives.done');
      expect(done).toHaveLength(1);
      const line = done[0] ?? {};
      const own = Object.keys(line).filter((k) => !BASE_KEYS.includes(k));
      expect(own.sort()).toEqual(['cost_micros', 'ms', 'outcome', 'rid', 'things']);
      expect(line).toMatchObject({ rid: id, outcome: 'done', things: 3, cost_micros: costMicros(MODEL, USAGE) });
      expect(t.lines.join('\n')).not.toContain('never be logged');
    },
    PGLITE_TIMEOUT,
  );
});

describe('the fact-check routes on the kit', () => {
  it(
    'test_openapi_factcheck_paths_unchanged: the three paths deep-equal the pre-refactor build',
    async () => {
      const t = await createTestApp();
      cleanup.push(t.close);
      // Only the fact-check routes: the whole app's document is not what this compares.
      const app = new OpenAPIHono<AppEnv>();
      const jobs = createJobStore<never>({ ttlMs: 1, maxRunning: 1, maxKeptPerUser: 1 });
      factcheckRoutes(app, { ...t.deps, priceSchedule: CREDIT_PRICE_SCHEDULE, factcheckJobs: jobs }, {} as LimitDeps);
      const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '1' } });
      const fixture = JSON.parse(readFileSync(new URL('./fixtures/openapi/factcheck-paths.json', import.meta.url), 'utf8'));
      expect(JSON.parse(JSON.stringify(doc.paths))).toEqual(fixture);
    },
    PGLITE_TIMEOUT,
  );

  it('test_factcheck_route_is_a_spec: factcheck.ts is a short spec, and the kit knows no pipeline', () => {
    const factcheck = readFileSync(new URL('../src/routes/factcheck.ts', import.meta.url), 'utf8');
    expect(factcheck.split('\n').length).toBeLessThan(120);
    expect(factcheck).toMatch(/import \{[^}]*\bmountJobRoutes\b[^}]*\} from '\.\/jobs\.ts'/);
    const kit = readFileSync(new URL('../src/routes/jobs.ts', import.meta.url), 'utf8');
    expect(kit).not.toContain('@unalgorithm/research');
  });
});

describe('jobOffer', () => {
  it('test_job_offer_rule_for_any_task: perspectives on a billing server, disabled, and BILLING=off', () => {
    const at = new Date('2026-10-15T12:00:00Z');
    const o = { enabled: true, defaultCeilingMicros: 123_000 };
    expect(jobOffer('perspectives', { ...o, billing: 'module' }, TEST_PRICE_SCHEDULE, at)).toEqual({
      offered: true,
      price: { typicalMicros: 270_000, maxMicros: 500_000 },
      maxCostMicros: 250_000,
    });
    expect(jobOffer('perspectives', { ...o, enabled: false, billing: 'module' }, TEST_PRICE_SCHEDULE, at)).toEqual({
      offered: false,
    });
    expect(jobOffer('perspectives', { ...o, billing: 'off' }, TEST_PRICE_SCHEDULE, at)).toEqual({
      offered: true,
      price: null,
      maxCostMicros: 123_000,
    });
  });
});
