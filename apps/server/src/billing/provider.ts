/**
 * The one seam between the open server and a billing module (ADR 0007). A provider is asked before every AI call
 * (allow, hold, or refuse) and told after it (settle what succeeded, or release the hold), reports a balance, and may
 * mount its own routes and pages, add its records to an account's export and hear of the account's deletion first
 * (CL3-15). The built-in provider is a no-op (`BILLING=off`): usage is still recorded and admins set caps, but nobody
 * is charged. With `BILLING=module`, `loadBilling` imports the module at `BILLING_MODULE` at boot, and a module that
 * cannot be used stops the start: a server meant to charge never serves AI for free.
 *
 * A provider sees account ids, amounts and usage counts, never posts: `BillingContext` and `SettleInput` have no field
 * that could carry post text, a name or a prompt, and none may be added.
 */
import { pathToFileURL } from 'node:url';
import { AIError } from '@unalgorithm/ai';
import type { ClassifyResponse, CreditTask, NormalizedUsage } from '@unalgorithm/protocol';
import type { Hono } from 'hono';
import type { Config } from '../config.ts';
import type { AppEnv } from '../http/middleware.ts';
import { errorFields, type Logger } from '../log.ts';
import type { BillingHost, BillingModule } from './host.ts';

/** Every task a server may charge credit for: classify per post, a fact-check or a comparison per job. */
export type BillingTask = CreditTask;

export interface BillingContext {
  userId: string;
  deviceId: string;
  task: BillingTask;
  requestId: string;
  /**
   * The instant `runWithBilling` called `check`. It prices the request: the price card in effect then (CL2-26), for a
   * hold and its settlement alike, even across 00:00 UTC. Set by `runWithBilling`.
   */
  checkedAt: Date;
}

/**
 * The answer to `check`. `hold` reserves credit before a long call (a fact-check or a comparison job): its settlement
 * charges **at most** `amountMicros`, and `runWithBilling` logs `billing.settle.over_hold` at error level when a
 * provider reports more (it still returns that settlement: the server cannot undo a charge). A hold the server neither
 * settles nor releases (the process crashed) must expire on its own; a job never outlives its 240 s deadline plus the
 * 10 s stop drain, so a module may expire a job hold after 15 minutes.
 */
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
  /**
   * The amount to price: our AI cost of the successful calls in micro-dollars, or null when a model has no price card.
   * For a job it sums several calls on different models (claims on one, research and verdicts on another) while `model`
   * names one of them and `chargeableUsage` sums their tokens, so a module charges `retailMicros(costMicros,
   * multiplier)` and never re-prices `chargeableUsage` at `model`'s card.
   */
  costMicros: number | null;
  /** Units used: posts classified, or 1 for a finished check or comparison. */
  posts: number;
  /** The request's `BillingContext.checkedAt`: a settlement is priced at its check's instant. Set by `runWithBilling`. */
  checkedAt: Date;
}

/** What callers hand `runWithBilling`; it adds `checkedAt`. */
export type CheckRequest = Omit<BillingContext, 'checkedAt'>;
/** What a caller's `toSettle` answers; `runWithBilling` adds `checkedAt` (and a hold's id). */
export type SettleRequest = Omit<SettleInput, 'checkedAt' | 'holdId'>;

/** What a settled request cost and the balance left: the `billing` field of the classify response. */
export type Settlement = NonNullable<ClassifyResponse['billing']>;

export interface ReleaseInput {
  userId: string;
  requestId: string;
  holdId?: string;
}

/**
 * An alert a module raises through the server's own alerts (CL4-15) and notifier (CL4-16), which titles it by its key.
 * Content-free: the key and value are the only module text that can reach an email or a webhook.
 */
export interface BillingAlert {
  /** `billing-` and a fixed code chosen by the module: /^billing-[a-z0-9-]{1,40}$/. Never an id, amount or address. */
  key: string;
  level: 'warning' | 'critical';
  /** A count or amount for the message (CL4-16 prints it), or null. */
  value: number | null;
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
  /**
   * What the module holds about this account (balances, ledger entries), for the account export. No post content.
   * Amounts as integer numbers, times as ISO strings.
   */
  exportAccount?(userId: string): Promise<{ [key: string]: JsonValue } | null>;
  /**
   * Called before the account is deleted; a rejection stops the deletion (for example, records a module must keep). It
   * may be called more than once for the same user (a double submit, two tabs, a retry after the server's delete
   * failed), and the server deletes only after it resolves, so the deletion can still fail. It must be idempotent per
   * userId (for example, a fixed ledger idempotency key `account-delete:<userId>`).
   */
  deleteAccount?(userId: string): Promise<void>;
  /**
   * The module's alerts open now, asked every time the server checks its own (CL4-15, every 5 minutes). An alert not
   * answered closes; invalid ones are dropped, at most 20 are kept, and a rejection or an answer later than 5 s keeps
   * the module's open alerts as they are and opens `billing-alerts-failed` (`moduleFindings`).
   */
  alerts?(now: Date): Promise<BillingAlert[]>;
}

