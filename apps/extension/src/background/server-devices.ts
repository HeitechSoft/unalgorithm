import { codeForStatus, describeError } from '@unalgorithm/ai';
import {
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  type AccountDevice,
  AccountDevicesResponseSchema,
  type AIErrorCode,
  RevokeDeviceRequestSchema,
  ServerErrorSchema,
} from '@unalgorithm/protocol';
import type { BgError } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import { serverAccountItem } from './server-auth.ts';
import { type ServerHttpDeps, type ServerResult, serverRequest } from './server-http.ts';

/**
 * The account's devices from the extension (R11): the devices list and revoking another device. Revoking this computer
 * itself is the sign-out (the background's `signOutOfServer`). The token stays in `serverRequest`; pages get device ids
 * and names, which are not credentials. The name this computer gives itself at sign-in is `deviceName()`
 * (`device-name.ts`, kept apart because `server-auth.ts` uses it and this module imports `server-auth.ts`).
 */

const TIMEOUT_MS = 10_000;

export type DevicesResult = { ok: true; devices: AccountDevice[] } | { ok: false; error: BgError };
export type RevokeDeviceResult = { ok: true } | { ok: false; error: BgError };

const fail = (code: AIErrorCode, title?: string): { ok: false; error: BgError } => ({
  ok: false,
  error: { code, message: describeError(code, title) },
});

/** The signed-in account's devices, most recently used first. */
export async function listDevices(deps: Partial<ServerHttpDeps> = {}): Promise<DevicesResult> {
  const origin = await signedInOrigin();
  if (typeof origin !== 'string') return origin;
  const res = await serverRequest(origin, ACCOUNT_DEVICES_PATH, { timeoutMs: TIMEOUT_MS }, deps);
  if (!res.ok) return failure(res, origin);
  const body = AccountDevicesResponseSchema.safeParse(res.body);
  return body.success ? { ok: true, devices: body.data.devices } : fail('unknown');
}

/** Signs one of the account's other devices out on the server. */
export async function revokeDevice(deviceId: string, deps: Partial<ServerHttpDeps> = {}): Promise<RevokeDeviceResult> {
  const origin = await signedInOrigin();
  if (typeof origin !== 'string') return origin;
  const body = RevokeDeviceRequestSchema.safeParse({ device_id: deviceId });
  if (!body.success) return fail('bad-request', serverLabel(origin).title);
  const res = await serverRequest(
    origin,
    ACCOUNT_DEVICE_REVOKE_PATH,
    { method: 'POST', body: body.data, timeoutMs: TIMEOUT_MS },
    deps,
  );
  return res.ok ? { ok: true } : failure(res, origin);
}

/** The account's origin, or `auth-required` when nobody is signed in or the account must sign in again. */
async function signedInOrigin(): Promise<string | { ok: false; error: BgError }> {
  const account = await serverAccountItem.getValue();
  if (account && !account.needsSignIn) return account.origin;
  return fail('auth-required', account ? serverLabel(account.origin).title : undefined);
}

/** The extension's own words for a failed request, never the server's text. */
function failure(res: Exclude<ServerResult, { ok: true }>, origin: string): { ok: false; error: BgError } {
  const { title } = serverLabel(origin);
  // `codeForStatus(0)` would say `unknown`.
  if ('reason' in res) return fail(res.reason === 'auth' ? 'auth-required' : 'network', title);
  const wire = ServerErrorSchema.safeParse(res.body);
  return fail(wire.success ? wire.data.code : codeForStatus(res.status, '', new URL(origin).hostname), title);
}
