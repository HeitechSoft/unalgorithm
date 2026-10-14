import { startMockOpenAI } from '@unalgorithm/ai/testing';
import { clientForRoute } from '../../src/ai/provider.ts';
import { createAuth } from '../../src/auth/better-auth.ts';
import { type BillingModule, createBillingHost } from '../../src/billing/host.ts';
import { type BillingProvider, noopBilling } from '../../src/billing/provider.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import type { DbHandle } from '../../src/db/client.ts';
import { type AppDeps, createApp } from '../../src/http/app.ts';
import { createJobRegistry } from '../../src/jobs/worker.ts';
import { memoryMailer } from '../../src/mail/mailer.ts';
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
  /**
   * Better Auth's rate limiter. Default: off. Without a socket every test request comes from one address, and the
   * limiter allows 3 codes and 3 sign-ins a minute per address, so a few sign-ins would get 429. Its counts live in one
   * store per process, so only the test of the limiter itself turns it on.
   */
  authRateLimit?: boolean;
  /**
   * Default: the production `clientForRoute`, which reaches this app's mock AI provider (CL1-02) through the route
   * seeded for it. A fake client answers without the mock.
   */
  ai?: AppDeps['ai'];
  /** The deadline of a whole classify request. Default: the server's own (25 s). */
  classifyDeadlineMs?: number;
  /**
   * A migrated database that the caller opened and closes itself, such as a Postgres one. Default: a fresh PGlite
   * database, which `close()` closes.
   */
  db?: DbHandle;
}

/**
 * The real app on a fresh migrated PGlite database (or the caller's `db`), logging into memory: `lines` and `events()`
 * hold what it wrote, and `outbox` every email it sent. Its classify route (`route`) is the app's own mock AI provider
 * (`mock`), past its eval; `seedPassingRoute` with overrides replaces it. `provider` is the app's billing, and `host` and
 * `jobs` the billing host and job registry built for it (as `startServer` builds them; the jobs never start). Call
 * `close()` when done. Tests add routes of their own to `app` when they need one.
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
    const host = createBillingHost({ config, db, log, auth, jobs, env: overrides.billingEnv ?? {} });
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
      classifyDeadlineMs: overrides.classifyDeadlineMs,
    };
    const app = createApp(deps);
    return { app, deps, mock, route, outbox, lines: capture.lines, events: capture.events, host, jobs, provider, close };
  } catch (err) {
    await close();
    throw err;
  }
}
