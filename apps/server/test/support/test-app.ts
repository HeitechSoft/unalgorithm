import { startMockOpenAI } from '@unalgorithm/ai/testing';
import { type CreditPriceSchedule, DEFAULT_PRICE_BOOK, type PriceBook } from '@unalgorithm/protocol';
import { openPriceStore } from '../../src/admin/prices.ts';
import { clientForRoute } from '../../src/ai/provider.ts';
import { createAuth } from '../../src/auth/better-auth.ts';
import { type BillingModule, createBillingHost } from '../../src/billing/host.ts';
import { type BillingProvider, noopBilling } from '../../src/billing/provider.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import type { DbHandle } from '../../src/db/client.ts';
import { type AppDeps, createApp } from '../../src/http/app.ts';
import type { InFlightRequests } from '../../src/http/middleware.ts';
import { createJobRegistry } from '../../src/jobs/worker.ts';
import { memoryMailer } from '../../src/mail/mailer.ts';
import type { SpaceNotifier } from '../../src/sync/notifier.ts';
import type { AccessResolver } from '../../src/sync/spaces.ts';
import { createTestDb } from './db.ts';
import { captureLog } from './log.ts';
import { seedPassingRoute } from './routes.ts';

/** `PUBLIC_URL` of every test server: the origin its own pages send, and the JWT issuer and audience. */
export const TEST_PUBLIC_URL = 'http://127.0.0.1:8787';

/**
 * The environment every test server starts from: a loopback origin, Mailpit's port, and an OpenAI-compatible provider
 * at the mock's standalone address (CL1-02). Nothing here is a real secret, and `DATABASE_URL` is never connected to:
 * test servers run on PGlite. A test of a command that reads `process.env` itself stubs these values.
 */
export const TEST_ENV: Readonly<Record<string, string>> = {
  PUBLIC_URL: TEST_PUBLIC_URL,
  DATABASE_URL: 'postgres://unalgorithm@127.0.0.1:5432/unalgorithm',
  BETTER_AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  INSTANCE_NAME: 'Test server',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'none',
  MAIL_FROM: 'noreply@example.org',
  AI_PROVIDER: 'openai-compatible',
  AI_MODEL: 'mock-model',
  AI_BASE_URL: 'http://127.0.0.1:8788/v1',
  AI_DATA_POLICY: 'self-hosted',
};

/** A valid server config for tests. `env` adds or replaces variables; `undefined` removes one. */
export function testConfig(env: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...env });
}

export interface TestAppOptions {
  /** Default: `testConfig()`. */
  config?: Config;
  /** Default: the no-op provider. Not with `billingModule`. */
  billing?: BillingProvider;
  /**
   * A billing module (such as `test/fixtures/billing-module`), given as the module itself: its provider, made with a
   * host on this app's database, config, logger and auth and a job registry of its own, becomes the app's billing.
   */
  billingModule?: BillingModule;
  /** The module's `BILLING_*` variables (`host.env`). Default: none. */
  billingEnv?: Record<string, string>;
  /** The price book's seed: the book in use until an admin saves (`prices`). Default: `DEFAULT_PRICE_BOOK`. */
  priceBook?: PriceBook;
  /**
   * The billing host's `priceSchedule`, and shorthand for a `priceBook` of `{ ...DEFAULT_PRICE_BOOK, schedule }`.
   * Default: `CREDIT_PRICE_SCHEDULE`; `TEST_PRICE_SCHEDULE` prices checks.
   */
  priceSchedule?: CreditPriceSchedule;
  /**
   * Better Auth's rate limiter. Default: off. Without a socket every test request comes from one address, and the
   * limiter allows 3 codes and 3 sign-ins a minute per address, so a few sign-ins would get 429. Its counts live in one
   * store per process, so only the tests of the limiters turn it on. It also turns on the per-email limits of `mountAuth`.
   */
  authRateLimit?: boolean;
  /**
   * Default: the production `clientForRoute`, which reaches this app's mock AI provider (CL1-02) through the route
   * seeded for it. A fake client answers without the mock.
   */
  ai?: AppDeps['ai'];
  /** The deadline of a whole classify request. Default: the server's own (25 s). */
  classifyDeadlineMs?: number;
  /** Who may read or write a sync space. Default: the server's own (`userSpaceAccess`). */
  syncAccess?: AccessResolver;
  /** The notifier that wakes sync long-polls, so a test can watch its waiters. Default: the app's own. */
  syncNotifier?: SpaceNotifier;
  /** Aborted to stop the app as `startServer` does. Default: never. */
  stopping?: AbortSignal;
  /** Counts the app's requests in flight, as `startServer` does. Default: not counted. */
  inFlight?: InFlightRequests;
  /**
   * A migrated database that the caller opened and closes itself, such as a Postgres one. Default: a fresh PGlite
   * database, which `close()` closes.
   */
  db?: DbHandle;
  /** The search provider for fact-check research. Default: the config's (`searchProviderFor`). */
  search?: AppDeps['search'];
  /** The fact-check link check. Default: none. */
  linkCheck?: AppDeps['linkCheck'];
  /** The fact-check job store, such as one on a test clock. Default: the app's own. */
  factcheckJobs?: AppDeps['factcheckJobs'];
  /** The perspectives job store. Default: the app's own. */
  perspectivesJobs?: AppDeps['perspectivesJobs'];
  /** The shared link's resolution (the egress fetcher's in production). Default: none. */
  resolveLink?: AppDeps['resolveLink'];
  /** The server's claim cache, such as a failing stub. Default: the app's own (`pgClaimCache` over its database). */
  claimCache?: AppDeps['claimCache'];
}

