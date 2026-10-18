import { randomUUID } from 'node:crypto';
import { AIError } from '@unalgorithm/ai';
import {
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceSchedule,
  type CreditTask,
  DEFAULT_PRICE_BOOK,
  priceScheduleProblems,
  ZERO_USAGE,
} from '@unalgorithm/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BillingProvider, type CheckRequest, runWithBilling, type SettleRequest } from '../src/billing/provider.ts';
import * as fixtureModule from './fixtures/billing-module/index.ts';
import { createTestHost } from './support/billing-host.ts';
import { TEST_PRICE_SCHEDULE } from './support/job-prices.ts';
import { captureLog } from './support/log.ts';
import { PGLITE_TIMEOUT } from './support/timeouts.ts';

/** Hosts a test opened, closed after it whatever the outcome. */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Fakes `Date` (only) at an instant the test schedule's job cards are in effect. */
function clockInJobPrices() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
}

/** The fixture's provider on a host priced by `priceSchedule` (default `TEST_PRICE_SCHEDULE`), from `startMicros`. */
async function fixtureProvider(opts: { startMicros?: number; priceSchedule?: CreditPriceSchedule } = {}) {
  const env: Record<string, string> =
    opts.startMicros === undefined ? {} : { BILLING_FIXTURE_START_MICROS: String(opts.startMicros) };
  const t = await createTestHost({ env, priceSchedule: opts.priceSchedule ?? TEST_PRICE_SCHEDULE });
  cleanup.push(() => t.close());
  const provider = await fixtureModule.createBillingProvider(t.host);
  return { provider, settle: vi.spyOn(provider, 'settle'), release: vi.spyOn(provider, 'release') };
}

/** A job's check request, for a fresh account (the fixture's balances are per process). */
function jobRequest(task: CreditTask = 'factcheck'): CheckRequest {
  return { userId: `user-${randomUUID()}`, deviceId: 'device-1', task, requestId: `req-${randomUUID()}` };
}

/** A finished job's settlement: one check, `costMicros` summed over its calls. */
function finished(ctx: CheckRequest, costMicros: number | null): SettleRequest {
  return {
    userId: ctx.userId,
    requestId: ctx.requestId,
    task: ctx.task,
    model: 'claude-sonnet-5-5',
    chargeableUsage: { ...ZERO_USAGE, uncachedInput: 40_000, output: 4_000 },
    costMicros,
    posts: 1,
  };
}

/** The hold `check` answers for `ctx`, without running anything. */
async function holdFor(provider: BillingProvider, ctx: CheckRequest) {
  return provider.check({ ...ctx, checkedAt: new Date() });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('billing host price schedule', () => {
  it(
    'test_billing_host_price_schedule_default_and_override',
    async () => {
      // The host prices from its store's book: the code defaults while none is stored.
      const plain = await createTestHost();
      cleanup.push(() => plain.close());
      expect(plain.host.prices.current().schedule).toEqual(CREDIT_PRICE_SCHEDULE);
      expect(plain.host.prices.current()).toEqual(DEFAULT_PRICE_BOOK);

      // A mutable copy: TEST_PRICE_SCHEDULE is frozen already, so it cannot show that the store freezes what it is given.
      type Mutable = { effectiveFrom: string; cards: Record<string, { maxChargeMicros?: number }> }[];
      const given = structuredClone(TEST_PRICE_SCHEDULE) as unknown as Mutable;
      const priced = await createTestHost({ priceSchedule: given as unknown as CreditPriceSchedule });
      cleanup.push(() => priced.close());
      const schedule = priced.host.prices.current().schedule;
      expect(schedule).toEqual(TEST_PRICE_SCHEDULE);
      expect(priced.host.prices.current()).toBe(priced.prices.current());
      expect(Object.isFrozen(schedule)).toBe(true);
      const entry = schedule[1];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry?.cards)).toBe(true);
      expect(Object.isFrozen(entry?.cards.factcheck)).toBe(true);
      // Changing the caller's schedule afterwards never changes what the host prices with.
      const card = given[1]?.cards.factcheck;
      if (card) card.maxChargeMicros = 1;
      given.push({ effectiveFrom: '2026-10-03T00:00:00Z', cards: {} });
      expect(priced.host.prices.current().schedule).toEqual(TEST_PRICE_SCHEDULE);
    },
    PGLITE_TIMEOUT,
  );

  it('test_test_price_schedule_is_sound', () => {
    expect(priceScheduleProblems(TEST_PRICE_SCHEDULE)).toEqual([]);
  });
});

