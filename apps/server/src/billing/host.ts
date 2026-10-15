/**
 * The billing host: what the server hands a billing module at boot (CL2-05 loads it), and the shape of the module.
 * ADR 0007 lets HeitechSoft's private module reach the server only through `BillingProvider`, never by patching it; to
 * keep a ledger it also needs a few services from the server, and this file defines them once. A module imports only
 * types from here: every value it uses (the protocol, SQL, the logger, the auth checks, the jobs) arrives through the
 * host, so it needs no runtime dependency of its own and never reads server internals.
 *
 * This is a reviewed contract, not an isolation boundary. The module runs in the server process with the server's own
 * database access: `db.query` runs any statement on the server's pool as the server's database role, so it can read
 * every server table, not only schema `billing`. Routes it adds through `mount` receive the request like any server
 * route, the client address (`clientIp`) and raw headers included. What the seam passes: account id, email, verified
 * flag and account creation time (`accounts`); device id, request id, model, token usage, cost and posts counted, and
 * the instant the server checked the request (`checkedAt`) (`BillingProvider`); the signed-in person's id and email on a
 * page request (`auth.webUser`). Pages it renders (`pages.render`) get the server's frame, stylesheet and CSP around
 * HTML escaped by `html`, with no script. What the host does not offer: the
 * server's Drizzle schema, `AppDeps`, the AI clients, the classify request body or any post field. No post text, prompt or interest reaches a module, because the server
 * neither stores nor passes them (ADR 0007). Adding to `BillingHost` is a reviewed public change.
 *
 * Driver differences a module must not rely on (node-postgres in production, PGlite in tests): a `bigint` column may
 * come back as a string, a number or a bigint, so read it with `Number()`; read times as epoch milliseconds
 * (`(extract(epoch from t) * 1000)::bigint`) and pass them as ISO strings cast `::timestamptz`.
 */
import { formatBalance, formatCreditAmount, formatPostsEstimate, formatPrice } from '@unalgorithm/core';
import * as protocol from '@unalgorithm/protocol';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { html } from 'hono/html';
import { type DeviceEnv, requireDevice } from '../auth/bearer.ts';
import type { Auth } from '../auth/better-auth.ts';
import { ownPageOnly, requireWebSession, type WebSessionEnv, type WebUser, webUserFrom } from '../auth/web-session.ts';
import type { Config } from '../config.ts';
import type { Db, DbHandle } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { user } from '../db/schema.ts';
import { type ModulePage, renderModulePage } from '../http/page-frame.ts';
import type { JobRegistry } from '../jobs/worker.ts';
import type { Logger } from '../log.ts';
import type { BillingProvider } from './provider.ts';

/** The module's only database access: parameterised SQL on the server's pool. */
export interface BillingSql {
  /** drizzle-orm's `sql` tag: interpolated values are bound parameters, never statement text. */
  readonly sql: typeof sql;
  query<T extends Record<string, unknown> = Record<string, unknown>>(statement: SQL): Promise<T[]>;
  /** One transaction; a throw rolls it back and is rethrown. */
  transaction<R>(fn: (tx: BillingSql) => Promise<R>): Promise<R>;
}

/** An account as billing sees it: no name, no sessions, no devices. */
export interface BillingUser {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
}

export interface BillingHost {
  /**
   * The running release's `@unalgorithm/protocol`: the dated price schedule (`CREDIT_PRICE_SCHEDULE`, `priceCardsAt`),
   * schemas and paths. A module never bundles its own.
   */
  readonly protocol: typeof protocol;
  /**
   * The schedule this server prices with: `CREDIT_PRICE_SCHEDULE` in production. A module reads cards from it
   * (`protocol.taskPriceAt(checkedAt, task, host.priceSchedule)`) so it and the server always agree; tests pass one
   * that prices checks.
   */
  readonly priceSchedule: protocol.CreditPriceSchedule;
  readonly db: BillingSql;
  /**
   * Applies the module's Drizzle-format migrations, recorded in `billing.__drizzle_migrations`, under the module's own
   * advisory lock. Schema `billing` exists before the first one runs. A folder without a journal applies nothing.
   */
  migrate(migrationsFolder: string): Promise<void>;
  /** `log.child({ module: 'billing' })`. */
  readonly log: Logger;
  readonly config: Readonly<{ publicOrigin: string; instanceName: string; version: string }>;
  /** The module's own `BILLING_*` variables, as set (`Config.billingEnv` in production, CL2-05). May hold secrets. */
  readonly env: Readonly<Record<string, string>>;
  readonly accounts: {
    get(userId: string): Promise<BillingUser | null>;
    findByEmail(email: string): Promise<BillingUser | null>;
  };
  /** Route middleware and checks: the extension's bearer check, the server page's session check, and for page routes. */
  readonly auth: {
    device: MiddlewareHandler<DeviceEnv>;
    webSession: MiddlewareHandler<WebSessionEnv>;
    /** Who the request's web session signs in, or null: for pages that send a signed-out person to sign in. */
    webUser(c: Context): Promise<WebUser | null>;
    /**
     * 403 `permission` unless Origin is this server's own origin: in front of every state-changing page route.
     * Script-free form posts from module pages rely on renderModulePage's `<meta name="referrer" content="same-origin">`,
     * because under the server's no-referrer header a form POST carries `Origin: null`.
     */
    ownPage: MiddlewareHandler;
  };
  readonly jobs: JobRegistry;
  /** hono/html's tag: interpolated values are escaped; nested results are kept. */
  readonly html: typeof html;
  /** A module's own page in the server's frame, stylesheet and CSP (`renderModulePage`), with no script. */
  readonly pages: { render(c: Context, page: ModulePage): Promise<Response> };
  /** The wording every surface shows (@unalgorithm/core), so a module never formats money itself. */
  readonly format: Readonly<{
    formatBalance: typeof formatBalance;
    formatCreditAmount: typeof formatCreditAmount;
    formatPostsEstimate: typeof formatPostsEstimate;
    formatPrice: typeof formatPrice;
  }>;
}

