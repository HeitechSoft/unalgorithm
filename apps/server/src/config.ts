import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_DEFAULT_MODEL } from '@unalgorithm/ai';
import { ExtensionIdSchema } from '@unalgorithm/protocol';
import { FACTCHECK_MODELS, SEARCH_PROVIDERS, type SearchProviderId } from '@unalgorithm/research';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { LOG_LEVELS, type LogLevel } from './log.ts';
import { denyList } from './net/egress.ts';

/**
 * The server's whole configuration, read once from the environment at startup. Every variable the server reads is
 * parsed here, so the rest of the code receives typed values and never touches `process.env`.
 *
 * Errors name variables and rules, never values: values include secrets.
 */

export const SERVER_VERSION: string = pkg.version;

/**
 * Every variable `loadConfig` reads, in the order it reads them. `apps/server/.env.example` documents each one
 * (test/env-example.test.ts holds both to this list), and the Cloud's own example is checked against it.
 */
export const CONFIG_VARIABLES: readonly string[] = [
  'PUBLIC_URL',
  'HOST',
  'PORT',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'INSTANCE_NAME',
  'SOURCE_URL',
  'BILLING',
  'BILLING_MODULE',
  'EXTENSION_IDS',
  'SIGNUP_ALLOWLIST',
  'TRUST_PROXY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'MAIL_FROM',
  'MAIL_FROM_NAME',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'AI_PROVIDER',
  'AI_MODEL',
  'AI_API_KEY',
  'AI_BASE_URL',
  'AI_DATA_POLICY',
  'FACTCHECK',
  'AI_RESEARCH_MODEL',
  'AI_SYNTHESIS_MODEL',
  'SEARCH_PROVIDER',
  'SEARCH_URL',
  'SEARCH_API_KEY',
  'CLAIM_CACHE',
  'PERSPECTIVES',
  'ROUTE_EVAL_MIN_AGREEMENT',
  'USER_DAILY_POST_CAP',
  'USER_REQUESTS_PER_MINUTE',
  'DAILY_SPEND_LIMIT_USD',
  'USER_DAILY_CHECK_CAP',
  'EGRESS_DENY',
  'ALERT_DISK_FREE_MIN_GB',
  'ALERT_DATABASE_MAX_GB',
  'ALERT_ERRORS_PER_15M',
  'ALERT_BACKUP_MAX_AGE_HOURS',
  'ALERT_EMAIL',
  'ALERT_WEBHOOK_URL',
  'METRICS_TOKEN',
  'WEB_DIST',
  'BACKUP_STATUS_DIR',
  'LOG_LEVEL',
  'BETTER_AUTH_TELEMETRY',
  'ANTHROPIC_CUSTOM_HEADERS',
];

