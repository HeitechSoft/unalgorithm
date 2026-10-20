import { type AISourceConfig, createLock } from '@unalgorithm/core';
import {
  type ClassifyResponse,
  CREDIT_BALANCE_PATH,
  CreditBalanceSchema,
  LOW_BALANCE_MICROS,
  ServerInfoSchema,
} from '@unalgorithm/protocol';
import { storage } from 'wxt/utils/storage';
import { CLOUD_DATA, hasConsent } from '../lib/data-consent.ts';
import { accountPageUrl, isServerAt } from '../lib/server-label.ts';
import { getAccessToken, type ServerAccount } from './server-auth.ts';
import { serverRequest } from './server-http.ts';

/**
 * The signed-in account's credit balance (R5, R31): the latest value a classify answer, a 402 or
 * `GET /v1/billing/balance` reported, so `aiStatus` can show it without waiting on the network. Only a server whose
 * discovery document advertises billing shows one; a self-hosted server with the no-op provider never does. The value
 * stays out of the feed: session storage is closed to content scripts, and only extension pages may ask for `aiStatus`.
 * In Firefox, without the server's data-collection consent (ADR 0008), there is no balance to show and none is asked
 * for: the server card's Allow brings both back.
 */

/** Session storage: memory only, cleared when the browser closes and by "Erase everything" (storage.session.clear()). */
export const serverBalanceItem = storage.defineItem<StoredBalance | null>('session:serverBalance', { fallback: null });

export interface StoredBalance {
  origin: string;
  /** `ServerAccount.deviceId` of the account the value belongs to (new on every sign-in). */
  deviceId: string;
  balanceMicros: number;
  /** 'endpoint': GET /v1/billing/balance; 'classify': a classify answer's `billing`; 'refused': a 402. */
  source: 'endpoint' | 'classify' | 'refused';
  updatedAt: number;
}

export interface PublicBalance {
  balanceMicros: number;
  /** 0 < balance < LOW_BALANCE_MICROS. */
  low: boolean;
  /** balance <= 0. */
  empty: boolean;
  /** `${origin}/account` for an https origin or a loopback http origin; otherwise null (no link is offered). */
  accountUrl: string | null;
  /**
   * The server's price of 1,000 classified posts, from its discovery document when the extension last read it
   * (`classifyPrice`, PA-04; read again at most every 5 minutes while the server answers, `refreshServerInfo`); null
   * when it sends none or the stored document doesn't parse. "About N posts" uses it.
   */
  microsPer1000Posts: number | null;
  updatedAt: number;
}

export const BALANCE_MAX_AGE_MS = 5 * 60_000;
/**
 * A stored, empty balance is refreshed after this long instead: the person may have just added credit (CL5), and a
 * paused feed tab resumes only once the background sees it.
 */
export const BALANCE_EMPTY_MAX_AGE_MS = 30_000;
/** Longest `balanceStatus` waits for a first refresh when nothing is stored for this origin and account. */
export const BALANCE_WAIT_MS = 3_000;
const TIMEOUT_MS = 10_000;

export interface BalanceDeps {
  fetch: typeof fetch;
  getAccessToken: typeof getAccessToken;
  now: () => number;
}

function withDefaults(deps: Partial<BalanceDeps>): BalanceDeps {
  return { fetch: (input, init) => fetch(input, init), getAccessToken, now: () => Date.now(), ...deps };
}

/** Keeps the balance a classify answer reported. Never throws: classification must not fail over a convenience. */
export async function noteSettlement(
  origin: string,
  deviceId: string,
  billing: NonNullable<ClassifyResponse['billing']>,
  now = Date.now(),
): Promise<void> {
  await store({ origin, deviceId, balanceMicros: billing.balanceMicros, source: 'classify', updatedAt: now });
}

