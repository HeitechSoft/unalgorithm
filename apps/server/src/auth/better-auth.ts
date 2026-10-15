/**
 * Sign-in with Better Auth (pinned exactly; its advisories are watched): a six-digit code sent by email, Google when
 * the operator configures a Google OAuth client, or a passkey the signed-in person added; a one-day web session for the
 * server's own sign-in page; and the EdDSA key that signs the extension's 15-minute access tokens. Only the routes
 * `authRoutesFor` lists are reachable over HTTP; everything else Better Auth offers stays unmounted.
 *
 * The server's operator pays for its AI, so accounts are created only for addresses their provider verified that are
 * allow-listed or invited (`admin/invites.ts`). Nothing here logs an address or a code: Better Auth's own log messages are dropped (`authLog`), its refusals
 * are answered without a log line, any other failure goes to the app's `onError`, and mail failures log `errorFields`
 * only.
 */
import { createHash } from 'node:crypto';
import { getAuthenticatorName, PASSKEY_ERROR_CODES, passkey } from '@better-auth/passkey';
import { AIError } from '@unalgorithm/ai';
import { ACCOUNT_PAGE_PATH } from '@unalgorithm/protocol';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin } from 'better-auth/plugins/admin';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { jwt } from 'better-auth/plugins/jwt';
import type { Context, Hono } from 'hono';
import { hasAccount, isInvited, mayCreateAccount, removeInvite } from '../admin/invites.ts';
import { createRateLimiter } from '../ai/limits.ts';
import type { Config } from '../config.ts';
import * as authSchema from '../db/auth-schema.ts';
import { type DbHandle, queryErrorFields } from '../db/client.ts';
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
 * Those stay unreachable, and `signJWT` and `verifyJWT` are server-only calls. Every server has the six passkey routes
 * the account page and the sign-in page use: adding a passkey (options, then verify; only the response and a label,
 * `PASSKEY_REGISTRATION_FIELDS`), signing in with one (options, then verify), listing and removing them; not renaming
 * one. With a Google client, the two routes of its sign-in join them: starting it (the redirect flow only,
 * `SOCIAL_SIGN_IN_FIELDS`), and Google's redirect back.
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
    ['GET', '/api/auth/passkey/generate-register-options'],
    ['POST', '/api/auth/passkey/verify-registration'],
    ['GET', '/api/auth/passkey/generate-authenticate-options'],
    ['POST', '/api/auth/passkey/verify-authentication'],
    ['GET', '/api/auth/passkey/list-user-passkeys'],
    ['POST', '/api/auth/passkey/delete-passkey'],
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

/**
 * The fields `POST /api/auth/sign-in/social` accepts: what the server's own page sends to start the redirect flow. Better
 * Auth takes more, and a request carrying any other field is refused: `scopes` and `additionalParams` would widen what
 * Google is asked for (a profile, offline access, other Google APIs), `idToken` signs in straight from a Google ID token
 * (no state, PKCE or Origin check), and the rest serve flows this server does not offer.
 */
const SOCIAL_SIGN_IN_FIELDS: ReadonlySet<string> = new Set([
  'provider',
  'callbackURL',
  'errorCallbackURL',
  'newUserCallbackURL',
  'disableRedirect',
]);

/**
 * The fields `POST /api/auth/passkey/verify-registration` accepts: the authenticator's response and the label the
 * account page may give it. Better Auth also takes `createSession`, which would start another session from the one
 * adding the passkey; a passkey only signs in later, through its own sign-in.
 */
const PASSKEY_REGISTRATION_FIELDS: ReadonlySet<string> = new Set(['response', 'name']);

/** The routes, by Better Auth path, whose body may hold only these fields; a request with any other is refused. */
const BODY_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['/sign-in/social', SOCIAL_SIGN_IN_FIELDS],
  ['/passkey/verify-registration', PASSKEY_REGISTRATION_FIELDS],
]);

/**
 * Better Auth's limits, per client address and Better Auth path, for the passkey sign-in, which anyone may start: its
 * own default would allow 100 requests every 10 seconds. Each options request stores a challenge for five minutes, so
 * 30 a minute, room for a sign-in page that asks on load and again on a click behind a shared address. Verifying is a
 * sign-in, limited as Better Auth limits its others: 3 every 10 seconds.
 */
const PASSKEY_SIGN_IN_LIMITS = {
  '/passkey/generate-authenticate-options': { window: 60, max: 30 },
  '/passkey/verify-authentication': { window: 10, max: 3 },
};

export interface AuthDeps {
  config: Pick<Config, 'instanceName' | 'publicUrl' | 'publicOrigin' | 'authSecret' | 'signupAllowlist' | 'google'>;
  db: DbHandle;
  mailer: Mailer;
  log: Logger;
  /**
   * Better Auth's per-address limits (3 codes a minute, 3 sign-ins every 10 seconds, and `PASSKEY_SIGN_IN_LIMITS`), and
   * with them `mountAuth`'s per-email ones. Default: on, in every running server. Tests turn it off unless they ask for it (`createTestApp`): without a socket
   * every request counts as one address.
   */
  rateLimitEnabled?: boolean;
}

