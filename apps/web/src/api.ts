/**
 * The page's calls to its own server: the discovery document, Better Auth's sign-in (an emailed code, Google or a
 * passkey), the authorize endpoint that hands the extension a single-use code, the account's credits where the server
 * bills, the account's devices and passkeys, the setup link's claim that makes the first admin, and the admin page's
 * accounts and the changes an admin makes to one, its invites and the server's usage overview; the source control
 * page's list with who made each change, an admin's change to one outlet and the import of the candidate list; the
 * Pricing page's price book with its history and an admin's change to it; the problem reports page's summary, lists,
 * single reports and the four changes an admin makes to them (ADR 0009 §7); and the public source list with its
 * history, which need no session. All same-origin, so the browser sends the session cookie
 * and the `Origin` header the server checks. Every failure is an `ApiError` carrying the HTTP status (0: no answer at
 * all) and the error body's `code` and `message` when it has them, except the browser's passkey prompt: a cancelled one
 * is `PasskeyCancelled`, and its other errors keep their name.
 */
import {
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_EXPORT_PATH,
  type AccountDevice,
  AccountDevicesResponseSchema,
  AccountExportSchema,
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_PRICES_PATH,
  ADMIN_REPORTS_DELETE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_FORGET_CONTACT_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  ADMIN_SETUP_PATH,
  ADMIN_USERS_PATH,
  AdminOkSchema,
  type AdminOutlets,
  AdminOutletsSchema,
  type AdminOverview,
  AdminOverviewSchema,
  type AdminPrices,
  AdminPricesSchema,
  AdminReportDetailSchema,
  type AdminReportList,
  AdminReportListSchema,
  type AdminReportsListQuery,
  type AdminReportsSummary,
  AdminReportsSummarySchema,
  type AdminRole,
  type AdminUsers,
  AdminUsersSchema,
  AUTHORIZE_API_PATH,
  type AuthorizeRequest,
  AuthorizeResponseSchema,
  adminReportPath,
  adminUserActionPath,
  CREDIT_ACCOUNT_PATH,
  type CreditAccount,
  CreditAccountSchema,
  type DeleteReportsRequest,
  type ForgetContactRequest,
  type HandleReportsRequest,
  type InviteRequest,
  type OfficialList,
  OfficialListSchema,
  OkResponseSchema,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  type OutletChanged,
  OutletChangedSchema,
  type OutletChangeRequest,
  type OutletChanges,
  OutletChangesSchema,
  PRICES_JSON_PATH,
  type PriceChanged,
  PriceChangedSchema,
  type PriceChangeRequest,
  type PublishedPrices,
  PublishedPricesSchema,
  priceBookIssues,
  SERVER_INFO_PATH,
  type ServerInfo,
  ServerInfoSchema,
  type SetAccessRequest,
  type SetCapRequest,
  type SetFloorRequest,
  type SetRoleRequest,
  type SetupRequest,
  type UserAccess,
} from '@unalgorithm/protocol';
import { z } from 'zod';

/** The Better Auth routes the server mounts for this page (CL1-08). */
export const SEND_CODE_PATH = '/api/auth/email-otp/send-verification-otp';
export const SIGN_IN_PATH = '/api/auth/sign-in/email-otp';
export const SESSION_PATH = '/api/auth/get-session';
export const SIGN_OUT_PATH = '/api/auth/sign-out';
/** Google sign-in, on a server with a Google client (CL3-13), and passkey sign-in, on every server (CL3-14). */
export const SOCIAL_SIGN_IN_PATH = '/api/auth/sign-in/social';
export const PASSKEY_AUTH_OPTIONS_PATH = '/api/auth/passkey/generate-authenticate-options';
export const PASSKEY_AUTH_VERIFY_PATH = '/api/auth/passkey/verify-authentication';
/** The account page's passkeys (CL3-14): adding one (options, then verify), listing them and removing one. */
export const PASSKEY_REGISTER_OPTIONS_PATH = '/api/auth/passkey/generate-register-options';
export const PASSKEY_REGISTER_VERIFY_PATH = '/api/auth/passkey/verify-registration';
export const PASSKEY_LIST_PATH = '/api/auth/passkey/list-user-passkeys';
export const PASSKEY_DELETE_PATH = '/api/auth/passkey/delete-passkey';

