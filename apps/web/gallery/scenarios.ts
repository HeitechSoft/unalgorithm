/**
 * The gallery's scenarios: each a page of the portal in one state, with the fake server set up for it. Every name,
 * address, outlet and report here is made up (`.example` domains only).
 */
import {
  ACCOUNT_PAGE_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_REPORTS_FLOOR_PATH,
  ADMIN_REPORTS_HANDLE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_REPORTS_PATH,
  ADMIN_REPORTS_SUMMARY_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  type AdminOverview,
  type AdminReportRow,
  type AdminReportsSummary,
  type AdminUsers,
  AUTHORIZE_PAGE_PATH,
  adminReportPath,
  CREDIT_ACCOUNT_PATH,
  type CreditAccount,
  type OfficialList,
  type OfficialOutlet,
  OUTLETS_PAGE_PATH,
  type OutletChanges,
  type PriceChange,
  type ReportDay,
  type ReportGroup,
  SETUP_PAGE_PATH,
} from '@unalgorithm/protocol';
import type { ReportDetail } from '../src/api.ts';
import { type Answer, fakeServer, INFO, PARAMS, passkeyRow, type Reply, SETUP_TOKEN, TOM } from '../test/support/fake-server.ts';

export interface Scenario {
  id: string;
  group: string;
  title: string;
  /** The address the page opens at: path, query and fragment. */
  url: string;
  setup(): void;
}

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const hoursAgo = (hours: number) => new Date(Math.floor((NOW - hours * HOUR) / HOUR) * HOUR).toISOString();
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();
const utcDay = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

const CLOUD = { ...INFO, name: 'unAlgorithm Cloud', auth: { ...INFO.auth, methods: ['email-otp', 'google', 'passkey'] } };
const BILLED = { ...CLOUD, billing: true };

const DEVICES = [
  {
    id: '4f5d8a2e-6b1c-4c3d-9e8f-0a1b2c3d4e5f',
    name: 'Chrome on Windows',
    createdAt: daysAgo(48),
    lastUsedAt: daysAgo(0),
    current: false,
  },
  {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    name: 'Firefox on macOS',
    createdAt: daysAgo(20),
    lastUsedAt: daysAgo(3),
    current: false,
  },
  {
    id: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
    name: 'Edge on Windows',
    createdAt: daysAgo(6),
    lastUsedAt: null,
    current: false,
  },
];
const PASSKEYS = [passkeyRow('pk-1', 'iCloud Keychain', daysAgo(40)), passkeyRow('pk-2', 'Google Password Manager', daysAgo(9))];

const CREDIT: CreditAccount = {
  v: 1,
  balance: {
    v: 1,
    balanceMicros: 7_420_000,
    promoMicros: 1_420_000,
    purchasedMicros: 6_000_000,
    promoExpiresAt: daysAgo(-24),
    starter: 'active',
  },
  history: [
    { kind: 'usage', reason: 'classify', amountMicros: -46_000, at: `${utcDay(0)}T00:00:00.000Z`, posts: 312 },
    { kind: 'usage', reason: 'factcheck', amountMicros: -120_000, at: `${utcDay(1)}T00:00:00.000Z`, posts: 2 },
    { kind: 'usage', reason: 'classify', amountMicros: -61_000, at: `${utcDay(1)}T00:00:00.000Z`, posts: 418 },
    { kind: 'purchase', reason: 'credit-pack', amountMicros: 5_000_000, at: daysAgo(4) },
    { kind: 'usage', reason: 'perspectives', amountMicros: -80_000, at: `${utcDay(5)}T00:00:00.000Z`, posts: 1 },
    { kind: 'grant', reason: 'starter-credit', amountMicros: 2_000_000, at: daysAgo(6) },
  ],
  pricingUrl: 'https://unalgorithmfeed.example/pricing',
  refundPolicyUrl: 'https://unalgorithmfeed.example/refunds',
  addCreditPath: '/billing/add-credit',
  autoReload: { path: '/billing/auto-reload', state: 'off' },
};