export function authOptions({ config, db, mailer, log, rateLimitEnabled = true }: AuthDeps) {
  const hasUser = (email: string): Promise<boolean> => hasAccount(db.db, email);

  /**
   * Better Auth calls this after storing the code's hash; for a sign-in code, for every valid address. Only sign-in
   * codes go out, and only to an existing account, an allow-listed address or an invited one. The endpoint answers the
   * same either way, so it never tells who may sign in.
   */
  async function sendVerificationOTP({ email, otp, type }: { email: string; otp: string; type: string }) {
    if (type !== 'sign-in') return;
    // Both looked up for every address, before deciding, so the answer takes as long whether a code goes out or not,
    // and whether the address is on the allowlist or not.
    const [known, invited] = await Promise.all([hasUser(email), isInvited(db.db, email)]);
    if (!known && !isEmailAllowed(email, config.signupAllowlist) && !invited) return;
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
            // Only the redirect flow signs in: no session straight from a Google ID token (also refused by
            // `SOCIAL_SIGN_IN_FIELDS`).
            disableIdTokenSignIn: true,
          },
        }
      : undefined,
    session: { expiresIn: SESSION_TTL_SECONDS },
    // Also refused as BETTER_AUTH_TELEMETRY by `loadConfig`: Better Auth honours that variable over this option.
    telemetry: { enabled: false },
    rateLimit: { enabled: rateLimitEnabled, storage: 'memory', customRules: PASSKEY_SIGN_IN_LIMITS },
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
    hooks: {
      // Refuses a sign-in/social or passkey registration body with a field beyond its `BODY_FIELDS`. Runs after Better
      // Auth's Origin check and before it validates the body.
      before: createAuthMiddleware(async (ctx) => {
        const fields = BODY_FIELDS.get(ctx.path);
        if (!fields) return;
        const body: unknown = ctx.body;
        if (typeof body === 'object' && body !== null && Object.keys(body).some((k) => !fields.has(k))) {
          throw new APIError('BAD_REQUEST', {
            code: 'VALIDATION_ERROR',
            message: 'The request has a field this server does not accept.',
          });
        }
      }),
    },
    plugins: [
      emailOTP({ otpLength: 6, expiresIn: OTP_TTL_SECONDS, allowedAttempts: 3, storeOTP: 'hashed', sendVerificationOTP }),
      jwt({
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: { issuer: config.publicOrigin, audience: config.publicOrigin, expirationTime: '15m' },
        // Web sessions never receive a JWT: access tokens are for devices only.
        disableSettingJwtHeader: true,
      }),
      passkey({
        // Passkeys belong to the PUBLIC_URL host. Browsers refuse an IP address as a relying party id, so passkeys work
        // on a domain name or localhost, not on an address such as http://127.0.0.1.
        rpID: new URL(config.publicUrl).hostname,
        rpName: config.instanceName,
        // What the browser signed (`clientDataJSON.origin`) must be this; it is never taken from the request.
        origin: config.publicOrigin,
        // Discoverable credentials: the sign-in page signs in without asking for an address.
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
        // Adding one needs a fresh web session (`requireSession`, on by default; fresh for a day, as long as a session
        // lasts), so a passkey never creates an account and the allowlist keeps deciding who has one.
        registration: {
          // Runs before the passkey is stored. A credential id already stored, for any account, is refused (WebAuthn
          // asks this of a relying party): without attestation a page can claim any id, and sign-in finds a passkey by
          // its id alone, so a copy under another account could stand in for the owner's and lock them out.
          // When the page sends no name, the authenticator's model as a label ("Google Password Manager"), from the
          // package's table; none for an unknown or anonymous model. A name the page sends wins.
          afterVerification: async ({ ctx, verification }) => {
            const info = verification.registrationInfo;
            const taken = info
              ? await ctx.context.adapter.findOne({
                  model: 'passkey',
                  where: [{ field: 'credentialID', value: info.credential.id }],
                  select: ['id'],
                })
              : null;
            if (taken) throw APIError.from('BAD_REQUEST', PASSKEY_ERROR_CODES.PREVIOUSLY_REGISTERED);
            return { name: getAuthenticatorName(info?.aaguid) };
          },
        },
      }),
      // For its `role` and `banned` columns and its refusal of a session for a banned account (`admin/access.ts`).
      // None of its routes is mounted (`authRoutesFor`): our admin routes call them server-side. The message names no
      // product: it is any server's.
      admin({ defaultRole: 'user', adminRoles: ['admin'], bannedUserMessage: 'This account cannot sign in to this server.' }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Every new account needs an address its provider verified (email codes always are; Google says so in
            // `email_verified`) that is allow-listed or invited. The code turns the refusal into a redirect with
            // `error=SIGNUP_CLOSED` in Better Auth's Google callback; without one it would fail the request.
            if (user.emailVerified !== true || !(await mayCreateAccount({ db: db.db, config }, user.email)))
              throw new APIError('FORBIDDEN', { code: 'SIGNUP_CLOSED', message: 'Sign-up is closed.' });
            // Only the address is kept: a name or an image sent with the first sign-in is dropped.
            return { data: { ...user, name: '', image: null } };
          },
          // Runs once the account is stored: its invite, if any, is used up. A failure leaves a harmless invite (the
          // admin can remove it) and never fails the sign-in. Logged by name and SQLSTATE only: no message (a
          // database error's can quote the address) and no stack (its package paths hold `@`, like an address).
          after: async (user) => {
            try {
              await removeInvite(db.db, user.email);
            } catch (err) {
              const { err_name, err_code } = queryErrorFields(err);
              log.warn('invites.consume_failed', { err_name, ...(err_code === undefined ? {} : { err_code }) });
            }
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
 * Codes emailed to one address, whoever asks: 5 in 15 minutes, then one every 3 minutes. Better Auth's limits count per
 * client address, which anyone with many addresses gets past, and each new code brings 3 more tries.
 */
export const CODE_SENDS_PER_EMAIL = { max: 5, windowMs: 15 * 60_000 } as const;
/** Wrong codes tried for one address, whoever tries them: 10 an hour, then one every 6 minutes. A sign-in is not counted. */
export const FAILED_SIGN_INS_PER_EMAIL = { max: 10, windowMs: 60 * 60_000 } as const;

const SEND_CODE_PATH = '/api/auth/email-otp/send-verification-otp';
const SIGN_IN_CODE_PATH = '/api/auth/sign-in/email-otp';

type Forward = (c: Context<AppEnv>) => Promise<Response>;

/**
 * Forwards each route of `authRoutesFor(config)` to Better Auth; any other `/api/auth` path, or another method, gets
 * the app's 404. The request reaches Better Auth with `CLIENT_IP_HEADER` set to the address `clientIp` decided, or
 * removed when there is none. With Better Auth's rate limit on, the emailed code is also limited per email address
 * (`CODE_SENDS_PER_EMAIL`, `FAILED_SIGN_INS_PER_EMAIL`), in this process's memory.
 */
export function mountAuth(app: Hono<AppEnv>, auth: Auth, config: Pick<Config, 'google'>): void {
  const forward: Forward = (c) => auth.handler(withClientIp(c));
  const limited = auth.options.rateLimit.enabled ? perEmailLimits(forward) : new Map<string, Forward>();
  for (const [method, path] of authRoutesFor(config)) app.on(method, path, limited.get(path) ?? forward);
}

/**
 * The two emailed-code routes, each behind its per-address limit. The counter's key is a hash of the address, never
 * logged and of one size whatever the request holds. A request Better Auth refuses (its per-client limit, a malformed
 * address) is given back, and a counter given everything back is dropped, so only codes sent and wrong codes tried hold
 * memory: no more than Better Auth's per-client limits let through.
 */
function perEmailLimits(forward: Forward): Map<string, Forward> {
  const sends = createRateLimiter(CODE_SENDS_PER_EMAIL);
  const failures = createRateLimiter(FAILED_SIGN_INS_PER_EMAIL);
  return new Map<string, Forward>([
    [
      SEND_CODE_PATH,
      async (c) => {
        const key = await emailKeyOf(c);
        if (key === undefined) return forward(c);
        // Past the limit: Better Auth's answer to a code sent, with no code made or mailed. It says nothing about
        // whether the address may sign in.
        if (!sends.take(key).ok) return c.json({ success: true });
        const res = await forward(c);
        // Every valid address gets 200 whether a code goes out or not, so another answer made no code.
        if (!res.ok) sends.refund(key);
        return res;
      },
    ],
    [
      SIGN_IN_CODE_PATH,
      async (c) => {
        const key = await emailKeyOf(c);
        if (key === undefined) return forward(c);
        // Taken before the code is checked, so requests sent at once cannot all pass; given back unless the code failed.
        const rate = failures.take(key);
        if (!rate.ok)
          throw new AIError('rate-limit', 'Too many wrong codes for this address.', { retryAfterMs: rate.retryAfterMs });
        const res = await forward(c);
        if (res.ok || res.status === 429) failures.refund(key);
        return res;
      },
    ],
  ]);
}

/**
 * The counter's key for the body's `email`, lowercased as Better Auth compares it (a SHA-256 hash), or undefined. The
 * request's body stays unread.
 */
async function emailKeyOf(c: Context<AppEnv>): Promise<string | undefined> {
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => undefined);
  const email = typeof body === 'object' && body !== null ? (body as { email?: unknown }).email : undefined;
  return typeof email === 'string' ? createHash('sha256').update(email.toLowerCase()).digest('base64url') : undefined;
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