/**
 * `get-session` answers `null` without a session; the pages need the address, and the admin plugin's `role` (absent or
 * null for an account it never gave one).
 */
const SessionSchema = z.object({ user: z.object({ email: z.string(), role: z.string().nullish() }) }).nullable();

/**
 * `sign-in/social` with `disableRedirect` answers where to send the browser instead of redirecting it. Only Google's own
 * sign-in page is followed: an answer naming any other address is a failure, never a navigation.
 */
const GoogleRedirectSchema = z.object({ url: z.url({ protocol: /^https$/, hostname: /^accounts\.google\.com$/ }) });

/** The authentication options `startAuthentication` takes; the library reads them as WebAuthn defines them. */
const PasskeyOptionsSchema = z.custom<PublicKeyCredentialRequestOptionsJSON>(
  (value) => z.looseObject({ challenge: z.string().min(1) }).safeParse(value).success,
);

/** The registration options `startRegistration` takes, read the same way. */
const PasskeyRegistrationOptionsSchema = z.custom<PublicKeyCredentialCreationOptionsJSON>(
  (value) =>
    z.looseObject({ challenge: z.string().min(1), user: z.looseObject({ id: z.string().min(1) }) }).safeParse(value).success,
);

/**
 * One of the account's passkeys. `list-user-passkeys` answers whole rows; only what the page shows is kept, never the
 * public key or the credential id. Better Auth leaves out a name it was never given.
 */
const PasskeySchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .nullish()
    .transform((name) => name ?? null),
  createdAt: z.iso
    .datetime()
    .nullish()
    .transform((at) => at ?? null),
});
export type Passkey = z.output<typeof PasskeySchema>;

export class ApiError extends Error {
  /** The HTTP status (a 2xx one when the answer could not be used), or 0 when the server could not be reached. */
  readonly status: number;
  /** The error body's `code`: Better Auth's (such as `BANNED_USER`) or the server's own `AIErrorCode`. */
  readonly code?: string;
  /**
   * The error body's `message`, for a page that shows the server's own words: the source list's admin routes name the
   * rule a change would break and the outlet. `message` stays the status line.
   */
  readonly serverMessage?: string;

  constructor(status: number, code?: string, serverMessage?: string) {
    super(status ? `The server answered ${status}.` : 'The server could not be reached.');
    this.name = 'ApiError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
  }
}

/** A string field of an error body, if it has one. */
function bodyText(failure: unknown, name: 'code' | 'message'): string | undefined {
  const value = typeof failure === 'object' && failure !== null ? (failure as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value : undefined;
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
  if (!res.ok) {
    const failure: unknown = await res.json().catch(() => undefined);
    throw new ApiError(res.status, bodyText(failure, 'code'), bodyText(failure, 'message'));
  }
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status);
  return parsed.data;
}

/** This server's discovery document: its name and the link to its source. */
export async function serverInfo(): Promise<ServerInfo> {
  return request(SERVER_INFO_PATH, ServerInfoSchema);
}

/** This server's source list as published (P3-67): public, the same for everyone, signed in or not. */
export async function publicSourceList(): Promise<OfficialList> {
  return request(OUTLETS_JSON_PATH, OfficialListSchema);
}

/** The source list's latest changes, newest first, without who made them. */
export async function publicChanges(): Promise<OutletChanges> {
  return request(OUTLET_CHANGES_JSON_PATH, OutletChangesSchema);
}

/** Who is signed in on this page, if anyone, and their role (`admin` for an admin of this server). */
export async function getSession(): Promise<{ email: string; role: string | null } | null> {
  const session = await request(SESSION_PATH, SessionSchema);
  return session ? { email: session.user.email, role: session.user.role ?? null } : null;
}

/** Emails a sign-in code. The server answers the same whether or not the address may sign in. */
export async function sendCode(email: string): Promise<void> {
  await request(SEND_CODE_PATH, z.unknown(), { email, type: 'sign-in' });
}

