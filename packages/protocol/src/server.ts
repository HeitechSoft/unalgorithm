import { z } from 'zod';
import { MAX_POSTS_PER_REQUEST } from './classify.ts';
import { AI_ERROR_CODES, type WireError } from './errors.ts';

/** Discovery document every UnAlgorithm server serves; the extension reads it before signing in. */
export const SERVER_INFO_PATH = '/.well-known/unalgorithm.json';
/** Web page (apps/web) the extension opens with `launchWebAuthFlow`. */
export const AUTHORIZE_PAGE_PATH = '/authorize';
/** Called by the authorize page on the same origin, with its session cookie. */
export const AUTHORIZE_API_PATH = '/v1/auth/authorize';
export const TOKEN_PATH = '/v1/auth/token';
export const REVOKE_PATH = '/v1/auth/revoke';
export const CLASSIFY_PATH = '/v1/classify';

/** Access tokens live 15 minutes; the extension refreshes them with its refresh token. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Chrome extension ids are 32 letters a-p. */
export const ExtensionIdSchema = z.string().regex(/^[a-p]{32}$/);

/** Where `launchWebAuthFlow` expects the authorize page to send the browser back. */
export function chromiumRedirectUri(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/`;
}

export const ServerInfoSchema = z.object({
  v: z.literal(1),
  /** The server's INSTANCE_NAME. A display hint only: never trusted to decide what is "UnAlgorithm Cloud". */
  name: z.string().min(1).max(80),
  /** The running server release, e.g. "0.1.0". */
  version: z.string().min(1).max(40),
  /** Source code of the running release (AGPL section 13). */
  source: z.string().url(),
  /** True only when a billing provider is active; the extension shows credits only then. */
  billing: z.boolean(),
  capabilities: z.object({ classify: z.boolean(), sync: z.boolean() }),
  auth: z.object({
    methods: z.array(z.enum(['email-otp'])).min(1),
    authorizePath: z.string().startsWith('/'),
    tokenPath: z.string().startsWith('/'),
  }),
  limits: z.object({ maxPostsPerRequest: z.number().int().min(1).max(MAX_POSTS_PER_REQUEST) }),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/** PKCE code verifier (RFC 7636 section 4.1). */
const Verifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);
/** base64url(sha256(verifier)), no padding. */
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AuthorizeRequestSchema = z.object({
  client_id: ExtensionIdSchema,
  redirect_uri: z.string().url(),
  code_challenge: Challenge,
  code_challenge_method: z.literal('S256'),
  state: z.string().min(16).max(128),
});
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/** Where the authorize page sends the browser: the redirect URI with a single-use code and the state. */
export const AuthorizeResponseSchema = z.object({ redirect: z.string().url() });
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;

export const TokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(20).max(200),
    code_verifier: Verifier,
    client_id: ExtensionIdSchema,
    redirect_uri: z.string().url(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(20).max(200),
    client_id: ExtensionIdSchema,
  }),
]);
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(20),
  device_id: z.string().uuid(),
  account: z.object({ email: z.string().email() }),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const RevokeRequestSchema = z.object({
  refresh_token: z.string().min(20).max(200),
  client_id: ExtensionIdSchema,
});
export type RevokeRequest = z.infer<typeof RevokeRequestSchema>;

/** Body of every non-2xx response from /v1 routes: the runtime validator for `WireError`. */
export const ServerErrorSchema = z.object({
  code: z.enum(AI_ERROR_CODES),
  message: z.string().max(300),
}) satisfies z.ZodType<WireError>;
