/**
 * The schema barrel: every table the server stores is defined here or in a module this file re-exports, so the Drizzle
 * client and drizzle-kit see one schema.
 *
 * No table holds post text, author names or prompts. The server keeps accounts, devices, tokens, AI routes and usage
 * counts; post content passes through classification and is never written down (ADR 0007).
 *
 * Adding a table: define it here (or in a module re-exported from here), run
 * `pnpm --filter @unalgorithm/server db:generate`, and commit the generated SQL and `drizzle/meta` journal together
 * with the schema change. Migrations run at startup under an advisory lock and are forward-only: never edit or delete a
 * committed migration. A branch that rebases onto someone else's migration deletes its own generated files and runs
 * `db:generate` again.
 */
import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    /** The extension id the device signed in with. */
    clientId: text('client_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 'sign-out' or 'refresh-reuse' (CL1-10). */
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

/** A device's refresh tokens, by hash only. Each works once: using it sets `used_at` and issues the next (CL1-10). */
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
  },
  (table) => [index('refresh_tokens_device_id_idx').on(table.deviceId)],
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
    /** 'classify'. */
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