/** Signs in with the emailed code; the server sets the session cookie. */
export async function verifyCode(email: string, otp: string): Promise<void> {
  await request(SIGN_IN_PATH, z.unknown(), { email, otp });
}

/**
 * Where to send the browser for Google; only an https://accounts.google.com/ address is accepted. Google sends the
 * browser back to `returnTo` (a path on this server) either way: signed in, or with `?error=` when it didn't work.
 */
export async function googleSignInUrl(returnTo: string): Promise<string> {
  const body = { provider: 'google', callbackURL: returnTo, errorCallbackURL: returnTo, disableRedirect: true };
  return (await request(SOCIAL_SIGN_IN_PATH, GoogleRedirectSchema, body)).url;
}

/** The person closed the browser's passkey prompt, or it timed out: the server was told nothing. */
export class PasskeyCancelled extends Error {
  constructor() {
    super('The passkey prompt was cancelled.');
    this.name = 'PasskeyCancelled';
  }
}

/**
 * Runs the browser's passkey prompt. A cancelled prompt is told apart by the error's name, never its class: the library
 * rethrows the browser's `DOMException` as its own `WebAuthnError`, an `Error` that keeps the name.
 */
async function passkeyPrompt<T>(prompt: () => Promise<T>): Promise<T> {
  try {
    return await prompt();
  } catch (err) {
    if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
      throw new PasskeyCancelled();
    }
    throw err;
  }
}

/**
 * Signs in with a passkey: the server's challenge, the browser's passkey prompt, then the signed answer back to the
 * server, which sets the session cookie.
 */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await request(PASSKEY_AUTH_OPTIONS_PATH, PasskeyOptionsSchema);
  const response: AuthenticationResponseJSON = await passkeyPrompt(() => startAuthentication({ optionsJSON }));
  await request(PASSKEY_AUTH_VERIFY_PATH, z.unknown(), { response });
}

export async function signOut(): Promise<void> {
  await request(SIGN_OUT_PATH, z.unknown(), {});
}

/** Asks for the extension's single-use code; returns where to send the browser (the extension's redirect address). */
export async function authorize(req: AuthorizeRequest): Promise<string> {
  return (await request(AUTHORIZE_API_PATH, AuthorizeResponseSchema, req)).redirect;
}

/** The signed-in person's balance and credit history; only a server that advertises billing answers it. */
export async function creditAccount(): Promise<CreditAccount> {
  return request(CREDIT_ACCOUNT_PATH, CreditAccountSchema);
}

/** A published book the page can price with: one the server could have saved (`priceBookIssues`). */
const SoundPricesSchema = PublishedPricesSchema.refine((prices) => priceBookIssues(prices).length === 0);

/**
 * This server's prices as published (PA-04): public, the same for everyone. Only a server that advertises billing
 * publishes them. A book that isn't sound is an answer that can't be used.
 */
export async function publicPrices(): Promise<PublishedPrices> {
  return request(PRICES_JSON_PATH, SoundPricesSchema);
}

/** The devices signed in to the account now, most recently used first. */
export async function listDevices(): Promise<AccountDevice[]> {
  return (await request(ACCOUNT_DEVICES_PATH, AccountDevicesResponseSchema)).devices;
}

/** Signs one of the account's devices out: it has to sign in again to use this server. */
export async function revokeDevice(id: string): Promise<void> {
  await request(ACCOUNT_DEVICE_REVOKE_PATH, OkResponseSchema, { device_id: id });
}

/** The account's passkeys, in the server's order. */
export async function listPasskeys(): Promise<Passkey[]> {
  return request(PASSKEY_LIST_PATH, z.array(PasskeySchema));
}

/**
 * Adds a passkey: the server's options, the browser's passkey prompt, then the authenticator's answer back. No name is
 * sent: the server labels the passkey from the authenticator's model (CL3-14).
 */
export async function addPasskey(): Promise<void> {
  const optionsJSON = await request(PASSKEY_REGISTER_OPTIONS_PATH, PasskeyRegistrationOptionsSchema);
  const response = await passkeyPrompt(() => startRegistration({ optionsJSON }));
  await request(PASSKEY_REGISTER_VERIFY_PATH, z.unknown(), { response });
}

