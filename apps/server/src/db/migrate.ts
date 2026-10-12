/**
 * Startup migrations. Every server instance runs them while holding one Postgres advisory lock, so two containers
 * starting together apply each migration once: the second waits, then finds nothing left to do. Only event names, a
 * duration and `errorFields` are logged, never SQL text or parameters.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import { errorFields, type Logger } from '../log.ts';
import type { DbHandle } from './client.ts';

/** The advisory lock key: "UNAL" read as a 32-bit integer. Any fixed constant works, as long as it never changes. */
export const MIGRATION_LOCK_KEY = 1431191884;

/** The committed migrations, written by `db:generate` (drizzle-kit) into `apps/server/drizzle`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export interface MigrateOptions {
  migrationsFolder: string;
  log: Logger;
}

/**
 * Applies the migrations in `migrationsFolder` that the database has not seen yet. `applied` is false only when the
 * folder has no journal (no table has been defined yet); a run that finds everything applied still reports true.
 * Rejects when a migration fails; its transaction is rolled back and the lock released either way.
 */
export async function runMigrations(h: DbHandle, { migrationsFolder, log }: MigrateOptions): Promise<{ applied: boolean }> {
  if (!existsSync(join(migrationsFolder, 'meta', '_journal.json'))) {
    log.info('db.migrations.none');
    return { applied: false };
  }
  const started = performance.now();
  log.info('db.migrations.start');
  try {
    if (h.kind === 'postgres') await migratePostgres(h.pool, migrationsFolder);
    else await migratePglite(h.pglite, migrationsFolder);
  } catch (err) {
    log.error('db.migrations.failed', errorFields(err));
    throw err;
  }
  log.info('db.migrations.done', { ms: Math.round(performance.now() - started) });
  return { applied: true };
}

const LOCK = 'SELECT pg_advisory_lock($1)';
const UNLOCK = 'SELECT pg_advisory_unlock($1)';

/**
 * An advisory lock belongs to a session, and a pool may run each query on a different connection, so the lock, the
 * migrations and the unlock all run on one checked-out connection. After a failure that connection is closed rather
 * than returned to the pool: closing the session releases the lock even if the unlock itself failed.
 */
async function migratePostgres(pool: Pool, migrationsFolder: string): Promise<void> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query(LOCK, [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query(UNLOCK, [MIGRATION_LOCK_KEY]);
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    client.release(failed);
  }
}

/** PGlite is a single session by design; the lock is taken anyway so both databases run the same steps. */
async function migratePglite(pglite: PGlite, migrationsFolder: string): Promise<void> {
  const [{ drizzle: drizzlePglite }, { migrate: migrateOnPglite }] = await Promise.all([
    import('drizzle-orm/pglite'),
    import('drizzle-orm/pglite/migrator'),
  ]);
  await pglite.query(LOCK, [MIGRATION_LOCK_KEY]);
  try {
    await migrateOnPglite(drizzlePglite({ client: pglite }), { migrationsFolder });
  } finally {
    await pglite.query(UNLOCK, [MIGRATION_LOCK_KEY]);
  }
}
