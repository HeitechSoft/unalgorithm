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
export * from './auth-schema.ts';
