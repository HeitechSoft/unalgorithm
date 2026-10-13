/**
 * The page's calls to its own server: the discovery document, Better Auth's email-code sign-in, and the authorize
 * endpoint that hands the extension a single-use code. All same-origin, so the browser sends the session cookie and the
 * `Origin` header Better Auth checks. Every failure is an `ApiError` carrying the HTTP status (0: no answer at all).
 */
import {
  AUTHORIZE_API_PATH,
  type AuthorizeRequest,
  AuthorizeResponseSchema,
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

/** `get-session` answers `null` without a session; the page only needs the address. */
const SessionSchema = z.object({ user: z.object({ email: z.string() }) }).nullable();

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

export async function signOut(): Promise<void> {
  await request(SIGN_OUT_PATH, z.unknown(), {});
}

/** Asks for the extension's single-use code; returns where to send the browser (the extension's redirect address). */
export async function authorize(req: AuthorizeRequest): Promise<string> {
  return (await request(AUTHORIZE_API_PATH, AuthorizeResponseSchema, req)).redirect;
}
