/**
 * The one way tests build a real billing host (CL2-04): the public server's own tests, and the private billing module's
 * tests through its `public/` checkout. The host runs on a migrated PGlite database, or on the caller's `db` (a Postgres
 * one, or the database of a `createTestApp`), with the test server's config, a logger into memory and a mailer into
 * `outbox`.
 */
import { createAuth } from '../../src/auth/better-auth.ts';
import { type BillingHost, createBillingHost } from '../../src/billing/host.ts';
import type { DbHandle } from '../../src/db/client.ts';
import { createJobRegistry, type JobRegistry } from '../../src/jobs/worker.ts';
import { type MailMessage, memoryMailer } from '../../src/mail/mailer.ts';
import { createTestDb } from './db.ts';
import { captureLog } from './log.ts';
import { testConfig } from './test-app.ts';

/**
 * A host on `opts.db`, or on a fresh migrated PGlite database that `close()` closes. A given database is never closed
 * here: its owner closes it. `opts.env` becomes `host.env`; `lines` holds what the host logged, `outbox` every email its
 * auth sent, and `jobs` is the registry the host hands out.
 */
export async function createTestHost(opts: { env?: Record<string, string>; db?: DbHandle } = {}): Promise<{
  host: BillingHost;
  db: DbHandle;
  jobs: JobRegistry;
  lines: string[];
  outbox: MailMessage[];
  close(): Promise<void>;
}> {
  const db = opts.db ?? (await createTestDb());
  const close = async () => {
    if (!opts.db) await db.close();
  };
  try {
    const config = testConfig();
    const { log, lines } = captureLog();
    const { mailer, outbox } = memoryMailer();
    // The rate limit off, as in `createTestApp`: without a socket every test request counts as one address.
    const auth = createAuth({ config, db, mailer, log, rateLimitEnabled: false });
    const jobs = createJobRegistry();
    const host = createBillingHost({ config, db, log, auth, jobs, env: opts.env });
    return { host, db, jobs, lines, outbox, close };
  } catch (err) {
    await close();
    throw err;
  }
}
