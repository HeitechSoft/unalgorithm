import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DEV_CHROMIUM_ID, FIREFOX_ADDON_ID, FIREFOX_DEV_ADDON_ID } from '@unalgorithm/protocol';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { CONFIG_VARIABLES, ConfigError, loadConfig, SERVER_VERSION } from '../src/config.ts';
import { errorFields } from '../src/log.ts';
import { captureLog } from './support/log.ts';
import { PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

/** Distinctive secret values: none of them may ever appear in an error, a reason or CLI output. */
const AUTH_SECRET = 'auth-secret-QXZ7-distinctive-0123456789abcdef';
const API_KEY = 'sk-ant-api-key-QXZ7-distinctive';
const SMTP_PASSWORD = 'smtp-password-QXZ7-distinctive';
/** Under 32 characters, so it fails the length rule: a too-short secret is still a secret. */
const SHORT_AUTH_SECRET = 'shortQXZ7auth';
const SECRETS = [AUTH_SECRET, API_KEY, SMTP_PASSWORD, SHORT_AUTH_SECRET];

const DEV_EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';
const FIREFOX_UUID_ID = '{daf44bf7-a45e-4450-979c-91cf07434c3d}';

/** The smallest environment an anthropic-backed server starts with. */
function minimalEnv(): Record<string, string> {
  return {
    PUBLIC_URL: 'https://cloud.example.org',
    DATABASE_URL: 'postgres://unalgorithm@db:5432/unalgorithm',
    BETTER_AUTH_SECRET: AUTH_SECRET,
    SMTP_HOST: 'smtp.example.org',
    MAIL_FROM: 'noreply@example.org',
    AI_PROVIDER: 'anthropic',
    AI_API_KEY: API_KEY,
  };
}

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

const invalidNames = (env: Record<string, string | undefined>) => configError(env).invalid.map((i) => i.name);
const isValid = (env: Record<string, string | undefined>) => {
  try {
    loadConfig(env);
    return true;
  } catch (err) {
    if (err instanceof ConfigError) return false;
    throw err;
  }
};

describe('defaults and required', () => {
  it('test_config_minimal_anthropic_defaults', () => {
    const config = loadConfig(minimalEnv());
    expect(config.instanceName).toBe('cloud.example.org');
    expect(config.ai).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      apiKey: API_KEY,
      baseUrl: undefined,
      dataPolicy: 'vendor-zdr',
    });
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.billing).toBe('off');
    // Every id this release knows: the development key's (Chrome and Edge) and both Firefox add-on ids.
    expect(config.extensionIds).toEqual([DEV_EXTENSION_ID, 'feed-dev@unalgorithmfeed.com', 'feed@unalgorithmfeed.com']);
    expect(config.extensionIds).toEqual([DEV_CHROMIUM_ID, FIREFOX_DEV_ADDON_ID, FIREFOX_ADDON_ID]);
    expect(config.signupAllowlist).toEqual([]);
    expect(config.dailySpendLimitMicros).toBe(5_000_000);

    // The remaining defaults from the ticket's table.
    expect(config.publicUrl).toBe('https://cloud.example.org');
    expect(config.publicOrigin).toBe('https://cloud.example.org');
    expect(config.sourceUrl).toBe(`https://github.com/HeitechSoft/unalgorithm/tree/server-v${SERVER_VERSION}`);
    expect(config.trustProxy).toBe('none');
    expect(config.smtp).toEqual({
      host: 'smtp.example.org',
      port: 587,
      secure: 'starttls',
      user: undefined,
      password: undefined,
      from: 'noreply@example.org',
      fromName: 'cloud.example.org',
    });
    expect(config.routeEvalMinAgreement).toBe(0.8);
    expect(config.userDailyPostCap).toBe(1000);
    expect(config.userRequestsPerMinute).toBe(30);
    expect(config.webDist).toBe(fileURLToPath(new URL('../../web/dist', import.meta.url)));
    expect(config.logLevel).toBe('info');
    expect(config.version).toBe(SERVER_VERSION);
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('test_config_empty_env_lists_missing', () => {
    const err = configError({});
    expect(err.missing).toEqual(['PUBLIC_URL', 'DATABASE_URL', 'BETTER_AUTH_SECRET', 'SMTP_HOST', 'MAIL_FROM', 'AI_PROVIDER']);
    expect(err.invalid).toEqual([]);
    // Blank values count as unset: Compose passes an unset `${VAR}` as an empty string.
    expect(configError({ ...minimalEnv(), DATABASE_URL: '  ' }).missing).toEqual(['DATABASE_URL']);
  });
});