/**
 * A value that survives `JSON.stringify` and `z.json()` unchanged (no bigint, no Date, no undefined): what
 * `exportAccount` answers, so a module converts ledger rows read as they are (bigint amounts and ids, `Date` times)
 * instead of failing every export.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const noopBilling: BillingProvider = Object.freeze({
  id: 'off',
  advertised: false,
  check: async (): Promise<BillingDecision> => ({ kind: 'allow' }),
  settle: async () => null,
  release: async () => {},
  balance: async () => null,
});

/**
 * A billing module that cannot be used: missing, failing to import, without `createBillingProvider`, or returning
 * something that is not a provider. The message names `BILLING_MODULE` only, never its path; a failed import keeps its
 * error as `cause`.
 */
export class BillingLoadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BillingLoadError';
  }
}

/** Imports the module at `path` (absolute) and checks that it exports `createBillingProvider`. */
export async function importBillingModule(path: string): Promise<BillingModule> {
  let mod: Partial<BillingModule>;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (cause) {
    throw new BillingLoadError('BILLING_MODULE could not be loaded', { cause });
  }
  if (typeof mod.createBillingProvider !== 'function') {
    throw new BillingLoadError('BILLING_MODULE does not export createBillingProvider');
  }
  return mod as BillingModule;
}

/**
 * The provider for this server. `off`: the no-op provider, and the module path is never touched. `module`: the module's
 * own provider, made with `host`; its errors (such as a `BillingConfigError` naming its variables) propagate unchanged,
 * and a result that is not a whole provider is refused. The routes never change: a module only adds its own (`mount`).
 */
export async function loadBilling(config: Config, host: BillingHost, log: Logger): Promise<BillingProvider> {
  if (config.billing === 'off') return noopBilling;
  const mod = await importBillingModule(config.billingModule ?? '');
  const provider: unknown = await mod.createBillingProvider(host);
  if (!isProvider(provider)) throw new BillingLoadError('the billing module returned an invalid provider');
  log.info('billing.loaded', { billing: provider.id, advertised: provider.advertised });
  return provider;
}

/**
 * A module's provider: an id of its own (`off` is the no-op's), the flag, the four calls, and `mount`, `exportAccount`,
 * `deleteAccount` and `alerts` if any.
 */
function isProvider(value: unknown): value is BillingProvider {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<keyof BillingProvider, unknown>;
  return (
    typeof p.id === 'string' &&
    p.id !== '' &&
    p.id !== noopBilling.id &&
    typeof p.advertised === 'boolean' &&
    [p.check, p.settle, p.release, p.balance].every((fn) => typeof fn === 'function') &&
    [p.mount, p.exportAccount, p.deleteAccount, p.alerts].every((fn) => fn === undefined || typeof fn === 'function')
  );
}

/**
 * Runs one AI call under billing, and is the only place that decides charge or release:
 *
 * 1. `check`; a refusal throws `insufficient-credits` and the call never runs.
 * 2. `call`, then `toSettle` on its result. When either throws, the request is released and the original error is
 *    rethrown unchanged: a failed request is never charged.
 * 3. `toSettle` answering null (no post succeeded) releases the request; anything else is settled as given, plus the
 *    check's instant (`checkedAt`, read once just before `check`) and the hold id of a `hold` decision, in a new object.
 *
 * A `settle` error propagates and fails the request; the provider owns its own idempotency by `requestId`. A `release`
 * error never does: nothing is charged on either release path, so it neither replaces the error of a failed call (the
 * route needs that `AIError` for its answer and retry hint) nor fails a request that succeeded with nothing to charge.
 * It goes to `log` as `billing.release.failed` with the request id and `errorFields` only, and a hold left behind is the
 * provider's to expire. A settlement that charges more than its hold is returned as given and logged as
 * `billing.settle.over_hold` (ids and amounts only): a module bug made visible, not undone.
 */
export async function runWithBilling<T>(
  provider: BillingProvider,
  ctx: CheckRequest,
  call: () => Promise<T>,
  toSettle: (result: T) => SettleRequest | null,
  log?: Logger,
): Promise<{ result: T; billing: Settlement | null }> {
  const checkedAt = new Date();
  const decision = await provider.check({ ...ctx, checkedAt });
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
  let input: SettleRequest | null;
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
  const billing = await provider.settle(holdId === undefined ? { ...input, checkedAt } : { ...input, checkedAt, holdId });
  if (decision.kind === 'hold' && billing !== null && billing.chargedMicros > decision.amountMicros) {
    log?.error('billing.settle.over_hold', {
      rid: ctx.requestId,
      billing: provider.id,
      held_micros: decision.amountMicros,
      charged_micros: billing.chargedMicros,
    });
  }
  return { result, billing };
}
