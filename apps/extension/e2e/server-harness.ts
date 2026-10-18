/**
 * The real server process for end-to-end tests, on a fresh Postgres database, with sign-in codes caught by Mailpit.
 * Node APIs, plus the server's own Postgres test helper (its `pg`, so apps/extension gains no dependency). Playwright
 * runs from apps/extension, so every path is absolute and every child process runs from the repository root.
 *
 * Defaults match `apps/server/compose.dev.yaml`, so the server spec also runs locally: `TEST_DATABASE_URL` names the
 * Postgres server (only used to create and drop the run's own database) and `MAILPIT_URL` the Mailpit API.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_CHROMIUM_ID, FIREFOX_DEV_ADDON_ID } from '@unalgorithm/protocol';
import { createPostgresTestDb, databaseExists as databaseExistsOn } from '../../server/test/support/postgres.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/**
 * The server's entry point, as shipped. UnEcho Chamber needs no other: each comparison request carries its source list
 * (P3-77).
 */
const SERVER_ENTRY = resolve(REPO_ROOT, 'apps/server/src/index.ts');
const ROUTE_EVAL = resolve(REPO_ROOT, 'apps/server/src/cli/route-eval.ts');
const WEB_DIST = resolve(REPO_ROOT, 'apps/web/dist');
/** The public test billing module (CL2-05), for `BILLING=module` and `BILLING_MODULE`. Test code, never shipped. */
export const BILLING_FIXTURE_MODULE = resolve(REPO_ROOT, 'apps/server/test/fixtures/billing-module/index.ts');

const ADMIN_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || 'postgres://postgres:dev@127.0.0.1:5432/unalgorithm';
const MAILPIT_URL = (process.env.MAILPIT_URL?.trim() || 'http://127.0.0.1:8025').replace(/\/+$/, '');
/** Mailpit's SMTP port, as `compose.dev.yaml` and the CI service publish it. */
const MAILPIT_SMTP_PORT = '1025';

const HEALTH_TIMEOUT_MS = 30_000;
const ROUTE_EVAL_TIMEOUT_MS = 60_000;
/** The server lets requests in flight finish for up to 10 s when it stops. */
const STOP_TIMEOUT_MS = 15_000;
const CODE_TIMEOUT_MS = 10_000;
const POLL_MS = 200;

/**
 * The e2e builds' ids: Chrome's and Edge's (the dev key) and Firefox's development id, so all three browsers can sign
 * in. Listed explicitly rather than left to the server's default, which also names the Firefox store id.
 */
export const E2E_EXTENSION_IDS = [DEV_CHROMIUM_ID, FIREFOX_DEV_ADDON_ID].join(',');

/** Variables a child process needs from this one to run at all; nothing of the developer's own server settings. */
const PLATFORM_ENV = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

