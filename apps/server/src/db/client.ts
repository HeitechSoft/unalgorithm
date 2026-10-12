/**
 * Database handles. The server runs on Postgres through node-postgres; tests run on PGlite (Postgres compiled to
 * WebAssembly, in memory), so they need no database server. Both are driven through the same Drizzle `Db` type.
 */
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { errorFields, type Logger } from '../log.ts';
import * as schema from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle =
  | { kind: 'postgres'; db: Db; pool: Pool; close(): Promise<void> }
  | { kind: 'pglite'; db: Db; pglite: PGlite; close(): Promise<void> };

/** At most this many connections per server process. */
const POOL_MAX = 10;

/**
 * How long a query waits for a connection: to open one, or for a free one when all are busy. Past it the query fails,
 * so a database that is down or unreachable gives a fast error (and a 503 from `/health`) instead of a hang.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

export interface PostgresOptions {
  /** Default: `CONNECT_TIMEOUT_MS`. */
  connectTimeoutMs?: number;
}

/**
 * A pooled Postgres connection. Nothing connects until the first query. `log` receives errors of idle connections (the
 * database restarted, say): the pool drops such a connection and opens a new one on demand, so they are not fatal.
 */
export function openPostgres(databaseUrl: string, log?: Logger, opts: PostgresOptions = {}): DbHandle {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: POOL_MAX,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  });
  pool.on('error', (err) => log?.warn('db.pool.error', errorFields(err)));
  return { kind: 'postgres', db: drizzle({ client: pool, schema }), pool, close: once(() => pool.end()) };
}

/**
 * A PGlite database, in memory when `dataDir` is undefined. PGlite is a development dependency, so it is loaded only
 * here and never by a production server.
 */
export async function openPglite(dataDir?: string): Promise<DbHandle> {
  const [{ PGlite }, { drizzle: drizzlePglite }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('drizzle-orm/pglite'),
  ]);
  const pglite = await PGlite.create(dataDir);
  return { kind: 'pglite', db: drizzlePglite({ client: pglite, schema }), pglite, close: once(() => pglite.close()) };
}

/** `close()` may be called more than once (a shutdown handler and a test cleanup, say); only the first call acts. */
function once(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => (closing ??= close());
}
