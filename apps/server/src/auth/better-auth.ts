/**
 * Sign-in with Better Auth (pinned exactly; its advisories are watched): a six-digit code sent by email, or Google when
 * the operator configures a Google OAuth client; a one-day web session for the server's own sign-in page; and the EdDSA
 * key that signs the extension's 15-minute access tokens. Only the routes `authRoutesFor` lists are reachable over
 * HTTP; everything else Better Auth offers stays unmounted.
 *
 * The server's operator pays for its AI, so accounts are created only for allow-listed addresses their provider
 * verified. Nothing here logs an address or a code: Better Auth's own log messages are dropped (`authLog`), its refusals
 * are answered without a log line, any other failure goes to the app's `onError`, and mail failures log `errorFields`
 * only.
 */
import { ACCOUNT_PAGE_PATH } from '@unalgorithm/protocol';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { jwt } from 'better-auth/plugins/jwt';
import { eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Config } from '../config.ts';
import * as authSchema from '../db/auth-schema.ts';
import type { DbHandle } from '../db/client.ts';
import { type AppEnv, getClientIp } from '../http/middleware.ts';
import { errorFields, type Logger } from '../log.ts';
import { type Mailer, signInCodeEmail } from '../mail/mailer.ts';

/**
 * The header Better Auth reads the client's address from, for its rate limiter and the `session` rows. `mountAuth`
 * always replaces it with `getClientIp`'s answer, so a client cannot choose the address it is counted under.
 */
export const CLIENT_IP_HEADER = 'x-ua-client-ip';

/** How long a sign-in code works. The email states it in minutes. */
const OTP_TTL_SECONDS = 300;
/** The web session only serves the sign-in page; the extension holds device tokens instead (CL1-09). */
const SESSION_TTL_SECONDS = 86_400;

/** A route Better Auth answers over HTTP: its method and path. */
export type AuthRoute = readonly ['GET' | 'POST', string];

/**
 * The Better Auth routes reachable over HTTP, each for one method. Not `/api/auth/*`: Better Auth has many more routes,
 * among them `/token` (a JWT signed with the device tokens' key for any web session), `/update-user` (a name and an
 * image the privacy notice does not cover), the other email-otp routes and the ones that link, list or unlink accounts.
 * Those stay unreachable, and `signJWT` and `verifyJWT` are server-only calls. With a Google client, the two routes of
 * its sign-in join them: starting it, and Google's redirect back.
 */
