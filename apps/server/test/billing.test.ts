import { AIError } from '@unalgorithm/ai';
import { ZERO_USAGE } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import {
  type BillingContext,
  type BillingDecision,
  type BillingProvider,
  noopBilling,
  type ReleaseInput,
  runWithBilling,
  type SettleInput,
  selectBilling,
} from '../src/billing/provider.ts';
import { loadConfig } from '../src/config.ts';
import { captureLog } from './support/log.ts';

const CTX: BillingContext = { userId: 'user-1', deviceId: 'device-1', task: 'classify', requestId: 'req-1' };

function settleInput(): SettleInput {
  return {
    userId: CTX.userId,
    requestId: CTX.requestId,
    task: 'classify',
    model: 'claude-haiku-5-5',
    chargeableUsage: { ...ZERO_USAGE, uncachedInput: 1_200, output: 300 },
    costMicros: 270,
    posts: 3,
  };
}

/** What the fake's `settle` answers. */
const SETTLED = { chargedMicros: 270, balanceMicros: 4_730 };

/** A provider that answers `decision` to every check and records every call it receives. */
function recordingFake(decision: BillingDecision = { kind: 'allow' }) {
  const calls = {
    check: [] as BillingContext[],
    settle: [] as SettleInput[],
    release: [] as ReleaseInput[],
  };
  const provider: BillingProvider = {
    id: 'fake',
    advertised: true,
    async check(ctx) {
      calls.check.push(ctx);
      return decision;
    },
    async settle(input) {
      calls.settle.push(input);
      return SETTLED;
    },
    async release(input) {
      calls.release.push(input);
    },
    async balance() {
      return { balanceMicros: SETTLED.balanceMicros };
    },
  };
  return { provider, calls };
}

