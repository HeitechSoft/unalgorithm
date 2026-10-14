/**
 * The server process. `startServer` opens the database, applies migrations, brings the AI route in line with the
 * configuration, loads the billing module if one is configured, starts the background jobs, and serves the app; run
 * directly (`node apps/server/src/index.ts`, or `pnpm start`), this module reads the configuration from the environment,
 * starts the server, and stops it gracefully on SIGTERM or SIGINT.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { clientForRoute } from './ai/provider.ts';
import { type AiRoute, RouteConfigError, syncRouteFromConfig } from './ai/routes.ts';
import { createAuth } from './auth/better-auth.ts';
import { createBillingHost } from './billing/host.ts';
import { BillingLoadError, loadBilling } from './billing/provider.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { type DbHandle, openPostgres } from './db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from './db/migrate.ts';
import { type App, createApp } from './http/app.ts';
import { createJobRegistry, type RunningJobs, startJobs } from './jobs/worker.ts';
import { createLogger, errorFields, type Logger } from './log.ts';
import { smtpMailer } from './mail/mailer.ts';

/** How long a stopping server lets requests in flight finish before it closes their connections. */
const STOP_GRACE_MS = 10_000;

export interface StartOptions {
  /** Default: a Postgres pool on `config.databaseUrl`. The server closes it when it stops or fails to start. */
  db?: DbHandle;
  /** Default: `config.port`. 0 picks a free port. */
  port?: number;
  /** Default: standard output at `config.logLevel`. */
  log?: Logger;
}

export interface RunningServer {
  /** `http://<host>:<port>` as bound. */
  url: string;
  /**
   * Stops accepting, answers sync long-polls at once, waits up to 10 s for requests in flight (each answer closes its
   * connection), stops the jobs (waiting for running ones), then closes the database. Safe to call twice.
   */
  close(): Promise<void>;
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? createLogger({ level: config.logLevel });
  const db = opts.db ?? openPostgres(config.databaseUrl, log);
  let server: Server;
  let running: RunningJobs | undefined;
  const stopping = new AbortController();
  try {
    await runMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER, log });
    // Refuses a provider that breaks the routing rules (RouteConfigError) before anything is served.
    await syncRouteFromConfig(db.db, config, log);
    // The rate limit stays at its default (on): only tests turn it off.
    const auth = createAuth({ config, db, mailer: smtpMailer(config.smtp, log), log });
    const ai = { clientFor: (route: AiRoute) => clientForRoute(route, config) };
    // Modules register their tasks here, before the jobs start. With none, no worker runs.
    const jobs = createJobRegistry();
    // A module that cannot be used stops the start (BillingLoadError, or the module's own error) before anything is
    // served: a server meant to charge never serves AI for free.
    const host = createBillingHost({ config, db, log, auth, jobs, env: config.billingEnv });
    const billing = await loadBilling(config, host, log);
    const app = createApp({ config, db, log, billing, auth, ai, stopping: stopping.signal });
    running = await startJobs(db, jobs, log);
    server = await listen(app, config.host, opts.port ?? config.port);
  } catch (err) {
    await closeAll(running, db);
    throw err;
  }

  const { port } = server.address() as AddressInfo;
  log.info('server.started', { port, version: config.version });
  let closing: Promise<void> | undefined;
  return {
    url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`,
    close: () => (closing ??= stop(server, stopping, running, db)),
  };
}

function listen(app: App, hostname: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Without `createServer` options, serve() builds a node:http server.
    const server = serve({ fetch: app.fetch, hostname, port }) as Server;
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function stop(server: Server, stopping: AbortController, running: RunningJobs | undefined, db: DbHandle): Promise<void> {
  // First: a sync long-poll would otherwise wait up to 20 s, past the grace period.
  stopping.abort();
  await new Promise<void>((resolve) => {
    // close() stops accepting and ends idle keep-alive connections; busy ones get the grace period.
    const grace = setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS);
    server.close(() => {
      clearTimeout(grace);
      resolve();
    });
  });
  await closeAll(running, db);
}

/** The jobs first: they share the database's pool. */
async function closeAll(running: RunningJobs | undefined, db: DbHandle): Promise<void> {
  try {
    await running?.stop();
  } finally {
    await db.close();
  }
}

/**
 * What `main` prints for a start failure that is the operator's to fix, or undefined for one it logs as
 * `server.start_failed`. A routing rule, a billing module that cannot be loaded and a module's own configuration error
 * (named `BillingConfigError`, whose message by contract names variables only) are printed like a ConfigError:
 * `errorFields` would drop the message, which is all they have to say.
 */
export function startFailureMessage(err: unknown): string | undefined {
  if (err instanceof RouteConfigError || err instanceof BillingLoadError) return err.message;
  if (err instanceof Error && err.name === 'BillingConfigError') return err.message;
  return undefined;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Variable names and rules only, never values (as `check-config` prints them).
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const log = createLogger({ level: config.logLevel });
  let server: RunningServer;
  try {
    server = await startServer(config, { log });
  } catch (err) {
    const message = startFailureMessage(err);
    if (message !== undefined) console.error(message);
    else log.error('server.start_failed', errorFields(err));
    process.exitCode = 1;
    return;
  }

  const shutdown = (signal: NodeJS.Signals) => {
    log.info('server.stopping', { signal });
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('server.stop_failed', errorFields(err));
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