describe('fixture module job holds', () => {
  it(
    'test_fixture_holds_card_cap_for_factcheck',
    async () => {
      clockInJobPrices();
      const { provider, settle } = await fixtureProvider();
      const check = vi.spyOn(provider, 'check');
      const ctx = jobRequest();
      let heldDuringCall = 0;

      await runWithBilling(
        provider,
        ctx,
        async () => {
          heldDuringCall = fixtureModule.openHolds();
          return 'checked';
        },
        () => finished(ctx, 1_000),
      );

      const holdId = `hold-${ctx.requestId}`;
      expect(await check.mock.results[0]?.value).toEqual({ kind: 'hold', holdId, amountMicros: 400_000 });
      expect(heldDuringCall).toBe(1);
      expect(settle.mock.calls[0]?.[0]).toMatchObject({ holdId });
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_hold_capped_by_balance_and_empty_refused',
    async () => {
      clockInJobPrices();
      const low = await fixtureProvider({ startMicros: 300_000 });
      const ctx = jobRequest();
      expect(await holdFor(low.provider, ctx)).toMatchObject({ kind: 'hold', amountMicros: 300_000 });
      await low.provider.release({ userId: ctx.userId, requestId: ctx.requestId });

      const empty = await fixtureProvider({ startMicros: 0 });
      let calls = 0;
      const err = await rejection(
        runWithBilling(
          empty.provider,
          jobRequest(),
          async () => {
            calls += 1;
            return 'checked';
          },
          () => null,
        ),
      );
      expect(err).toBeInstanceOf(AIError);
      expect((err as AIError).code).toBe('insufficient-credits');
      expect(calls).toBe(0);
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_settles_twice_cost',
    async () => {
      clockInJobPrices();
      const { provider } = await fixtureProvider();
      const ctx = jobRequest();

      const out = await runWithBilling(
        provider,
        ctx,
        async () => 'checked',
        () => finished(ctx, 120_000),
      );

      expect(out.billing).toEqual({ chargedMicros: 240_000, balanceMicros: 760_000 });
      expect(await provider.balance(ctx.userId)).toEqual({ balanceMicros: 760_000 });
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_charge_never_exceeds_hold',
    async () => {
      clockInJobPrices();
      const { provider } = await fixtureProvider();
      const ctx = jobRequest();

      const out = await runWithBilling(
        provider,
        ctx,
        async () => 'checked',
        () => finished(ctx, 300_000),
      );

      expect(out.billing).toEqual({ chargedMicros: 400_000, balanceMicros: 600_000 });
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_releases_on_failure_cancel_and_null_settle',
    async () => {
      clockInJobPrices();
      const { provider, settle, release } = await fixtureProvider();
      const failure = new AIError('overloaded', 'The provider is busy.');
      const cancel = new AbortController();
      cancel.abort();
      const calls: (() => Promise<string>)[] = [
        async () => {
          throw failure;
        },
        async () => {
          cancel.signal.throwIfAborted();
          return 'checked';
        },
      ];

      for (const call of calls) {
        const ctx = jobRequest();
        const err = await rejection(runWithBilling(provider, ctx, call, () => finished(ctx, 120_000)));
        expect(err === failure || (err as Error).name === 'AbortError').toBe(true);
        expect(await provider.balance(ctx.userId)).toEqual({ balanceMicros: 1_000_000 });
        expect(fixtureModule.openHolds()).toBe(0);
      }

      const ctx = jobRequest('perspectives');
      const out = await runWithBilling(
        provider,
        ctx,
        async () => 'nothing compared',
        () => null,
      );
      expect(out.billing).toBeNull();
      expect(await provider.balance(ctx.userId)).toEqual({ balanceMicros: 1_000_000 });
      expect(fixtureModule.openHolds()).toBe(0);

      expect(settle).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(3);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_unpriced_job_charged_zero',
    async () => {
      clockInJobPrices();
      const { provider } = await fixtureProvider();
      const ctx = jobRequest();

      const out = await runWithBilling(
        provider,
        ctx,
        async () => 'checked',
        () => finished(ctx, null),
      );

      expect(out.billing).toEqual({ chargedMicros: 0, balanceMicros: 1_000_000 });
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );

  it(
    'test_fixture_refuses_task_not_offered',
    async () => {
      clockInJobPrices();
      const { provider } = await fixtureProvider({ priceSchedule: CREDIT_PRICE_SCHEDULE });
      let calls = 0;

      const err = await rejection(
        runWithBilling(
          provider,
          jobRequest(),
          async () => {
            calls += 1;
            return 'checked';
          },
          () => null,
        ),
      );

      expect((err as Error).message).toBe('task not offered');
      expect(calls).toBe(0);
      expect(fixtureModule.openHolds()).toBe(0);
    },
    PGLITE_TIMEOUT,
  );
});

describe('runWithBilling and the hold contract', () => {
  /** A provider that holds 400,000 and settles `chargedMicros`. */
  function holdingFake(chargedMicros: number): BillingProvider {
    return {
      id: 'fake',
      advertised: true,
      check: async () => ({ kind: 'hold', holdId: 'hold-1', amountMicros: 400_000 }),
      settle: async () => ({ chargedMicros, balanceMicros: 100_000 }),
      release: async () => {},
      balance: async () => ({ balanceMicros: 100_000 }),
    };
  }

  it('test_run_with_billing_flags_settle_over_hold', async () => {
    const ctx = jobRequest();
    const over = captureLog();
    const out = await runWithBilling(
      holdingFake(500_000),
      ctx,
      async () => 'checked',
      () => finished(ctx, 250_000),
      over.log,
    );
    expect(out.billing).toEqual({ chargedMicros: 500_000, balanceMicros: 100_000 });
    expect(over.events()).toEqual([
      {
        t: expect.any(String),
        level: 'error',
        event: 'billing.settle.over_hold',
        rid: ctx.requestId,
        billing: 'fake',
        held_micros: 400_000,
        charged_micros: 500_000,
      },
    ]);

    for (const charged of [400_000, 240_000]) {
      const within = captureLog();
      await runWithBilling(
        holdingFake(charged),
        ctx,
        async () => 'checked',
        () => finished(ctx, 120_000),
        within.log,
      );
      expect(within.lines).toEqual([]);
    }
  });
});
