/**
 * The extension's sign-in (R10). `launchWebAuthFlow` opens the server's sign-in page with a PKCE challenge; once the
 * person is signed in there, the page asks `POST /v1/auth/authorize` for a single-use code bound to the extension, its
 * redirect address and the challenge, and sends the browser back to the extension with it. The extension trades the
 * code and its verifier at `POST /v1/auth/token` for device tokens, and later trades each refresh token there for the
 * next. "Sign out" in the extension ends its device with `POST /v1/auth/revoke`.
 *
 * No route logs or stores a code, a verifier or a token in plain form. Every refused exchange or refresh gets the same
 * answer, so a caller cannot tell an unknown code or token from a spent one, an expired one or a wrong verifier.
 */
import { createRoute } from '@hono/zod-openapi';
import { AIError } from '@unalgorithm/ai';
import {
  AUTHORIZE_API_PATH,
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  chromiumRedirectUri,
  REVOKE_PATH,
  RevokeRequestSchema,
  ServerErrorSchema,
  TOKEN_PATH,
  TokenRequestSchema,
  TokenResponseSchema,
  type WireError,
} from '@unalgorithm/protocol';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  consumeAuthCode,
  issueAuthCode,
  issueTokens,
  revokeByRefreshToken,
  rotateRefreshToken,
  verifyPkce,
} from '../auth/tokens.ts';
import type { App, AppDeps } from '../http/app.ts';

const REFUSED: WireError = { code: 'permission', message: "This server doesn't accept sign-ins from here." };

/** The revoke answer, whatever the token was (RFC 7009): it tells a caller nothing about the token. */
const RevokeResponseSchema = z.object({ ok: z.literal(true) });

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({ description, content: json(ServerErrorSchema) });

/** Mounts the authorize, token and revoke routes on the app. */
export function authRoutes(app: App, { config, db, auth, log }: AppDeps): void {
  const extensionIds = new Set(config.extensionIds);

  app.openapi(
    createRoute({
      method: 'post',
      path: AUTHORIZE_API_PATH,
      // Before the body is read: only the server's own sign-in page may ask for a code.
      middleware: [ownPageOnly(config.publicOrigin)] as const,
      request: { body: { content: json(AuthorizeRequestSchema), required: true } },
      responses: {
        200: { description: 'Where the sign-in page sends the browser', content: json(AuthorizeResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No web session'),
        403: errorResponse('Not from this server, or not a listed extension'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) throw new AIError('auth-required', 'No web session.');
      const req = c.req.valid('json');
      if (!extensionIds.has(req.client_id)) return c.json(REFUSED, 403);
      // The schema holds the same rule; the server does not depend on it to keep codes from going elsewhere.
      if (req.redirect_uri !== chromiumRedirectUri(req.client_id)) throw new HTTPException(400);
      const code = await issueAuthCode(db.db, {
        userId: session.user.id,
        clientId: req.client_id,
        redirectUri: req.redirect_uri,
        codeChallenge: req.code_challenge,
      });
      return c.json({ redirect: `${req.redirect_uri}?code=${code}&state=${encodeURIComponent(req.state)}` }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: TOKEN_PATH,
      request: { body: { content: json(TokenRequestSchema), required: true } },
      responses: {
        200: { description: 'Device tokens', content: json(TokenResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('The code or token was not accepted'),
        403: errorResponse('Not a listed extension'),
      },
    }),
    async (c) => {
      c.header('Cache-Control', 'no-store');
      const req = c.req.valid('json');
      if (!extensionIds.has(req.client_id)) return c.json(REFUSED, 403);
      if (req.grant_type === 'refresh_token') {
        const rid = c.get('rid');
        const rotation = await rotateRefreshToken({ db: db.db, auth }, req.refresh_token, req.client_id);
        if (!rotation.ok) {
          // A spent token came back: someone else holds a copy, and the device is now revoked. Logged every time, so a
          // copy tried again after the device was revoked or signed out leaves a trace too.
          const { reuse } = rotation;
          if (reuse) log.warn('auth.refresh_reuse', { rid, device_id: reuse.deviceId, already_revoked: reuse.alreadyRevoked });
          throw new AIError('auth-required', 'The refresh token was not accepted.');
        }
        log.info('auth.refreshed', { rid, device_id: rotation.tokens.device_id });
        return c.json(rotation.tokens, 200);
      }
      // Spent from here on, whatever the checks below find.
      const grant = await consumeAuthCode(db.db, req.code);
      if (
        !grant ||
        grant.clientId !== req.client_id ||
        grant.redirectUri !== req.redirect_uri ||
        !verifyPkce(req.code_verifier, grant.codeChallenge)
      ) {
        throw new AIError('auth-required', 'The code was not accepted.');
      }
      // A new device. Its id goes into the access token, which is signed before the device is stored.
      const device = { userId: grant.userId, deviceId: crypto.randomUUID(), clientId: grant.clientId };
      const tokens = await issueTokens({ db: db.db, auth }, device, { newDevice: true });
      log.info('auth.signed_in', { rid: c.get('rid'), device_id: device.deviceId });
      return c.json(tokens, 200);
    },
  );

  // Not in the spec, which names no sign-out: without it, "Sign out" in the extension would only forget the tokens and
  // leave the device signed in here. The one piece of device management (R11, CL3) that cannot wait: a device signs
  // itself out, and cannot list or revoke any other.
  app.openapi(
    createRoute({
      method: 'post',
      path: REVOKE_PATH,
      request: { body: { content: json(RevokeRequestSchema), required: true } },
      responses: {
        200: { description: 'Signed out, or there was nothing to sign out', content: json(RevokeResponseSchema) },
        400: errorResponse('The request was not valid'),
      },
    }),
    async (c) => {
      const req = c.req.valid('json');
      const deviceId = await revokeByRefreshToken(db.db, req.refresh_token, req.client_id);
      if (deviceId) log.info('auth.revoked', { rid: c.get('rid'), device_id: deviceId });
      return c.json({ ok: true as const }, 200);
    },
  );
}

/** Refuses a request whose `Origin` is not `origin`, such as another site or an extension. */
function ownPageOnly(origin: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header('origin') !== origin) return c.json(REFUSED, 403);
    await next();
  };
}
