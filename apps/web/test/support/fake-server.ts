/**
 * A fake server for the web app's tests: `fetch` stubbed with the server's routes, keeping a session as the real one
 * does (an accepted code or passkey starts it and signing out ends it), and every request recorded. Also the query the
 * extension opens the authorize page with, and what Google and a passkey sign-in answer. The account's devices and
 * passkeys are kept too: revoking or removing one takes it off its list and adding a passkey puts one on. The account
 * exports as `EXPORT`, and deleting it (with the address typed again) ends the session. The setup link's `SETUP_TOKEN`
 * can be claimed once, as CL4-04's can. Without a session those routes answer 401, as the real ones do.
 *
 * The session's `role` is the admin plugin's: the admin routes answer 403 unless it is `admin`. The accounts the admin
 * page lists (`adminUsers`) are kept too: setting one's cap, access or role changes the next list, as CL4-06's routes
 * do, and changing the signed-in admin's own access or role answers 400. Inviting an address (CL4-06) adds it, as the
 * server keeps it (trimmed, lower case), to the next list's invites at `INVITED_AT`, or answers 400 when an account has
 * it; removing one takes it off. The overview (`adminOverview`) is answered as given.
 *
 * The public source list (`sourceList`) and its history (`outletChanges`) are answered as given, with or without a
 * session, as P3-67's routes are: by default an empty list that was never changed.
 *
 * The source control page's routes (P3-73) keep their own copy of that list and history, for an admin only: a change
 * is checked as the server checks it (the version the page showed, an id already listed or gone, the list rules) and,
 * when it is accepted, changes the next list and adds a history line by the signed-in address at `OUTLET_CHANGED_AT`;
 * the import adds `CANDIDATES` to an empty list. The public routes keep answering as given.
 *
 * The Pricing page's routes (PA-03) keep a price book (`DEFAULT_PRICE_BOOK` unless a test passes its own), its version
 * and its history, for an admin only, and answer with the server's clock at `PRICES_NOW` and `billing` as the discovery
 * document says. A change is checked as the server checks it, with the same functions: the version the page showed
 * (409), PA-01's edits (404 for a cancel or a move of a change that isn't scheduled) and PA-02's
 * `priceBookChangeIssues` at `PRICES_NOW` (400 with `priceIssuesText`). An accepted change replaces the book and adds a
 * history line by the signed-in address, after a `seed` line the first time, as the server's `price_changes` does.
 */
import { priceIssuesText } from '@unalgorithm/core';
import { type CandidateOutlet, listProblems, listProblemText } from '@unalgorithm/outlets';
import {
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DEVICE_REVOKE_PATH,
  ACCOUNT_DEVICES_PATH,
  ACCOUNT_EXPORT_PATH,
  type AccountDevice,
  type AccountExport,
  ADMIN_INVITE_REMOVE_PATH,
  ADMIN_INVITES_PATH,
  ADMIN_OUTLETS_IMPORT_PATH,
  ADMIN_OUTLETS_PATH,
  ADMIN_OVERVIEW_PATH,
  ADMIN_PRICES_PATH,
  ADMIN_SETUP_PATH,
  ADMIN_USERS_PATH,
  type AdminOutletChange,
  type AdminOverview,
  type AdminUsers,
  AUTHORIZE_API_PATH,
  adminUserActionPath,
  cancelTaskChange,
  chromiumRedirectUri,
  DEFAULT_PRICE_BOOK,
  moveTaskChange,
  type OfficialList,
  type OfficialOutlet,
  OUTLET_CHANGES_JSON_PATH,
  OUTLETS_JSON_PATH,
  type OutletChangeAction,
  OutletChangeRequestSchema,
  type OutletChanges,
  type PriceBook,
  type PriceChange,
  type PriceChangeRequest,
  PriceChangeRequestSchema,
  type PriceChangeValue,
  priceBookChangeIssues,
  SERVER_INFO_PATH,
  type ServerInfo,
  scheduledTaskChanges,
  starterCreditAt,
  taskPriceAt,
  withStarterCredit,
  withTaskCard,
} from '@unalgorithm/protocol';
import { vi } from 'vitest';
import {
  PASSKEY_AUTH_OPTIONS_PATH,
  PASSKEY_AUTH_VERIFY_PATH,
  PASSKEY_DELETE_PATH,
  PASSKEY_LIST_PATH,
  PASSKEY_REGISTER_OPTIONS_PATH,
  PASSKEY_REGISTER_VERIFY_PATH,
  SEND_CODE_PATH,
  SESSION_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  SOCIAL_SIGN_IN_PATH,
} from '../../src/api.ts';

