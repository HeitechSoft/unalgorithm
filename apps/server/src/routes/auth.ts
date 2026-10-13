/**
 * The extension's sign-in (R10). `launchWebAuthFlow` opens the server's sign-in page with a PKCE challenge; once the
 * person is signed in there, the page asks `POST /v1/auth/authorize` for a single-use code bound to the extension, its
 * redirect address and the challenge, and sends the browser back to the extension with it. The extension trades the
 * code and its verifier at `POST /v1/auth/token` for device tokens.
 *
 * Neither route logs or stores a code, a verifier or a token in plain form. Every refused exchange gets the same
 * answer, so a caller cannot tell an unknown code from a spent one or a wrong verifier.
 */
import { createRoute } from '@hono/zod-openapi';
import { AIError } from '@unalgorithm/ai';
import {
  AUTHORIZE_API_PATH,
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  chromiumRedirectUri,
  ServerErrorSchema,
  TOKEN_PATH,
  TokenRequestSchema,
  TokenResponseSchema,
  type WireError,
} from '@unalgorithm/protocol';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { consumeAuthCode, issueAuthCode, issueTokens, verifyPkce } from '../auth/tokens.ts';
import type { App, AppDeps } from '../http/app.ts';

const REFUSED: WireError = { code: 'permission', message: "This server doesn't accept sign-ins from here." };

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const errorResponse = (description: string) => ({ description, content: json(ServerErrorSchema) });

/** Mounts the authorize and token routes on the app. */
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
      // The refresh grant arrives with CL1-10.
      if (req.grant_type !== 'authorization_code') throw new HTTPException(400);
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
}

/** Refuses a request whose `Origin` is not `origin`, such as another site or an extension. */
function ownPageOnly(origin: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header('origin') !== origin) return c.json(REFUSED, 403);
    await next();
  };
}