const USERS: AdminUsers = {
  users: [
    {
      id: 'u1',
      email: TOM,
      role: 'admin',
      access: 'active',
      createdAt: daysAgo(90),
      lastActiveAt: daysAgo(0),
      activeDevices: 2,
      postsToday: 120,
      posts30Days: 2400,
      costMicros30Days: 180_000,
      dailyPostCap: null,
    },
    {
      id: 'u2',
      email: 'ana.ruiz@example.com',
      role: 'user',
      access: 'active',
      createdAt: daysAgo(40),
      lastActiveAt: daysAgo(1),
      activeDevices: 1,
      postsToday: 64,
      posts30Days: 1830,
      costMicros30Days: 132_000,
      dailyPostCap: 500,
    },
    {
      id: 'u3',
      email: 'sam@example.com',
      role: 'user',
      access: 'removed',
      createdAt: daysAgo(30),
      lastActiveAt: daysAgo(12),
      activeDevices: 0,
      postsToday: 0,
      posts30Days: 210,
      costMicros30Days: 16_000,
      dailyPostCap: null,
    },
    {
      id: 'u4',
      email: 'jordan.lee@example.com',
      role: 'user',
      access: 'active',
      createdAt: daysAgo(3),
      lastActiveAt: null,
      activeDevices: 0,
      postsToday: 0,
      posts30Days: 0,
      costMicros30Days: 0,
      dailyPostCap: null,
    },
  ],
  truncated: false,
  invites: [
    { email: 'kim@example.com', createdAt: daysAgo(1) },
    { email: 'dad@example.com', createdAt: daysAgo(5) },
  ],
  defaultDailyPostCap: 1000,
};

function usageDays(): AdminOverview['last30Days'] {
  return Array.from({ length: 30 }, (_, i) => {
    const posts = Math.round(1800 + 900 * Math.sin(i / 3) + i * 20);
    return { day: utcDay(29 - i), posts, requests: Math.round(posts / 9), costMicros: posts * 75 };
  });
}

const OVERVIEW: AdminOverview = {
  version: '0.5.0',
  users: 4,
  today: { day: utcDay(0), posts: 2140, requests: 238, costMicros: 160_500 },
  last30Days: usageDays(),
  spendLimitMicros: 5_000_000,
  breakerTripped: false,
  defaultDailyPostCap: 1000,
  ops: {
    diskFreeBytes: 41_200_000_000,
    diskTotalBytes: 80_000_000_000,
    databaseBytes: 812_000_000,
    errors15m: 0,
    backups: [
      { kind: 'local', ok: true, finishedAt: hoursAgo(9), lastSuccessAt: hoursAgo(9), bytes: 182_000_000, error: null },
      { kind: 'offsite', ok: true, finishedAt: hoursAgo(8), lastSuccessAt: hoursAgo(8), bytes: 182_000_000, error: null },
    ],
    openAlerts: [],
  },
  reports: { enabled: true, open: 10, last24h: 7 },
};

const evidence = (note: string, slug: string) => [{ url: `https://ratings.example/${slug}`, note }];
const OUTLETS: OfficialOutlet[] = [
  {
    id: 'harbor-times',
    name: 'Harbor Times',
    domains: ['harbortimes.example'],
    country: 'US',
    lean: { bucket: 'lean-left', evidence: evidence('Two independent ratings, 2026', 'harbor-times') },
    changedOn: utcDay(12),
  },
  {
    id: 'north-ledger',
    name: 'The North Ledger',
    domains: ['northledger.example', 'ledger-news.example'],
    country: 'CA',
    lean: { bucket: 'center', evidence: evidence('Media bias review, 2026', 'north-ledger') },
    changedOn: utcDay(3),
  },
  {
    id: 'plains-courier',
    name: 'Plains Courier',
    domains: ['plainscourier.example'],
    country: 'US',
    lean: { bucket: 'lean-right', evidence: evidence('Editorial board review, 2025', 'plains-courier') },
    changedOn: utcDay(30),
  },
  {
    id: 'civic-wire',
    name: 'Civic Wire',
    domains: ['civicwire.example'],
    country: 'US',
    lean: { bucket: 'left', evidence: evidence('Audience survey and ratings, 2026', 'civic-wire') },
    changedOn: utcDay(30),
  },
  {
    id: 'liberty-daily',
    name: 'Liberty Daily',
    domains: ['libertydaily.example'],
    country: 'US',
    lean: { bucket: 'right', evidence: evidence('Two independent ratings, 2026', 'liberty-daily') },
    changedOn: utcDay(30),
  },
  {
    id: 'metro-bulletin',
    name: 'Metro Bulletin',
    domains: ['metrobulletin.example'],
    country: 'CA',
    lean: null,
    changedOn: utcDay(1),
  },
];
const LIST: OfficialList = { v: 1, version: '9', updatedAt: daysAgo(1), license: 'CC-BY-4.0', outlets: OUTLETS };
const outlet = (id: string) => OUTLETS.find((o) => o.id === id) ?? null;
const CHANGES: OutletChanges = {
  v: 1,
  changes: [
    { seq: 9, at: daysAgo(1), action: 'add', outletId: 'metro-bulletin', before: null, after: outlet('metro-bulletin') },
    {
      seq: 8,
      at: daysAgo(3),
      action: 'edit',
      outletId: 'north-ledger',
      before: {
        ...(outlet('north-ledger') as OfficialOutlet),
        lean: { bucket: 'lean-left', evidence: evidence('Older review', 'nl') },
      },
      after: outlet('north-ledger'),
    },
    {
      seq: 7,
      at: daysAgo(12),
      action: 'edit',
      outletId: 'harbor-times',
      before: outlet('harbor-times'),
      after: outlet('harbor-times'),
    },
    { seq: 1, at: daysAgo(30), action: 'import', outletId: 'civic-wire', before: null, after: outlet('civic-wire') },
  ],
};