export const TOM = 'tom@example.com';
export const SIGNED_IN = `Signed in as ${TOM}`;

export const EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
/** The query `launchWebAuthFlow` opens the authorize page with. */
export const PARAMS = {
  client_id: EXTENSION_ID,
  redirect_uri: chromiumRedirectUri(EXTENSION_ID),
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  state: 'Qm9vdHN0cmFwLXN0YXRlLTE',
};
/** Where the authorize endpoint sends the browser: back to the extension with its single-use code. */
export const REDIRECT = `${PARAMS.redirect_uri}?code=${'c'.repeat(43)}&state=${PARAMS.state}`;

/** Google's address `sign-in/social` answers, where the page sends the browser. */
export const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client&state=test-state';
/** The authentication options Better Auth's passkey plugin answers, as `startAuthentication` receives them. */
export const PASSKEY_OPTIONS = {
  challenge: 'cGFzc2tleS1jaGFsbGVuZ2U',
  timeout: 300000,
  rpId: 'localhost',
  userVerification: 'preferred',
};

/** The registration options Better Auth's passkey plugin answers, as `startRegistration` receives them. */
export const REGISTER_OPTIONS = {
  challenge: 'cmVnaXN0ZXItY2hhbGxlbmdl',
  rp: { name: 'Example AI', id: 'localhost' },
  user: { id: 'dTE', name: TOM, displayName: TOM },
  pubKeyCredParams: [
    { alg: -8, type: 'public-key' },
    { alg: -7, type: 'public-key' },
  ],
  timeout: 300000,
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  attestation: 'none',
};

/** A passkey as `list-user-passkeys` answers it: the whole row, of which the page shows the id, name and date. */
export interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | null;
  userId: string;
  publicKey: string;
  credentialID: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string;
  aaguid: string | null;
}

/** A passkey of the signed-in account. */
export function passkeyRow(id: string, name: string | null, createdAt: string | null): PasskeyRow {
  return {
    id,
    name,
    createdAt,
    userId: 'u1',
    publicKey: 'cHVibGljLWtleQ',
    credentialID: `Y3JlZGVudGlhbC0${id}`,
    counter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
    transports: 'internal,hybrid',
    aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
  };
}

/** The passkey `verify-registration` stores: the server labels it from the authenticator's model (CL3-14). */
export const ADDED_PASSKEY = passkeyRow('pk-added', 'Google Password Manager', '2026-10-14T12:00:00.000Z');

/** What the account routes answer without a session. */
export const SESSION_GONE = { status: 401, body: { code: 'auth-required', message: 'Sign in again.' } };

/** What the admin routes answer for an account that isn't an admin (CL4-05's `NOT_ADMIN`). */
export const NOT_ADMIN = { status: 403, body: { code: 'permission', message: "This account isn't an admin of this server." } };
/** What CL4-06's routes answer for a change to the signed-in admin's own access or role. */
export const OWN_ACCOUNT = { status: 400, body: { code: 'bad-request', message: "You can't change your own account here." } };
/** No accounts listed: the admin page's routes answer this unless a test passes its own. */
export const NO_ADMIN_USERS: AdminUsers = { users: [], truncated: false, invites: [], defaultDailyPostCap: 1000 };

/** When the fake server's invite routes invite an address. */
export const INVITED_AT = '2026-10-15T12:00:00.000Z';
/** What `POST /v1/admin/invites` answers for an address that already has an account (CL4-06). */
export const HAS_ACCOUNT = { status: 400, body: { code: 'bad-request', message: 'This address already has an account.' } };