/** What `BILLING_MODULE` exports. */
export interface BillingModule {
  createBillingProvider(host: BillingHost): Promise<BillingProvider>;
  /** Admin commands run with `pnpm billing …` (CL2-06). Resolves with the exit code. */
  runCli?(args: readonly string[], host: BillingHost, out: (line: string) => void): Promise<number>;
}

export interface BillingHostDeps {
  config: Config;
  db: DbHandle;
  log: Logger;
  auth: Auth;
  jobs: JobRegistry;
  /** Becomes `host.env`; default `{}`. CL2-05 passes `config.billingEnv`. */
  env?: Readonly<Record<string, string>>;
  /** Becomes `host.priceSchedule`, frozen; default `CREDIT_PRICE_SCHEDULE`. Tests pass one that prices checks. */
  priceSchedule?: protocol.CreditPriceSchedule;
}

/** The schema a module's tables and its migrations' bookkeeping live in. */
export const BILLING_SCHEMA = 'billing';

/** "UNAB" read as a 32-bit integer (the server's migrations hold "UNAL", route sync "UNAR"). */
export const BILLING_MIGRATION_LOCK_KEY = 1431191874;

/** The columns of Better Auth's `user` table that billing sees. */
const ACCOUNT_COLUMNS = { id: user.id, email: user.email, emailVerified: user.emailVerified, createdAt: user.createdAt };

export function createBillingHost(deps: BillingHostDeps): BillingHost {
  const { config, db, log, jobs, env = {} } = deps;

  async function findAccount(where: SQL): Promise<BillingUser | null> {
    const [row] = await db.db.select(ACCOUNT_COLUMNS).from(user).where(where).limit(1);
    return row ?? null;
  }

  return Object.freeze({
    protocol,
    priceSchedule: deps.priceSchedule ? frozenSchedule(deps.priceSchedule) : protocol.CREDIT_PRICE_SCHEDULE,
    db: billingSql(db.db),
    async migrate(migrationsFolder: string) {
      await runMigrations(db, {
        migrationsFolder,
        migrationsSchema: BILLING_SCHEMA,
        migrationsTable: '__drizzle_migrations',
        lockKey: BILLING_MIGRATION_LOCK_KEY,
        log: log.child({ migrations: 'billing' }),
      });
    },
    log: log.child({ module: 'billing' }),
    config: Object.freeze({ publicOrigin: config.publicOrigin, instanceName: config.instanceName, version: config.version }),
    env: Object.freeze({ ...env }),
    accounts: Object.freeze({
      get: (userId: string) => findAccount(eq(user.id, userId)),
      // Better Auth stores addresses in lowercase.
      findByEmail: (email: string) => findAccount(eq(user.email, email.trim().toLowerCase())),
    }),
    auth: Object.freeze({
      device: requireDevice(deps),
      webSession: requireWebSession(deps),
      async webUser(c: Context): Promise<WebUser | null> {
        const web = await webUserFrom(c, deps);
        // Who, never when the session began or a token.
        return web && { userId: web.userId, email: web.email };
      },
      ownPage: ownPageOnly(config.publicOrigin),
    }),
    jobs,
    html,
    pages: Object.freeze({ render: (c: Context, page: ModulePage) => renderModulePage(c, { config, log }, page) }),
    format: Object.freeze({ formatBalance, formatCreditAmount, formatPostsEstimate, formatPrice }),
  });
}

/** A frozen copy of `schedule`: its entries, their cards and each card. */
function frozenSchedule(schedule: protocol.CreditPriceSchedule): protocol.CreditPriceSchedule {
  return Object.freeze(
    schedule.map((entry) =>
      Object.freeze({
        effectiveFrom: entry.effectiveFrom,
        cards: Object.freeze(
          Object.fromEntries(Object.entries(entry.cards).map(([task, card]) => [task, Object.freeze({ ...card })])),
        ) as protocol.CreditPriceScheduleEntry['cards'],
      }),
    ),
  );
}

/** The SQL facade over the server's database, or over one transaction on it. */
function billingSql(db: Db): BillingSql {
  return Object.freeze({
    sql,
    async query<T extends Record<string, unknown> = Record<string, unknown>>(statement: SQL): Promise<T[]> {
      // node-postgres and PGlite both answer `{ rows }`.
      return ((await db.execute(statement)) as unknown as { rows: T[] }).rows;
    },
    transaction: <R>(fn: (tx: BillingSql) => Promise<R>): Promise<R> => db.transaction((tx) => fn(billingSql(tx))),
  });
}