const PRICE_HISTORY: PriceChange[] = [
  {
    seq: 3,
    at: daysAgo(2),
    action: 'starter',
    task: null,
    effectiveFrom: null,
    movedTo: null,
    before: 1_000_000,
    after: 2_000_000,
    by: TOM,
  },
  { seq: 2, at: daysAgo(9), action: 'seed', task: null, effectiveFrom: null, movedTo: null, before: null, after: null, by: TOM },
];

// Problem reports, as the reports test has them.
const LI_KEY = 'linkedin|linkedin@2026.10.2|detection|feed-not-started';
const FB_KEY = 'facebook|facebook@2026.10.1|wrong-call|sponsored';
const FACTCHECK_KEY = '||correction|factcheck';
const perDay = (...last: number[]) => [...Array(14 - last.length).fill(0), ...last];
const GROUPS: ReportGroup[] = [
  {
    key: LI_KEY,
    platform: 'linkedin',
    adapter: 'linkedin@2026.10.2',
    kind: 'detection',
    topic: 'feed-not-started',
    total: 7,
    open: 7,
    networks: 5,
    lastAt: hoursAgo(2),
    perDay: perDay(1, 0, 2, 3, 4),
  },
  {
    key: '||other|credits',
    platform: null,
    adapter: null,
    kind: 'other',
    topic: 'credits',
    total: 1,
    open: 1,
    networks: 1,
    lastAt: hoursAgo(30),
    perDay: perDay(1, 0),
  },
  {
    key: FACTCHECK_KEY,
    platform: null,
    adapter: null,
    kind: 'correction',
    topic: 'factcheck',
    total: 3,
    open: 2,
    networks: 2,
    lastAt: hoursAgo(80),
    perDay: perDay(1, 0, 0, 0),
  },
  {
    key: FB_KEY,
    platform: 'facebook',
    adapter: 'facebook@2026.10.1',
    kind: 'wrong-call',
    topic: 'sponsored',
    total: 2,
    open: 0,
    networks: 2,
    lastAt: hoursAgo(80),
    perDay: perDay(2, 0, 0, 0),
  },
];
function reportDays(): ReportDay[] {
  return Array.from({ length: 30 }, (_, i) => {
    const d = 29 - i;
    return {
      day: utcDay(d),
      linkedin: d < 5 ? 5 - d : d % 7 === 0 ? 1 : 0,
      facebook: d % 9 === 2 ? 2 : 0,
      other: d === 1 ? 1 : 0,
    };
  });
}
const SUMMARY: AdminReportsSummary = {
  enabled: true,
  today: 4,
  dailyMax: 1000,
  unlisted7d: 3,
  days: reportDays(),
  groups: GROUPS,
  floors: [{ platform: 'linkedin', adapter: 'linkedin@2026.10.1', setAt: daysAgo(8) }],
};
const reportId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function row(n: number, change: Partial<AdminReportRow> = {}): AdminReportRow {
  return {
    id: reportId(n),
    ref: `7KQ3-M2P${'ABCDEFGHJK'[n % 10]}`,
    receivedAt: hoursAgo(2 + n),
    kind: 'detection',
    from: 'notice',
    channel: 'chrome-store',
    listed: true,
    extension: '0.4.1',
    browser: 'chrome',
    browserMajor: 141,
    platform: 'linkedin',
    adapter: 'linkedin@2026.10.2',
    topic: 'feed-not-started',
    choices: [],
    firstFromNetwork: true,
    handledAt: null,
    resolution: null,
    hasMessage: false,
    hasContact: false,
    ...change,
  };
}
const correction = (n: number, receivedAt: string, hasContact: boolean) =>
  row(n, {
    receivedAt,
    kind: 'correction',
    from: 'sidepanel',
    platform: null,
    adapter: null,
    topic: 'factcheck',
    choices: ['verdict-wrong'],
    hasMessage: true,
    hasContact,
  });