/** A usage day with no usage. */
function quietDay(day: string) {
  return { day, posts: 0, requests: 0, costMicros: 0 };
}
/** The overview the admin page's usage section shows unless a test passes its own: a quiet day, no status yet. */
export const OVERVIEW: AdminOverview = {
  version: '0.1.0',
  users: 0,
  today: quietDay('2026-10-15'),
  last30Days: [quietDay('2026-10-14'), quietDay('2026-10-15')],
  spendLimitMicros: 5_000_000,
  breakerTripped: false,
  defaultDailyPostCap: 1000,
  ops: null,
};

/** A setup link's token (CL4-04): 43 URL-safe base64 characters, from the fragment of `/setup#<token>`. */
export const SETUP_TOKEN = 'c2V0dXAtbGluay10b2tlbi1mb3ItdGhlLWZpcnN0LWE';
/** What `POST /v1/admin/setup` answers for a token that doesn't work: unknown, expired, used, or another address's. */
export const SETUP_REFUSED = {
  status: 403,
  body: { code: 'permission', message: "This setup link doesn't work. Ask for a new one." },
};

/** A server whose source list was never changed (P3-67): what the public routes answer unless a test passes its own. */
export const EMPTY_SOURCE_LIST: OfficialList = { v: 1, version: '0', updatedAt: null, license: 'CC-BY-4.0', outlets: [] };
export const NO_OUTLET_CHANGES: OutletChanges = { v: 1, changes: [] };

/** When the fake server's source control routes make a change. */
export const OUTLET_CHANGED_AT = '2026-10-16T12:00:00.000Z';
/** The candidate list the fake server's import adds: fictional `.example` outlets, never a lean (as the real one). */
export const CANDIDATES: readonly CandidateOutlet[] = [
  { id: 'fx-candidate-b', name: 'Fixture Candidate B', domains: ['candidate-b.example'], country: 'CA', lean: null },
  {
    id: 'fx-candidate-a',
    name: 'Fixture Candidate A',
    domains: ['candidate-a.example', 'candidate-a-news.example'],
    country: 'US',
    lean: null,
  },
];
/** What P3-73's routes answer for a change made on a list that changed since the page showed it. */
export const LIST_CHANGED = {
  status: 409,
  body: { code: 'bad-request', message: 'The list changed since you opened it. Reload it and try again.' },
};
/** What they answer for an edit or a removal of an id the list doesn't have. */
export const OUTLET_GONE = { status: 404, body: { code: 'not-found', message: 'Not found.' } };
const ID_TAKEN = { status: 400, body: { code: 'bad-request', message: 'An outlet with this id already exists.' } };
const LIST_NOT_EMPTY = { status: 400, body: { code: 'bad-request', message: "The source list isn't empty." } };
const NOT_VALID = { status: 400, body: { code: 'bad-request', message: 'The request was not valid.' } };
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The server's clock in every answer of the fake Pricing routes (PA-05): the 2026-10-18 prices are in effect. */
export const PRICES_NOW = '2026-11-02T12:00:00Z';
/** What PA-03's routes answer for a change made on a book that changed since the page showed it. */
export const PRICES_CHANGED = {
  status: 409,
  body: { code: 'bad-request', message: 'The prices changed since you opened this page. Reload it and try again.' },
};
/** What they answer for a cancel or a move of a change that isn't scheduled. */
export const PRICE_CHANGE_GONE = {
  status: 404,
  body: { code: 'bad-request', message: 'That scheduled change is no longer on the list.' },
};

/** The book a price change makes, and what it changed (the history's `before` and `after`). */
interface PriceEdit {
  head: PriceBook;
  before: PriceChangeValue;
  after: PriceChangeValue;
  movedTo: string | null;
}

/**
 * The book `req` makes from `book` at `now`, with PA-01's edits and PA-02's starter credit step, as the server's
 * `editOf` does; null for a cancel or a move of a change `book` doesn't schedule.
 */
