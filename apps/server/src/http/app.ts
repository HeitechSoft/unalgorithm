/**
 * The server's one HTTP app. Every route is mounted here by `createApp`, behind the same middleware and the same error
 * mapping; later features extend `AppDeps` and add their routes, never a second app. Error bodies are fixed strings or
 * `describeError` text: never a zod issue, an input value or an error message, any of which can hold post text.
 */
import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { OpenAPIHono } from '@hono/zod-openapi';
import { type AIClient, AIError, describeError } from '@unalgorithm/ai';
import type { SourceList } from '@unalgorithm/outlets';
import {
  ACCOUNT_PAGE_PATH,
  ADMIN_PAGE_PATH,
  type AIErrorCode,
  AUTHORIZE_PAGE_PATH,
  CREDIT_PRICE_SCHEDULE,
  type CreditPriceSchedule,
  EMAIL_OTP_METHOD,
  FACTCHECK_JOB_TTL_MS,
  type FactcheckResult,
  GOOGLE_METHOD,
  MAX_POSTS_PER_REQUEST,
  PASSKEY_METHOD,
  type PerspectivesResult,
  SERVER_INFO_PATH,
  SETUP_PAGE_PATH,
  type ServerInfo,
  TOKEN_PATH,
  type WireError,
} from '@unalgorithm/protocol';
import type { ClaimCache, LinkChecker, SearchProvider } from '@unalgorithm/research';
import { sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { claimCacheSecret, pgClaimCache } from '../ai/claim-cache.ts';
import { searchProviderFor } from '../ai/factcheck.ts';
import { createRateLimiter, type LimitDeps } from '../ai/limits.ts';
import { perspectivesOffer } from '../ai/perspectives.ts';
import type { AiRoute } from '../ai/routes.ts';
import { type Auth, mountAuth } from '../auth/better-auth.ts';
import type { BillingProvider } from '../billing/provider.ts';
import type { Config } from '../config.ts';
import type { DbHandle } from '../db/client.ts';
import { createJobStore, type JobStore } from '../jobs/memory-jobs.ts';
import { errorFields, type Logger } from '../log.ts';
import type { ErrorWindow } from '../ops/error-window.ts';
import { accountRoutes } from '../routes/account.ts';
import { adminRoutes } from '../routes/admin.ts';
import { authRoutes } from '../routes/auth.ts';
import { classifyRoutes } from '../routes/classify.ts';
import { factcheckOffer, factcheckRoutes } from '../routes/factcheck.ts';
import { metricsRoutes } from '../routes/metrics.ts';
import { NOT_FOUND } from '../routes/openapi.ts';
import { outletAdminRoutes } from '../routes/outlets.ts';
import { perspectivesRoutes } from '../routes/perspectives.ts';
import { syncRoutes } from '../routes/sync.ts';
import type { SpaceNotifier } from '../sync/notifier.ts';
import type { AccessResolver } from '../sync/spaces.ts';
import {
  type AppEnv,
  clientIp,
  closeWhenStopping,
  extensionCors,
  type InFlightRequests,
  nonErrorsAsErrors,
  requestLog,
} from './middleware.ts';
import { MAX_PAGE_BODY_BYTES, pageCsp, readWebIndex, webMissing } from './page-frame.ts';

export type { AppEnv } from './middleware.ts';

export interface AppDeps {
  config: Config;
  db: DbHandle;
  log: Logger;
  billing: BillingProvider;
  /** Better Auth: email-code, Google and passkey sign-in, web sessions and the access-token signing key. */
  auth: Auth;
  /** The AI client for a route: `clientForRoute(route, config)` in production; tests answer from the mock or a fake. */
  ai: { clientFor(route: AiRoute): AIClient };
  /** Tests only: the deadline of a whole classify request. Default: `CLASSIFY_DEADLINE_MS` (25 s). */
  classifyDeadlineMs?: number;
  /** Who may read or write a sync space. Default: `userSpaceAccess`, the owner of a personal space; CL7 adds org spaces. */
  syncAccess?: AccessResolver;
  /** Tests only: the notifier that wakes sync long-polls, to watch its waiters. Default: a new one for the app. */
  syncNotifier?: SpaceNotifier;
  /**
   * Aborted when the server begins to stop (`startServer`): sync long-polls answer at once, and every answer from then on
   * closes its connection, so neither holds the stop open. Default: never.
   */
  stopping?: AbortSignal;
  /** Counts the requests in flight, so a stopping server (`startServer`) waits for them to end. Default: not counted. */
  inFlight?: InFlightRequests;
  /** The server's error-level log lines of the last 15 minutes, for the admin page's status (CL4-14). Default: none (0). */
  errors?: ErrorWindow;
  /** The admin's search provider (`searchProviderFor(config)`, the default); null: research through the research route. */
  search?: SearchProvider | null;
  /** The egress link check (P3-13); default: none (every source counts as live). */
  linkCheck?: LinkChecker;
  /** Default CREDIT_PRICE_SCHEDULE; tests pass TEST_PRICE_SCHEDULE (the same object the billing host gets). */
  priceSchedule?: CreditPriceSchedule;
  /** Default: createJobStore({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 }). */
  factcheckJobs?: JobStore<FactcheckResult>;
  /**
   * The source list UnEcho Chamber compares across; null (the default): not offered, since nothing bundled holds a lean.
   * Tests pass `FIXTURE_LIST`. P3-77 removes it: a request will carry its list.
   */
  outlets?: SourceList | null;
  /** Default: createJobStore({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 4, maxKeptPerUser: 5 }). */
  perspectivesJobs?: JobStore<PerspectivesResult>;
  /** The egress fetcher's resolution of a shared link to its canonical URL (P3-32); default: none (the link as shared). */
  resolveLink?: (url: string, signal: AbortSignal) => Promise<string | null>;
  /**
   * The server's shared claim cache (P3-58); null: none. Default: `pgClaimCache` over the app's database, keyed from
   * BETTER_AUTH_SECRET; `createApp` writes it here, so `deps.claimCache` is the app's own.
   */
  claimCache?: ClaimCache | null;
}

export type App = OpenAPIHono<AppEnv>;

/** Larger `/v1` request bodies are refused before any route reads them. */
const MAX_BODY_BYTES = 128 * 1024;
/**
 * The same for `/api/auth`, whose bodies hold an address, a code and a type, the pages a Google sign-in comes back to,
 * or an authenticator's passkey response without attestation: a few kilobytes at most.
 */
const MAX_AUTH_BODY_BYTES = 16 * 1024;

const NOT_VALID: WireError = { code: 'bad-request', message: 'The request was not valid.' };
const TOO_LARGE: WireError = { code: 'bad-request', message: 'The request was too large.' };
const UNKNOWN: WireError = { code: 'unknown', message: 'Something went wrong on the server.' };

/** The server's pages' CSP (`pageCsp`): scripts, styles and requests from this origin only, nothing inline, never in a frame. */
const PAGE_CSP = pageCsp();

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
  if (deps.claimCache === undefined) deps.claimCache = pgClaimCache(db.db, { secret: claimCacheSecret(config.authSecret) });
  const app = new OpenAPIHono<AppEnv>({
    // A request that fails its schema gets one fixed answer: zod's issues quote the input.
    defaultHook: (result, c) => {
      if (!result.success) return c.json(NOT_VALID, 400);
    },
  });

  if (deps.inFlight) app.use(deps.inFlight.track);
  app.use(clientIp(config.trustProxy));
  app.use(requestLog(log));
  app.use(secureHeaders({ referrerPolicy: 'no-referrer' }));
  if (deps.stopping) app.use(closeWhenStopping(deps.stopping));
  // CORS before the body limit, so the extension can read a 413 too.
  app.use('/v1/*', extensionCors(config.extensionIds));
  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(TOO_LARGE, 413) }));
  // Everything outside `/v1` and `/api/auth` (which has its own below): the server's pages take no body, and a route a
  // billing module mounts reads none larger.
  const pageBodyLimit = bodyLimit({ maxSize: MAX_PAGE_BODY_BYTES, onError: (c) => c.json(TOO_LARGE, 413) });
  app.use((c, next) => (c.req.path.startsWith('/v1/') || c.req.path.startsWith('/api/auth/') ? next() : pageBodyLimit(c, next)));
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

  const priceSchedule = deps.priceSchedule ?? CREDIT_PRICE_SCHEDULE;
  const outlets = deps.outlets ?? null;
  const serverInfo: ServerInfo = {
    v: 1,
    name: config.instanceName,
    version: config.version,
    source: config.sourceUrl,
    billing: billing.advertised,
    capabilities: { classify: true, sync: true },
    auth: {
      // Google only when the operator configured a Google OAuth client; passkeys on every server.
      methods: [EMAIL_OTP_METHOD, ...(config.google ? [GOOGLE_METHOD] : []), PASSKEY_METHOD],
      authorizePath: AUTHORIZE_PAGE_PATH,
      tokenPath: TOKEN_PATH,
    },
    limits: { maxPostsPerRequest: MAX_POSTS_PER_REQUEST },
  };
  app.get(SERVER_INFO_PATH, (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    // Public by design: any page or extension may read which server this is.
    c.header('Access-Control-Allow-Origin', '*');
    // Per request: whether checks are offered, and their price, follow the schedule entry in effect now.
    const offer = factcheckOffer(config, priceSchedule);
    const compare = perspectivesOffer(config, priceSchedule, outlets);
    const billed = config.billing === 'module';
    const jobPrices = {
      ...(offer.offered && offer.price && billed ? { factcheck: offer.price } : {}),
      ...(compare.offered && compare.price && billed ? { perspectives: compare.price } : {}),
    };
    const info: ServerInfo = {
      ...serverInfo,
      capabilities: { ...serverInfo.capabilities, factcheck: offer.offered, perspectives: compare.offered },
      ...(Object.keys(jobPrices).length ? { jobPrices } : {}),
    };
    return c.json(info);
  });

  // Better Auth reads a body of any size, and these routes take requests from anyone.
  app.use('/api/auth/*', bodyLimit({ maxSize: MAX_AUTH_BODY_BYTES, onError: (c) => c.json(TOO_LARGE, 413) }));
  mountAuth(app, auth, config, log);
  authRoutes(app, deps);
  accountRoutes(app, deps);
  // One per app, shared by classify, fact-check and perspectives: one rate bucket per user, and the breaker's log state and the
  // requests in flight last as long as the server process.
  const limits: LimitDeps = {
    db: db.db,
    config,
    limiter: createRateLimiter({ perMinute: config.userRequestsPerMinute }),
    log,
  };
  classifyRoutes(app, deps, limits);
  const search = deps.search === undefined ? searchProviderFor(config) : deps.search;
  factcheckRoutes(
    app,
    {
      ...deps,
      search,
      priceSchedule,
      factcheckJobs: deps.factcheckJobs ?? createJobStore({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 8, maxKeptPerUser: 5 }),
    },
    limits,
  );
  perspectivesRoutes(
    app,
    {
      ...deps,
      search,
      priceSchedule,
      outlets,
      perspectivesJobs:
        deps.perspectivesJobs ?? createJobStore({ ttlMs: FACTCHECK_JOB_TTL_MS, maxRunning: 4, maxKeptPerUser: 5 }),
    },
    limits,
  );
  adminRoutes(app, deps);
  outletAdminRoutes(app, deps);
  metricsRoutes(app, deps);
  syncRoutes(app, deps);

  billing.mount?.(app);

  mountWeb(app, deps);

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
 * The server's web app (apps/web), built into `config.webDist`: `/`, `/authorize`, `/account` and `/setup` answer its
 * `index.html`, and `/assets/*` the files Vite built, named by their content hash. Without a build those pages answer
 * 503 and the log says so once. The build is looked up per request, so one made after the server started is served.
 */
function mountWeb(app: App, { config, log }: AppDeps): void {
  const page = async (c: Context<AppEnv>) => {
    const html = await readWebIndex(config.webDist);
    if (html === null) return webMissing(c, { config, log });
    c.header('Content-Security-Policy', PAGE_CSP);
    c.header('Cache-Control', 'no-store');
    return c.html(html);
  };
  app.get('/', page);
  app.get(AUTHORIZE_PAGE_PATH, page);
  app.get(ACCOUNT_PAGE_PATH, page);
  app.get(SETUP_PAGE_PATH, page);
  app.get(ADMIN_PAGE_PATH, page);

  // Made once the folder exists: serveStatic writes to the console, outside the log, when its root is missing.
  let assets: MiddlewareHandler | undefined;
  app.use('/assets/*', async (c, next) => {
    assets ??= existsSync(config.webDist) ? serveStatic({ root: config.webDist }) : undefined;
    if (!assets) return next();
    const found = await assets(c, next);
    // Only a file it served (not found, it calls `next`): Vite names each by its content hash, so a copy never goes stale.
    if (found instanceof Response) found.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    return found;
  });
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
