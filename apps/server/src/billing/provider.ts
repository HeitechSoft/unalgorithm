/**
 * The one seam between the open server and a billing module (ADR 0007). A provider is asked before every AI call
 * (allow, hold, or refuse) and told after it (settle what succeeded, or release the hold), reports a balance, and may
 * mount its own routes and pages. The built-in provider is a no-op (`BILLING=off`): usage is still recorded and admins
 * set caps, but nobody is charged.
 *
 * A provider sees account ids, amounts and usage counts, never posts: `BillingContext` and `SettleInput` have no field
 * that could carry post text, a name or a prompt, and none may be added.
 */
import { AIError } from '@unalgorithm/ai';
import type { ClassifyResponse, NormalizedUsage } from '@unalgorithm/protocol';
import type { Hono } from 'hono';
import type { Config } from '../config.ts';
import type { AppEnv } from '../http/middleware.ts';
import { errorFields, type Logger } from '../log.ts';

export type BillingTask = 'classify';

export interface BillingContext {
  userId: string;
  deviceId: string;
  task: BillingTask;
  requestId: string;
}

export type BillingDecision =
  | { kind: 'allow' }
  | { kind: 'hold'; holdId: string; amountMicros: number }
  | { kind: 'refuse'; code: 'insufficient-credits'; message: string };

export interface SettleInput {
  userId: string;
  requestId: string;
  task: BillingTask;
  /** Set by `runWithBilling` from a `hold` decision; callers leave it out. */
  holdId?: string;
  model: string;
  /** Usage of the successful calls only: a failed call is never charged. */
  chargeableUsage: NormalizedUsage;
  /** `costMicros(model, chargeableUsage)`, or null when the model has no price card. */
  costMicros: number | null;
  /** Posts classified successfully. */
  posts: number;
}

/** What a settled request cost and the balance left: the `billing` field of the classify response. */
export type Settlement = NonNullable<ClassifyResponse['billing']>;

export interface ReleaseInput {
  userId: string;
  requestId: string;
  holdId?: string;
}

export interface BillingProvider {
  /** `off` for the no-op provider. */
  readonly id: string;
  /** The `billing` flag in `/.well-known/unalgorithm.json`: the extension shows credits only when it is true. */
  readonly advertised: boolean;
  check(ctx: BillingContext): Promise<BillingDecision>;
  /** Charges a finished request. Null when nothing is charged (the no-op provider). */
  settle(input: SettleInput): Promise<Settlement | null>;
  /**
   * Lets go of a request that is not charged, and of its hold when there is one. Best effort: `runWithBilling` logs a
   * rejection and carries on, so a hold that is not released must expire on its own.
   */
  release(input: ReleaseInput): Promise<void>;
  /** Null when the provider keeps no balance. */
  balance(userId: string): Promise<{ balanceMicros: number } | null>;
  /** Mounts the module's own routes and pages on the server's app, behind its middleware and after its routes. */
  mount?(app: Hono<AppEnv>): void;
}

export const noopBilling: BillingProvider = Object.freeze({
  id: 'off',
  advertised: false,
  check: async (): Promise<BillingDecision> => ({ kind: 'allow' }),
  settle: async () => null,
  release: async () => {},
  balance: async () => null,
});

/**
 * The provider for this server. CL1 knows only `off`; the private module extends the `BILLING` enum and this function
 * (a module path loaded at boot), never the routes.
 */
export function selectBilling(config: Config): BillingProvider {
  switch (config.billing) {
    case 'off':
      return noopBilling;
  }
}

/**
 * Runs one AI call under billing, and is the only place that decides charge or release:
 *
 * 1. `check`; a refusal throws `insufficient-credits` and the call never runs.
 * 2. `call`, then `toSettle` on its result. When either throws, the request is released and the original error is
 *    rethrown unchanged: a failed request is never charged.
 * 3. `toSettle` answering null (no post succeeded) releases the request; anything else is settled exactly as given,
 *    plus the hold id of a `hold` decision.
 *
 * A `settle` error propagates and fails the request; the provider owns its own idempotency by `requestId`. A `release`
 * error never does: nothing is charged on either release path, so it neither replaces the error of a failed call (the
 * route needs that `AIError` for its answer and retry hint) nor fails a request that succeeded with nothing to charge.
 * It goes to `log` as `billing.release.failed` with the request id and `errorFields` only, and a hold left behind is the
 * provider's to expire.
 */
export async function runWithBilling<T>(
  provider: BillingProvider,
  ctx: BillingContext,
  call: () => Promise<T>,
  toSettle: (result: T) => SettleInput | null,
  log?: Logger,
): Promise<{ result: T; billing: Settlement | null }> {
  const decision = await provider.check(ctx);
  if (decision.kind === 'refuse') throw new AIError('insufficient-credits', decision.message);

  const holdId = decision.kind === 'hold' ? decision.holdId : undefined;
  const release = async () => {
    try {
      await provider.release({ userId: ctx.userId, requestId: ctx.requestId, holdId });
    } catch (err) {
      log?.warn('billing.release.failed', { rid: ctx.requestId, billing: provider.id, ...errorFields(err) });
    }
  };

  let result: T;
  let input: SettleInput | null;
  try {
    result = await call();
    input = toSettle(result);
  } catch (err) {
    await release();
    throw err;
  }

  if (input === null) {
    await release();
    return { result, billing: null };
  }
  return { result, billing: await provider.settle(holdId === undefined ? input : { ...input, holdId }) };
}