function priceEdit(book: PriceBook, req: PriceChangeRequest, now: Date): PriceEdit | null {
  switch (req.action) {
    case 'schedule': {
      const price = taskPriceAt(new Date(req.effectiveFrom), req.task, book.schedule);
      const schedule = withTaskCard(book.schedule, req.task, req.effectiveFrom, req.card);
      return { head: { ...book, schedule }, before: price.offered ? price.card : null, after: req.card, movedTo: null };
    }
    case 'cancel':
    case 'move': {
      const schedule =
        req.action === 'cancel'
          ? cancelTaskChange(book.schedule, req.task, req.effectiveFrom)
          : moveTaskChange(book.schedule, req.task, req.effectiveFrom, req.to);
      const since = new Date(Date.parse(req.effectiveFrom) - 1);
      const change = scheduledTaskChanges(book.schedule, req.task, since).find((c) => c.effectiveFrom === req.effectiveFrom);
      if (schedule === null || change === undefined) return null;
      const head = { ...book, schedule };
      if (req.action === 'cancel') return { head, before: change.card, after: change.before, movedTo: null };
      return { head, before: change.card, after: change.card, movedTo: req.to };
    }
    case 'starter': {
      const before = starterCreditAt(now, book).amountMicros;
      return { head: withStarterCredit(book, req.amountMicros, now), before, after: req.amountMicros, movedTo: null };
    }
    case 'purchase':
      return { head: { ...book, purchase: req.purchase }, before: book.purchase, after: req.purchase, movedTo: null };
    case 'auto-reload':
      return { head: { ...book, autoReload: req.autoReload }, before: book.autoReload, after: req.autoReload, movedTo: null };
  }
}

export const INFO: ServerInfo = {
  v: 1,
  name: 'Example AI',
  version: '0.1.0',
  source: 'https://example.org/source/server-v0.1.0',
  billing: false,
  capabilities: { classify: true, sync: false },
  auth: { methods: ['email-otp'], authorizePath: '/authorize', tokenPath: '/v1/auth/token' },
  limits: { maxPostsPerRequest: 12 },
};

/** What `GET /v1/account/export` answers for TOM. */
export const EXPORT: AccountExport = {
  v: 1,
  exportedAt: '2026-10-14T12:00:00.000Z',
  server: { name: INFO.name, origin: 'https://ai.example.org', version: INFO.version },
  account: { email: TOM, createdAt: '2026-08-20T12:00:00.000Z', linkedProviders: ['credential'] },
  devices: [
    {
      id: '4f5d8a2e-6b1c-4c3d-9e8f-0a1b2c3d4e5f',
      name: 'Chrome on Windows',
      createdAt: '2026-09-02T15:00:00.000Z',
      lastUsedAt: '2026-10-13T09:30:00.000Z',
      revokedAt: null,
      revokedReason: null,
    },
  ],
  passkeys: [{ name: 'iCloud Keychain', createdAt: '2026-09-01T12:00:00.000Z', deviceType: 'multiDevice', backedUp: true }],
  sessions: [{ createdAt: '2026-10-14T11:55:00.000Z', expiresAt: '2026-10-15T11:55:00.000Z', ipAddress: null, userAgent: null }],
  usage: [{ day: '2026-10-13', task: 'classify', requests: 3, postsRequested: 30, postsOk: 30 }],
  sync: { spaces: [] },
  billing: null,
};

export type Answer = { status: number; body?: unknown };
export interface Call {
  method: string;
  path: string;
  body: unknown;
}
/**
 * An answer, `'offline'` for none at all (`fetch` rejects), or a function of the request for one that depends on it or
 * arrives when the test says.
 */
export type Reply = Answer | 'offline' | ((call: Call) => Answer | Promise<Answer>);

/**
 * Stubs `fetch` with the server's routes (keyed `METHOD path`; `routes` replaces or adds any of them). `session` is the
 * address signed in at the start, or null for none; an accepted code or passkey signs in as TOM and signing out ends
 * the session. `devices` and `passkeys` are the account's at the start (none by default).
 */
