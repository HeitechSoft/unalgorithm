import { fileURLToPath } from 'node:url';
import { ADMIN_PAGE_PATH, InviteRequestSchema } from '@unalgorithm/protocol';
import { normalizeEmail } from '../admin/invites.ts';
import { createSetupLink, SETUP_LINK_TTL_MS } from '../admin/setup.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';

/**
 * Prints the one-time setup link that makes `<email>` this server's admin (R38, `admin/setup.ts`):
 * `node apps/server/src/cli/setup-link.ts <email> [--recover]` (or `pnpm setup-link`), with the server's own
 * environment; in production, inside the container with
 * `docker compose exec server node apps/server/src/cli/setup-link.ts you@example.org`. The link works for 60 minutes and
 * replaces any unused one. `--recover` makes one although the server already has an admin. The link is printed to the
 * operator's terminal only, never logged. Exit code 0 when a link was printed, 1 otherwise.
 */

export interface SetupLinkDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
}

const USAGE = 'usage: node apps/server/src/cli/setup-link.ts <email> [--recover]';
const RECOVER = '--recover';

export async function main(argv: readonly string[], deps: SetupLinkDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const email = normalizeEmail(argv[0] ?? '');
  const recover = argv[1] === RECOVER;
  const flagsOk = argv.length === 1 || (argv.length === 2 && recover);
  if (!flagsOk || !InviteRequestSchema.shape.email.safeParse(email).success) {
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
    const link = await createSetupLink(handle.db, config, email, { recover });
    if (!link.ok) {
      out(
        `This server already has an admin, who invites people at ${config.publicUrl}${ADMIN_PAGE_PATH}. To make an admin ` +
          `anyway (for example, when the only admin lost their mailbox), add ${RECOVER}.`,
      );
      return 1;
    }
    out(`Open this link within ${SETUP_LINK_TTL_MS / 60_000} minutes and sign in as ${email} to become this server's admin:`);
    out(link.url);
    if (link.restored) out("This address's account had been removed from this server; it can sign in again.");
    return 0;
  } catch (err) {
    // A database error by name and code only: its message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`setup-link failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
