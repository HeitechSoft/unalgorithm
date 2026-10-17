import { fileURLToPath } from 'node:url';
import { DEFAULT_PRICE_BOOK } from '@unalgorithm/protocol';
import { openPriceStore } from '../admin/prices.ts';
import { createAuth } from '../auth/better-auth.ts';
import { type BillingModule, createBillingHost } from '../billing/host.ts';
import { BillingLoadError, importBillingModule } from '../billing/provider.ts';
import { type Config, ConfigError, loadConfig } from '../config.ts';
import { type DbHandle, openPostgres, queryErrorFields } from '../db/client.ts';
import { createJobRegistry } from '../jobs/worker.ts';
import { createLogger } from '../log.ts';
import { smtpMailer } from '../mail/mailer.ts';

/**
 * Runs a command of the configured billing module: `node apps/server/src/cli/billing.ts <command> …` (or
 * `pnpm billing …`), with the server's own environment; in production, inside the container with
 * `docker compose exec server node apps/server/src/cli/billing.ts <command> …`. The commands are the module's own
 * (`BillingModule.runCli`): this entry point loads the module that `BILLING_MODULE` names, builds the billing host the
 * server builds at start, and hands it the arguments as given; the module reads them and prints its own usage. It never
 * runs migrations: the server applies them when it starts, and this runs against a deployment that is up. The host's
 * prices are the stored book as it is when the command starts (decision PD13). Exit code: the module's, or 1 when there
 * is no module or the command fails.
 */

export interface BillingCliDeps {
  /** A handle to use as is; it stays open after `main` returns. */
  db?: DbHandle;
  /** Opens the handle when `db` is not given; it is closed before `main` returns. Default: `openPostgres`. */
  openDb?: (databaseUrl: string) => DbHandle;
  /** Default: `loadConfig(process.env)`. */
  config?: Config;
  /** Default: standard output. */
  out?: (line: string) => void;
}

export async function main(argv: readonly string[], deps: BillingCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));

  let config: Config;
  try {
    config = deps.config ?? loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values.
    out(err.message);
    return 1;
  }
  if (config.billing === 'off') {
    out('BILLING is off: this server has no billing module');
    return 1;
  }

  let mod: BillingModule;
  try {
    // `loadConfig` requires the path when billing is `module`.
    mod = await importBillingModule(config.billingModule ?? '');
  } catch (err) {
    if (!(err instanceof BillingLoadError)) throw err;
    // Names BILLING_MODULE, never its path.
    out(err.message);
    return 1;
  }
  if (typeof mod.runCli !== 'function') {
    out('the billing module has no commands');
    return 1;
  }

  const handle = deps.db ?? (deps.openDb ?? openPostgres)(config.databaseUrl);
  try {
    // Errors only: what the command has to say goes to `out`.
    const log = createLogger({ level: 'error' });
    // One mailer: the module's commands send their account emails through the host's `mail`.
    const mailer = smtpMailer(config.smtp, log);
    const auth = createAuth({ config, db: handle, mailer, log });
    // Never started: a command runs once, and the server's own process runs the jobs.
    const jobs = createJobRegistry();
    // The book the server uses, read once: a stored book that is not sound fails the command (PriceBookError).
    const prices = await openPriceStore(handle.db, { seed: DEFAULT_PRICE_BOOK });
    const host = createBillingHost({ config, db: handle, log, auth, jobs, mailer, env: config.billingEnv, prices });
    return await mod.runCli(argv, host, out);
  } catch (err) {
    // By name and code only: the message can name a host.
    const { err_name, err_code } = queryErrorFields(err);
    out(`billing command failed: ${err_name}${err_code === undefined ? '' : ` (${err_code})`}`);
    return 1;
  } finally {
    if (!deps.db) await handle.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