export function fakeServer({
  session = null,
  role = null,
  adminUsers = NO_ADMIN_USERS,
  adminOverview = OVERVIEW,
  sourceList = EMPTY_SOURCE_LIST,
  outletChanges = NO_OUTLET_CHANGES,
  priceBook = DEFAULT_PRICE_BOOK,
  priceVersion = '0',
  priceChanges = [],
  info = INFO,
  devices = [],
  passkeys = [],
  routes = {},
}: {
  session?: string | null;
  /** The session user's `role`, whoever signs in. */
  role?: string | null;
  adminUsers?: AdminUsers;
  adminOverview?: AdminOverview;
  sourceList?: OfficialList;
  outletChanges?: OutletChanges;
  /** The Pricing routes' book, its version ('0': the code defaults, never saved) and history (newest first). */
  priceBook?: PriceBook;
  priceVersion?: string;
  priceChanges?: readonly PriceChange[];
  info?: ServerInfo;
  devices?: readonly AccountDevice[];
  passkeys?: readonly PasskeyRow[];
  routes?: Record<string, Reply>;
} = {}) {
  const calls: Call[] = [];
  let current = session;
  let deviceList = [...devices];
  let passkeyList = [...passkeys];
  let setupClaimed = false;
  let accounts = structuredClone(adminUsers);
  /** The source control routes' list and history (newest first), from the public ones; a history line keeps its `by`. */
  let outletList = structuredClone(sourceList);
  let outletHistory: AdminOutletChange[] = structuredClone(outletChanges.changes).map((c) => ({ by: null, ...c }));
  /** Publishes `outlets` as the next version, with one history line per change, as P3-73's `outlet_changes` does. */
  function publish(
    outlets: OfficialOutlet[],
    made: { action: OutletChangeAction; before: OfficialOutlet | null; after: OfficialOutlet | null }[],
  ) {
    let seq = Number(outletList.version);
    const lines = made.map(({ action, before, after }) => ({
      seq: ++seq,
      at: OUTLET_CHANGED_AT,
      action,
      outletId: (after ?? before)?.id ?? '',
      before,
      after,
      by: current,
    }));
    outletList = { ...outletList, version: String(seq), updatedAt: OUTLET_CHANGED_AT, outlets: [...outlets].sort(byId) };
    outletHistory = [...lines.reverse(), ...outletHistory];
    return { status: 200, body: { ok: true, version: outletList.version } };
  }
  /** The Pricing routes' book, its version and newest change, and its history (newest first). */
  let book = priceBook;
  let bookVersion = Number(priceVersion);
  let bookUpdatedAt: string | null = priceChanges[0]?.at ?? null;
  let bookHistory: PriceChange[] = structuredClone([...priceChanges]);
  /** Adds one accepted change's history lines (a `seed` line first, the first time), each the next version. */
  function recordPriceChange(lines: Omit<PriceChange, 'seq' | 'at' | 'by'>[]) {
    const made = lines.map((line) => ({ ...line, seq: ++bookVersion, at: PRICES_NOW, by: current }));
    bookHistory = [...made.reverse(), ...bookHistory];
    bookUpdatedAt = PRICES_NOW;
  }
  /** `answer` with a session, 401 without one. */
  const withSession =
    (answer: (call: Call) => Answer): Reply =>
    (call) =>
      current ? answer(call) : SESSION_GONE;
  /** `answer` for an admin's session; 401 without a session and 403 for anyone else, as the admin routes answer. */
  function asAdmin(answer: (call: Call) => Answer): Reply {
    return withSession((call) => (role === 'admin' ? answer(call) : NOT_ADMIN));
  }
  /** The body's field `name`, when it is a string. */
  const field = (call: Call, name: string): string | undefined => {
    const value = (call.body as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' ? value : undefined;
  };
  const all: Record<string, Reply> = {
    [`GET ${SERVER_INFO_PATH}`]: { status: 200, body: info },
    [`GET ${OUTLETS_JSON_PATH}`]: { status: 200, body: sourceList },
    [`GET ${OUTLET_CHANGES_JSON_PATH}`]: { status: 200, body: outletChanges },
    [`GET ${SESSION_PATH}`]: () => ({
      status: 200,
      body: current ? { session: { userId: 'u1' }, user: { email: current, role } } : null,
    }),
    [`POST ${SEND_CODE_PATH}`]: { status: 200, body: { success: true } },
    [`POST ${SIGN_IN_PATH}`]: () => {
      current = TOM;
      return { status: 200, body: { token: 'session-token', user: { email: TOM } } };
    },
    [`POST ${SIGN_OUT_PATH}`]: () => {
      current = null;
      return { status: 200, body: { success: true } };
    },
    [`POST ${AUTHORIZE_API_PATH}`]: { status: 200, body: { redirect: REDIRECT } },
    [`POST ${SOCIAL_SIGN_IN_PATH}`]: { status: 200, body: { url: GOOGLE_URL, redirect: false } },
    [`GET ${PASSKEY_AUTH_OPTIONS_PATH}`]: { status: 200, body: PASSKEY_OPTIONS },
    [`POST ${PASSKEY_AUTH_VERIFY_PATH}`]: () => {
      current = TOM;
      return { status: 200, body: { session: { userId: 'u1' } } };
    },
    [`GET ${ACCOUNT_DEVICES_PATH}`]: withSession(() => ({ status: 200, body: { v: 1, devices: deviceList } })),
    [`POST ${ACCOUNT_DEVICE_REVOKE_PATH}`]: withSession((call) => {
      const id = field(call, 'device_id');
      if (!deviceList.some((d) => d.id === id)) return { status: 404, body: { code: 'not-found', message: 'Not found.' } };
      deviceList = deviceList.filter((d) => d.id !== id);
      return { status: 200, body: { ok: true } };
    }),
    [`GET ${PASSKEY_LIST_PATH}`]: withSession(() => ({ status: 200, body: passkeyList })),
    [`GET ${PASSKEY_REGISTER_OPTIONS_PATH}`]: withSession(() => ({ status: 200, body: REGISTER_OPTIONS })),
    [`POST ${PASSKEY_REGISTER_VERIFY_PATH}`]: withSession(() => {
      passkeyList = [...passkeyList, ADDED_PASSKEY];
      return { status: 200, body: ADDED_PASSKEY };
    }),
    [`GET ${ACCOUNT_EXPORT_PATH}`]: withSession(() => ({ status: 200, body: EXPORT })),
    [`POST ${ACCOUNT_DELETE_PATH}`]: withSession((call) => {
      if (field(call, 'confirm')?.trim().toLowerCase() !== current?.toLowerCase()) {
        return { status: 400, body: { code: 'bad-request', message: 'The address does not match.' } };
      }
      current = null;
      return { status: 200, body: { ok: true } };
    }),
    [`POST ${PASSKEY_DELETE_PATH}`]: withSession((call) => {
      const id = field(call, 'id');
      if (!passkeyList.some((p) => p.id === id)) return { status: 404, body: { code: 'NOT_FOUND', message: 'Not found.' } };
      passkeyList = passkeyList.filter((p) => p.id !== id);
      return { status: 200, body: { status: true } };
    }),
    [`POST ${ADMIN_SETUP_PATH}`]: withSession((call) => {
      if (setupClaimed || field(call, 'token') !== SETUP_TOKEN) return SETUP_REFUSED;
      setupClaimed = true;
      return { status: 200, body: { ok: true } };
    }),
    [`GET ${ADMIN_USERS_PATH}`]: asAdmin(() => ({ status: 200, body: accounts })),
    [`GET ${ADMIN_OVERVIEW_PATH}`]: asAdmin(() => ({ status: 200, body: adminOverview })),
    [`POST ${ADMIN_INVITES_PATH}`]: asAdmin((call) => {
      const email = field(call, 'email')?.trim().toLowerCase() ?? '';
      if (accounts.users.some((u) => u.email.toLowerCase() === email)) return HAS_ACCOUNT;
      if (!accounts.invites.some((i) => i.email === email)) {
        accounts = { ...accounts, invites: [{ email, createdAt: INVITED_AT }, ...accounts.invites] };
      }
      return { status: 200, body: { ok: true } };
    }),
    [`POST ${ADMIN_INVITE_REMOVE_PATH}`]: asAdmin((call) => {
      const email = field(call, 'email')?.trim().toLowerCase();
      accounts = { ...accounts, invites: accounts.invites.filter((i) => i.email !== email) };
      return { status: 200, body: { ok: true } };
    }),
    [`GET ${ADMIN_OUTLETS_PATH}`]: asAdmin(() => ({ status: 200, body: { list: outletList, changes: outletHistory } })),
    [`POST ${ADMIN_OUTLETS_PATH}`]: asAdmin((call) => {
      const parsed = OutletChangeRequestSchema.safeParse(call.body);
      if (!parsed.success) return NOT_VALID;
      const req = parsed.data;
      if (req.baseVersion !== outletList.version) return LIST_CHANGED;
      const id = req.action === 'remove' ? req.id : req.outlet.id;
      const before = outletList.outlets.find((o) => o.id === id) ?? null;
      if (req.action === 'add' && before) return ID_TAKEN;
      if (req.action !== 'add' && !before) return OUTLET_GONE;
      const after = req.action === 'remove' ? null : { ...req.outlet, changedOn: OUTLET_CHANGED_AT.slice(0, 10) };
      const rest = outletList.outlets.filter((o) => o.id !== id);
      const outlets = after ? [...rest, after] : rest;
      const [problem] = listProblems(outlets);
      if (problem) return { status: 400, body: { code: 'bad-request', message: listProblemText(problem) } };
      return publish(outlets, [{ action: req.action, before, after }]);
    }),
    [`POST ${ADMIN_OUTLETS_IMPORT_PATH}`]: asAdmin((call) => {
      const body = call.body;
      if (typeof body !== 'object' || body === null || Object.keys(body).length > 0) return NOT_VALID;
      if (outletList.outlets.length > 0) return LIST_NOT_EMPTY;
      const imported = CANDIDATES.map((c) => ({ ...c, domains: [...c.domains], changedOn: OUTLET_CHANGED_AT.slice(0, 10) }));
      return publish(
        imported,
        [...imported].sort(byId).map((after) => ({ action: 'import' as const, before: null, after })),
      );
    }),
    [`GET ${ADMIN_PRICES_PATH}`]: asAdmin(() => ({
      status: 200,
      body: {
        prices: { v: 1, version: String(bookVersion), updatedAt: bookUpdatedAt, ...book },
        changes: bookHistory,
        now: PRICES_NOW,
        billing: info.billing,
      },
    })),
    [`POST ${ADMIN_PRICES_PATH}`]: asAdmin((call) => {
      const parsed = PriceChangeRequestSchema.safeParse(call.body);
      if (!parsed.success) return NOT_VALID;
      const req = parsed.data;
      if (req.baseVersion !== String(bookVersion)) return PRICES_CHANGED;
      const now = new Date(PRICES_NOW);
      const edit = priceEdit(book, req, now);
      if (!edit) return PRICE_CHANGE_GONE;
      const issues = priceBookChangeIssues(book, edit.head, now);
      if (issues.length > 0) return { status: 400, body: { code: 'bad-request', message: priceIssuesText(issues) } };
      const scheduled = req.action === 'schedule' || req.action === 'cancel' || req.action === 'move';
      const { before, after, movedTo } = edit;
      const seed = { action: 'seed' as const, task: null, effectiveFrom: null, movedTo: null, before: null, after: null };
      recordPriceChange([
        ...(bookVersion === 0 ? [seed] : []),
        {
          action: req.action,
          task: scheduled ? req.task : null,
          effectiveFrom: scheduled ? req.effectiveFrom : null,
          movedTo,
          before,
          after,
        },
      ]);
      book = edit.head;
      return { status: 200, body: { ok: true, version: String(bookVersion) } };
    }),
    ...Object.fromEntries(
      adminUsers.users.flatMap(({ id, email }) => {
        /** Changes the account's row in the next list; the admin's own access and role are refused. */
        const change = (action: 'cap' | 'access' | 'role', own: boolean): [string, Reply] => [
          `POST ${adminUserActionPath(id, action)}`,
          asAdmin((call) => {
            if (own && email === current) return OWN_ACCOUNT;
            const update = call.body as Record<string, unknown>;
            accounts = { ...accounts, users: accounts.users.map((u) => (u.id === id ? { ...u, ...update } : u)) };
            return { status: 200, body: { ok: true } };
          }),
        ];
        return [change('cap', false), change('access', true), change('role', true)];
      }),
    ),
    ...routes,
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    const call: Call = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = all[`${method} ${path}`] ?? { status: 404, body: { code: 'bad-request', message: 'Not found.' } };
    if (route === 'offline') throw new TypeError('Failed to fetch');
    const reply = typeof route === 'function' ? await route(call) : route;
    return new Response(JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    calls,
    posts: () => calls.filter((c) => c.method === 'POST'),
    count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length,
  };
}