export interface Config {
  /** The origin people and the extension reach the server on, without a trailing slash. */
  publicUrl: string;
  publicOrigin: string;
  host: string;
  port: number;
  databaseUrl: string;
  authSecret: string;
  /** Shown to people as this server's name. Public code never hardcodes a name. */
  instanceName: string;
  /** Source code of the running release (AGPL section 13); set it for modified builds. */
  sourceUrl: string;
  /** `off`: the no-op provider, nobody is charged. `module`: the billing module at `billingModule`, loaded at boot. */
  billing: 'off' | 'module';
  /** The module's absolute path; set exactly when `billing` is `module`. */
  billingModule?: string;
  /**
   * The module's own `BILLING_*` variables (all but `BILLING_MODULE`), exactly as set: they may hold secrets. Empty when
   * `billing` is `off`. The server neither reads nor checks them; the module does (`host.env`).
   */
  billingEnv: Readonly<Record<string, string>>;
  extensionIds: string[];
  /** Lowercase emails and `@domain` entries allowed to create an account. Empty: nobody can. */
  signupAllowlist: string[];
  trustProxy: 'none' | 'one-hop';
  smtp: {
    host: string;
    port: number;
    secure: 'starttls' | 'tls' | 'none';
    user?: string;
    password?: string;
    from: string;
    fromName: string;
  };
  /**
   * The operator's Google OAuth client, for signing in with Google; set when both variables are. The server asks Google
   * for the verified address only (openid and email) and keeps no Google token.
   */
  google?: { clientId: string; clientSecret: string };
  ai: {
    provider: 'anthropic' | 'openai-compatible';
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dataPolicy: 'vendor-zdr' | 'self-hosted';
  };
  /** Fact-check (Labs, F12): off unless `FACTCHECK=on`. */
  factcheck: {
    enabled: boolean;
    /** The `research` route's model; unused when `search` is set (the model then reads search results instead). */
    researchModel: string;
    /** The `synthesis` route's model, which writes the verdicts. */
    synthesisModel: string;
    /** A search provider for research; null: Anthropic web search on the server's key. `apiKey` is a secret. */
    search: { provider: SearchProviderId; url?: string; apiKey?: string } | null;
    /** Fact-checks per person per UTC day when `BILLING` is off; 0: none. */
    userDailyCheckCap: number;
    /** Public posts' checks read and write the server's claim cache (F27, `CLAIM_CACHE`, default on); false while fact-check is off. */
    claimCache: boolean;
  };
  /** Other perspectives (Labs, F22): off unless `PERSPECTIVES=on`, which needs `FACTCHECK=on` (its routes and search). */
  perspectives: { enabled: boolean };
  /** More IPs or `ip/prefix` ranges the egress fetcher refuses, on top of its own deny list (R51). */
  egressDeny: string[];
  routeEvalMinAgreement: number;
  userDailyPostCap: number;
  userRequestsPerMinute: number;
  /** The daily spend breaker, in integer micro-dollars. */
  dailySpendLimitMicros: number;
  /** The alert rules' thresholds (CL4-15, `ops/alerts.ts`); 0 turns a rule off. */
  alerts: {
    /** `disk-free-low` opens below this many free bytes. */
    diskFreeMinBytes: number;
    /** `database-size-high` opens above this many bytes. */
    databaseMaxBytes: number;
    /** `errors-high` opens at this many error lines in 15 minutes. */
    errorsPer15m: number;
    /** `backup-<kind>` opens when the last success is older than this (ms); 0: only a failed run opens it. */
    backupMaxAgeMs: number;
    /** Who gets alert emails (CL4-16, `ops/notify.ts`): the active admins (the default), nobody, or these addresses. */
    email: AlertEmail;
    /**
     * Where alert notifications are also POSTed as JSON, exactly as given: it often holds a token, so it is never logged
     * or printed. An admin-configured URL, so the SSRF fetcher does not apply to it (R51).
     */
    webhookUrl?: string;
  };
  /** The bearer token of `GET /metrics` (CL4-17), at least 32 characters, exactly as given. Unset: no metrics endpoint. */
  metricsToken?: string;
  webDist: string;
  /**
   * The folder of the backup status files (`<kind>.json`, CL4-10), absolute; compose.yaml mounts it read-only. Unset:
   * this server does not watch backups.
   */
  backupStatusDir?: string;
  logLevel: LogLevel;
  version: string;
}

/** `ALERT_EMAIL`: unset, `none`, or 1 to 20 lowercase addresses. */
export type AlertEmail = { kind: 'admins' } | { kind: 'none' } | { kind: 'list'; addresses: string[] };
/** The most addresses `ALERT_EMAIL` may list. */
export const MAX_ALERT_EMAILS = 20;

export interface ConfigIssue {
  name: string;
  reason: string;
}

export class ConfigError extends Error {
  readonly missing: string[];
  readonly invalid: ConfigIssue[];

