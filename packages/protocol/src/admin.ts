import { z } from 'zod';

/**
 * Setup and admin contracts (R38) and the content-free server status the admin page shows (R43). Every string field
 * is an id, an address, a version, an ISO time or date, a fixed enum or a kind/key held to a regex: no field can carry
 * post text, a prompt or free text from a log. The admin pages are not advertised in discovery (ServerInfoSchema).
 */

/** Pages the server serves from apps/web (CL4-07, CL4-08). */
export const SETUP_PAGE_PATH = '/setup';
export const ADMIN_PAGE_PATH = '/admin';
/** The source control page (P3-74): admins edit the server's source list through `ADMIN_OUTLETS_PATH`'s routes. */
export const ADMIN_SOURCES_PAGE_PATH = '/admin/sources';
/** The Pricing page (PA-05, PA-06): admins edit the server's price book through `ADMIN_PRICES_PATH`'s routes. */
export const ADMIN_PRICES_PAGE_PATH = '/admin/prices';

/** Routes; all behind a web session (CL2-02). The setup route needs no admin; every other one needs the admin role. */
export const ADMIN_SETUP_PATH = '/v1/admin/setup';
export const ADMIN_OVERVIEW_PATH = '/v1/admin/overview';
export const ADMIN_USERS_PATH = '/v1/admin/users';
export const ADMIN_INVITES_PATH = '/v1/admin/invites';
export const ADMIN_INVITE_REMOVE_PATH = '/v1/admin/invites/remove';
/** OpenAPI-style templates for @hono/zod-openapi's createRoute (`{userId}`). */
export const ADMIN_USER_CAP_ROUTE = '/v1/admin/users/{userId}/cap';
export const ADMIN_USER_ACCESS_ROUTE = '/v1/admin/users/{userId}/access';
export const ADMIN_USER_ROLE_ROUTE = '/v1/admin/users/{userId}/role';

export const ADMIN_ROLES = ['admin', 'user'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const USER_ACCESS = ['active', 'removed'] as const;
export type UserAccess = (typeof USER_ACCESS)[number];
export const MAX_ADMIN_USERS = 1000;
export const MAX_INVITES = 1000;
export const USAGE_DAYS = 30;
/** The largest daily post cap the `user_limits.daily_post_cap` column (a Postgres integer) holds; as CL1-21's CLI. */
export const MAX_DAILY_POST_CAP = 2_147_483_647;
/** Why a backup run failed: fixed codes written by the backup scripts (CL4-10, CL4-22) or by the server's reader. */
export const BACKUP_ERRORS = ['no-key', 'dump', 'encrypt', 'write', 'copy', 'verify', 'unreadable'] as const;
export const ALERT_LEVELS = ['warning', 'critical'] as const;

/** Better Auth user ids: letters, digits, `_` and `-` only, so an id is safe in a path. */
export const AdminUserIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** A backup kind (`local`, `offsite`): it names a status file, a metric label and an alert key. */
export const BackupKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** An alert key (`disk-free-low`, `backup-local`); fixed identifiers made by the server. */
export const AlertKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);

/** `/v1/admin/users/{userId}/{action}`; a `TypeError` (which never repeats the value) when `userId` is not a user id. */
export function adminUserActionPath(userId: string, action: 'cap' | 'access' | 'role'): string {
  if (!AdminUserIdSchema.safeParse(userId).success) throw new TypeError('Not a user id.');
  return `/v1/admin/users/${userId}/${action}`;
}

const Count = z.number().int().min(0);
const Iso = z.iso.datetime();
const DailyPostCap = z.number().int().min(0).max(MAX_DAILY_POST_CAP);

export const AdminUserSchema = z.object({
  id: AdminUserIdSchema,
  email: z.string().min(3).max(254),
  role: z.enum(ADMIN_ROLES),
  access: z.enum(USER_ACCESS),
  createdAt: Iso,
  /** Newest `devices.last_used_at` of the account; null when no device has been used. */
  lastActiveAt: Iso.nullable(),
  activeDevices: Count,
  postsToday: Count,
  posts30Days: Count,
  costMicros30Days: Count,
  /** The account's own cap (`user_limits`); null: the server's USER_DAILY_POST_CAP applies. */
  dailyPostCap: DailyPostCap.nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const InviteSchema = z.object({ email: z.string().min(3).max(254), createdAt: Iso });
export type Invite = z.infer<typeof InviteSchema>;

export const AdminUsersSchema = z.object({
  users: z.array(AdminUserSchema).max(MAX_ADMIN_USERS),
  /** More accounts exist than were returned. */
  truncated: z.boolean(),
  invites: z.array(InviteSchema).max(MAX_INVITES),
  defaultDailyPostCap: Count,
});
export type AdminUsers = z.infer<typeof AdminUsersSchema>;

export const UsageDaySchema = z.object({ day: z.iso.date(), posts: Count, requests: Count, costMicros: Count });
export type UsageDay = z.infer<typeof UsageDaySchema>;

export const BackupStatusSchema = z.object({
  kind: BackupKindSchema,
  ok: z.boolean(),
  finishedAt: Iso.nullable(),
  lastSuccessAt: Iso.nullable(),
  bytes: Count.nullable(),
  error: z.enum(BACKUP_ERRORS).nullable(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const OpenAlertSchema = z.object({ key: AlertKeySchema, level: z.enum(ALERT_LEVELS), openedAt: Iso });
export type OpenAlert = z.infer<typeof OpenAlertSchema>;

export const OpsStatusSchema = z.object({
  diskFreeBytes: Count.nullable(),
  diskTotalBytes: Count.nullable(),
  databaseBytes: Count.nullable(),
  errors15m: Count,
  /** null: this server does not watch backups (BACKUP_STATUS_DIR unset). */
  backups: z.array(BackupStatusSchema).max(10).nullable(),
  openAlerts: z.array(OpenAlertSchema).max(50),
});
export type OpsStatus = z.infer<typeof OpsStatusSchema>;

export const AdminOverviewSchema = z.object({
  version: z.string().min(1).max(40),
  users: Count,
  today: UsageDaySchema,
  /** Oldest first, ending with today; days without usage are present with zeros. */
  last30Days: z.array(UsageDaySchema).max(USAGE_DAYS + 1),
  spendLimitMicros: Count,
  breakerTripped: z.boolean(),
  defaultDailyPostCap: Count,
  /** null until the server reports its status (CL4-14). */
  ops: OpsStatusSchema.nullable(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const SetCapRequestSchema = z.object({ dailyPostCap: DailyPostCap.nullable() });
export type SetCapRequest = z.infer<typeof SetCapRequestSchema>;
export const SetAccessRequestSchema = z.object({ access: z.enum(USER_ACCESS) });
export type SetAccessRequest = z.infer<typeof SetAccessRequestSchema>;
export const SetRoleRequestSchema = z.object({ role: z.enum(ADMIN_ROLES) });
export type SetRoleRequest = z.infer<typeof SetRoleRequestSchema>;
/** `z.email()` refuses `@localhost` addresses: invites are for real mailboxes. */
export const InviteRequestSchema = z.object({ email: z.email().max(254) });
export type InviteRequest = z.infer<typeof InviteRequestSchema>;
/** The setup link's secret: 32 random bytes, base64url (CL1-09's `newSecret`). */
export const SetupRequestSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export type SetupRequest = z.infer<typeof SetupRequestSchema>;
export const AdminOkSchema = z.object({ ok: z.literal(true) });
export type AdminOk = z.infer<typeof AdminOkSchema>;