const LI_ROWS = [row(1, { choices: ['ads-showing'] }), row(2, { listed: false, channel: 'edge-store', browser: 'edge' }), row(3)];
const CORRECTIONS = [correction(11, daysAgo(1), false), correction(12, daysAgo(9), true)];
const DETAILS: ReportDetail[] = [
  {
    ...(CORRECTIONS[1] as AdminReportRow),
    details: { correction: { feature: 'factcheck', promptVersion: 3, via: 'cloud' } },
    unknownCodes: 0,
    message: 'The claim was about 2025, not 2024.\nThe source in the second link says so.',
    contact: 'ana+news@example.com',
    lines: [
      'unAlgorithm 0.4.1 from the Chrome Web Store',
      'Chrome 141',
      'Reported from the side panel',
      'About: a Fact-check result (prompt version 3), made with unAlgorithm Cloud',
      'Your answer: The verdict is wrong',
    ],
    handledBy: null,
  },
  {
    ...(LI_ROWS[0] as AdminReportRow),
    details: {
      page: {
        platform: 'linkedin',
        adapter: 'linkedin@2026.10.2',
        route: 'feed-candidate',
        feedWord: 'foryou',
        lang: 'en',
        preset: 'balanced',
        ai: 'off',
        paused: false,
      },
      health: { status: 'broken', issues: ['feed-not-started'], degraded: [] },
      detection: { counts: { items: 0 } },
    },
    unknownCodes: 2,
    message: null,
    contact: null,
    lines: [
      'unAlgorithm 0.4.1 from the Chrome Web Store · LinkedIn detection 2026.10.2',
      'Chrome 141',
      "unAlgorithm noticed: LinkedIn's feed is on a page unAlgorithm doesn't recognise",
    ],
    handledBy: null,
  },
];
const ok: Answer = { status: 200, body: { ok: true } };
function reportRoutes(): Record<string, Reply> {
  const list = (query: Record<string, string>) => `GET ${ADMIN_REPORTS_PATH}?${new URLSearchParams(query)}`;
  const routes: Record<string, Reply> = {
    [`GET ${ADMIN_REPORTS_SUMMARY_PATH}?days=30&dev=0`]: { status: 200, body: SUMMARY },
    [`GET ${ADMIN_REPORTS_SUMMARY_PATH}?days=30&dev=1`]: { status: 200, body: SUMMARY },
    [list({ group: LI_KEY, status: 'open' })]: { status: 200, body: { rows: LI_ROWS, nextBefore: null } },
    [list({ group: LI_KEY, status: 'all' })]: { status: 200, body: { rows: LI_ROWS, nextBefore: null } },
    [list({ group: LI_KEY, status: 'handled' })]: { status: 200, body: { rows: [], nextBefore: null } },
    [list({ group: FACTCHECK_KEY, status: 'open' })]: { status: 200, body: { rows: CORRECTIONS, nextBefore: null } },
    [list({ group: FACTCHECK_KEY, status: 'all' })]: { status: 200, body: { rows: CORRECTIONS, nextBefore: null } },
    [`POST ${ADMIN_REPORTS_HANDLE_PATH}`]: ok,
    [`POST ${ADMIN_REPORTS_FLOOR_PATH}`]: ok,
  };
  for (const detail of DETAILS) routes[`GET ${adminReportPath(detail.id)}`] = { status: 200, body: detail };
  return routes;
}

const credit = { [`GET ${CREDIT_ACCOUNT_PATH}`]: { status: 200, body: CREDIT } };
const signedInAdmin = { session: TOM, role: 'admin' as const };