  constructor(missing: string[], invalid: ConfigIssue[]) {
    const lines = [
      ...(missing.length ? [`missing: ${missing.join(', ')}`] : []),
      ...invalid.map((i) => `invalid: ${i.name} (${i.reason})`),
    ];
    super(lines.join('\n'));
    this.name = 'ConfigError';
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** The development key's extension id (ADR 0004). The store id joins it once the store assigns one. */
const DEV_EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
/** INSTANCE_NAME and MAIL_FROM_NAME; the discovery document's `name` has the same limit. */
const MAX_DISPLAY_NAME = 80;
/** Decimal gigabytes, as disks are sold and `df -H` shows them. */
const GB = 1_000_000_000;
const HOUR_MS = 3_600_000;
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const Email = z.email();
/** What `BILLING_MODULE` may name: a module Node.js imports as is (type stripping for TypeScript). */
const MODULE_FILE = /\.(?:ts|mts|js|mjs)$/;
/** A billing module's own variables; `BILLING_MODULE` is the server's. */
const BILLING_ENV_NAME = /^BILLING_[A-Z0-9_]+$/;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const invalid: ConfigIssue[] = [];
  const bad = (name: string, reason: string) => void invalid.push({ name, reason });

  /** A variable's value, trimmed; blank counts as unset (Compose passes an unset `${VAR}` as ''). */
  const read = (name: string): string | undefined => env[name]?.trim() || undefined;
  /** Secrets are kept exactly as given: only a blank one counts as unset. */
  const readSecret = (name: string): string | undefined => (env[name]?.trim() ? env[name] : undefined);
  const required = (name: string, value = read(name)): string | undefined => {
    if (value === undefined) missing.push(name);
    return value;
  };

  function oneOf<T extends string>(name: string, values: readonly T[], fallback: T): T;
  function oneOf<T extends string>(name: string, values: readonly T[], fallback?: T): T | undefined;
  function oneOf<T extends string>(name: string, values: readonly T[], fallback?: T): T | undefined {
    const value = fallback === undefined ? required(name) : read(name);
    if (value === undefined) return fallback;
    if ((values as readonly string[]).includes(value)) return value as T;
    bad(name, `must be one of ${values.join(', ')}`);
    return fallback;
  }

  function integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = read(name);
    if (value === undefined) return fallback;
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
    bad(
      name,
      max === Number.MAX_SAFE_INTEGER
        ? `must be a whole number of at least ${min}`
        : `must be a whole number from ${min} to ${max}`,
    );
    return fallback;
  }

  function decimal(name: string, fallback: number, ok: (n: number) => boolean, rule: string): number {
    const value = read(name);
    if (value === undefined) return fallback;
    const n = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (Number.isFinite(n) && ok(n)) return n;
    bad(name, rule);
    return fallback;
  }

  /** The value as given when it is an http(s) URL; otherwise reported, and ''. */
  function httpUrl(name: string, value: string): string {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (url?.protocol === 'https:' || url?.protocol === 'http:') return value;
    bad(name, 'must be an http or https URL');
    return '';
  }

  /** A display name: at most 80 characters on one line (it reaches mail headers and the extension). */
  function displayName(name: string, value: string): string {
    if (value.length <= MAX_DISPLAY_NAME && !/\p{Cc}/u.test(value)) return value;
    bad(name, 'must be 1 to 80 characters on one line');
    return '';
  }

  /** Comma-separated list: entries trimmed, blanks and repeats dropped. */
  const list = (value: string) => [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  // Server and database
  const publicUrl = parsePublicUrl(required('PUBLIC_URL'));
  const host = read('HOST') ?? '127.0.0.1';
  const port = integer('PORT', 8787, 1, 65535);
  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    bad('DATABASE_URL', 'must start with postgres:// or postgresql://');
  }
  const authSecret = required('BETTER_AUTH_SECRET', readSecret('BETTER_AUTH_SECRET'));
  if (authSecret !== undefined && authSecret.length < 32) bad('BETTER_AUTH_SECRET', 'must be at least 32 characters');

  // Identity of this instance
  const instanceNameValue = read('INSTANCE_NAME');
  const instanceName = instanceNameValue ? displayName('INSTANCE_NAME', instanceNameValue) : (publicUrl?.host ?? '');
  // Unset, the name is the PUBLIC_URL host, which must fit the same limit (the discovery document refuses a longer one).
  if (!instanceNameValue && instanceName.length > MAX_DISPLAY_NAME) {
    bad('INSTANCE_NAME', 'must be set when the PUBLIC_URL host is longer than 80 characters');
  }
  const sourceValue = read('SOURCE_URL');
  const sourceUrl = sourceValue
    ? httpUrl('SOURCE_URL', sourceValue)
    : `https://github.com/HeitechSoft/unalgorithm/tree/server-v${SERVER_VERSION}`;
  const billing = oneOf('BILLING', ['off', 'module'] as const, 'off');
  const billingModule = read('BILLING_MODULE');
  if (billing === 'module') {
    required('BILLING_MODULE', billingModule);
    if (billingModule !== undefined && !(isAbsolute(billingModule) && MODULE_FILE.test(billingModule))) {
      bad('BILLING_MODULE', 'must be an absolute path to a .ts, .mts, .js or .mjs file');
    }
  } else if (billingModule !== undefined && !invalid.some((i) => i.name === 'BILLING')) {
    // A path left behind with billing off would look as if a module ran.
    bad('BILLING_MODULE', 'must be unset when BILLING is off');
  }