/**
 * The real app on a fresh migrated PGlite database (or the caller's `db`), logging into memory: `lines` and `events()`
 * hold what it wrote (`deps.errors` counts its error lines, as the server's window does), `outbox` every email it
 * sent, and `prices` the price book's store on its database (`deps.prices`). Its classify route (`route`) is the app's
 * own mock AI provider (`mock`), past its eval; `seedPassingRoute` with overrides replaces it. `provider` is the app's
 * billing, and `host` and `jobs` the billing host and job registry built for it (as `startServer` builds them; the jobs
 * never start). Call `close()` when done. Tests add routes of their own to `app` when they need one.
 */
export async function createTestApp(overrides: TestAppOptions = {}) {
  if (overrides.billing && overrides.billingModule) throw new TypeError('Pass billing or billingModule, not both.');
  const db = overrides.db ?? (await createTestDb());
  const mock = await startMockOpenAI();
  const close = async () => {
    await mock.close();
    if (!overrides.db) await db.close();
  };
  try {
    const capture = captureLog();
    const config = overrides.config ?? testConfig();
    const { mailer, outbox } = memoryMailer();
    const route = await seedPassingRoute(db.db, { baseUrl: mock.baseUrl });
    const log = capture.log;
    const auth = createAuth({ config, db, mailer, log, rateLimitEnabled: overrides.authRateLimit ?? false });
    const jobs = createJobRegistry();
    const { priceSchedule } = overrides;
    const seed = overrides.priceBook ?? (priceSchedule ? { ...DEFAULT_PRICE_BOOK, schedule: priceSchedule } : DEFAULT_PRICE_BOOK);
    const prices = await openPriceStore(db.db, { seed });
    const host = createBillingHost({
      config,
      db,
      log,
      auth,
      jobs,
      mailer,
      env: overrides.billingEnv ?? {},
      priceSchedule: priceSchedule ?? overrides.priceBook?.schedule,
    });
    const provider = overrides.billingModule
      ? await overrides.billingModule.createBillingProvider(host)
      : (overrides.billing ?? noopBilling);
    const deps: AppDeps = {
      config,
      db,
      log,
      billing: provider,
      auth,
      ai: overrides.ai ?? { clientFor: (r) => clientForRoute(r, config) },
      prices,
      classifyDeadlineMs: overrides.classifyDeadlineMs,
      syncAccess: overrides.syncAccess,
      syncNotifier: overrides.syncNotifier,
      stopping: overrides.stopping,
      inFlight: overrides.inFlight,
      errors: capture.errors,
      search: overrides.search,
      linkCheck: overrides.linkCheck,
      // The billing host's schedule, so discovery and the job gates price checks as the module does.
      priceSchedule: host.priceSchedule,
      factcheckJobs: overrides.factcheckJobs,
      perspectivesJobs: overrides.perspectivesJobs,
      resolveLink: overrides.resolveLink,
      ...(overrides.claimCache !== undefined ? { claimCache: overrides.claimCache } : {}),
    };
    const app = createApp(deps);
    return {
      app,
      deps,
      mock,
      route,
      outbox,
      lines: capture.lines,
      events: capture.events,
      host,
      jobs,
      provider,
      prices,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}
