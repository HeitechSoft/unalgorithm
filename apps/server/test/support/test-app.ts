import { createAuth } from '../../src/auth/better-auth.ts';
import { type BillingProvider, noopBilling } from '../../src/billing/provider.ts';
import { type Config, loadConfig } from '../../src/config.ts';
import { type AppDeps, createApp } from '../../src/http/app.ts';
import { memoryMailer } from '../../src/mail/mailer.ts';
import { createTestDb } from './db.ts';
import { captureLog } from './log.ts';

/**
 * The environment every test server starts from: a loopback origin, Mailpit's port, and an OpenAI-compatible provider
 * at the mock's standalone address (CL1-02). Nothing here is a real secret, and `DATABASE_URL` is never connected to:
 * test servers run on PGlite.
 */
const TEST_ENV: Record<string, string> = {
  PUBLIC_URL: 'http://127.0.0.1:8787',
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
  /** Default: the no-op provider. */
  billing?: BillingProvider;
  /**
   * Better Auth's rate limiter. Default: off. Without a socket every test request comes from one address, and the
   * limiter allows 3 codes and 3 sign-ins a minute per address, so a few sign-ins would get 429. Its counts live in one
   * store per process, so only the test of the limiter itself turns it on.
   */
  authRateLimit?: boolean;
}

/**
 * The real app on a fresh migrated PGlite database, logging into memory: `lines` and `events()` hold what it wrote,
 * and `outbox` every email it sent. Call `close()` when done. Tests add routes of their own to `app` when they need one.
 */
export async function createTestApp(overrides: TestAppOptions = {}) {
  const db = await createTestDb();
  const capture = captureLog();
  const config = overrides.config ?? testConfig();
  const { mailer, outbox } = memoryMailer();
  const deps: AppDeps = {
    config,
    db,
    log: capture.log,
    billing: overrides.billing ?? noopBilling,
    auth: createAuth({ config, db, mailer, log: capture.log, rateLimitEnabled: overrides.authRateLimit ?? false }),
  };
  return { app: createApp(deps), deps, outbox, lines: capture.lines, events: capture.events, close: () => db.close() };
}