/** An AI call that counts how often it runs and answers `result`. */
function countingCall<T>(result: T) {
  const counter = { calls: 0 };
  const call = async () => {
    counter.calls += 1;
    return result;
  };
  return { call, counter };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

describe('no-op provider', () => {
  it('test_noop_billing_allows_and_charges_nothing', async () => {
    expect(noopBilling.id).toBe('off');
    expect(noopBilling.advertised).toBe(false);
    expect(noopBilling.mount).toBeUndefined();
    await expect(noopBilling.check(CTX)).resolves.toEqual({ kind: 'allow' });
    await expect(noopBilling.settle(settleInput())).resolves.toBeNull();
    await expect(noopBilling.release({ userId: CTX.userId, requestId: CTX.requestId })).resolves.toBeUndefined();
    await expect(noopBilling.balance(CTX.userId)).resolves.toBeNull();
  });

  it('test_select_billing_off_returns_noop', () => {
    const config = loadConfig({
      PUBLIC_URL: 'https://cloud.example.org',
      DATABASE_URL: 'postgres://unalgorithm@db:5432/unalgorithm',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      SMTP_HOST: 'smtp.example.org',
      MAIL_FROM: 'noreply@example.org',
      AI_PROVIDER: 'anthropic',
      AI_API_KEY: 'test-key',
    });
    expect(selectBilling({ ...config, billing: 'off' })).toBe(noopBilling);
  });

  it('test_run_with_noop_returns_null_billing', async () => {
    const out = await runWithBilling(noopBilling, CTX, async () => 'answer', settleInput);
    expect(out).toEqual({ result: 'answer', billing: null });
  });
});

describe('runWithBilling with a recording fake', () => {
  it('test_refusal_never_calls_ai', async () => {
    const { provider, calls } = recordingFake({ kind: 'refuse', code: 'insufficient-credits', message: 'Balance is empty.' });
    const { call, counter } = countingCall('answer');

    const err = await rejection(runWithBilling(provider, CTX, call, settleInput));

    expect(err).toBeInstanceOf(AIError);
    expect((err as AIError).code).toBe('insufficient-credits');
    expect((err as AIError).message).toBe('Balance is empty.');
    expect(counter.calls).toBe(0);
    expect(calls.check).toEqual([CTX]);
    expect(calls.settle).toHaveLength(0);
    expect(calls.release).toHaveLength(0);
  });

  it('test_failed_call_is_released_not_settled', async () => {
    const { provider, calls } = recordingFake();
    const failure = new AIError('overloaded', 'The provider is busy.');
    let toSettleCalls = 0;

    const err = await rejection(
      runWithBilling(
        provider,
        CTX,
        async () => {
          throw failure;
        },
        () => {
          toSettleCalls += 1;
          return settleInput();
        },
      ),
    );

    expect(err).toBe(failure);
    expect(calls.release).toEqual([{ userId: CTX.userId, requestId: CTX.requestId }]);
    expect(calls.settle).toHaveLength(0);
    expect(toSettleCalls).toBe(0);
  });

  it('test_nothing_chargeable_is_released', async () => {
    const { provider, calls } = recordingFake();

    const out = await runWithBilling(
      provider,
      CTX,
      async () => 'every post failed',
      () => null,
    );

    expect(out).toEqual({ result: 'every post failed', billing: null });
    expect(calls.release).toEqual([{ userId: CTX.userId, requestId: CTX.requestId }]);
    expect(calls.settle).toHaveLength(0);
  });

  it('test_success_is_settled_once', async () => {
    const { provider, calls } = recordingFake();
    const input = settleInput();

    const out = await runWithBilling(
      provider,
      CTX,
      async () => 'answer',
      () => input,
    );

    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]).toBe(input);
    expect(calls.release).toHaveLength(0);
    expect(out.result).toBe('answer');
    expect(out.billing).toEqual(SETTLED);
  });

  it('test_hold_id_flows_to_settle_and_release', async () => {
    const hold: BillingDecision = { kind: 'hold', holdId: 'hold-7', amountMicros: 5_000 };
    const released = { userId: CTX.userId, requestId: CTX.requestId, holdId: 'hold-7' };

    const settled = recordingFake(hold);
    await runWithBilling(settled.provider, CTX, async () => 'answer', settleInput);
    expect(settled.calls.settle).toEqual([{ ...settleInput(), holdId: 'hold-7' }]);
    expect(settled.calls.release).toHaveLength(0);

    const nothingChargeable = recordingFake(hold);
    await runWithBilling(
      nothingChargeable.provider,
      CTX,
      async () => 'every post failed',
      () => null,
    );
    expect(nothingChargeable.calls.release).toEqual([released]);
    expect(nothingChargeable.calls.settle).toHaveLength(0);

    const failed = recordingFake(hold);
    const failure = new AIError('timeout', 'The provider took too long.');
    const err = await rejection(
      runWithBilling(
        failed.provider,
        CTX,
        async () => {
          throw failure;
        },
        settleInput,
      ),
    );
    expect(err).toBe(failure);
    expect(failed.calls.release).toEqual([released]);
    expect(failed.calls.settle).toHaveLength(0);
  });

  it('test_release_failure_keeps_the_outcome', async () => {
    const hold: BillingDecision = { kind: 'hold', holdId: 'hold-7', amountMicros: 5_000 };
    const { provider, calls } = recordingFake(hold);
    const ledgerDown: BillingProvider = {
      ...provider,
      async release(input) {
        calls.release.push(input);
        throw new Error('ledger unavailable for user-1');
      },
    };
    const { log, lines, events } = captureLog();

    // A failed call: the AI error itself comes back, retry hint and usage included.
    const failure = new AIError('overloaded', 'The provider is busy.', {
      retryAfterMs: 2_000,
      usage: { ...ZERO_USAGE, uncachedInput: 800 },
    });
    const err = await rejection(
      runWithBilling(
        ledgerDown,
        CTX,
        async () => {
          throw failure;
        },
        settleInput,
        log,
      ),
    );
    expect(err).toBe(failure);

    // Nothing chargeable: the result still comes back, uncharged.
    const out = await runWithBilling(
      ledgerDown,
      CTX,
      async () => 'every post failed',
      () => null,
      log,
    );
    expect(out).toEqual({ result: 'every post failed', billing: null });

    expect(calls.release).toHaveLength(2);
    expect(calls.settle).toHaveLength(0);
    expect(events()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'billing.release.failed', rid: CTX.requestId, billing: 'fake' }),
      expect.objectContaining({ level: 'warn', event: 'billing.release.failed', rid: CTX.requestId, billing: 'fake' }),
    ]);
    // Only `errorFields`: the provider's message never reaches the log.
    for (const line of lines) expect(line).not.toContain('ledger unavailable');

    // Without a log the outcome is the same.
    await expect(
      runWithBilling(
        ledgerDown,
        CTX,
        async () => 'answer',
        () => null,
      ),
    ).resolves.toEqual({
      result: 'answer',
      billing: null,
    });
  });
});
