/**
 * The server's one HTTP app. Every route is mounted here by `createApp`, behind the same middleware and the same error
 * mapping; later features extend `AppDeps` and add their routes, never a second app. Error bodies are fixed strings or
 * `describeError` text: never a zod issue, an input value or an error message, any of which can hold post text.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import { AIError, describeError } from '@unalgorithm/ai';
import {
  type AIErrorCode,
  AUTHORIZE_PAGE_PATH,
  EMAIL_OTP_METHOD,
  MAX_POSTS_PER_REQUEST,
  SERVER_INFO_PATH,
  type ServerInfo,
  TOKEN_PATH,
  type WireError,
} from '@unalgorithm/protocol';
import { sql } from 'drizzle-orm';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type Auth, mountAuth } from '../auth/better-auth.ts';
import type { BillingProvider } from '../billing/provider.ts';
import type { Config } from '../config.ts';
import type { DbHandle } from '../db/client.ts';
import { errorFields, type Logger } from '../log.ts';
import { type AppEnv, clientIp, extensionCors, nonErrorsAsErrors, requestLog } from './middleware.ts';

export type { AppEnv } from './middleware.ts';

export interface AppDeps {
  config: Config;
  db: DbHandle;
  log: Logger;
  billing: BillingProvider;
  /** Better Auth: email-code sign-in, web sessions and the access-token signing key. */
  auth: Auth;
}

export type App = OpenAPIHono<AppEnv>;

/** Larger `/v1` request bodies are refused before any route reads them. */
const MAX_BODY_BYTES = 128 * 1024;
/** The same for `/api/auth`, whose bodies hold an address, a code and a type: well under a kilobyte. */
const MAX_AUTH_BODY_BYTES = 16 * 1024;

const NOT_VALID: WireError = { code: 'bad-request', message: 'The request was not valid.' };
const TOO_LARGE: WireError = { code: 'bad-request', message: 'The request was too large.' };
const NOT_FOUND: WireError = { code: 'bad-request', message: 'Not found.' };
const UNKNOWN: WireError = { code: 'unknown', message: 'Something went wrong on the server.' };

/** The HTTP status for an error code; the body carries the code itself. */
export function httpStatusFor(code: AIErrorCode): ContentfulStatusCode {
  switch (code) {
    case 'bad-request':
      return 400;
    case 'auth-required':
    case 'auth':
      return 401;
    case 'insufficient-credits':
      return 402;
    case 'permission':
      return 403;
    case 'rate-limit':
    case 'cap-reached':
      return 429;
    case 'overloaded':
    case 'not-available':
      return 503;
    case 'timeout':
      return 504;
    default:
      return 500;
  }
}

export function createApp(deps: AppDeps): App {
  const { config, db, log, billing, auth } = deps;
  const app = new OpenAPIHono<AppEnv>({
    // A request that fails its schema gets one fixed answer: zod's issues quote the input.
    defaultHook: (result, c) => {
      if (!result.success) return c.json(NOT_VALID, 400);
    },
  });

  app.use(clientIp(config.trustProxy));
  app.use(requestLog(log));
  app.use(secureHeaders({ referrerPolicy: 'no-referrer' }));
  // CORS before the body limit, so the extension can read a 413 too.
  app.use('/v1/*', extensionCors(config.extensionIds));
  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(TOO_LARGE, 413) }));
  // Last: everything registered after it (every route, and middleware added later) is inside it.
  app.use(nonErrorsAsErrors());

  app.get('/health', async (c) => {
    try {
      await db.db.execute(sql`select 1`);
      return c.json({ ok: true, version: config.version });
    } catch (err) {
      log.error('health.db_failed', errorFields(err));
      return c.json({ ok: false }, 503);
    }
  });

  const serverInfo: ServerInfo = {
    v: 1,
    name: config.instanceName,
    version: config.version,
    source: config.sourceUrl,
    billing: billing.advertised,
    capabilities: { classify: true, sync: false },
    auth: { methods: [EMAIL_OTP_METHOD], authorizePath: AUTHORIZE_PAGE_PATH, tokenPath: TOKEN_PATH },
    limits: { maxPostsPerRequest: MAX_POSTS_PER_REQUEST },
  };
  app.get(SERVER_INFO_PATH, (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    // Public by design: any page or extension may read which server this is.
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(serverInfo);
  });

  // Better Auth reads a body of any size, and these routes take requests from anyone.
  app.use('/api/auth/*', bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: (c) => c.json(TOO_LARGE, 413) }));
  mountAuth(app, auth);

  billing.mount?.(app);

  app.notFound((c) => c.json(NOT_FOUND, 404));

  app.onError((err, c) => {
    const { status, body } = errorResponse(err, config.instanceName);
    const level = status >= 500 ? 'error' : 'warn';
    log[level]('http.error', { rid: c.get('rid'), ...errorFields(err) });
    if (err instanceof AIError && err.retryAfterMs !== undefined && Number.isFinite(err.retryAfterMs)) {
      c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
    }
    return c.json(body, status);
  });

  return app;
}

/**
 * An `AIError` answers with its code and the plain-language message for it. A client error Hono raises itself (such as
 * malformed JSON in a validated body) keeps its status as `bad-request`. Anything else is a 500 `unknown`.
 */
function errorResponse(err: Error, instanceName: string): { status: ContentfulStatusCode; body: WireError } {
  if (err instanceof AIError) {
    return { status: httpStatusFor(err.code), body: { code: err.code, message: describeError(err.code, instanceName) } };
  }
  if (err instanceof HTTPException && err.status >= 400 && err.status < 500) return { status: err.status, body: NOT_VALID };
  return { status: 500, body: UNKNOWN };
}
