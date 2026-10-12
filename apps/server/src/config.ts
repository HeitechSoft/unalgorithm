import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_DEFAULT_MODEL } from '@unalgorithm/ai';
import { ExtensionIdSchema } from '@unalgorithm/protocol';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { LOG_LEVELS, type LogLevel } from './log.ts';

/**
 * The server's whole configuration, read once from the environment at startup. Every variable the server reads is
 * parsed here, so the rest of the code receives typed values and never touches `process.env`.
 *
 * Errors name variables and rules, never values: values include secrets.
 */

export const SERVER_VERSION: string = pkg.version;

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
  billing: 'off';
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
  ai: {
    provider: 'anthropic' | 'openai-compatible';
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dataPolicy: 'vendor-zdr' | 'self-hosted';
  };
  routeEvalMinAgreement: number;
  userDailyPostCap: number;
  userRequestsPerMinute: number;
  /** The daily spend breaker, in integer micro-dollars. */
  dailySpendLimitMicros: number;
  webDist: string;
  logLevel: LogLevel;
  version: string;
}

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
const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const Email = z.email();

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
    if (value.length <= 80 && !/\p{Cc}/u.test(value)) return value;
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
  const sourceValue = read('SOURCE_URL');
  const sourceUrl = sourceValue
    ? httpUrl('SOURCE_URL', sourceValue)
    : `https://github.com/HeitechSoft/unalgorithm/tree/server-v${SERVER_VERSION}`;
  const billing = oneOf('BILLING', ['off'] as const, 'off');

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
  if (smtpSecure === 'none' && smtpHost !== undefined && !LOOPBACK_HOSTS.has(smtpHost) && smtpHost.includes('.')) {
    bad('SMTP_SECURE', 'none is allowed only for a local mail server (localhost or a name without dots)');
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

  // Runtime
  const webDistValue = read('WEB_DIST');
  const webDist = webDistValue ? resolve(webDistValue) : DEFAULT_WEB_DIST;
  const logLevel = oneOf('LOG_LEVEL', LOG_LEVELS, 'info');
  const telemetry = read('BETTER_AUTH_TELEMETRY');
  if (telemetry !== undefined && telemetry !== '0' && telemetry !== 'false') {
    bad('BETTER_AUTH_TELEMETRY', 'telemetry must stay off: unset it, or set it to 0 or false');
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
    ai: {
      provider: provider ?? 'anthropic',
      model: model ?? '',
      apiKey,
      baseUrl,
      dataPolicy: dataPolicy ?? 'vendor-zdr',
    },
    routeEvalMinAgreement,
    userDailyPostCap,
    userRequestsPerMinute,
    dailySpendLimitMicros: Math.round(dailySpendLimitUsd * 1_000_000),
    webDist,
    logLevel,
    version: SERVER_VERSION,
  };

  /** An origin only: https, or http for a loopback host; no path, query, fragment or credentials. */
  function parsePublicUrl(value: string | undefined): URL | undefined {
    if (value === undefined) return undefined;
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