export function authRoutesFor(config: Pick<Config, 'google'>): AuthRoute[] {
  const google: AuthRoute[] = [
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/callback/google'],
  ];
  return [
    ['POST', '/api/auth/email-otp/send-verification-otp'],
    ['POST', '/api/auth/sign-in/email-otp'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-out'],
    ['GET', '/api/auth/jwks'],
    ...(config.google ? google : []),
  ];
}

/**
 * What a sign-in through another provider leaves of that provider's tokens: nothing. The server needs Google only to
 * learn the verified address once; a Google token kept here would only be a liability.
 */
const NO_PROVIDER_TOKENS = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

export interface AuthDeps {
  config: Pick<Config, 'instanceName' | 'publicUrl' | 'publicOrigin' | 'authSecret' | 'signupAllowlist' | 'google'>;
  db: DbHandle;
  mailer: Mailer;
  log: Logger;
  /**
   * Better Auth's per-address limits (3 codes and 3 sign-ins a minute). Default: on, in every running server. Tests
   * turn it off unless they ask for it (`createTestApp`): without a socket every request counts as one address.
   */
  rateLimitEnabled?: boolean;
}

export function authOptions({ config, db, mailer, log, rateLimitEnabled = true }: AuthDeps) {
  async function hasUser(email: string): Promise<boolean> {
    const { user } = authSchema;
    const rows = await db.db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    return rows.length > 0;
  }

  /**
   * Better Auth calls this after storing the code's hash; for a sign-in code, for every valid address. Only sign-in
   * codes go out, and only to an allowed address or an existing account. The endpoint answers the same either way, so it
   * never tells who may sign in.
   */
  async function sendVerificationOTP({ email, otp, type }: { email: string; otp: string; type: string }) {
    if (type !== 'sign-in') return;
    // Looked up for every address, so the answer takes as long whether a code goes out or not.
    const known = await hasUser(email);
    if (!known && !isEmailAllowed(email, config.signupAllowlist)) return;
    const message = signInCodeEmail({ code: otp, instanceName: config.instanceName, minutes: OTP_TTL_SECONDS / 60 });
    // Not awaited (Better Auth's advice against timing attacks); a failure is logged without its message.
    void mailer.send({ to: email, ...message }).catch((err: unknown) => log.error('mail.otp_failed', errorFields(err)));
  }

  return {
    appName: config.instanceName,
    baseURL: config.publicUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    database: drizzleAdapter(db.db, { provider: 'pg', schema: authSchema }),
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: false },
    socialProviders: config.google
      ? {
          google: {
            clientId: config.google.clientId,
            clientSecret: config.google.clientSecret,
            // No 'profile': the server never stores a name or a picture. Nor scopes left from an earlier grant.
            disableDefaultScope: true,
            scope: ['openid', 'email'],
            includeGrantedScopes: false,
            prompt: 'select_account',
          },
        }
      : undefined,
    session: { expiresIn: SESSION_TTL_SECONDS },
    // Also refused as BETTER_AUTH_TELEMETRY by `loadConfig`: Better Auth honours that variable over this option.
    telemetry: { enabled: false },
    rateLimit: { enabled: rateLimitEnabled, storage: 'memory' },
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Better Auth skips the Origin check when NODE_ENV is `test` or TEST is set; it holds in every environment here.
      disableOriginCheck: false,
    },
    logger: { level: 'warn', log: authLog(log) },
    // Otherwise Better Auth's router writes a failed request to the console, past `authLog`: a refusal's message (which
    // can quote the client's Content-Type) and, for any other error, the whole error, whose query parameters hold the
    // address and the code's hash. Its refusals are still answered as before; any other error reaches the app's
    // `onError`, which logs `errorFields` only and answers 500 `unknown`. A Google sign-in that fails goes back to the
    // page that started it with an `error` parameter; when the page is unknown (a state never issued), to the account page.
    onAPIError: { throw: true, errorURL: `${config.publicOrigin}${ACCOUNT_PAGE_PATH}` },
    plugins: [
      emailOTP({ otpLength: 6, expiresIn: OTP_TTL_SECONDS, allowedAttempts: 3, storeOTP: 'hashed', sendVerificationOTP }),
      jwt({
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: { issuer: config.publicOrigin, audience: config.publicOrigin, expirationTime: '15m' },
        // Web sessions never receive a JWT: access tokens are for devices only.
        disableSettingJwtHeader: true,
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Every new account needs an address its provider verified: email codes always are; Google says so in
            // `email_verified`. The code turns the refusal into a redirect with `error=SIGNUP_CLOSED` in Better Auth's
            // Google callback; without one it would fail the request.
            if (user.emailVerified !== true || !isEmailAllowed(user.email, config.signupAllowlist)) {
              throw new APIError('FORBIDDEN', { code: 'SIGNUP_CLOSED', message: 'Sign-up is closed.' });
            }
            // Only the address is kept: a name or an image sent with the first sign-in is dropped.
            return { data: { ...user, name: '', image: null } };
          },
        },
      },
      // Linking Google to an existing account of the same address needs Google's `email_verified` too (Better Auth's
      // default: Google is not a trusted provider), and writes no name or picture (`updateUserInfoOnLink` stays off).
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_PROVIDER_TOKENS } }) },
      },
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Forwards each route of `authRoutesFor(config)` to Better Auth; any other `/api/auth` path, or another method, gets
 * the app's 404. The request reaches Better Auth with `CLIENT_IP_HEADER` set to the address `clientIp` decided, or
 * removed when there is none.
 */
export function mountAuth(app: Hono<AppEnv>, auth: Auth, config: Pick<Config, 'google'>): void {
  for (const [method, path] of authRoutesFor(config)) app.on(method, path, (c) => auth.handler(withClientIp(c)));
}

function withClientIp(c: Context<AppEnv>): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.delete(CLIENT_IP_HEADER);
  const ip = getClientIp(c);
  if (ip !== null) headers.set(CLIENT_IP_HEADER, ip);
  return new Request(c.req.raw, { headers });
}

/**
 * Whether `email` may create an account. Entries compare in lowercase: `@domain` matches an address whose part after
 * the last `@` is exactly that domain (no subdomains); any other entry must be the whole address. An empty list lets
 * nobody in. It gates account creation only: an existing account signs in whatever the list says.
 */
export function isEmailAllowed(email: string, allowlist: readonly string[]): boolean {
  const address = email.toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1);
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('@') ? e.slice(1) === domain : e === address;
  });
}

/**
 * Better Auth's logger, as our log lines. Its message and extra arguments are free-form (they can name an address, and
 * a database error's message can quote the query's parameters), so a line holds the fixed event `auth.log`, the level
 * and, for an `Error` argument, its `errorFields`.
 */
export function authLog(log: Logger) {
  return (level: string, _message: string, ...args: unknown[]): void => {
    const err = args.find((a) => a instanceof Error);
    log[level === 'error' ? 'error' : 'warn']('auth.log', err ? errorFields(err) : {});
  };
}