  // Who may use it
  const extensionIdsValue = read('EXTENSION_IDS');
  const extensionIds = extensionIdsValue ? list(extensionIdsValue) : [DEV_EXTENSION_ID];
  if (!extensionIds.length || !extensionIds.every((id) => ExtensionIdSchema.safeParse(id).success)) {
    bad('EXTENSION_IDS', 'must be a comma-separated list of extension ids (32 letters a to p)');
  }
  const allowlistValue = read('SIGNUP_ALLOWLIST');
  const signupAllowlist = allowlistValue ? list(allowlistValue.toLowerCase()) : [];
  // An `@domain` entry is valid when an address at that domain would be.
  if (!signupAllowlist.every((entry) => Email.safeParse(entry.startsWith('@') ? `user${entry}` : entry).success)) {
    bad('SIGNUP_ALLOWLIST', 'must be a comma-separated list of email addresses or @domain entries');
  }
  const trustProxy = oneOf('TRUST_PROXY', ['none', 'one-hop'] as const, 'none');

  // Mail
  const smtpHost = required('SMTP_HOST');
  const smtpPort = integer('SMTP_PORT', 587, 1, 65535);
  const smtpSecure = oneOf('SMTP_SECURE', ['starttls', 'tls', 'none'] as const, 'starttls');
  // Local means loopback or a single-label name (a Compose service); a dot or a colon (an IPv6 literal) means remote.
  if (smtpSecure === 'none' && smtpHost !== undefined && !LOOPBACK_HOSTS.has(smtpHost) && /[.:]/.test(smtpHost)) {
    bad('SMTP_SECURE', 'none is allowed only for a local mail server (localhost, ::1 or a name without dots)');
  }
  const smtpUser = read('SMTP_USER');
  const smtpPassword = readSecret('SMTP_PASSWORD');
  if ((smtpUser === undefined) !== (smtpPassword === undefined)) {
    bad(smtpUser === undefined ? 'SMTP_PASSWORD' : 'SMTP_USER', 'set SMTP_USER and SMTP_PASSWORD together, or neither');
  }
  const mailFrom = required('MAIL_FROM');
  if (mailFrom !== undefined && !Email.safeParse(mailFrom).success) bad('MAIL_FROM', 'must be an email address');
  const mailFromNameValue = read('MAIL_FROM_NAME');
  const mailFromName = mailFromNameValue ? displayName('MAIL_FROM_NAME', mailFromNameValue) : instanceName;

  // Sign in with Google (optional)
  const googleId = read('GOOGLE_CLIENT_ID');
  const googleSecret = readSecret('GOOGLE_CLIENT_SECRET');
  if ((googleId === undefined) !== (googleSecret === undefined)) {
    bad(
      googleId === undefined ? 'GOOGLE_CLIENT_ID' : 'GOOGLE_CLIENT_SECRET',
      'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET together, or neither',
    );
  }

