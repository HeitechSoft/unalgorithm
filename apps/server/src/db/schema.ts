/**
 * The schema barrel: every table the server stores is defined here or in a module this file re-exports, so the Drizzle
 * client and drizzle-kit see one schema.
 *
 * No table holds post text or prompts. The server keeps accounts, devices, tokens, AI routes, usage counts and each
 * person's synced settings, whose only names are the labels of people that person chose to always show or hide (CL3)
 * and the outlet names of their own UnEcho Chamber source list (P3-76).
 * Post content passes through classification and is never written down (ADR 0007).
 *
 * Adding a table: define it here (or in a module re-exported from here), run
 * `pnpm --filter @unalgorithm/server db:generate`, and commit the generated SQL and `drizzle/meta` journal together
 * with the schema change. Migrations run at startup under an advisory lock and are forward-only: never edit or delete a
 * committed migration. A branch that rebases onto someone else's migration deletes its own generated files and runs
 * `db:generate` again.
 */
import {
  type CreditTask,
  HLC_ZERO,
  type LeanBucket,
  type OfficialOutlet,
  type OutletChangeAction,
  type PriceChangeAction,
} from '@unalgorithm/protocol';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.ts';

export * from './auth-schema.ts';

/**
 * One signed-in copy of the extension. Each code exchange creates one (CL1-09); its refresh tokens and access tokens
 * name it, and revoking it (sign-out, or a reused refresh token, CL1-10) ends them all at once.
 */
export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The extension id the device signed in with: a Chrome or Edge id, or a Firefox add-on id. */
    clientId: text('client_id').notNull(),
    /**
     * What the extension called itself at sign-in (CL3-02 `DeviceNameSchema`), e.g. 'Chrome on Windows' or 'Firefox on
     * Linux'. Never derived from request headers. Null for devices from before CL3.
     */
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 'sign-out' or 'refresh-reuse' (CL1-10), or 'revoked-by-user' from the devices list (CL3-12). */
    revokedReason: text('revoked_reason'),
  },
  (table) => [index('devices_user_id_idx').on(table.userId)],
);

/**
 * Single-use authorization codes, bound to the extension, its redirect address and the PKCE challenge. Only the code's
 * hash is stored; `used_at` is set when an exchange claims it, whether the exchange then succeeds or not.
 */
