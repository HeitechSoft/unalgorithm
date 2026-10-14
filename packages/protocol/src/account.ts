import { z } from 'zod';
import { SyncValueSchema } from './sync.ts';

/**
 * Account contracts (R11, R12): the devices list with revoke, and the account's export and deletion. The server, the
 * account page (apps/web) and the extension all speak them. `server.ts` imports `DeviceNameSchema` from here, so this
 * file never imports `server.ts`.
 */

// ACCOUNT_PAGE_PATH ('/account') already exists (CL2-01, billing.ts): the page CL2-08 adds and CL3 extends.
/** GET with the device's bearer token or the web session: the account's signed-in devices. */
export const ACCOUNT_DEVICES_PATH = '/v1/account/devices';
/** POST with the device's bearer token or the web session: sign one of the account's devices out. */
export const ACCOUNT_DEVICE_REVOKE_PATH = '/v1/account/devices/revoke';
/** GET with the web session: everything the server holds about the account, as one JSON download. */
export const ACCOUNT_EXPORT_PATH = '/v1/account/export';
/** POST with the web session: delete the account. */
export const ACCOUNT_DELETE_PATH = '/v1/account/delete';

/**
 * What the extension calls itself at sign-in, e.g. "Chrome on Windows". Letters, digits, spaces and . _ ( ) - only.
 * Self-declared, coarse and optional: the server stores what passes and never derives a name from the User-Agent.
 */
export const DeviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} ._()-]+$/u);
export type DeviceName = z.infer<typeof DeviceNameSchema>;

/** The most devices the list answers, most recently used first: far more than one person signs in. */
export const MAX_ACCOUNT_DEVICES = 200;

const Iso = z.iso.datetime();

export const AccountDeviceSchema = z.object({
  id: z.uuid(),
  /** Null for devices that signed in before CL3-11. */
  name: DeviceNameSchema.nullable(),
  createdAt: Iso,
  lastUsedAt: Iso.nullable(),
  /** The device whose access token made the request (never one, for the web session). */
  current: z.boolean(),
});
export type AccountDevice = z.infer<typeof AccountDeviceSchema>;
export const AccountDevicesResponseSchema = z.object({
  v: z.literal(1),
  devices: z.array(AccountDeviceSchema).max(MAX_ACCOUNT_DEVICES),
});
export type AccountDevicesResponse = z.infer<typeof AccountDevicesResponseSchema>;

export const RevokeDeviceRequestSchema = z.object({ device_id: z.uuid() });
export type RevokeDeviceRequest = z.infer<typeof RevokeDeviceRequestSchema>;

/** The answer of a request that changes something and has nothing else to say. */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponseSchema>;

/** Deleting needs the account's address typed again (compared case-insensitively by the server). */
export const DeleteAccountRequestSchema = z.object({ confirm: z.string().trim().min(3).max(320) });
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

/**
 * The JSON a person downloads; field names are part of the contract. It carries no secret: no token, hash, code, key,
 * passkey public key or credential id (parsing strips any key not listed here). `account.email` and `server.origin` are
 * plain strings: a self-hosted server can hold `a@localhost` (which zod's email rule refuses) and run on
 * `http://127.0.0.1:…`.
 */
export const AccountExportSchema = z.object({
  v: z.literal(1),
  exportedAt: Iso,
  server: z.object({ name: z.string().max(80), origin: z.string().max(200), version: z.string().max(40) }),
  account: z.object({ email: z.string().max(320), createdAt: Iso, linkedProviders: z.array(z.string().max(40)) }),
  devices: z.array(
    z.object({
      id: z.uuid(),
      name: DeviceNameSchema.nullable(),
      createdAt: Iso,
      lastUsedAt: Iso.nullable(),
      revokedAt: Iso.nullable(),
      revokedReason: z.string().max(40).nullable(),
    }),
  ),
  passkeys: z.array(
    z.object({
      name: z.string().max(200).nullable(),
      createdAt: Iso.nullable(),
      deviceType: z.string().max(40),
      backedUp: z.boolean(),
    }),
  ),
  sessions: z.array(
    z.object({
      createdAt: Iso,
      expiresAt: Iso,
      ipAddress: z.string().max(64).nullable(),
      userAgent: z.string().max(500).nullable(),
    }),
  ),
  usage: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      task: z.string().max(40),
      requests: z.number().int().min(0),
      postsRequested: z.number().int().min(0),
      postsOk: z.number().int().min(0),
    }),
  ),
  sync: z.object({
    spaces: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(['user', 'org']),
        items: z.array(
          z.object({
            collection: z.string(),
            key: z.string(),
            deleted: z.boolean(),
            /** The live value, absent for a tombstone; depth-checked like every sync value. */
            value: SyncValueSchema.optional(),
            hlc: z.string(),
            updatedAt: Iso,
          }),
        ),
      }),
    ),
  }),
  /** Whatever the billing module reports for this account, or null (the no-op provider). */
  billing: z.record(z.string(), z.json()).nullable(),
});
export type AccountExport = z.infer<typeof AccountExportSchema>;