/** The server refused a request for want of credit (402 `insufficient-credits`): the balance is 0. Never throws. */
export async function noteRefused(origin: string, deviceId: string, now = Date.now()): Promise<void> {
  await store({ origin, deviceId, balanceMicros: 0, source: 'refused', updatedAt: now });
}

/**
 * Every write of the balance runs one at a time, so a classify answer or a 402 never lands between a refresh's check
 * and its write.
 */
const writing = createLock();

async function store(value: StoredBalance): Promise<void> {
  await writing(() => serverBalanceItem.setValue(value)).catch(() => undefined);
}

/**
 * `value` when it belongs to this account. Sign-out and sign-in leave session storage alone, so a value for another
 * origin or another device (an earlier sign-in) counts as missing.
 */
function belongsTo(value: StoredBalance | null, account: ServerAccount): StoredBalance | undefined {
  return value?.origin === account.origin && value.deviceId === account.deviceId ? value : undefined;
}

async function storedFor(account: ServerAccount): Promise<StoredBalance | undefined> {
  try {
    return belongsTo(await serverBalanceItem.getValue(), account);
  } catch {
    return undefined;
  }
}

function sameValue(a: StoredBalance | null, b: StoredBalance | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.origin === b.origin &&
    a.deviceId === b.deviceId &&
    a.balanceMicros === b.balanceMicros &&
    a.source === b.source &&
    a.updatedAt === b.updatedAt
  );
}

const restoredListeners = new Set<() => void>();

/**
 * Calls `listener` whenever a refresh moves the stored balance of the same account (origin and device) from 0 or less
 * (a 402 included) to more than 0. Returns the function that removes it.
 */
export function onBalanceRestored(listener: () => void): () => void {
  restoredListeners.add(listener);
  return () => {
    restoredListeners.delete(listener);
  };
}

function notifyRestored(): void {
  for (const listener of [...restoredListeners]) {
    try {
      listener();
    } catch {
      // One listener's failure never stops the others or the stored value.
    }
  }
}

/** One balance request per account at a time. */
const refreshing = new Map<string, Promise<StoredBalance | undefined>>();

/**
 * Asks the server for the account's balance and stores it, unless something else was stored while the request ran (a
 * classify answer, a 402, or "Erase everything"): that is newer than the server's answer and stays, so a refused 0 is
 * never replaced by a balance the server read before it. Resolves with the stored value for this account: the new one,
 * the newer one, or on any failure the one it had (or undefined). Never rejects, and never marks the account for
 * signing in again: the classify path makes that call (CL1-17). In Firefox without the server consent nothing is sent
 * (`serverRequest` refuses) and the stored value stands.
 */