  // AI provider
  const provider = oneOf('AI_PROVIDER', ['anthropic', 'openai-compatible'] as const);
  const anthropic = provider === 'anthropic';
  const compatible = provider === 'openai-compatible';
  const model = read('AI_MODEL') ?? (anthropic ? ANTHROPIC_DEFAULT_MODEL : undefined);
  if (compatible) required('AI_MODEL', model);
  const apiKey = readSecret('AI_API_KEY');
  if (anthropic) required('AI_API_KEY', apiKey);
  const baseUrlValue = read('AI_BASE_URL');
  if (compatible) required('AI_BASE_URL', baseUrlValue);
  if (anthropic && baseUrlValue !== undefined) bad('AI_BASE_URL', 'must be unset when AI_PROVIDER is anthropic');
  const baseUrl = compatible && baseUrlValue !== undefined ? httpUrl('AI_BASE_URL', baseUrlValue) : undefined;
  const dataPolicy = compatible
    ? oneOf('AI_DATA_POLICY', ['vendor-zdr', 'self-hosted'] as const)
    : oneOf('AI_DATA_POLICY', ['vendor-zdr', 'self-hosted'] as const, 'vendor-zdr');
  if (anthropic && dataPolicy === 'self-hosted') bad('AI_DATA_POLICY', 'must be vendor-zdr when AI_PROVIDER is anthropic');

  // Fact-check (Labs). Every name is read on every load, so the parity test sees them with fact-check off too.
  const factcheck = oneOf('FACTCHECK', ['off', 'on'] as const, 'off');
  const factcheckOn = factcheck === 'on';
  const claimCacheOn = oneOf('CLAIM_CACHE', ['off', 'on'] as const, 'on') === 'on';
  const researchModelValue = read('AI_RESEARCH_MODEL');
  const synthesisModelValue = read('AI_SYNTHESIS_MODEL');
  const searchValue = read('SEARCH_PROVIDER');
  const searchUrlValue = read('SEARCH_URL');
  const searchApiKey = readSecret('SEARCH_API_KEY');
  let search: Config['factcheck']['search'] = null;
  if (!factcheckOn) {
    // A setting left behind with fact-check off would look as if it ran.
    if (!invalid.some((i) => i.name === 'FACTCHECK')) {
      const settings = {
        AI_RESEARCH_MODEL: researchModelValue,
        AI_SYNTHESIS_MODEL: synthesisModelValue,
        SEARCH_PROVIDER: searchValue,
        SEARCH_URL: searchUrlValue,
        SEARCH_API_KEY: searchApiKey,
      };
      for (const [name, value] of Object.entries(settings)) {
        if (value !== undefined) bad(name, 'must be unset when FACTCHECK is off');
      }
    }
  } else {
    const searchProvider = searchValue === undefined ? undefined : oneOf('SEARCH_PROVIDER', SEARCH_PROVIDERS);
    if (searchProvider === 'searxng') {
      const url = required('SEARCH_URL', searchUrlValue);
      if (searchApiKey !== undefined) bad('SEARCH_API_KEY', 'must be unset when SEARCH_PROVIDER is searxng');
      search = { provider: searchProvider, url: url === undefined ? undefined : httpUrl('SEARCH_URL', url) };
    } else if (searchProvider !== undefined) {
      required('SEARCH_API_KEY', searchApiKey);
      if (searchUrlValue !== undefined) bad('SEARCH_URL', `must be unset when SEARCH_PROVIDER is ${searchProvider}`);
      search = { provider: searchProvider, apiKey: searchApiKey };
    } else if (searchValue === undefined) {
      if (searchUrlValue !== undefined) bad('SEARCH_URL', 'must be unset when SEARCH_PROVIDER is unset');
      if (searchApiKey !== undefined) bad('SEARCH_API_KEY', 'must be unset when SEARCH_PROVIDER is unset');
      if (compatible) bad('SEARCH_PROVIDER', 'an OpenAI-compatible model cannot search the web: set SEARCH_PROVIDER');
    }
    if (researchModelValue !== undefined && searchValue !== undefined) {
      bad('AI_RESEARCH_MODEL', 'unused when SEARCH_PROVIDER is set');
    }
    if (billing === 'module') {
      // Decision D12: Anthropic web search is the one research path with a price card.
      const why = 'a billing server researches with Anthropic web search only, so every check is priced';
      if (compatible) bad('AI_PROVIDER', `must be anthropic when BILLING is module and FACTCHECK is on: ${why}`);
      if (searchValue !== undefined) bad('SEARCH_PROVIDER', `must be unset when BILLING is module: ${why}`);
    }
  }
  // Other perspectives (Labs, decision D33): read on every load, like the fact-check names.
  const perspectives = oneOf('PERSPECTIVES', ['off', 'on'] as const, 'off');
  if (perspectives === 'on' && !factcheckOn) {
    bad('PERSPECTIVES', 'must be off when FACTCHECK is off: perspectives uses the fact-check routes and search provider');
  }
  /** Unset: Sonnet on Anthropic; the classify model on an OpenAI-compatible server (one model serves every task). */
  const factcheckModel = (value: string | undefined) => value ?? (anthropic ? FACTCHECK_MODELS.research : (model ?? ''));

