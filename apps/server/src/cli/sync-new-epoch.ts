import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';
import { syncSpaces } from '../db/schema.ts';

/**
 * Gives every sync space a new epoch: `node apps/server/src/cli/sync-new-epoch.ts` (or `pnpm sync:new-epoch`), with the
 * server's own environment, once after the database was restored from a backup (CL4's restore guide). Cursors held by
 * devices may point past the restored seq, or at seqs the server will hand out again; with a new epoch every device is
 * told `410 resync-required` (reason `epoch`) and starts again from the server's copy. Nothing is lost: devices push
 * their newer local edits after resyncing. Prints the number of spaces only. Exit code 0 when done, 1 otherwise.
 */

export interface SyncNewEpochDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
}

const USAGE = 'usage: node apps/server/src/cli/sync-new-epoch.ts (no options; run it once after restoring the database)';

export async function main(argv: readonly string[], deps: SyncNewEpochDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (argv.length > 0) {
    out(USAGE);
    return 1;
  }

  let config: Config;
  try {
    config = deps.config ?? loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }

  const handle = deps.db ?? openPostgres(config.databaseUrl);
  try {
    const spaces = await handle.db.update(syncSpaces).set({ epoch: sql`gen_random_uuid()` }).returning({ id: syncSpaces.id });
    out(`new sync epoch for ${spaces.length} spaces: every device starts its sync again from this server's copy`);
    return 0;
  } catch (err) {
    // A database error by name and code only: its message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`sync:new-epoch failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
