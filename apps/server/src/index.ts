/**
 * The server process. `startServer` opens the database, applies migrations, brings the AI route in line with the
 * configuration, and serves the app; run directly (`node apps/server/src/index.ts`, or `pnpm start`), this module
 * reads the configuration from the environment, starts the server, and stops it gracefully on SIGTERM or SIGINT.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { clientForRoute } from './ai/provider.ts';
import { type AiRoute, RouteConfigError, syncRouteFromConfig } from './ai/routes.ts';
import { createAuth } from './auth/better-auth.ts';
import { selectBilling } from './billing/provider.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { type DbHandle, openPostgres } from './db/client.ts';
import { MIGRATIONS_FOLDER, runMigrations } from './db/migrate.ts';
import { type App, createApp } from './http/app.ts';
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
  /** Stops accepting, waits up to 10 s for requests in flight, then closes the database. Safe to call twice. */
  close(): Promise<void>;
}

export async function startServer(config: Config, opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? createLogger({ level: config.logLevel });
  const db = opts.db ?? openPostgres(config.databaseUrl, log);
  let server: Server;
  try {
    await runMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER, log });
    // Refuses a provider that breaks the routing rules (RouteConfigError) before anything is served.
    await syncRouteFromConfig(db.db, config, log);
    // The rate limit stays at its default (on): only tests turn it off.
    const auth = createAuth({ config, db, mailer: smtpMailer(config.smtp, log), log });
    const ai = { clientFor: (route: AiRoute) => clientForRoute(route, config) };
    const app = createApp({ config, db, log, billing: selectBilling(config), auth, ai });
    server = await listen(app, config.host, opts.port ?? config.port);
  } catch (err) {
    await db.close();
    throw err;
  }

  const { port } = server.address() as AddressInfo;
  log.info('server.started', { port, version: config.version });
  let closing: Promise<void> | undefined;
  return {
    url: `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`,
    close: () => (closing ??= stop(server, db)),
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

async function stop(server: Server, db: DbHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    // close() stops accepting and ends idle keep-alive connections; busy ones get the grace period.
    const grace = setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS);
    server.close(() => {
      clearTimeout(grace);
      resolve();
    });
  });
  await db.close();
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
    // A routing rule is printed like a ConfigError: errorFields would drop the message, which is all it has to say.
    if (err instanceof RouteConfigError) console.error(err.message);
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