/** Removes one of the account's passkeys; signing in with an emailed code still works. */
export async function removePasskey(id: string): Promise<void> {
  await request(PASSKEY_DELETE_PATH, z.unknown(), { id });
}

/**
 * Everything the server holds about the account, as the JSON file the person downloads. The answer is checked with
 * `AccountExportSchema` first, which also drops any field the contract does not list: a bad answer is an `ApiError`,
 * never a download.
 */
export async function exportAccount(): Promise<Blob> {
  const data = await request(ACCOUNT_EXPORT_PATH, AccountExportSchema);
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

/**
 * Deletes the account and everything stored about it, which signs out every device. `confirm` is the address as the
 * person typed it; the server compares it ignoring case and surrounding spaces, and answers 401 when the session is
 * older than 10 minutes and 400 when the address does not match.
 */
export async function deleteAccount(confirm: string): Promise<void> {
  await request(ACCOUNT_DELETE_PATH, OkResponseSchema, { confirm });
}

/**
 * Claims the setup link for the signed-in account, which makes it this server's first admin (CL4-04). The server answers
 * 401 without a session and 403 for a token that doesn't work: unknown, expired, used, or made for another address.
 */
export async function claimSetup(token: string): Promise<void> {
  const body: SetupRequest = { token };
  await request(ADMIN_SETUP_PATH, AdminOkSchema, body);
}

/** The server's accounts with their numbers, its invites and its default cap; 401 without a session, 403 for a non-admin. */
export async function adminUsers(): Promise<AdminUsers> {
  return request(ADMIN_USERS_PATH, AdminUsersSchema);
}

/** Sets the account's own daily post cap; `null` lets the server's cap apply. */
export async function setUserCap(id: string, cap: number | null): Promise<void> {
  const body: SetCapRequest = { dailyPostCap: cap };
  await request(adminUserActionPath(id, 'cap'), AdminOkSchema, body);
}

/** Removes the account's access (it is signed out everywhere) or restores it; 400 for the admin's own account. */
export async function setUserAccess(id: string, access: UserAccess): Promise<void> {
  const body: SetAccessRequest = { access };
  await request(adminUserActionPath(id, 'access'), AdminOkSchema, body);
}

/** Makes the account an admin or a regular user; 400 for the admin's own account. */
export async function setUserRole(id: string, role: AdminRole): Promise<void> {
  const body: SetRoleRequest = { role };
  await request(adminUserActionPath(id, 'role'), AdminOkSchema, body);
}

/**
 * Today's usage and the last 30 days against the daily spend limit, and the server's content-free status (null until it
 * reports one); 401 without a session, 403 for a non-admin.
 */
export async function adminOverview(): Promise<AdminOverview> {
  return request(ADMIN_OVERVIEW_PATH, AdminOverviewSchema);
}

/**
 * Lets the address create an account; no email is sent. Inviting it twice is fine; 400 when the address already has an
 * account. The server keeps the address trimmed and in lower case.
 */
export async function addInvite(email: string): Promise<void> {
  const body: InviteRequest = { email };
  await request(ADMIN_INVITES_PATH, AdminOkSchema, body);
}

/** Withdraws the address's invite, whether or not it had one; an account it already made stays. */
export async function removeInvite(email: string): Promise<void> {
  const body: InviteRequest = { email };
  await request(ADMIN_INVITE_REMOVE_PATH, AdminOkSchema, body);
}

/**
 * The source list as published and its latest changes, newest first, each with the address of the admin who made it
 * (null once that account is deleted); 401 without a session, 403 for a non-admin.
 */
export async function adminOutlets(): Promise<AdminOutlets> {
  return request(ADMIN_OUTLETS_PATH, AdminOutletsSchema);
}

/**
 * Adds, edits or removes one outlet, published at once; answers the list's version now. 400 with the server's message
 * for a change that breaks a rule of the list, 404 for an outlet no longer listed, 409 when the list changed since
 * `baseVersion`.
 */
export async function changeOutlet(req: OutletChangeRequest): Promise<OutletChanged> {
  return request(ADMIN_OUTLETS_PATH, OutletChangedSchema, req);
}

/** Imports the candidate list, with no lean, into an empty list; 400 when the list isn't empty. */
export async function importCandidates(): Promise<OutletChanged> {
  return request(ADMIN_OUTLETS_IMPORT_PATH, OutletChangedSchema, {});
}

/**
 * The server's price book as published, its latest changes (newest first, each with the admin's address), the server's
 * clock and whether it charges (PA-03); 401 without a session, 403 for a non-admin.
 */
export async function adminPrices(): Promise<AdminPrices> {
  return request(ADMIN_PRICES_PATH, AdminPricesSchema);
}

/**
 * Schedules, cancels or moves one task's price change (or changes another part of the book); answers the book's
 * version now. 400 with the server's message for a change that breaks a price rule, 404 for a scheduled change that is
 * no longer there, 409 when the book changed since `baseVersion`.
 */
export async function changePrices(req: PriceChangeRequest): Promise<PriceChanged> {
  return request(ADMIN_PRICES_PATH, PriceChangedSchema, req);
}

/**
 * The problem reports summary (ADR 0009 §7): today's count against the daily limit, unlisted reports of the last 7
 * days, `days` days of daily counts, the groups (open first) and the "Fixed in" floors. Development builds count only
 * with `dev`. 401 without a session, 403 for a non-admin.
 */
export async function adminReportsSummary(opts: { days: number; dev: boolean }): Promise<AdminReportsSummary> {
  const query = new URLSearchParams({ days: String(opts.days), dev: opts.dev ? '1' : '0' });
  return request(`${ADMIN_REPORTS_SUMMARY_PATH}?${query}`, AdminReportsSummarySchema);
}

/**
 * A page of reports, newest first: a group's, by status, from `before` (the previous page's `nextBefore`, passed back
 * as it came: the server reads it as a cursor, not a time). A `ref` finds one report whatever its group or status.
 */
export async function adminReports(query: Partial<AdminReportsListQuery>): Promise<AdminReportList> {
  const params = new URLSearchParams();
  for (const name of ['group', 'status', 'before', 'ref'] as const) {
    const value = query[name];
    if (value !== undefined) params.set(name, value);
  }
  return request(`${ADMIN_REPORTS_PATH}?${params}`, AdminReportListSchema);
}

/**
 * One report as the detail view reads it. The reply address is taken as any short text: the page makes a `mailto:`
 * link only from one that is an email address, so an answer holding something else still opens, with it as plain text.
 */
const ReportDetailSchema = AdminReportDetailSchema.extend({ contact: z.string().max(254).nullable() });
export type ReportDetail = z.output<typeof ReportDetailSchema>;

/** One report in full, with `describeReport`'s lines; 404 when no report has this id (deleted, or purged). */
export async function adminReport(id: string): Promise<ReportDetail> {
  return request(adminReportPath(id), ReportDetailSchema);
}

/**
 * Marks reports handled with a resolution, or reopens them: by id, or a whole group (the rows received by then).
 * Marking changes only open reports and reopening only handled ones.
 */
export async function handleReports(req: HandleReportsRequest): Promise<void> {
  await request(ADMIN_REPORTS_HANDLE_PATH, AdminOkSchema, req);
}

/**
 * Sets a platform's "Fixed in" detection version, which marks its open reports from older versions handled
 * (`older-version`); `adapter: null` clears it.
 */
export async function setReportFloor(req: SetFloorRequest): Promise<void> {
  await request(ADMIN_REPORTS_FLOOR_PATH, AdminOkSchema, req);
}

/** Clears a report's reply address now; 404 when no report has this id. */
export async function forgetReportContact(id: string): Promise<void> {
  const body: ForgetContactRequest = { id };
  await request(ADMIN_REPORTS_FORGET_CONTACT_PATH, AdminOkSchema, body);
}

/** Deletes reports for good: a privacy request, or a message holding personal data. */
export async function deleteReports(ids: string[]): Promise<void> {
  const body: DeleteReportsRequest = { ids };
  await request(ADMIN_REPORTS_DELETE_PATH, AdminOkSchema, body);
}
