import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { CONNECT_TIMEOUT_MS } from '../../src/db/client.ts';

/**
 * The Postgres server for tests, or undefined. Postgres tests skip themselves when it is unset (`describe.skipIf`), so
 * `pnpm test` needs no database server; PGlite (`createTestDb`) covers everything else.
 */
export const TEST_DATABASE_URL: string | undefined = process.env.TEST_DATABASE_URL?.trim() || undefined;

export interface PostgresTestDb {
  /** The database's name: the prefix, an underscore and 12 random hex characters. */
  name: string;
  /** `TEST_DATABASE_URL` with only the database name changed. */
  url: string;
  /** Drops the database, ending any connection still open to it. Only the first call acts. */
  drop(): Promise<void>;
}

/**
 * A new, empty database on the server `TEST_DATABASE_URL` points at. That URL is used only to create and drop
 * databases, never for tables: Vitest runs test files in parallel, and in a shared database migrations and rows would
 * depend on which file ran first (and the end-to-end server's data would leak in). Every Postgres test takes its own
 * database from here, opens it with `openPostgres(db.url)`, and calls `drop()` after closing its handles.
 */
export async function createPostgresTestDb(prefix = 'ua_test', adminUrl = TEST_DATABASE_URL): Promise<PostgresTestDb> {
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is not set');
  // The name goes into SQL unquoted, so the prefix is held to a plain lowercase identifier.
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) throw new Error('The prefix must be a lowercase identifier.');
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  await runAdmin(adminUrl, `create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  let dropping: Promise<void> | undefined;
  return {
    name,
    url: url.href,
    drop: () => (dropping ??= runAdmin(adminUrl, `drop database if exists ${name} with (force)`)),
  };
}

/** One statement on its own short-lived connection, so a test leaves no admin connection open. */
async function runAdmin(adminUrl: string, statement: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}
