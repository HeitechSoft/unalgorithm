import { type DbHandle, openPglite } from '../../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.ts';
import { createLogger } from '../../src/log.ts';

/**
 * A fresh in-memory PGlite database with every committed migration applied. Server tests use this, never a PGlite
 * instance of their own, so they all run against the schema the server ships. Close the handle when done.
 * `migrationsFolder` exists for this helper's own test; every other test keeps the default.
 */
export async function createTestDb(migrationsFolder: string = MIGRATIONS_FOLDER): Promise<DbHandle> {
  const handle = await openPglite();
  await runMigrations(handle, { migrationsFolder, log: createLogger({ level: 'error', sink: () => {} }) });
  return handle;
}
