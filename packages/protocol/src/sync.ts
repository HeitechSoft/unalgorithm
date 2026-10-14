import { z } from 'zod';
import { HlcSchema } from './hlc.ts';

/**
 * Sync v2 wire contracts, shared by the server, `packages/sync` and the extension. A space holds one owner's
 * collections; every item is a live value or a tombstone, and both carry the HLC of the edit that wrote them.
 */

/** GET with the device's bearer token: the spaces this account can read. */
export const SYNC_SPACES_PATH = '/v1/sync/spaces';
/** GET (long-poll) with the device's bearer token: changes after a cursor. */
export const SYNC_CHANGES_PATH = '/v1/sync/changes';
/** POST with the device's bearer token: write items, idempotent per `pushId`. */
export const SYNC_PUSH_PATH = '/v1/sync/push';

/** Tombstones are kept this long (R16). A client whose cursor predates a removed tombstone gets 410. */
export const TOMBSTONE_TTL_DAYS = 90;
/** Items per changes page. */
export const SYNC_PULL_LIMIT = 500;
/** Long-poll: under the extension's 30 s service-worker idle window and nginx's 60 s proxy timeout. */
export const SYNC_MAX_WAIT_SECONDS = 20;
export const SYNC_MAX_PUSH_ITEMS = 200;
/** Client chunking target, under the server's 128 KiB body limit for /v1. */
export const SYNC_MAX_PUSH_BYTES = 96 * 1024;
export const SYNC_MAX_KEY_LENGTH = 200;
/** UTF-8 bytes of `JSON.stringify(value)`. */
export const SYNC_MAX_ITEM_BYTES = 8 * 1024;
/** Live items per space; tombstones count toward `SYNC_SPACE_MAX_BYTES` instead. */
export const SYNC_SPACE_MAX_ITEMS = 5_000;
export const SYNC_SPACE_MAX_BYTES = 2 * 1024 * 1024;
/** Stamps further ahead of the server's clock than this are refused (`clock-ahead`). */
export const SYNC_MAX_HLC_AHEAD_MS = 10 * 60_000;

/** Segments that reach `Object.prototype` when a key is walked as a path (CL3-04, CL3-05): never a valid segment. */
const RESERVED_KEY_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** A dotted path such as `display.mode` or `interests.more.ai-tech`: segments of 1 to 64 `[A-Za-z0-9_-]`. */
export const SyncKeySchema = z
  .string()
  .min(1)
  .max(SYNC_MAX_KEY_LENGTH)
  .regex(/^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64})*$/)
  .refine((k) => !k.split('.').some((seg) => RESERVED_KEY_SEGMENTS.has(seg)), 'reserved key segment');
/** A collection name from the registry (CL3-03), such as `settings`. */
export const SyncCollectionSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

const Live = z.object({
  collection: SyncCollectionSchema,
  key: SyncKeySchema,
  hlc: HlcSchema,
  deleted: z.literal(false),
  value: z.json(),
});
/** A deletion. Any `value` sent with it is dropped when parsed. */
const Tombstone = z.object({
  collection: SyncCollectionSchema,
  key: SyncKeySchema,
  hlc: HlcSchema,
  deleted: z.literal(true),
});
export const SyncItemSchema = z.discriminatedUnion('deleted', [Live, Tombstone]);
export type SyncItem = z.infer<typeof SyncItemSchema>;

/** The server's write sequence within a space; a changes cursor is the last `seq` a client has seen. */
const Seq = z.number().int().positive();
export const SyncChangeSchema = z.discriminatedUnion('deleted', [Live.extend({ seq: Seq }), Tombstone.extend({ seq: Seq })]);
export type SyncChange = z.infer<typeof SyncChangeSchema>;

/** A space holds one owner's collections. CL3 has personal spaces only; CL7 adds read-only 'org' spaces. */
export const SyncSpaceSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['user', 'org']),
  access: z.enum(['read-write', 'read']),
  /** Changes when the space starts over (a reset or restore): a client holding another epoch downloads it again. */
  epoch: z.uuid(),
});
export type SyncSpace = z.infer<typeof SyncSpaceSchema>;
export const SyncSpacesResponseSchema = z.object({ v: z.literal(1), spaces: z.array(SyncSpaceSchema).max(20) });
export type SyncSpacesResponse = z.infer<typeof SyncSpacesResponseSchema>;

