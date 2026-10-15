import { fileURLToPath } from 'node:url';
import { MAX_DAILY_POST_CAP } from '@unalgorithm/protocol';
import { eq } from 'drizzle-orm';
import { setDailyCap } from '../ai/limits.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';
import { user } from '../db/schema.ts';

/**
 * Sets or clears one person's daily post cap: `node apps/server/src/cli/user-cap.ts <email> <posts-per-day | default>`
 * (or `pnpm user-cap`), with the server's own environment; in production, inside the container with
 * `docker compose exec server node apps/server/src/cli/user-cap.ts …`. A number replaces the server's
 * `USER_DAILY_POST_CAP` for that account, from its next request on; `default` removes it again. The account is found by
 * its email address, matched in lowercase as accounts store it. Exit code 0 when the cap was set, 1 otherwise.
 */

export interface UserCapDeps {
  /** Default: a Postgres pool on `config.databaseUrl`, closed before `main` returns. A given handle stays open. */
  db?: DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
}

const USAGE = 'usage: node apps/server/src/cli/user-cap.ts <email> <posts-per-day | default>';

/** The cap argument: a whole number of posts, `null` for `default`, `undefined` when it is neither. */
function parseCap(arg: string | undefined): number | null | undefined {
  if (arg === 'default') return null;
  if (arg === undefined || !/^\d+$/.test(arg)) return undefined;
  const n = Number(arg);
  // The admin page's cap route has the same bound (`SetCapRequestSchema`).
  return n <= MAX_DAILY_POST_CAP ? n : undefined;
}

export async function main(argv: readonly string[], deps: UserCapDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const email = argv[0]?.trim().toLowerCase();
  const cap = parseCap(argv[1]);
  if (argv.length !== 2 || !email || cap === undefined) {
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
    const [account] = await handle.db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    if (!account) {
      out(`no account for ${email}`);
      return 1;
    }
    await setDailyCap(handle.db, account.id, cap);
    out(
      cap === null
        ? `daily cap for ${email} uses the server default (${config.userDailyPostCap})`
        : `daily cap for ${email}: ${cap} posts`,
    );
    return 0;
  } catch (err) {
    // A database error by name and code only: its message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`user-cap failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