export const SCENARIOS: readonly Scenario[] = [
  { id: 'home', group: 'Public', title: 'Home', url: '/', setup: () => fakeServer({ info: CLOUD }) },
  {
    id: 'outlets',
    group: 'Public',
    title: 'Source list',
    url: OUTLETS_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, sourceList: LIST, outletChanges: CHANGES }),
  },
  {
    id: 'sign-in',
    group: 'Sign in',
    title: 'Account, signed out',
    url: ACCOUNT_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD }),
  },
  {
    id: 'sign-in-email-only',
    group: 'Sign in',
    title: 'Account, signed out (email only)',
    url: ACCOUNT_PAGE_PATH,
    setup: () => fakeServer({ info: { ...INFO, name: 'Family AI' } }),
  },
  {
    id: 'authorize',
    group: 'Sign in',
    title: 'Extension sign-in',
    url: `${AUTHORIZE_PAGE_PATH}?${new URLSearchParams(PARAMS)}`,
    setup: () => fakeServer({ info: CLOUD }),
  },
  {
    id: 'authorize-continue',
    group: 'Sign in',
    title: 'Extension sign-in, signed in',
    url: `${AUTHORIZE_PAGE_PATH}?${new URLSearchParams(PARAMS)}`,
    setup: () => fakeServer({ info: CLOUD, session: TOM }),
  },
  {
    id: 'authorize-invalid',
    group: 'Sign in',
    title: 'Extension sign-in, bad link',
    url: AUTHORIZE_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD }),
  },
  {
    id: 'setup',
    group: 'Sign in',
    title: 'Setup link, signed out',
    url: `${SETUP_PAGE_PATH}#${SETUP_TOKEN}`,
    setup: () => fakeServer({ info: { ...INFO, name: 'Family AI' } }),
  },
  {
    id: 'setup-done',
    group: 'Sign in',
    title: 'Setup link, claimed',
    url: `${SETUP_PAGE_PATH}#${SETUP_TOKEN}`,
    setup: () => fakeServer({ info: { ...INFO, name: 'Family AI' }, session: TOM }),
  },
  {
    id: 'account',
    group: 'Account',
    title: 'Account',
    url: ACCOUNT_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, session: TOM, devices: DEVICES, passkeys: PASSKEYS }),
  },
  {
    id: 'account-billing',
    group: 'Account',
    title: 'Account with credits',
    url: ACCOUNT_PAGE_PATH,
    setup: () => fakeServer({ info: BILLED, ...signedInAdmin, devices: DEVICES, passkeys: PASSKEYS, routes: credit }),
  },
  {
    id: 'account-empty',
    group: 'Account',
    title: 'Account, nothing yet',
    url: ACCOUNT_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, session: TOM }),
  },
  {
    id: 'admin',
    group: 'Admin',
    title: 'Admin',
    url: ADMIN_PAGE_PATH,
    setup: () => fakeServer({ info: BILLED, ...signedInAdmin, adminUsers: USERS, adminOverview: OVERVIEW }),
  },
  {
    id: 'admin-not-admin',
    group: 'Admin',
    title: 'Admin, not an admin',
    url: ADMIN_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, session: 'ana.ruiz@example.com' }),
  },
  {
    id: 'sources',
    group: 'Admin',
    title: 'Source list (admin)',
    url: ADMIN_SOURCES_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, ...signedInAdmin, sourceList: LIST, outletChanges: CHANGES, adminOverview: OVERVIEW }),
  },
  {
    id: 'sources-empty',
    group: 'Admin',
    title: 'Source list (admin), empty',
    url: ADMIN_SOURCES_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, ...signedInAdmin, adminOverview: OVERVIEW }),
  },
  {
    id: 'prices',
    group: 'Admin',
    title: 'Pricing',
    url: ADMIN_PRICES_PAGE_PATH,
    setup: () =>
      fakeServer({ info: BILLED, ...signedInAdmin, priceVersion: '3', priceChanges: PRICE_HISTORY, adminOverview: OVERVIEW }),
  },
  {
    id: 'reports',
    group: 'Admin',
    title: 'Problem reports',
    url: ADMIN_REPORTS_PAGE_PATH,
    setup: () => fakeServer({ info: CLOUD, ...signedInAdmin, adminOverview: OVERVIEW, routes: reportRoutes() }),
  },
];
