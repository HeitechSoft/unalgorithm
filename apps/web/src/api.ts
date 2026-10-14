/**
 * The page's calls to its own server: the discovery document, Better Auth's sign-in (an emailed code, Google or a
 * passkey), the authorize endpoint that hands the extension a single-use code, and the account's credits where the
 * server bills. All same-origin, so the browser sends the session cookie and the `Origin` header Better Auth checks.
 * Every failure is an `ApiError` carrying the HTTP status (0: no answer at all), except a cancelled passkey prompt
 * (`PasskeyCancelled`).
 */
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from '@simplewebauthn/browser';
import {
  AUTHORIZE_API_PATH,
  type AuthorizeRequest,
  AuthorizeResponseSchema,
  CREDIT_ACCOUNT_PATH,
  type CreditAccount,
  CreditAccountSchema,
  SERVER_INFO_PATH,
  type ServerInfo,
  ServerInfoSchema,
} from '@unalgorithm/protocol';
import { z } from 'zod';

/** The Better Auth routes the server mounts for this page (CL1-08). */
export const SEND_CODE_PATH = '/api/auth/email-otp/send-verification-otp';
export const SIGN_IN_PATH = '/api/auth/sign-in/email-otp';
export const SESSION_PATH = '/api/auth/get-session';
export const SIGN_OUT_PATH = '/api/auth/sign-out';
/** Google sign-in, on a server with a Google client (CL3-13), and passkey sign-in, on every server (CL3-14). */
export const SOCIAL_SIGN_IN_PATH = '/api/auth/sign-in/social';
export const PASSKEY_AUTH_OPTIONS_PATH = '/api/auth/passkey/generate-authenticate-options';
export const PASSKEY_AUTH_VERIFY_PATH = '/api/auth/passkey/verify-authentication';

/** `get-session` answers `null` without a session; the page only needs the address. */
const SessionSchema = z.object({ user: z.object({ email: z.string() }) }).nullable();

/**
 * `sign-in/social` with `disableRedirect` answers where to send the browser instead of redirecting it. Only Google's own
 * sign-in page is followed: an answer naming any other address is a failure, never a navigation.
 */
const GoogleRedirectSchema = z.object({ url: z.url({ protocol: /^https$/, hostname: /^accounts\.google\.com$/ }) });

/** The authentication options `startAuthentication` takes; the library reads them as WebAuthn defines them. */
const PasskeyOptionsSchema = z.custom<PublicKeyCredentialRequestOptionsJSON>(
  (value) => z.looseObject({ challenge: z.string().min(1) }).safeParse(value).success,
);

export class ApiError extends Error {
  /** The HTTP status (a 2xx one when the answer could not be used), or 0 when the server could not be reached. */
  readonly status: number;

  constructor(status: number) {
    super(status ? `The server answered ${status}.` : 'The server could not be reached.');
    this.name = 'ApiError';
    this.status = status;
  }
}

/** A GET, or a JSON POST when there is a body; the answer must match `schema`. */
async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? { headers }
        : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiError(0);
  }
  if (!res.ok) throw new ApiError(res.status);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status);
  return parsed.data;
}

/** This server's discovery document: its name and the link to its source. */
export async function serverInfo(): Promise<ServerInfo> {
  return request(SERVER_INFO_PATH, ServerInfoSchema);
}

/** Who is signed in on this page, if anyone. */
export async function getSession(): Promise<{ email: string } | null> {
  const session = await request(SESSION_PATH, SessionSchema);
  return session ? { email: session.user.email } : null;
}

/** Emails a sign-in code. The server answers the same whether or not the address may sign in. */
export async function sendCode(email: string): Promise<void> {
  await request(SEND_CODE_PATH, z.unknown(), { email, type: 'sign-in' });
}

/** Signs in with the emailed code; the server sets the session cookie. */
export async function verifyCode(email: string, otp: string): Promise<void> {
  await request(SIGN_IN_PATH, z.unknown(), { email, otp });
}

/**
 * Where to send the browser for Google; only an https://accounts.google.com/ address is accepted. Google sends the
 * browser back to `returnTo` (a path on this server) either way: signed in, or with `?error=` when it didn't work.
 */
export async function googleSignInUrl(returnTo: string): Promise<string> {
  const body = { provider: 'google', callbackURL: returnTo, errorCallbackURL: returnTo, disableRedirect: true };
  return (await request(SOCIAL_SIGN_IN_PATH, GoogleRedirectSchema, body)).url;
}

/** The person closed the browser's passkey prompt, or it timed out: the server was told nothing. */
export class PasskeyCancelled extends Error {
  constructor() {
    super('The passkey sign-in was cancelled.');
    this.name = 'PasskeyCancelled';
  }
}

/**
 * Signs in with a passkey: the server's challenge, the browser's passkey prompt, then the signed answer back to the
 * server, which sets the session cookie. A cancelled prompt is told apart by the error's name, never its class: the
 * library rethrows the browser's `DOMException` as its own `WebAuthnError`, an `Error` that keeps the name.
 */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await request(PASSKEY_AUTH_OPTIONS_PATH, PasskeyOptionsSchema);
  let response: AuthenticationResponseJSON;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (err) {
    if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      throw new PasskeyCancelled();
    }
    throw err;
  }
  await request(PASSKEY_AUTH_VERIFY_PATH, z.unknown(), { response });
}

export async function signOut(): Promise<void> {
  await request(SIGN_OUT_PATH, z.unknown(), {});
}

/** Asks for the extension's single-use code; returns where to send the browser (the extension's redirect address). */
export async function authorize(req: AuthorizeRequest): Promise<string> {
  return (await request(AUTHORIZE_API_PATH, AuthorizeResponseSchema, req)).redirect;
}

/** The signed-in person's balance and credit history; only a server that advertises billing answers it. */
export async function creditAccount(): Promise<CreditAccount> {
  return request(CREDIT_ACCOUNT_PATH, CreditAccountSchema);
}