export const authCodes = pgTable('auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

/**
 * A device's refresh tokens, by hash only. Each works once: using it sets `used_at` and issues the next (CL1-10). Rows
 * are deleted once expired (`auth.purge-expired`).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * The token a refresh with this one issued last, so a refresh whose answer was lost can be replayed
     * (`REFRESH_REPLAY_MS`). Null for a token no refresh spent (revoked, or superseded by a replay). Not a foreign key:
     * the purge deletes rows by their own expiry.
     */
    replacedBy: uuid('replaced_by'),
  },
  (table) => [
    index('refresh_tokens_device_id_idx').on(table.deviceId),
    index('refresh_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * Which model serves each AI task (R20). The enabled `classify` route follows the provider configured by environment
 * (`syncRouteFromConfig`, R36); replaced routes stay, disabled, as a record. A route serves requests only once it has
 * passed its eval for the current prompt version. The API key is never stored here: it stays in the environment.
 */
export const aiRoutes = pgTable(
  'ai_routes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** 'classify' (research and synthesis arrive in Phase 3). */
    task: text('task').notNull(),
    /** 'anthropic' or 'openai-compatible'. */
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    /** Null for anthropic, which is always reached at api.anthropic.com. */
    baseUrl: text('base_url'),
    effort: text('effort').notNull().default('low'),
    /** 'vendor-zdr' (the vendor retains no data) or 'self-hosted' (hardware the operator controls). */
    dataPolicy: text('data_policy').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    evalPassedAt: timestamp('eval_passed_at', { withTimezone: true }),
    /** Double precision, so the stored agreement compares exactly with the minimum the eval measured it against. */
    evalAgreement: doublePrecision('eval_agreement'),
    evalPromptVersion: integer('eval_prompt_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('ai_routes_one_enabled_per_task').on(table.task).where(sql`${table.enabled}`)],
);

/**
 * One row per AI request, written in the gateway's `finally` whether the request succeeded, partly failed or threw
 * (R21, `recordUsageEvent`). Counts and token numbers only: no column can hold post content, and `task` and `model`
 * are short identifiers. `usage` columns hold every token spent, failed calls included; the chargeable cost covers
 * only the calls that answered, because failed calls are the operator's cost. Rows stay until the account is deleted.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The request's `rid`, so a request can never be recorded twice. */
    requestId: uuid('request_id').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Null when no route served the request (none was configured, or none had passed its eval). */
    routeId: uuid('route_id').references(() => aiRoutes.id),
    /** A `CreditTask`: 'classify', or a job's 'factcheck' or 'perspectives' (one row per job, `posts_ok` 0). */
    task: text('task').notNull(),
    model: text('model').notNull(),
    /** 'ok', 'partial', 'failed' or 'refused-before-call' (`UsageEventInput`). */
    outcome: text('outcome').notNull(),
    postsRequested: integer('posts_requested').notNull(),
    postsOk: integer('posts_ok').notNull(),
    calls: integer('calls').notNull(),
    failedCalls: integer('failed_calls').notNull(),
    uncachedInput: integer('uncached_input').notNull(),
    cacheRead: integer('cache_read').notNull(),
    cacheWrite: integer('cache_write').notNull(),
    output: integer('output').notNull(),
    webSearches: integer('web_searches').notNull(),
    estimated: boolean('estimated').notNull(),
    /** Micro-dollars: the operator's cost of all usage. Null when the model has no price card. */
    costMicros: integer('cost_micros'),
    /** Micro-dollars: the cost of the calls that answered; 0 when no post succeeded, else null when no price card. */
    chargeableCostMicros: integer('chargeable_cost_micros'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('usage_events_user_day').on(table.userId, table.createdAt), index('usage_events_day').on(table.createdAt)],
);

/**
 * A person's own limits, set by the server's admin (`user-cap`, CL1-21). No row, or a null column, means the server's
 * default from the environment applies.
 */
export const userLimits = pgTable('user_limits', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Posts a day; null: `USER_DAILY_POST_CAP`. */
  dailyPostCap: integer('daily_post_cap'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Addresses an admin (or the setup link, CL4-04) has invited; a row is removed when its account is created
 * (`admin/invites.ts`). Keyed by address, not by account: deleting an account deletes its address's row too (CL3-15).
 */
export const signupInvites = pgTable('signup_invites', {
  /** Lowercased and trimmed. */
  email: text('email').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** The admin who invited; null for a setup link, or once that admin's account is deleted. */
  invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
});

/**
 * One-time setup links (R38, `admin/setup.ts`). Only the token's hash is stored; a link is spent when claimed. A used
 * row is kept until the account with its address is deleted (CL3-15's `deleteAccount`).
 */
export const setupTokens = pgTable('setup_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  /** Lowercased: the address the link was made for. */
  email: text('email').notNull(),
  /** Made with --recover: it works although the server already has an admin. */
  recover: boolean('recover').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

/*
 * Sync v2 (CL3). These tables hold a person's own settings, including the labels of people they chose to always show
 * or hide, and never post text. Deleting the account deletes them: every space cascades from `user`, and items and
 * push records from their space.
 */

/** One owner's synced collections (R14). CL3 has one personal ('user') space per account; CL7 adds 'org' spaces. */
export const syncSpaces = pgTable('sync_spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'user' (CL3); 'org' arrives in CL7. */
  kind: text('kind').notNull(),
  /** Owner of a 'user' space; null for other kinds. One personal space per account. */
  userId: text('user_id')
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** Changes when the server is restored from a backup (CL3-09): every client then resyncs. */
  epoch: uuid('epoch').notNull().defaultRandom(),
  /** The last seq handed out in this space. */
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
  /** Live items only. Tombstones are not counted here, but their bytes count toward `bytes_used` (CL3-07). */
  itemCount: integer('item_count').notNull().default(0),
  bytesUsed: integer('bytes_used').notNull().default(0),
  /** The highest seq and HLC among tombstones already cleaned up (CL3-09): an older cursor gets `410 resync-required`. */
  gcFloorSeq: bigint('gc_floor_seq', { mode: 'number' }).notNull().default(0),
  gcFloorHlc: text('gc_floor_hlc').notNull().default(HLC_ZERO),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The newest value of each key in a space, or its tombstone, with the seq of the write that stored it. */
export const syncItems = pgTable(
  'sync_items',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => syncSpaces.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    key: text('key').notNull(),
    /** Null for a tombstone. */
    value: jsonb('value'),
    deleted: boolean('deleted').notNull(),
    hlc: text('hlc').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** Key length plus `itemBytes(value)`, for the space's quota. */
    bytes: integer('bytes').notNull(),
    /** `ttl-cache` items only. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.collection, table.key] }),
    index('sync_items_space_seq').on(table.spaceId, table.seq),
    index('sync_items_tombstones').on(table.updatedAt).where(sql`${table.deleted}`),
  ],
);

/** The answer to each push, so a retried `pushId` gets the same answer and writes nothing (CL3-07). */
export const syncPushes = pgTable(
  'sync_pushes',
  {
    spaceId: uuid('space_id')
      .notNull()
      .references(() => syncSpaces.id, { onDelete: 'cascade' }),
    pushId: uuid('push_id').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    /** Statuses, seqs and reasons, and the keys of items not refused; never a value, never a refused key (CL3-07). */
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.spaceId, table.pushId] }), index('sync_pushes_created').on(table.createdAt)],
);

/**
 * Alerts that are open now (R43, CL4-15). A row is deleted when its alert closes; the log keeps the history. Content-free:
 * a fixed key, a level, times and a number.
 */
export const opsAlerts = pgTable('ops_alerts', {
  /** A fixed key: disk-free-low, database-size-high, errors-high, spend-breaker, backup-<kind>. */
  key: text('key').primaryKey(),
  /** 'warning' or 'critical' (`ALERT_LEVELS`). */
  level: text('level').$type<'warning' | 'critical'>().notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  /** The measured value when last seen (bytes, a count or hours); null when the rule has none. */
  lastValue: doublePrecision('last_value'),
  /** When a notification about this alert last went out (CL4-16); null: none yet. */
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
});

/**
 * The shared claim cache (F27, decisions D59–D61): one row per checked public claim, found by key only. `key` is the hex
 * HMAC-SHA-256 of the normalized claim under a key derived from BETTER_AUTH_SECRET (`claimCacheSecret`). No column holds
 * a claim, post text, or any user, device or post id; the explanation is kept only when it repeats no run of the post's
 * words (P3-57's echo rule), and both times are whole UTC hours, so no row can be joined to the `usage_events` row of the
 * check that wrote it. Served until `expires_at`; deleted hourly after it.
 */
export const claimCache = pgTable(
  'claim_cache',
  {
    key: text('key').primaryKey(),
    /** A CACHEABLE_VERDICTS member. */
    verdict: text('verdict').notNull(),
    /** The verdict's explanation (≤ 280 characters); null when it was empty or repeated the post's words. */
    explanation: text('explanation'),
    /** 2–4 validated citations: [{ url, domain, title, quote }] (`CachedCitationSchema`). */
    citations: jsonb('citations').notNull(),
    /** When the check that stored it ran, floored to the hour (P3-57). */
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    /** checked_at + CLAIM_CACHE_TTL_MS: never the write's own time. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('claim_cache_expires_at_idx').on(table.expiresAt)],
);

/*
 * The server's source list for UnEcho Chamber (P3-73, decisions D92–D95): an editorial list, published whole, with an
 * append-only history of every change. No personal data except which admin made each change.
 */

/** The list as published now: one row per outlet. Written only by `admin/outlets.ts`, under its advisory lock. */
export const outlets = pgTable('outlets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domains: jsonb('domains').$type<string[]>().notNull(),
  country: text('country').$type<OfficialOutlet['country']>().notNull(),
  /** A LEAN_BUCKETS member, or null: no lean. */
  bucket: text('bucket').$type<LeanBucket>(),
  /** [{ url, note }], at least one when `bucket` is set (OutletInputSchema). */
  evidence: jsonb('evidence').$type<{ url: string; note: string }[]>().notNull().default([]),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
});

/** Every change to the list, never updated or deleted, except that `changed_by` empties when that account is deleted. */
export const outletChanges = pgTable(
  'outlet_changes',
  {
    /** The list's version after this change. */
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** An OUTLET_CHANGE_ACTIONS member. */
    action: text('action').$type<OutletChangeAction>().notNull(),
    outletId: text('outlet_id').notNull(),
    /** The outlet as published before and after (OfficialOutletSchema); null before an add or import, after a remove. */
    before: jsonb('before'),
    after: jsonb('after'),
    /** The admin; null for a deleted account. Never published (decision D94). */
    changedBy: text('changed_by').references(() => user.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('outlet_changes_at').on(table.changedAt)],
);

/*
 * The server's prices (PA-03, decisions PD2, PD9): the price book admins set on the Pricing page, with an append-only
 * history. No personal data except which admin made each change.
 */

/**
 * Every change to the price book, never updated or deleted, except that `changed_by` empties when that account is
 * deleted. The newest row's book is the one in use; with no row the server uses its code defaults (`DEFAULT_PRICE_BOOK`)
 * and writes nothing until an admin first saves. Written only by `admin/prices.ts`, under its advisory lock.
 */
export const priceChanges = pgTable(
  'price_changes',
  {
    /** The book's version after this change. */
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** A PRICE_CHANGE_ACTIONS member. */
    action: text('action').$type<PriceChangeAction>().notNull(),
    /** schedule, cancel, move: the task and the entry's date (move: the date it left); null otherwise. */
    task: text('task').$type<CreditTask>(),
    effectiveFrom: text('effective_from'),
    movedTo: text('moved_to'),
    /** What changed, before and after (PriceChangeValueSchema); null for seed. */
    before: jsonb('before'),
    after: jsonb('after'),
    /** The whole price book after this change (PriceBookSchema). */
    book: jsonb('book').notNull(),
    /** The admin; null for a deleted account. Never published (decision PD9). */
    changedBy: text('changed_by').references(() => user.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('price_changes_at').on(table.changedAt)],
);
