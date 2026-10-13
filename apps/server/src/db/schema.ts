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
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
