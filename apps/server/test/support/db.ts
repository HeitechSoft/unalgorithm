import type { SQL } from 'drizzle-orm';
import { type DbHandle, openPglite } from '../../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.ts';
import { createLogger } from '../../src/log.ts';

/**
 * A fresh in-memory PGlite database with every committed migration applied. Server tests use this, never a PGlite
 * instance of their own, so they all run against the schema the server ships. Close the handle when done.
 * `migrationsFolder` exists for this helper's own test; every other test keeps the default.
 *
 * Starting PGlite is most of a server test's time, and a new empty database is the slow start: Postgres's initdb. So
 * the committed migrations are applied once per test file, and every database after that loads a dump of that one.
 */
export async function createTestDb(migrationsFolder: string = MIGRATIONS_FOLDER): Promise<DbHandle> {
  if (migrationsFolder !== MIGRATIONS_FOLDER) return migratedDb(migrationsFolder);
  migratedDump ??= migratedDb(MIGRATIONS_FOLDER).then(dumpAndClose);
  return openPglite(undefined, await migratedDump);
}

/** The dump `createTestDb` loads: an uncompressed `dumpDataDir()` of a database with the committed migrations. */
let migratedDump: Promise<Blob> | undefined;

async function migratedDb(migrationsFolder: string): Promise<DbHandle> {
  const handle = await openPglite();
  await runMigrations(handle, { migrationsFolder, log: createLogger({ level: 'error', sink: () => {} }) });
  return handle;
}

async function dumpAndClose(handle: DbHandle): Promise<Blob> {
  try {
    if (handle.kind !== 'pglite') throw new Error('Not a PGlite database');
    return await handle.pglite.dumpDataDir('none');
  } finally {
    await handle.close();
  }
}

/** Rows of a raw `execute()` result: node-postgres and PGlite both answer `{ rows }`. */
export async function queryRows(h: DbHandle, query: SQL): Promise<Record<string, unknown>[]> {
  return ((await h.db.execute(query)) as { rows: Record<string, unknown>[] }).rows;
}
