import { z } from 'zod';
import { DeviceNameSchema } from './account.ts';
import type { JobPrice } from './billing.ts';
import { MAX_POSTS_PER_REQUEST } from './classify.ts';
import { AI_ERROR_CODES, type WireError } from './errors.ts';
import { sha1Hex } from './sha1.ts';

/** Discovery document every unAlgorithm server serves; the extension reads it before signing in. */
export const SERVER_INFO_PATH = '/.well-known/unalgorithm.json';
/** Web page (apps/web) the extension opens with `launchWebAuthFlow`. */
export const AUTHORIZE_PAGE_PATH = '/authorize';
/** Called by the authorize page on the same origin, with its session cookie. */
export const AUTHORIZE_API_PATH = '/v1/auth/authorize';
export const TOKEN_PATH = '/v1/auth/token';
export const REVOKE_PATH = '/v1/auth/revoke';
export const CLASSIFY_PATH = '/v1/classify';

/** The sign-in method every server offers today, and the one the extension uses: a 6-digit code sent by email. */
export const EMAIL_OTP_METHOD = 'email-otp';
/** Listed only when the server has a Google OAuth client (CL3-13). */
export const GOOGLE_METHOD = 'google';
/** Listed by every server that runs the passkey plugin (CL3-14). */
export const PASSKEY_METHOD = 'passkey';

/** Access tokens live 15 minutes; the extension refreshes them with its refresh token. */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Chrome and Edge extension ids are 32 letters a-p. Each store assigns its own. */
export const ChromiumIdSchema = z.string().regex(/^[a-p]{32}$/);

/**
 * Firefox add-on ids (`runtime.id`): `{uuid}` or `name@domain`, in Firefox's own pattern. That pattern ignores case;
 * it is written out here because a regex flag does not reach the OpenAPI document. At most 80 characters, as
 * addons.mozilla.org allows.
 */
export const GeckoIdSchema = z
  .string()
  .max(80)
  .regex(/^(\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}|[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+)$/);

/** The extension's id in any browser: the `client_id` of sign-in. The two forms never overlap. */
export const ClientIdSchema = z.union([ChromiumIdSchema, GeckoIdSchema]);

