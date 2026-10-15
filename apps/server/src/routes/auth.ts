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
  OkResponseSchema,
  REVOKE_PATH,
  RevokeRequestSchema,
  TOKEN_PATH,
  TokenRequestSchema,
  TokenResponseSchema,
} from '@unalgorithm/protocol';
import { HTTPException } from 'hono/http-exception';
import {
  consumeAuthCode,
  issueAuthCode,
  issueTokens,
  revokeByRefreshToken,
  rotateRefreshToken,
  verifyPkce,
} from '../auth/tokens.ts';
import { ownPageOnly, REFUSED, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json } from './openapi.ts';

/** Mounts the authorize, token and revoke routes on the app. */
export function authRoutes(app: App, deps: AppDeps): void {
  const { config, db, auth, log } = deps;
  const extensionIds = new Set(config.extensionIds);

  app.openapi(
    createRoute({
      method: 'post',
      path: AUTHORIZE_API_PATH,
      // Before the body is read: only the server's own sign-in page, with a web session, may ask for a code. So a request
      // without a session gets 401 even when its body is not valid.
      middleware: [ownPageOnly(config.publicOrigin), requireWebSession(deps)] as const,
      request: { body: { content: json(AuthorizeRequestSchema), required: true } },
      responses: {
        200: { description: 'Where the sign-in page sends the browser', content: json(AuthorizeResponseSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No web session'),
        403: errorResponse('Not from this server, or not a listed extension'),
      },
    }),
    async (c) => {
      // `requireWebSession` has set `Cache-Control: no-store`: the answer holds a code.
      const req = c.req.valid('json');
      if (!extensionIds.has(req.client_id)) return c.json(REFUSED, 403);
      // The schema holds the same rule; the server does not depend on it to keep codes from going elsewhere.
      if (req.redirect_uri !== chromiumRedirectUri(req.client_id)) throw new HTTPException(400);
      const code = await issueAuthCode(db.db, {
        userId: c.get('webUser').userId,
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
        // A replay is a refresh whose answer was lost, not a copy: logged apart, at info.
        log.info(rotation.replayed ? 'auth.refresh_replayed' : 'auth.refreshed', { rid, device_id: rotation.tokens.device_id });
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
      // A new device. Its id goes into the access token, which is signed before the device is stored. Its name is the
      // one the extension sent, trimmed and checked by the schema (an invalid one got 400 before the code was spent).
      // Never logged: it can hold a person's own label.
      const device = {
        userId: grant.userId,
        deviceId: crypto.randomUUID(),
        clientId: grant.clientId,
        name: req.device_name ?? null,
      };
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
        // The same answer whatever the token was (RFC 7009): it tells a caller nothing about the token.
        200: { description: 'Signed out, or there was nothing to sign out', content: json(OkResponseSchema) },
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
