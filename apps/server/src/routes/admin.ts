/**
 * The admin routes (R38). `GET /v1/admin/users` and `GET /v1/admin/overview` are what the admin page reads
 * (`admin/queries.ts`): they need a web session with the admin role, and log only the app's `http` line, since every
 * answer names accounts. `POST /v1/admin/setup` claims the one-time setup link (`admin/setup.ts`) for the person signed
 * in on the setup page: it needs a web session and the page's own `Origin`, not the admin role, since it makes the
 * first admin. Every refusal gets one answer, so the page cannot tell an unknown link from a spent, expired or
 * other-address one; the log names the reason with a fixed code. No line logs a token, its hash or an address.
 *
 * The five admin actions (CL4-06) change an account's daily post cap, access or role, and the invites: the page's own
 * `Origin` first (before the body is read), then a web session with the admin role. Each calls the function that
 * already does the work (`setDailyCap`, `removeAccess`/`restoreAccess`, the admin plugin's `setRole`, the invites). An
 * admin can change neither their own access nor their own role, so the last admin can never lock themself out. Their
 * log lines name the admin and the account by id, with the cap or the role; never an address.
 */
import { createRoute } from '@hono/zod-openapi';
import {
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_SETUP_PATH,
  ADMIN_USER_ACCESS_ROUTE,
  ADMIN_USER_CAP_ROUTE,
  ADMIN_USER_ROLE_ROUTE,
  ADMIN_USERS_PATH,
  AdminOkSchema,
  AdminOverviewSchema,
  AdminUserIdSchema,
  AdminUsersSchema,
  InviteRequestSchema,
  SetAccessRequestSchema,
  SetCapRequestSchema,
  SetRoleRequestSchema,
  SetupRequestSchema,
  type WireError,
} from '@unalgorithm/protocol';
import { z } from 'zod';
import { adminApiError, findAccount, removeAccess, requireAdmin, restoreAccess } from '../admin/access.ts';
import { addInvite, hasAccount, removeInvite } from '../admin/invites.ts';
import { adminOverview, listAdminUsers } from '../admin/queries.ts';
import { claimSetup, SETUP_REFUSED } from '../admin/setup.ts';
import { setDailyCap } from '../ai/limits.ts';
import { ownPageOnly, requireWebSession } from '../auth/web-session.ts';
import type { App, AppDeps } from '../http/app.ts';
import { errorResponse, json, NOT_FOUND } from './openapi.ts';

const OWN_ACCESS: WireError = { code: 'bad-request', message: "You can't change your own access." };
const OWN_ROLE: WireError = { code: 'bad-request', message: "You can't change your own role." };
const HAS_ACCOUNT: WireError = { code: 'bad-request', message: 'This address already has an account.' };

/** The `{userId}` of the per-account action routes. */
const UserParamsSchema = z.object({ userId: AdminUserIdSchema });