/** Which family a client id belongs to; it decides the redirect URI. Edge is `chromium`, Firefox is `gecko`. */
export const ClientKindSchema = z.enum(['chromium', 'gecko']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/** The development key's id (ADR 0004): Chrome and Edge development, e2e and GitHub sideload builds. */
export const DEV_CHROMIUM_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
/** The Firefox store build's add-on id. Permanent once on addons.mozilla.org: devices and the redirect follow it. */
export const FIREFOX_ADDON_ID = 'feed@unalgorithmfeed.com';
/** Firefox development, e2e and GitHub sideload builds: the release's `.xpi` is signed by AMO as an unlisted add-on. */
export const FIREFOX_DEV_ADDON_ID = 'feed-dev@unalgorithmfeed.com';

/** `'chromium'`, `'gecko'`, or null for anything that is not a client id. Never throws. */
export function clientKind(id: string): ClientKind | null {
  if (ChromiumIdSchema.safeParse(id).success) return 'chromium';
  if (GeckoIdSchema.safeParse(id).success) return 'gecko';
  return null;
}

/** Where Chrome's and Edge's `launchWebAuthFlow` expect the authorize page to send the browser back. */
export function chromiumRedirectUri(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/`;
}

/**
 * Firefox's `identity.getRedirectURL()`: the SHA-1 of the add-on id, hashed exactly as given, in lowercase hex.
 * `launchWebAuthFlow` refuses any other redirect URI.
 */
export function geckoRedirectUri(addonId: string): string {
  return `https://${sha1Hex(addonId)}.extensions.allizom.org/`;
}

/** The only redirect URI a client id may sign in with, or null when `id` is not a client id. Never throws. */
export function redirectUriFor(id: string): string | null {
  switch (clientKind(id)) {
    case 'chromium':
      return chromiumRedirectUri(id);
    case 'gecko':
      return geckoRedirectUri(id);
    default:
      return null;
  }
}

/**
 * A path on the server's own origin: URL path characters only, and no second slash straight after the first, so
 * `new URL(path, origin)` cannot reach another host ("//host", "/\host", or a tab the URL parser strips).
 */
const OriginPath = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[\w\-.~!$&'()*+,;=:@%/]*$/);
export const OriginPathSchema = OriginPath;

/** billing.ts's is not exported (and importing its values here would be a cycle); same bounds. */
const Micros = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** What an on-demand task (a check, a comparison) costs on a billing server now: typical and at most. */
export const JobPriceSchema = z.object({ typicalMicros: Micros, maxMicros: Micros }) satisfies z.ZodType<JobPrice>;

export const ServerInfoSchema = z.object({
  v: z.literal(1),
  /** The server's INSTANCE_NAME. A display hint only: never trusted to decide what is "unAlgorithm Cloud". */
  name: z.string().min(1).max(80),
  /** The running server release, e.g. "0.1.0". */
  version: z.string().min(1).max(40),
  /** Source code of the running release (AGPL section 13). Shown as a link, so http(s) only. */
  source: z.url({ protocol: /^https?$/ }),
  /** True only when a billing provider is active; the extension shows credits only then. */
  billing: z.boolean(),
  /** `factcheck` and `perspectives` are optional: an older server's document still parses, and an older extension ignores them. */
  capabilities: z.object({
    classify: z.boolean(),
    sync: z.boolean(),
    factcheck: z.boolean().optional(),
    perspectives: z.boolean().optional(),
  }),
  /** A billing server's price for an on-demand task now (CL2-26 schedule). Absent when it charges nothing for it. */
  jobPrices: z.object({ factcheck: JobPriceSchema.optional(), perspectives: JobPriceSchema.optional() }).optional(),
  /** A billing server's price of 1,000 classified posts now, on its reference model. Absent when it charges nothing. */
  classifyPrice: z.object({ microsPer1000Posts: Micros }).optional(),
  auth: z.object({
    /**
     * Sign-in methods the server offers, such as `email-otp`. Open-ended, so a server that adds a method later still
     * passes: a client checks that the list includes the method it supports (`EMAIL_OTP_METHOD`).
     */
    methods: z.array(z.string().min(1).max(40)).min(1).max(10),
    authorizePath: OriginPath,
    tokenPath: OriginPath,
    /**
     * The client kinds (`clientKind`) the server takes sign-ins from, from its EXTENSION_IDS. Missing means
     * `['chromium']`: servers from before Firefox leave it out. Kinds this client does not know are dropped, not
     * refused, so a newer server's list still parses; a list with none it knows reads as missing. What this returns
     * parses again unchanged, as stored accounts are.
     */
    clients: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(10)
      .transform((kinds) => {
        const known = kinds.filter((kind): kind is ClientKind => ClientKindSchema.safeParse(kind).success);
        return known.length ? known : undefined;
      })
      .optional(),
  }),
  limits: z.object({ maxPostsPerRequest: z.number().int().min(1).max(MAX_POSTS_PER_REQUEST) }),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/** PKCE code verifier (RFC 7636 section 4.1). */
const Verifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/);
/** base64url(sha256(verifier)), no padding. */
const Challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Rotating refresh token; the same bounds wherever it travels, so a token the extension stores can be used. */
const RefreshToken = z.string().min(20).max(200);

/**
 * The redirect URI must be `redirectUriFor(client_id)`, so a code can only ever go back to the extension that asked
 * for it, whichever server (or fork) answers. The check stays synchronous (the web page parses during a render) and
 * refuses rather than throws whatever `client_id` holds.
 */
export const AuthorizeRequestSchema = z
  .object({
    client_id: ClientIdSchema,
    redirect_uri: z.string().url(),
    code_challenge: Challenge,
    code_challenge_method: z.literal('S256'),
    state: z.string().min(16).max(128),
  })
  .refine(
    (r) => {
      const uri = redirectUriFor(r.client_id);
      return uri !== null && r.redirect_uri === uri;
    },
    { path: ['redirect_uri'] },
  );
export type AuthorizeRequest = z.infer<typeof AuthorizeRequestSchema>;

/**
 * Where the authorize page sends the browser: the redirect URI with a single-use code and the state. https on a
 * Chromium (`chromiumapp.org`) or Firefox (`extensions.allizom.org`) redirect host only; never Firefox's loopback form.
 */
export const AuthorizeResponseSchema = z.object({
  redirect: z.url({
    protocol: /^https$/,
    hostname: /^([a-p]{32}\.chromiumapp\.org|[0-9a-f]{40}\.extensions\.allizom\.org)$/,
  }),
});
export type AuthorizeResponse = z.infer<typeof AuthorizeResponseSchema>;

export const TokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(20).max(200),
    code_verifier: Verifier,
    client_id: ClientIdSchema,
    /** Bound at authorize time; the server compares it with the stored one after burning the code. */
    redirect_uri: z.string().url(),
    /** What the extension calls itself, shown in the account's devices list. A refresh never renames a device. */
    device_name: DeviceNameSchema.optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: RefreshToken,
    client_id: ClientIdSchema,
  }),
]);
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: RefreshToken,
  device_id: z.string().uuid(),
  account: z.object({ email: z.string().email() }),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const RevokeRequestSchema = z.object({
  refresh_token: RefreshToken,
  client_id: ClientIdSchema,
});
export type RevokeRequest = z.infer<typeof RevokeRequestSchema>;

/** Body of every non-2xx response from /v1 routes: the runtime validator for `WireError`. */
export const ServerErrorSchema = z.object({
  code: z.enum(AI_ERROR_CODES),
  message: z.string().max(300),
}) satisfies z.ZodType<WireError>;
