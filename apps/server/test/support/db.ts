import { type DbHandle, openPglite } from '../../src/db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/db/migrate.ts';
import { createLogger } from '../../src/log.ts';

/**
 * A fresh in-memory PGlite database with every committed migration applied. Server tests use this, never a PGlite
 * instance of their own, so they all run against the schema the server ships. Close the handle when done.
 */
export async function createTestDb(): Promise<DbHandle> {
  const handle = await openPglite();
  await runMigrations(handle, { migrationsFolder: MIGRATIONS_FOLDER, log: createLogger({ level: 'error', sink: () => {} }) });
  return handle;
}