/** Mounts the admin routes on the app. */
export function adminRoutes(app: App, deps: AppDeps): void {
  const { config, db, log, auth } = deps;
  // A GET changes nothing, so it needs no `ownPageOnly`; `requireWebSession` sets `Cache-Control: no-store`.
  const webSession = requireWebSession(deps);
  const adminRole = requireAdmin(deps);
  const refusals = {
    401: errorResponse('No web session'),
    403: errorResponse("This account isn't an admin of this server"),
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_USERS_PATH,
      middleware: [webSession, adminRole] as const,
      responses: {
        200: { description: "The server's accounts with their caps and usage, and the invites", content: json(AdminUsersSchema) },
        ...refusals,
      },
    }),
    async (c) => c.json(await listAdminUsers(db.db, config), 200),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: ADMIN_OVERVIEW_PATH,
      middleware: [webSession, adminRole] as const,
      responses: {
        200: {
          description: "The server's usage of the last 30 days against its daily spend limit",
          content: json(AdminOverviewSchema),
        },
        ...refusals,
      },
    }),
    async (c) => c.json(await adminOverview(db.db, config), 200),
  );

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

  // The actions change state: the Origin check runs first, before the body is read, as the authorize route's does.
  const pageOnly = ownPageOnly(config.publicOrigin);
  const actionRefusals = {
    400: errorResponse('The request was not valid, or it would change your own access or role'),
    401: errorResponse('No web session'),
    403: errorResponse("Not from this server's own page, or this account isn't an admin of this server"),
  };
  const done = { description: 'Done', content: json(AdminOkSchema) };
  const ok = { ok: true as const };

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_USER_CAP_ROUTE,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { params: UserParamsSchema, body: { content: json(SetCapRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals, 404: errorResponse('No account has this id') },
    }),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { dailyPostCap } = c.req.valid('json');
      // Without the check, a cap for an unknown id would fail `user_limits`' foreign key (500), and `null` answer 200.
      if (!(await findAccount(db.db, userId))) return c.json(NOT_FOUND, 404);
      // From the account's next classify request on (`checkLimits` reads it per request); `null`: the server default.
      await setDailyCap(db.db, userId, dailyPostCap);
      log.info('admin.cap_set', { rid: c.get('rid'), admin_id: c.get('webUser').userId, user_id: userId, cap: dailyPostCap });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_USER_ACCESS_ROUTE,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { params: UserParamsSchema, body: { content: json(SetAccessRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals, 404: errorResponse('No account has this id') },
    }),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { access } = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      // The plugin's `banUser` refuses the caller's own id, but its `unbanUser` does not: refused here for both.
      if (userId === adminId) return c.json(OWN_ACCESS, 400);
      const accessDeps = { db: db.db, auth, log };
      try {
        if (access === 'removed') await removeAccess(accessDeps, c.req.raw.headers, adminId, userId);
        else await restoreAccess(accessDeps, c.req.raw.headers, adminId, userId);
      } catch (err) {
        const refusal = adminApiError(err);
        if (!refusal) throw err;
        return c.json(refusal.body, refusal.status);
      }
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_USER_ROLE_ROUTE,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { params: UserParamsSchema, body: { content: json(SetRoleRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals, 404: errorResponse('No account has this id') },
    }),
    async (c) => {
      const { userId } = c.req.valid('param');
      const { role } = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      // So the last admin can never demote themself.
      if (userId === adminId) return c.json(OWN_ROLE, 400);
      try {
        // The plugin checks `user:set-role` on the caller's own session, and that the account exists.
        await auth.api.setRole({ headers: c.req.raw.headers, body: { userId, role } });
      } catch (err) {
        const refusal = adminApiError(err);
        if (!refusal) throw err;
        return c.json(refusal.body, refusal.status);
      }
      log.info('admin.role_set', { rid: c.get('rid'), admin_id: adminId, user_id: userId, role });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_INVITES_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(InviteRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals },
    }),
    async (c) => {
      const { email } = c.req.valid('json');
      const adminId = c.get('webUser').userId;
      if (await hasAccount(db.db, email)) return c.json(HAS_ACCOUNT, 400);
      // Idempotent: inviting an address twice answers 200 both times.
      await addInvite(db.db, email, adminId);
      log.info('admin.invite_added', { rid: c.get('rid'), admin_id: adminId });
      return c.json(ok, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: ADMIN_INVITE_REMOVE_PATH,
      middleware: [pageOnly, webSession, adminRole] as const,
      request: { body: { content: json(InviteRequestSchema), required: true } },
      responses: { 200: done, ...actionRefusals },
    }),
    async (c) => {
      const { email } = c.req.valid('json');
      // Idempotent: 200 whether or not the address was invited.
      await removeInvite(db.db, email);
      log.info('admin.invite_removed', { rid: c.get('rid'), admin_id: c.get('webUser').userId });
      return c.json(ok, 200);
    },
  );
}