describe('validation', () => {
  it('test_config_public_url_rules', () => {
    expect(invalidNames({ ...minimalEnv(), PUBLIC_URL: 'http://cloud.example.org' })).toEqual(['PUBLIC_URL']);

    const local = loadConfig({ ...minimalEnv(), PUBLIC_URL: 'http://127.0.0.1:8787' });
    expect(local.publicUrl).toBe('http://127.0.0.1:8787');
    expect(local.instanceName).toBe('127.0.0.1:8787');

    const plain = loadConfig({ ...minimalEnv(), PUBLIC_URL: 'https://x.org' });
    expect(plain.publicUrl).toBe('https://x.org');
    expect(plain.publicOrigin).toBe('https://x.org');

    // The raw string, as the caddy profile's Caddyfile reads it: a trailing / would become a site path that proxies
    // only `/`, so the server and check-config refuse it before Caddy runs.
    for (const trailing of ['https://x.org/', 'http://127.0.0.1:8787/']) {
      expect(configError({ ...minimalEnv(), PUBLIC_URL: trailing }).invalid, trailing).toEqual([
        { name: 'PUBLIC_URL', reason: 'must be written without a trailing slash' },
      ]);
    }

    expect(invalidNames({ ...minimalEnv(), PUBLIC_URL: 'https://x.org/app' })).toEqual(['PUBLIC_URL']);
  });

  it('test_config_instance_name_fallback_limit', () => {
    // Unset, INSTANCE_NAME falls back to the PUBLIC_URL host, which must then fit the same 80 characters.
    const host = `${'a'.repeat(60)}.${'b'.repeat(8)}.example.org`;
    expect(host).toHaveLength(81);
    expect(configError({ ...minimalEnv(), PUBLIC_URL: `https://${host}` }).invalid).toEqual([
      { name: 'INSTANCE_NAME', reason: 'must be set when the PUBLIC_URL host is longer than 80 characters' },
    ]);
    expect(loadConfig({ ...minimalEnv(), PUBLIC_URL: `https://${host}`, INSTANCE_NAME: 'Long host' }).instanceName).toBe(
      'Long host',
    );
    expect(loadConfig({ ...minimalEnv(), PUBLIC_URL: `https://${host.slice(1)}` }).instanceName).toBe(host.slice(1));
  });

  it('test_config_ai_provider_rules', () => {
    const { AI_API_KEY: _, ...noKey } = minimalEnv();

    const compat = configError({ ...noKey, AI_PROVIDER: 'openai-compatible' });
    expect(compat.missing).toEqual(['AI_MODEL', 'AI_BASE_URL', 'AI_DATA_POLICY']);

    expect(configError(noKey).missing).toEqual(['AI_API_KEY']);

    expect(invalidNames({ ...minimalEnv(), AI_BASE_URL: 'http://127.0.0.1:11434/v1' })).toEqual(['AI_BASE_URL']);
  });

  it('test_config_extension_ids', () => {
    expect(invalidNames({ ...minimalEnv(), EXTENSION_IDS: 'abc' })).toEqual(['EXTENSION_IDS']);

    const two = loadConfig({ ...minimalEnv(), EXTENSION_IDS: `${DEV_EXTENSION_ID},${'b'.repeat(32)}` });
    expect(two.extensionIds).toEqual([DEV_EXTENSION_ID, 'b'.repeat(32)]);

    // Firefox add-on ids, alone or among Chrome and Edge ids: trimmed and de-duplicated, never lower-cased (the
    // redirect address hashes the id exactly as written).
    const mixed = loadConfig({
      ...minimalEnv(),
      EXTENSION_IDS: ` ${DEV_EXTENSION_ID} , Feed@Example.org,${FIREFOX_UUID_ID},${'b'.repeat(32)}, Feed@Example.org `,
    });
    expect(mixed.extensionIds).toEqual([DEV_EXTENSION_ID, 'Feed@Example.org', FIREFOX_UUID_ID, 'b'.repeat(32)]);
    expect(loadConfig({ ...minimalEnv(), EXTENSION_IDS: 'a.b-c_d@x.y' }).extensionIds).toEqual(['a.b-c_d@x.y']);
    expect(loadConfig({ ...minimalEnv(), EXTENSION_IDS: FIREFOX_UUID_ID.toUpperCase() }).extensionIds).toEqual([
      FIREFOX_UUID_ID.toUpperCase(),
    ]);
    const longest = `${'a'.repeat(68)}@example.org`;
    expect(longest).toHaveLength(80);
    expect(isValid({ ...minimalEnv(), EXTENSION_IDS: longest })).toBe(true);

    // One bad entry refuses the whole list, whichever browser's form it misses.
    for (const bad of [
      `b${longest}`,
      'feed@',
      '@',
      'feed',
      'feed@unalgorithm feed.com',
      'a@b@c',
      '{daf44bf7-a45e-4450-979c}',
      'daf44bf7-a45e-4450-979c-91cf07434c3d',
      'chrome-extension://aokmlebkpkeniofcnbeajmgabinicggm',
      'moz-extension://daf44bf7-a45e-4450-979c-91cf07434c3d',
      DEV_EXTENSION_ID.toUpperCase(),
    ]) {
      expect(invalidNames({ ...minimalEnv(), EXTENSION_IDS: `${DEV_EXTENSION_ID},${bad}` }), bad).toEqual(['EXTENSION_IDS']);
    }
    expect(invalidNames({ ...minimalEnv(), EXTENSION_IDS: ' , ' })).toEqual(['EXTENSION_IDS']);

    // The rule names both browsers' forms, and no value.
    const err = configError({ ...minimalEnv(), EXTENSION_IDS: 'feed@,secret-QXZ7-value' });
    expect(err.invalid).toEqual([
      {
        name: 'EXTENSION_IDS',
        reason:
          'must be a comma-separated list of extension ids (Chrome and Edge: 32 letters a to p; Firefox: name@domain or {uuid}, up to 80 characters)',
      },
    ]);
    expect(err.message).not.toContain('QXZ7');
  });

  it('test_config_smtp_rules', () => {
    expect(loadConfig({ ...minimalEnv(), SMTP_HOST: 'mailpit', SMTP_SECURE: 'none' }).smtp.secure).toBe('none');
    expect(invalidNames({ ...minimalEnv(), SMTP_HOST: 'mail.smtp2go.com', SMTP_SECURE: 'none' })).toEqual(['SMTP_SECURE']);
    // An IPv6 literal has no dots but is a remote host, bracketed or not; only loopback passes.
    expect(invalidNames({ ...minimalEnv(), SMTP_HOST: '2001:db8::25', SMTP_SECURE: 'none' })).toEqual(['SMTP_SECURE']);
    expect(invalidNames({ ...minimalEnv(), SMTP_HOST: '[2001:db8::25]', SMTP_SECURE: 'none' })).toEqual(['SMTP_SECURE']);
    expect(isValid({ ...minimalEnv(), SMTP_HOST: '::1', SMTP_SECURE: 'none' })).toBe(true);
    expect(isValid({ ...minimalEnv(), SMTP_HOST: 'localhost', SMTP_SECURE: 'none' })).toBe(true);
    expect(invalidNames({ ...minimalEnv(), SMTP_USER: 'mailer' })).toEqual(['SMTP_USER']);
  });

  it('test_config_refuses_better_auth_telemetry', () => {
    expect(invalidNames({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: '1' })).toEqual(['BETTER_AUTH_TELEMETRY']);
    expect(invalidNames({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: 'true' })).toEqual(['BETTER_AUTH_TELEMETRY']);
    expect(isValid({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: undefined })).toBe(true);
    expect(isValid({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: '0' })).toBe(true);
    expect(isValid({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: 'false' })).toBe(true);
    // Better Auth reads the raw value: blank-only or padded values turn telemetry on, so they are refused here too.
    for (const value of [' ', '0 ', ' false']) {
      expect(invalidNames({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: value })).toEqual(['BETTER_AUTH_TELEMETRY']);
    }
    expect(isValid({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: '' })).toBe(true);
    expect(isValid({ ...minimalEnv(), BETTER_AUTH_TELEMETRY: 'FALSE' })).toBe(true);
  });

  it('test_config_refuses_anthropic_custom_headers', () => {
    // The Anthropic SDK adds these to every request, over the API key too, whatever the client's options.
    expect(invalidNames({ ...minimalEnv(), ANTHROPIC_CUSTOM_HEADERS: 'x-probe: injected' })).toEqual([
      'ANTHROPIC_CUSTOM_HEADERS',
    ]);
    expect(
      invalidNames({
        ...minimalEnv(),
        AI_PROVIDER: 'openai-compatible',
        AI_MODEL: 'llama',
        AI_BASE_URL: 'http://ollama:11434/v1',
        AI_DATA_POLICY: 'self-hosted',
        ANTHROPIC_CUSTOM_HEADERS: 'x-probe: injected',
      }),
    ).toEqual(['ANTHROPIC_CUSTOM_HEADERS']);
    // The SDK ignores a blank value, as unset.
    expect(isValid({ ...minimalEnv(), ANTHROPIC_CUSTOM_HEADERS: ' ' })).toBe(true);
    expect(isValid({ ...minimalEnv(), ANTHROPIC_CUSTOM_HEADERS: undefined })).toBe(true);
  });

  it('test_backup_status_dir_must_be_absolute', () => {
    const err = configError({ ...minimalEnv(), BACKUP_STATUS_DIR: 'relative/dir' });
    expect(err.invalid).toEqual([{ name: 'BACKUP_STATUS_DIR', reason: 'must be an absolute path' }]);
    expect(err.message).toContain('BACKUP_STATUS_DIR');
    expect(err.message).not.toContain('relative/dir');
    expect(loadConfig({ ...minimalEnv(), BACKUP_STATUS_DIR: '/backup-status' }).backupStatusDir).toBe('/backup-status');
    expect(loadConfig(minimalEnv()).backupStatusDir).toBeUndefined();
    expect(CONFIG_VARIABLES).toContain('BACKUP_STATUS_DIR');
  });

  it('test_config_billing_and_allowlist', () => {
    expect(invalidNames({ ...minimalEnv(), BILLING: 'on' })).toEqual(['BILLING']);
    // A module path beside an unknown BILLING is not also reported as "set while off".
    expect(invalidNames({ ...minimalEnv(), BILLING: 'on', BILLING_MODULE: '/srv/billing/index.ts' })).toEqual(['BILLING']);

    const config = loadConfig({ ...minimalEnv(), SIGNUP_ALLOWLIST: 'Tom@Example.com, @heitechsoft.com' });
    expect(config.signupAllowlist).toEqual(['tom@example.com', '@heitechsoft.com']);
  });

  it('test_signup_mode_default_open_and_invalid', () => {
    expect(loadConfig(minimalEnv()).signup).toBe('allowlist');
    expect(loadConfig({ ...minimalEnv(), SIGNUP: 'open' }).signup).toBe('open');
    // Open needs no allowlist.
    expect(loadConfig({ ...minimalEnv(), SIGNUP: 'open', SIGNUP_ALLOWLIST: '' }).signupAllowlist).toEqual([]);

    const err = configError({ ...minimalEnv(), SIGNUP: 'public' });
    expect(err.invalid.map((i) => i.name)).toEqual(['SIGNUP']);
    expect(err.message).toContain('invalid: SIGNUP (must be one of allowlist, open)');
    expect(err.message).not.toContain('public');
    expect(CONFIG_VARIABLES.indexOf('SIGNUP')).toBe(CONFIG_VARIABLES.indexOf('SIGNUP_ALLOWLIST') - 1);
  });

  it('test_config_errors_never_echo_secrets', () => {
    // Every secret is set but something is wrong with it, or with a variable beside it.
    const err = configError({
      ...minimalEnv(),
      PUBLIC_URL: `https://${AUTH_SECRET}.example.org/${API_KEY}`,
      DATABASE_URL: `mysql://user:${SMTP_PASSWORD}@db/ua`,
      BETTER_AUTH_SECRET: SHORT_AUTH_SECRET,
      AI_BASE_URL: `https://${API_KEY}.example.org`,
      AI_DATA_POLICY: API_KEY,
      SMTP_PASSWORD,
      SMTP_SECURE: SMTP_PASSWORD,
      INSTANCE_NAME: AUTH_SECRET.repeat(3),
      EXTENSION_IDS: API_KEY,
      SIGNUP_ALLOWLIST: SMTP_PASSWORD,
      PORT: API_KEY,
      LOG_LEVEL: AUTH_SECRET,
      BETTER_AUTH_TELEMETRY: AUTH_SECRET,
      ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${API_KEY}`,
    });
    expect(err.invalid.length).toBeGreaterThan(10);
    const texts = [err.message, ...err.invalid.map((i) => i.reason), ...err.invalid.map((i) => i.name)];
    for (const text of texts) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(err.invalid.map((i) => i.name)).toContain('BETTER_AUTH_SECRET');
  });
});

describe('billing variables', () => {
  /** A distinctive path: a module path may say where the private code lives, so no error repeats it. */
  const MODULE_PATH = '/srv/QXZ7-billing/index.ts';

  it('test_billing_module_requires_absolute_path', () => {
    const missing = configError({ ...minimalEnv(), BILLING: 'module' });
    expect(missing.message).toContain('missing: BILLING_MODULE');
    expect(missing.missing).toEqual(['BILLING_MODULE']);
    // Blank counts as unset, as for every variable.
    expect(configError({ ...minimalEnv(), BILLING: 'module', BILLING_MODULE: ' ' }).missing).toEqual(['BILLING_MODULE']);

    const refused = [
      configError({ ...minimalEnv(), BILLING: 'module', BILLING_MODULE: 'relative/QXZ7-billing/index.ts' }),
      configError({ ...minimalEnv(), BILLING: 'module', BILLING_MODULE: '/x/QXZ7-billing/index.json' }),
      configError({ ...minimalEnv(), BILLING: 'module', BILLING_MODULE: '/x/QXZ7-billing' }),
      configError({ ...minimalEnv(), BILLING: 'off', BILLING_MODULE: MODULE_PATH }),
      // Unset, BILLING is off.
      configError({ ...minimalEnv(), BILLING_MODULE: MODULE_PATH }),
    ];
    for (const err of refused) {
      expect(err.message).toMatch(/^invalid: BILLING_MODULE \(.+\)$/m);
      expect(err.invalid.map((i) => i.name)).toEqual(['BILLING_MODULE']);
      expect(err.message).not.toContain('QXZ7');
    }
    expect(refused[0]?.message).toBe('invalid: BILLING_MODULE (must be an absolute path to a .ts, .mts, .js or .mjs file)');
    expect(refused[3]?.message).toBe('invalid: BILLING_MODULE (must be unset when BILLING is off)');

    for (const file of ['index.ts', 'index.mts', 'index.js', 'index.mjs']) {
      const path = `/srv/billing/${file}`;
      const config = loadConfig({ ...minimalEnv(), BILLING: 'module', BILLING_MODULE: path });
      expect(config.billing).toBe('module');
      expect(config.billingModule).toBe(path);
    }
    const off = loadConfig(minimalEnv());
    expect(off.billing).toBe('off');
    expect(off.billingModule).toBeUndefined();
  });

  it('test_billing_env_passthrough', () => {
    const env = {
      ...minimalEnv(),
      BILLING_MODULE: MODULE_PATH,
      BILLING_STARTER_SECRET: 's3cret',
      // Not the module's: lowercase, no name after the prefix, another prefix.
      BILLING_lower: 'x',
      BILLING_: 'x',
      BILLINGX: 'x',
      STRIPE_KEY: 'x',
    };
    const config = loadConfig({ ...env, BILLING: 'module' });
    expect(config.billingEnv).toStrictEqual({ BILLING_STARTER_SECRET: 's3cret' });
    expect(Object.isFrozen(config.billingEnv)).toBe(true);

    // Values are kept exactly as set (they may be secrets); a blank one counts as unset, as Compose passes `${VAR}`.
    const exact = loadConfig({ ...env, BILLING: 'module', BILLING_STARTER_SECRET: ' s3 cret ', BILLING_BLANK: '  ' });
    expect(exact.billingEnv).toStrictEqual({ BILLING_STARTER_SECRET: ' s3 cret ' });

    // Off, nothing is passed on, and the module's names are not the server's to check.
    expect(loadConfig({ ...minimalEnv(), BILLING: 'off', BILLING_STARTER_SECRET: 's3cret' }).billingEnv).toStrictEqual({});
    expect(loadConfig(minimalEnv()).billingEnv).toStrictEqual({});
    expect(CONFIG_VARIABLES).toContain('BILLING_MODULE');
    expect(CONFIG_VARIABLES).not.toContain('BILLING_STARTER_SECRET');

    // An error elsewhere never repeats a module variable.
    const err = configError({ ...env, BILLING: 'module', SMTP_HOST: undefined });
    expect(err.message).toBe('missing: SMTP_HOST');
    expect(err.message).not.toContain('s3cret');
  });
});

describe('logger', () => {
  it('test_logger_json_lines_and_levels', () => {
    const { log, lines, events } = captureLog('info');
    log.debug('debug.dropped', { n: 1 });
    log.info('server.started', { port: 8787, version: '0.1.0' });
    log.warn('rate.limited', { ok: false, rid: null });
    log.child({ rid: 'r1' }).error('http.error', { status: 500 });

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.endsWith('\n')).toBe(true);
    const [started, limited, failed] = events();
    for (const entry of [started, limited, failed]) {
      expect(typeof entry?.t).toBe('string');
      expect(new Date(entry?.t as string).toISOString()).toBe(entry?.t);
    }
    expect(started).toMatchObject({ level: 'info', event: 'server.started', port: 8787, version: '0.1.0' });
    expect(limited).toMatchObject({ level: 'warn', event: 'rate.limited', ok: false, rid: null });
    expect(failed).toMatchObject({ level: 'error', event: 'http.error', rid: 'r1', status: 500 });

    // Fields never replace the three fixed keys.
    log.info('real.event', { event: 'spoofed', level: 'error', t: 'never' });
    const spoof = events().at(-1);
    expect(spoof).toMatchObject({ event: 'real.event', level: 'info' });
    expect(spoof?.t).not.toBe('never');

    // There is no way to log an object, even past the type checker.
    log.info('body.attempt', { body: { text: 'post text' } as unknown as string });
    expect(lines.at(-1)).not.toContain('post text');
  });

  it('test_logger_truncates_strings', () => {
    const { log, events } = captureLog();
    log.debug('long.field', { text: 'x'.repeat(300) });
    // No key gets more room, err_stack included.
    log.debug('long.stack', { err_stack: 'z'.repeat(1500) });
    const [entry, stack] = events();
    expect(entry?.text).toBe('x'.repeat(200));
    expect(stack?.err_stack).toBe('z'.repeat(200));
  });

  it('test_error_fields_drop_message', () => {
    const plain = errorFields(new Error('secret text'));
    expect(JSON.stringify(plain)).not.toContain('secret text');
    expect(plain.err_name).toBe('Error');
    expect(plain.err_stack).toMatch(/^at /);
    expect(plain.err_stack?.split('\n').length).toBeLessThanOrEqual(10);

    // A deep stack keeps only the whole top frames that fit in the logger's 200-character cut.
    const deep = (n: number): Error => (n === 0 ? new Error('deep') : deep(n - 1));
    const deepStack = errorFields(deep(20)).err_stack ?? '';
    expect(deepStack.length).toBeGreaterThan(0);
    expect(deepStack.length).toBeLessThanOrEqual(200);
    for (const frame of deepStack.split('\n')) expect(frame).toMatch(/^at .+:\d+:\d+\)?$/);

    const coded = errorFields(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(coded.err_code).toBe('ECONNREFUSED');

    // A multi-line message (a provider echoing a response body) never leaks through the stack either.
    class EchoError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'EchoError';
      }
    }
    const echoed = errorFields(new EchoError('upstream said:\nsecret text\n    at fake (secret text)'));
    expect(JSON.stringify(echoed)).not.toContain('secret text');
    expect(echoed.err_name).toBe('EchoError');

    // Thrown non-errors are never echoed.
    expect(JSON.stringify(errorFields('secret text'))).not.toContain('secret text');
    expect(errorFields({ code: { nested: true } }).err_code).toBeUndefined();
  });
});

/** By absolute path, and run from a folder outside the repository: no CLI test depends on where Vitest runs. */
const CHECK_CONFIG = fileURLToPath(new URL('../src/cli/check-config.ts', import.meta.url));

describe('cli', { timeout: SPAWN_TIMEOUT }, () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [CHECK_CONFIG], { env, cwd: tmpdir(), encoding: 'utf8', timeout: PROCESS_TIMEOUT });

  it('test_check_config_cli_exit_codes', () => {
    const empty = run({});
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('missing: PUBLIC_URL, DATABASE_URL, BETTER_AUTH_SECRET, SMTP_HOST, MAIL_FROM, AI_PROVIDER');

    const ok = run({ ...minimalEnv(), SMTP_USER: 'mailer', SMTP_PASSWORD });
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(`config ok (server ${SERVER_VERSION})`);

    const bad = run({ ...minimalEnv(), BETTER_AUTH_SECRET: SHORT_AUTH_SECRET, SMTP_PASSWORD });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/^invalid: BETTER_AUTH_SECRET \(.+\)$/m);
    expect(bad.stderr).toMatch(/^invalid: SMTP_PASSWORD \(.+\)$/m);

    for (const out of [empty, ok, bad]) {
      for (const secret of SECRETS) expect(out.stdout + out.stderr).not.toContain(secret);
    }
  });

  it('test_check_config_cli_applies_routing_rules', () => {
    // Configurations loadConfig accepts but the server refuses at startup fail here too, before a deploy.
    const opus = run({ ...minimalEnv(), AI_MODEL: 'claude-opus-5-5' });
    expect(opus.status).toBe(1);
    expect(opus.stderr).toMatch(/^AI_MODEL claude-opus-5-5 is not eligible for zero data retention/m);
    expect(opus.stdout).toBe('');

    const vendor = run({
      ...minimalEnv(),
      AI_PROVIDER: 'openai-compatible',
      AI_MODEL: 'some-model',
      AI_BASE_URL: 'https://api.example.org/v1',
      AI_DATA_POLICY: 'vendor-zdr',
    });
    expect(vendor.status).toBe(1);
    expect(vendor.stderr).toMatch(/^AI_DATA_POLICY must be self-hosted when AI_PROVIDER is openai-compatible/m);

    for (const out of [opus, vendor]) {
      for (const secret of SECRETS) expect(out.stdout + out.stderr).not.toContain(secret);
      expect(out.stdout + out.stderr).not.toContain('api.example.org');
    }
  });
});

describe('node version', { timeout: SPAWN_TIMEOUT }, () => {
  /** As a file URL: `--import` resolves its argument like an `import` specifier. */
  const guard = new URL('../src/require-node.js', import.meta.url).href;
  /** Turning type stripping off stands in for a Node.js too old to have it. */
  const canTurnOff =
    spawnSync(process.execPath, ['--no-experimental-strip-types', '-p', 'Boolean(process.features.typescript)'], {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT,
    }).stdout.trim() === 'false';

  it.skipIf(!canTurnOff)('test_node_without_type_stripping_gets_a_clear_error', () => {
    const run = (...flags: string[]) =>
      spawnSync(process.execPath, [...flags, '--import', guard, CHECK_CONFIG], {
        env: minimalEnv(),
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT,
      });

    const old = run('--no-experimental-strip-types');
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/^This server needs Node\.js 22\.18 or newer/m);
    expect(old.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');

    // Where Node.js runs TypeScript, the check stays out of the way.
    const current = run();
    expect(current.status).toBe(0);
    expect(current.stdout.trim()).toBe(`config ok (server ${SERVER_VERSION})`);
  });

  it('test_scripts_preload_the_node_check', () => {
    // Every script that runs a .ts file goes through the check first.
    const scripts = Object.entries(pkg.scripts).filter(([, command]) => /^node .*\.ts$/.test(command));
    expect(scripts.map(([name]) => name)).toEqual(expect.arrayContaining(['check-config', 'dev', 'start']));
    for (const [name, command] of scripts)
      expect([name, command]).toEqual([name, expect.stringContaining('--import ./src/require-node.js ')]);
    // The same requirement, for package managers: type stripping is on by default from 22.18 and from 23.6.
    expect(pkg.engines.node).toBe('^22.18.0 || >=23.6.0');
  });
});