  // Limits
  const routeEvalMinAgreement = decimal('ROUTE_EVAL_MIN_AGREEMENT', 0.8, (n) => n <= 1, 'must be a number from 0 to 1');
  const userDailyPostCap = integer('USER_DAILY_POST_CAP', 1000, 0);
  const userRequestsPerMinute = integer('USER_REQUESTS_PER_MINUTE', 30, 1);
  const dailySpendLimitUsd = decimal(
    'DAILY_SPEND_LIMIT_USD',
    5,
    (n) => n > 0 && n <= 1_000_000,
    'must be a number of dollars above 0 and at most 1000000',
  );
  const userDailyCheckCap = integer('USER_DAILY_CHECK_CAP', 10, 0);
  const egressDenyValue = read('EGRESS_DENY');
  const egressDeny = egressDenyValue ? list(egressDenyValue) : [];
  try {
    // The egress fetcher's own parser, so an entry accepted here never fails there.
    denyList(egressDeny);
  } catch {
    bad('EGRESS_DENY', 'must be IP addresses or ip/prefix ranges (prefix up to 32 for IPv4, 128 for IPv6), comma-separated');
  }

  // Alerts (CL4-15): 0 turns a rule off.
  const gigabytes = (name: string, fallback: number, alert: string) =>
    decimal(name, fallback, (n) => n >= 0, `must be a number of GB, 0 or more (0 turns ${alert} off)`);
  const diskFreeMinGb = gigabytes('ALERT_DISK_FREE_MIN_GB', 5, 'disk-free-low');
  const databaseMaxGb = gigabytes('ALERT_DATABASE_MAX_GB', 10, 'database-size-high');
  const errorsPer15m = integer('ALERT_ERRORS_PER_15M', 20, 0);
  const backupMaxAgeHours = integer('ALERT_BACKUP_MAX_AGE_HOURS', 26, 0);
  const alertEmail = parseAlertEmail(read('ALERT_EMAIL'));
  const webhookValue = readSecret('ALERT_WEBHOOK_URL');
  const webhookUrl = webhookValue === undefined ? undefined : httpUrl('ALERT_WEBHOOK_URL', webhookValue);
  const metricsToken = readSecret('METRICS_TOKEN');
  if (metricsToken !== undefined && metricsToken.length < 32) bad('METRICS_TOKEN', 'must be at least 32 characters');

  // Runtime
  const webDistValue = read('WEB_DIST');
  const webDist = webDistValue ? resolve(webDistValue) : DEFAULT_WEB_DIST;
  const backupStatusDir = read('BACKUP_STATUS_DIR');
  if (backupStatusDir !== undefined && !isAbsolute(backupStatusDir)) bad('BACKUP_STATUS_DIR', 'must be an absolute path');
  const logLevel = oneOf('LOG_LEVEL', LOG_LEVELS, 'info');
  // Better Auth reads this variable itself, untrimmed: any value but '', '0' or 'false' (any case) turns telemetry on.
  const telemetry = env.BETTER_AUTH_TELEMETRY;
  if (telemetry !== undefined && telemetry !== '' && telemetry !== '0' && telemetry.toLowerCase() !== 'false') {
    bad('BETTER_AUTH_TELEMETRY', 'telemetry must stay off: unset it, or set it to 0 or false');
  }
  // The Anthropic SDK adds these headers to every request whatever its options, even over the API key, so the server
  // could no longer be sure which account a request runs under or what it carries.
  if (read('ANTHROPIC_CUSTOM_HEADERS') !== undefined) {
    bad('ANTHROPIC_CUSTOM_HEADERS', 'must be unset: no environment variable may change the AI client');
  }

  if (missing.length || invalid.length) throw new ConfigError(missing, invalid);

