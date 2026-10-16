/**
 * For the Better Auth CLI only, in development (`pnpm --filter @unalgorithm/server auth:generate`): the server's own
 * auth options with stub dependencies, so the CLI sees the plugins and tables the server runs with and writes them to
 * `src/db/auth-schema.ts`. Nothing here connects anywhere or sends anything, and the server never imports this file.
 */
import { createAuth } from './src/auth/better-auth.ts';
import { openPostgres } from './src/db/client.ts';
import { createLogger } from './src/log.ts';
import { memoryMailer } from './src/mail/mailer.ts';

export const auth = createAuth({
  config: {
    instanceName: 'auth-cli',
    publicUrl: 'http://localhost:8787',
    publicOrigin: 'http://localhost:8787',
    // A placeholder: the CLI signs nothing.
    authSecret: '0'.repeat(32),
    signup: 'allowlist',
    signupAllowlist: [],
    // The Google provider adds no tables.
    google: undefined,
  },
  // A pool opens a connection on its first query, and the CLI makes none.
  db: openPostgres('postgres://auth-cli@localhost:5432/auth-cli'),
  mailer: memoryMailer().mailer,
  log: createLogger({ level: 'error' }),
});