/** Query string of `SYNC_CHANGES_PATH`: every value arrives as a string, so numbers are coerced. */
export const SyncChangesQuerySchema = z.object({
  spaceId: z.uuid(),
  epoch: z.uuid(),
  since: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(SYNC_PULL_LIMIT).default(SYNC_PULL_LIMIT),
  /** Seconds to hold the request open when nothing is newer than `since`; 0 answers at once. */
  wait: z.coerce.number().int().min(0).max(SYNC_MAX_WAIT_SECONDS).default(0),
  /** '1' while paging through a download that started at since=0 (see CL3-06). */
  snapshot: z.enum(['0', '1']).default('0'),
});
export type SyncChangesQuery = z.infer<typeof SyncChangesQuerySchema>;

export const SyncChangesResponseSchema = z.object({
  v: z.literal(1),
  spaceId: z.uuid(),
  epoch: z.uuid(),
  /** Pass as `since` next time. */
  cursor: z.number().int().min(0),
  more: z.boolean(),
  /** The newest HLC among tombstones already cleaned up (HLC_ZERO when none): used after a resync (CL3-05). */
  gcFloorHlc: HlcSchema,
  items: z.array(SyncChangeSchema).max(SYNC_PULL_LIMIT),
});
export type SyncChangesResponse = z.infer<typeof SyncChangesResponseSchema>;

export const SyncPushRequestSchema = z.object({
  v: z.literal(1),
  spaceId: z.uuid(),
  epoch: z.uuid(),
  /** Idempotency: the server answers a repeated pushId with its first answer and writes nothing. */
  pushId: z.uuid(),
  items: z.array(SyncItemSchema).min(1).max(SYNC_MAX_PUSH_ITEMS),
});
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

/** Why the server refused one pushed item; the rest of the push still applies. */
export const SYNC_REJECT_REASONS = ['invalid', 'unknown-collection', 'credential', 'clock-ahead', 'not-own-device'] as const;
export type SyncRejectReason = (typeof SYNC_REJECT_REASONS)[number];

/** One answer per pushed item: written (with its new `seq`), older than what the server holds, or refused. */
export const SyncPushResultSchema = z.discriminatedUnion('status', [
  z.object({ collection: SyncCollectionSchema, key: SyncKeySchema, status: z.literal('applied'), seq: Seq }),
  z.object({ collection: SyncCollectionSchema, key: SyncKeySchema, status: z.literal('stale') }),
  z.object({
    collection: SyncCollectionSchema,
    key: SyncKeySchema,
    status: z.literal('rejected'),
    reason: z.enum(SYNC_REJECT_REASONS),
  }),
]);
export type SyncPushResult = z.infer<typeof SyncPushResultSchema>;
export const SyncPushResponseSchema = z.object({
  v: z.literal(1),
  results: z.array(SyncPushResultSchema).max(SYNC_MAX_PUSH_ITEMS),
});
export type SyncPushResponse = z.infer<typeof SyncPushResponseSchema>;

/**
 * Sync-specific refusals. Auth, rate limits and validation keep the `ServerErrorSchema` body (CL1-01). The server
 * answers with these status codes (CL3-06 to CL3-08):
 * - `410 resync-required`: the cursor cannot be trusted (another epoch, a cursor ahead of the server, or one that
 *   predates tombstones already cleaned up); start over from 0.
 * - `413 quota-exceeded`: the push would take the space over `SYNC_SPACE_MAX_ITEMS` or `SYNC_SPACE_MAX_BYTES`.
 * - `403 read-only`: a push to a space this account may only read (CL7's org spaces).
 * - `404 not-found`: no such space for this account (another account's space is never revealed).
 * Not part of `AI_ERROR_CODES`: those say how an AI call can fail. A sync client checks the status first (CL3-19).
 */
export const SYNC_ERROR_CODES = ['resync-required', 'quota-exceeded', 'read-only', 'not-found'] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];
export const SyncErrorSchema = z.object({ code: z.enum(SYNC_ERROR_CODES), message: z.string().max(300) });
export type SyncError = z.infer<typeof SyncErrorSchema>;