  // Every value below was checked above; the fallbacks only satisfy the types.
  const origin = publicUrl?.origin ?? '';
  return {
    publicUrl: origin,
    publicOrigin: origin,
    host,
    port,
    databaseUrl: databaseUrl ?? '',
    authSecret: authSecret ?? '',
    instanceName,
    sourceUrl,
    billing,
    billingModule: billing === 'module' ? billingModule : undefined,
    billingEnv: billing === 'module' ? moduleEnv(env) : Object.freeze({}),
    extensionIds,
    signupAllowlist,
    trustProxy,
    smtp: {
      host: smtpHost ?? '',
      port: smtpPort,
      secure: smtpSecure,
      user: smtpUser,
      password: smtpPassword,
      from: mailFrom ?? '',
      fromName: mailFromName,
    },
    google: googleId !== undefined && googleSecret !== undefined ? { clientId: googleId, clientSecret: googleSecret } : undefined,
    ai: {
      provider: provider ?? 'anthropic',
      model: model ?? '',
      apiKey,
      baseUrl,
      dataPolicy: dataPolicy ?? 'vendor-zdr',
    },
    factcheck: {
      enabled: factcheckOn,
      researchModel: factcheckModel(researchModelValue),
      synthesisModel: factcheckModel(synthesisModelValue),
      search,
      userDailyCheckCap,
      claimCache: claimCacheOn && factcheckOn,
    },
    perspectives: { enabled: perspectives === 'on' && factcheckOn },
    egressDeny,
    routeEvalMinAgreement,
    userDailyPostCap,
    userRequestsPerMinute,
    dailySpendLimitMicros: Math.round(dailySpendLimitUsd * 1_000_000),
    alerts: {
      diskFreeMinBytes: Math.round(diskFreeMinGb * GB),
      databaseMaxBytes: Math.round(databaseMaxGb * GB),
      errorsPer15m,
      backupMaxAgeMs: backupMaxAgeHours * HOUR_MS,
      email: alertEmail,
      webhookUrl,
    },
    metricsToken,
    webDist,
    backupStatusDir,
    logLevel,
    version: SERVER_VERSION,
  };

  /** Unset: the active admins; `none`: no email; otherwise 1 to 20 addresses, comma-separated, kept in lowercase. */
  function parseAlertEmail(value: string | undefined): AlertEmail {
    if (value === undefined) return { kind: 'admins' };
    if (value.toLowerCase() === 'none') return { kind: 'none' };
    const addresses = list(value.toLowerCase());
    if (addresses.length >= 1 && addresses.length <= MAX_ALERT_EMAILS && addresses.every((a) => Email.safeParse(a).success)) {
      return { kind: 'list', addresses };
    }
    bad('ALERT_EMAIL', 'must be email addresses, comma-separated, or none');
    return { kind: 'none' };
  }

  /**
   * The module's variables, values exactly as given (secrets). Blank counts as unset, as for the server's own: Compose
   * passes an unset `${VAR}` as ''.
   */
  function moduleEnv(from: Env): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of Object.keys(from)) {
      const value = from[name];
      if (name !== 'BILLING_MODULE' && BILLING_ENV_NAME.test(name) && value?.trim()) out[name] = value;
    }
    return Object.freeze(out);
  }

  /**
   * An origin only: https, or http for a loopback host; no path, query, fragment or credentials, and no trailing slash.
   * The slash is checked on the raw string (a URL's pathname is `/` either way): the caddy profile's Caddyfile uses the
   * raw value as its site address, where `https://host/` would proxy the path `/` alone.
   */
  function parsePublicUrl(value: string | undefined): URL | undefined {
    if (value === undefined) return undefined;
    if (value.endsWith('/')) {
      bad('PUBLIC_URL', 'must be written without a trailing slash');
      return undefined;
    }
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      bad('PUBLIC_URL', 'must be an https URL');
    } else if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
      bad('PUBLIC_URL', 'must use https unless the host is localhost, 127.0.0.1 or [::1]');
    } else if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      bad('PUBLIC_URL', 'must be an origin only, with no path, query, fragment or credentials');
    } else {
      return url;
    }
    return undefined;
  }
}
