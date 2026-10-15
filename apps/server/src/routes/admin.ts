/**
 * The admin routes (R38). `POST /v1/admin/setup` claims the one-time setup link (`admin/setup.ts`) for the person signed
 * in on the setup page: it needs a web session and the page's own `Origin`, not the admin role, since it makes the
 * first admin. Every refusal gets one answer, so the page cannot tell an unknown link from a spent, expired or
 * other-address one; the log names the reason with a fixed code. No line logs a token, its hash or an address.
 */
import { createRoute } from '@hono/zod-openapi';
import { ADMIN_SETUP_PATH, AdminOkSchema, SetupRequestSchema } from '@unalgorithm/protocol';
import { claimSetup, SETUP_REFUSED } from '../admin/setup.ts';
import { ownPageOnly, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json } from './openapi.ts';

/** Mounts the setup route on the app. */
export function adminRoutes(app: App, deps: AppDeps): void {
  const { config, db, log } = deps;

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_SETUP_PATH,
      // Before the body is read: a request without the page's Origin or a session never reaches the claim.
      middleware: [ownPageOnly(config.publicOrigin), requireWebSession(deps)] as const,
      request: { body: { content: json(SetupRequestSchema), required: true } },
      responses: {
        200: { description: "The signed-in account is now this server's admin", content: json(AdminOkSchema) },
        400: errorResponse('The request was not valid'),
        401: errorResponse('No web session'),
        403: errorResponse("Not from this server's own page, or the setup link doesn't work"),
      },
    }),
    async (c) => {
      const { token } = c.req.valid('json');
      const who = c.get('webUser');
      const result = await claimSetup(db.db, who, token);
      if (!result.ok) {
        log.warn('setup.refused', { rid: c.get('rid'), reason: result.reason });
        return c.json(SETUP_REFUSED, 403);
      }
      log.info('admin.setup_claimed', { rid: c.get('rid'), user_id: who.userId, recover: result.recover });
      return c.json({ ok: true as const }, 200);
    },
  );
}
