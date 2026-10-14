/**
 * Signing in from tests the way people and the extension do, through the real routes only: the emailed code on the
 * server's own page gives a web session (`signInWeb`); the page asks for a PKCE-bound code, and the extension trades it
 * for device tokens (`signInDevice`). The address must be on the test server's `SIGNUP_ALLOWLIST` or have an account.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  AUTHORIZE_API_PATH,
  type AuthorizeRequest,
  AuthorizeResponseSchema,
  chromiumRedirectUri,
  TOKEN_PATH,
  type TokenRequest,
  type TokenResponse,
  TokenResponseSchema,
} from '@unalgorithm/protocol';
import type { App } from '../../src/http/app.ts';
import type { MailMessage } from '../../src/mail/mailer.ts';
import { TEST_PUBLIC_URL } from './test-app.ts';

/** The development key's extension id (ADR 0004): the one `EXTENSION_IDS` lists by default. */
export const DEV_EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
export const DEV_EXTENSION_ORIGIN = `chrome-extension://${DEV_EXTENSION_ID}`;

/** Better Auth's two mounted sign-in endpoints: email a code, then sign in with it. */
export const SEND_CODE = '/api/auth/email-otp/send-verification-otp';
export const SIGN_IN = '/api/auth/sign-in/email-otp';
/** A sign-in code as the email shows it. */
export const SIX_DIGITS = /\b\d{6}\b/;

/** A JSON POST with these headers added (an `Origin`, a `Cookie`). */
export function postJson(app: App, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** The code in the newest email to `email`. */
export function sentCode(outbox: readonly MailMessage[], email: string): string {
  const code = SIX_DIGITS.exec(outbox.findLast((m) => m.to === email)?.text ?? '')?.[0];
  if (!code) throw new Error('No sign-in code was sent: is the address on SIGNUP_ALLOWLIST?');
  return code;
}

/** Signs `email` in on the server's own page (code by email, then the code) and returns the session `Cookie` header. */
export async function signInWeb(app: App, outbox: readonly MailMessage[], email: string): Promise<string> {
  const page = { Origin: TEST_PUBLIC_URL };
  const sent = await postJson(app, SEND_CODE, { email, type: 'sign-in' }, page);
  if (sent.status !== 200) throw new Error(`Sending the sign-in code answered ${sent.status}.`);
  const res = await postJson(app, SIGN_IN, { email, otp: sentCode(outbox, email) }, page);
  if (res.status !== 200) throw new Error(`Signing in answered ${res.status}.`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** A PKCE verifier and its S256 challenge, computed here rather than by the server's own code. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The authorize request the extension's `launchWebAuthFlow` URL carries, for this challenge. */
export function authorizeRequest(challenge: string, clientId = DEV_EXTENSION_ID): AuthorizeRequest {
  return {
    client_id: clientId,
    redirect_uri: chromiumRedirectUri(clientId),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomBytes(16).toString('base64url'),
  };
}

/** `POST /v1/auth/authorize` as the sign-in page sends it: its own origin and the session cookie. */
export function postAuthorize(app: App, cookie: string, body: unknown, origin = TEST_PUBLIC_URL): Promise<Response> {
  return postJson(app, AUTHORIZE_API_PATH, body, { Origin: origin, Cookie: cookie });
}

/** The single-use code in an authorize answer's redirect. */
export async function codeFrom(res: Response): Promise<string> {
  if (res.status !== 200) throw new Error(`Authorize answered ${res.status}.`);
  const { redirect } = AuthorizeResponseSchema.parse(await res.json());
  const code = new URL(redirect).searchParams.get('code');
  if (!code) throw new Error('The redirect holds no code.');
  return code;
}

/**
 * The exchange the extension makes after `launchWebAuthFlow` returns. `deviceName` is sent as given (untrimmed, or one
 * the schema refuses); without it the request carries no `device_name`, like an extension from before CL3.
 */
export function codeExchange(code: string, verifier: string, clientId = DEV_EXTENSION_ID, deviceName?: string): TokenRequest {
  return {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: chromiumRedirectUri(clientId),
    ...(deviceName === undefined ? {} : { device_name: deviceName }),
  };
}

/** `POST /v1/auth/token` from the extension's origin. */
export function postToken(app: App, body: unknown, origin = DEV_EXTENSION_ORIGIN): Promise<Response> {
  return postJson(app, TOKEN_PATH, body, { Origin: origin });
}

/**
 * The whole extension sign-in for `email`: web sign-in, authorize, exchange, naming the device `deviceName` when given.
 * Returns the device's tokens.
 */
export async function signInDevice(
  app: App,
  outbox: readonly MailMessage[],
  email: string,
  clientId = DEV_EXTENSION_ID,
  deviceName?: string,
): Promise<TokenResponse> {
  const cookie = await signInWeb(app, outbox, email);
  const { verifier, challenge } = pkcePair();
  const code = await codeFrom(await postAuthorize(app, cookie, authorizeRequest(challenge, clientId)));
  const res = await postToken(app, codeExchange(code, verifier, clientId, deviceName));
  if (res.status !== 200) throw new Error(`The code exchange answered ${res.status}.`);
  return TokenResponseSchema.parse(await res.json());
}