export interface LocalServer {
  /** `http://127.0.0.1:<free port>`. */
  url: string;
  /** The run's own database: `ua_e2e_` and 12 hex characters. */
  database: string;
  /** The variables the server and `route-eval` ran with. */
  env: Readonly<Record<string, string>>;
  /** Everything the server process wrote to stdout and stderr. */
  logs(): string;
  /** Whether the server process has exited. */
  exited(): boolean;
  /** Stops the server, then drops the run's database. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Starts the server on a free port and a new database, waits for `/health`, then opens the eval gate with
 * `route-eval`, and with `FACTCHECK=on` then `route-eval factcheck`. `ROUTE_EVAL_MIN_AGREEMENT=0` is an operator's
 * explicit choice that the server and the CLI both read: the mock's default verdicts agree at most 0.4 with the eval set, so with the default minimum every classify would
 * answer 503. The gate itself still runs (`recordEval`, then `resolveRoute` on every request).
 *
 * `env` is added after the harness's own variables, for the server and `route-eval` alike: a billing module
 * (`BILLING=module`, `BILLING_MODULE=BILLING_FIXTURE_MODULE` and the module's own `BILLING_*` variables), or a changed
 * default.
 */
export async function startLocalServer(opts: {
  aiBaseUrl: string;
  env?: Readonly<Record<string, string>>;
}): Promise<LocalServer> {
  const db = await createPostgresTestDb('ua_e2e', ADMIN_DATABASE_URL);
  let child: ChildProcess | undefined;
  let output = '';
  try {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const env: Record<string, string> = {
      PUBLIC_URL: url,
      PORT: String(port),
      DATABASE_URL: db.url,
      BETTER_AUTH_SECRET: randomBytes(36).toString('base64'),
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: MAILPIT_SMTP_PORT,
      SMTP_SECURE: 'none',
      MAIL_FROM: 'signin@example.com',
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: opts.aiBaseUrl,
      AI_MODEL: 'mock-model',
      AI_DATA_POLICY: 'self-hosted',
      SIGNUP_ALLOWLIST: 'tester@example.com',
      EXTENSION_IDS: E2E_EXTENSION_IDS,
      ROUTE_EVAL_MIN_AGREEMENT: '0',
      WEB_DIST,
      ...opts.env,
    };

    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = server;
    server.stdout.setEncoding('utf8').on('data', (s: string) => void (output += s));
    server.stderr.setEncoding('utf8').on('data', (s: string) => void (output += s));
    server.once('error', (err) => void (output += `\nspawn failed: ${err.message}\n`));
    await waitForHealth(url, server, () => output);

    const evaluated = await runNode(ROUTE_EVAL, [], env, ROUTE_EVAL_TIMEOUT_MS);
    if (evaluated.code !== 0) throw new Error(`route-eval exited with ${evaluated.code}:\n${evaluated.output}`);
    if (env.FACTCHECK === 'on') {
      // The fact-check routes' gate, on the classify route's eval just stored.
      const checked = await runNode(ROUTE_EVAL, ['factcheck'], env, ROUTE_EVAL_TIMEOUT_MS);
      if (checked.code !== 0) throw new Error(`route-eval factcheck exited with ${checked.code}:\n${checked.output}`);
    }

    let stopping: Promise<void> | undefined;
    return {
      url,
      database: db.name,
      env,
      logs: () => output,
      exited: () => hasExited(server),
      stop: () => (stopping ??= stopProcess(server).then(() => db.drop())),
    };
  } catch (err) {
    if (child) await stopProcess(child);
    await db.drop();
    throw err;
  }
}

/** Whether the Postgres server has a database of this name (read through `TEST_DATABASE_URL`). */
export function databaseExists(name: string): Promise<boolean> {
  return databaseExistsOn(name, ADMIN_DATABASE_URL);
}

/** Empties Mailpit's mailbox, so the next message is this test's. */
export async function clearMailbox(): Promise<void> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Mailpit answered ${res.status} to emptying the mailbox.`);
}

/** The 6-digit code in the newest message's text. Mailpit answers 404 until a message arrives. */
export async function latestSignInCode(): Promise<string> {
  const deadline = Date.now() + CODE_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/message/latest`);
    if (res.status === 200) {
      const { Text } = (await res.json()) as { Text?: string };
      const code = /\b(\d{6})\b/.exec(Text ?? '')?.[1];
      if (!code) throw new Error('The newest message holds no 6-digit code.');
      return code;
    }
    if (Date.now() >= deadline) throw new Error(`No sign-in email arrived within ${CODE_TIMEOUT_MS / 1000} s.`);
    await sleep(POLL_MS);
  }
}

/** The given variables plus the few a process needs to run on this platform. */
function childEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  const platform = PLATFORM_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]] as const] : []));
  return { ...Object.fromEntries(platform), ...vars };
}

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitForHealth(url: string, server: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited(server)) throw new Error(`The server exited with ${server.exitCode}:\n${output()}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(POLL_MS);
  }
  throw new Error(`The server didn't answer /health within ${HEALTH_TIMEOUT_MS / 1000} s:\n${output()}`);
}

/** Runs a script with Node.js from the repository root; resolves with its exit code and output. */
function runNode(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => void (output += s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => void (output += s));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** SIGTERM (a graceful stop; on Windows the process ends at once), then SIGKILL if it is still running. */
async function stopProcess(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
  await exited;
  clearTimeout(timer);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