export function refreshBalance(account: ServerAccount, deps: Partial<BalanceDeps> = {}): Promise<StoredBalance | undefined> {
  const key = `${account.origin} ${account.deviceId}`;
  let pending = refreshing.get(key);
  if (!pending) {
    pending = fetchBalance(account, withDefaults(deps)).finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}

async function fetchBalance(account: ServerAccount, d: BalanceDeps): Promise<StoredBalance | undefined> {
  try {
    if (account.info.billing !== true || account.needsSignIn) return await storedFor(account);
    const before = await serverBalanceItem.getValue();
    // A 401 twice leaves the account as it is: the classify path decides about signing in again (CL1-17).
    const res = await serverRequest(
      account.origin,
      CREDIT_BALANCE_PATH,
      { timeoutMs: TIMEOUT_MS, markNeedsSignIn: false },
      { fetch: d.fetch, getAccessToken: d.getAccessToken },
    );
    const body = res.ok ? CreditBalanceSchema.safeParse(res.body) : undefined;
    if (!body?.success) return await storedFor(account);
    const value: StoredBalance = {
      origin: account.origin,
      deviceId: account.deviceId,
      balanceMicros: body.data.balanceMicros,
      source: 'endpoint',
      updatedAt: d.now(),
    };
    const written = await writing(async () => {
      const current = await serverBalanceItem.getValue();
      // Stored while the request ran: newer than what the server read.
      if (!sameValue(current, before)) return { value: belongsTo(current, account), restored: false };
      // Only this account's own value counts: a balance from another sign-in never resumes anything.
      const previous = belongsTo(current, account);
      await serverBalanceItem.setValue(value);
      return { value, restored: previous !== undefined && previous.balanceMicros <= 0 && value.balanceMicros > 0 };
    });
    if (written.restored) notifyRestored();
    return written.value;
  } catch {
    return storedFor(account);
  }
}

/**
 * The balance `aiStatus` reports, or undefined when there is none to show: the AI source isn't the account's server,
 * the account must sign in again, its server doesn't advertise billing (R5), or in Firefox the consent to reach it is
 * missing. Never throws, and never waits on the network for a value it has: a stale value is returned at once while one
 * refresh runs; with no value, it waits for the refresh at most `BALANCE_WAIT_MS`.
 */
export async function balanceStatus(
  cfg: AISourceConfig | null,
  account: ServerAccount | null,
  deps: Partial<BalanceDeps> = {},
): Promise<PublicBalance | undefined> {
  try {
    if (!showsBalance(cfg, account) || !(await hasConsent(CLOUD_DATA))) return undefined;
    const d = withDefaults(deps);
    let value = await storedFor(account);
    if (!value) value = await within(refreshBalance(account, d), BALANCE_WAIT_MS);
    else if (d.now() - value.updatedAt >= maxAge(value)) void refreshBalance(account, d);
    return value && toPublic(value, account);
  } catch {
    return undefined;
  }
}

/** The AI source is this account's server, which advertises billing, and the account needs no new sign-in. */
function showsBalance(cfg: AISourceConfig | null, account: ServerAccount | null): account is ServerAccount {
  if (cfg?.kind !== 'server' || !account || account.info.billing !== true || account.needsSignIn) return false;
  return isServerAt(cfg, account.origin);
}

function maxAge(value: StoredBalance): number {
  return value.balanceMicros <= 0 ? BALANCE_EMPTY_MAX_AGE_MS : BALANCE_MAX_AGE_MS;
}

/**
 * A paused feed tab became visible again (CL5): refreshes the account's balance when its stored value is empty and at
 * least `BALANCE_EMPTY_MAX_AGE_MS` old, so credit added meanwhile resumes AI through `onBalanceRestored`. Asks
 * nothing when the balance is positive or unknown, or under the same conditions `balanceStatus` shows none. Never
 * throws.
 */
export async function checkBalanceSoon(
  cfg: AISourceConfig | null,
  account: ServerAccount | null,
  deps: Partial<BalanceDeps> = {},
): Promise<void> {
  try {
    if (!showsBalance(cfg, account) || !(await hasConsent(CLOUD_DATA))) return;
    const d = withDefaults(deps);
    const value = await storedFor(account);
    if (value && value.balanceMicros <= 0 && d.now() - value.updatedAt >= BALANCE_EMPTY_MAX_AGE_MS) {
      await refreshBalance(account, d);
    }
  } catch {
    // A convenience: the tab stays paused until the next check, a reload or the popup.
  }
}

function toPublic({ balanceMicros, updatedAt }: StoredBalance, account: ServerAccount): PublicBalance {
  // Parsed again: storage.local is writable by content scripts (ADR 0005), so a stored price is used only when the
  // whole document is one the extension accepts.
  const info = ServerInfoSchema.safeParse(account.info);
  return {
    balanceMicros,
    low: balanceMicros > 0 && balanceMicros < LOW_BALANCE_MICROS,
    empty: balanceMicros <= 0,
    accountUrl: accountPageUrl(account.origin),
    microsPer1000Posts: (info.success ? info.data.classifyPrice?.microsPer1000Posts : undefined) ?? null,
    updatedAt,
  };
}

/** `promise`'s value, or undefined once `ms` have passed (the promise carries on). */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}
