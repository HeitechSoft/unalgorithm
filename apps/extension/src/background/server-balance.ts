import type { AISourceConfig } from '@unalgorithm/core';
import {
  ACCOUNT_PAGE_PATH,
  type ClassifyResponse,
  CREDIT_BALANCE_PATH,
  CreditBalanceSchema,
  LOW_BALANCE_MICROS,
} from '@unalgorithm/protocol';
import { storage } from 'wxt/utils/storage';
import { isServerAt } from '../lib/server-label.ts';
import { getAccessToken, isTrustedServerOrigin, type ServerAccount } from './server-auth.ts';

/**
 * The signed-in account's credit balance (R5, R31): the latest value a classify answer, a 402 or
 * `GET /v1/billing/balance` reported, so `aiStatus` can show it without waiting on the network. Only a server whose
 * discovery document advertises billing shows one; a self-hosted server with the no-op provider never does. The value
 * stays out of the feed: session storage is closed to content scripts, and only extension pages may ask for `aiStatus`.
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
  updatedAt: number;
}

export const BALANCE_MAX_AGE_MS = 5 * 60_000;
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

async function store(value: StoredBalance): Promise<void> {
  await serverBalanceItem.setValue(value).catch(() => undefined);
}

/**
 * The stored value when it belongs to this account. Sign-out and sign-in leave session storage alone, so a value for
 * another origin or another device (an earlier sign-in) counts as missing.
 */
async function storedFor(account: ServerAccount): Promise<StoredBalance | undefined> {
  try {
    const value = await serverBalanceItem.getValue();
    return value?.origin === account.origin && value.deviceId === account.deviceId ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One balance request per account at a time. */
const refreshing = new Map<string, Promise<StoredBalance | undefined>>();

/**
 * Asks the server for the account's balance and stores it. Resolves with the stored value for this account: the new
 * one, or on any failure the one it had (or undefined). Never rejects, and never marks the account for signing in
 * again: the classify path makes that call (CL1-17).
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
    const url = new URL(CREDIT_BALANCE_PATH, account.origin).href;
    const get = (token: string) =>
      d.fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let res = await get(await d.getAccessToken(account.origin));
    // The access token was revoked or ran out early: one refresh, one retry.
    if (res.status === 401) res = await get(await d.getAccessToken(account.origin, { forceRefresh: true }));
    const body = res.ok ? CreditBalanceSchema.safeParse(await res.json().catch(() => null)) : undefined;
    if (!body?.success) return await storedFor(account);
    const value: StoredBalance = {
      origin: account.origin,
      deviceId: account.deviceId,
      balanceMicros: body.data.balanceMicros,
      source: 'endpoint',
      updatedAt: d.now(),
    };
    await serverBalanceItem.setValue(value);
    return value;
  } catch {
    return storedFor(account);
  }
}

/**
 * The balance `aiStatus` reports, or undefined when there is none to show: the AI source isn't the account's server,
 * the account must sign in again, or its server doesn't advertise billing (R5). Never throws, and never waits on the
 * network for a value it has: a stale value is returned at once while one refresh runs; with no value, it waits for
 * the refresh at most `BALANCE_WAIT_MS`.
 */
export async function balanceStatus(
  cfg: AISourceConfig | null,
  account: ServerAccount | null,
  deps: Partial<BalanceDeps> = {},
): Promise<PublicBalance | undefined> {
  try {
    if (cfg?.kind !== 'server' || !account || account.info.billing !== true || account.needsSignIn) return undefined;
    if (!isServerAt(cfg, account.origin)) return undefined;
    const d = withDefaults(deps);
    let value = await storedFor(account);
    if (!value) value = await within(refreshBalance(account, d), BALANCE_WAIT_MS);
    else if (d.now() - value.updatedAt >= BALANCE_MAX_AGE_MS) void refreshBalance(account, d);
    return value && toPublic(value, account.origin);
  } catch {
    return undefined;
  }
}

function toPublic({ balanceMicros, updatedAt }: StoredBalance, origin: string): PublicBalance {
  return {
    balanceMicros,
    low: balanceMicros > 0 && balanceMicros < LOW_BALANCE_MICROS,
    empty: balanceMicros <= 0,
    accountUrl: accountUrl(origin),
    updatedAt,
  };
}

/** The server's account page, where discovery could have found the server; no link anywhere else. */
function accountUrl(origin: string): string | null {
  try {
    const url = new URL(origin);
    return isTrustedServerOrigin(url) ? new URL(ACCOUNT_PAGE_PATH, url.origin).href : null;
  } catch {
    return null;
  }
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
