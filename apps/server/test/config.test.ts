import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, SERVER_VERSION } from '../src/config.ts';
import { createLogger, errorFields, type LogLevel } from '../src/log.ts';

/** Distinctive secret values: none of them may ever appear in an error, a reason or CLI output. */
const AUTH_SECRET = 'auth-secret-QXZ7-distinctive-0123456789abcdef';
const API_KEY = 'sk-ant-api-key-QXZ7-distinctive';
const SMTP_PASSWORD = 'smtp-password-QXZ7-distinctive';
/** Under 32 characters, so it fails the length rule: a too-short secret is still a secret. */
const SHORT_AUTH_SECRET = 'shortQXZ7auth';
const SECRETS = [AUTH_SECRET, API_KEY, SMTP_PASSWORD, SHORT_AUTH_SECRET];

const DEV_EXTENSION_ID = 'aokmlebkpkeniofcnbeajmgabinicggm';

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
    expect(config.extensionIds).toEqual([DEV_EXTENSION_ID]);
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

    const trailing = loadConfig({ ...minimalEnv(), PUBLIC_URL: 'https://x.org/' });
    expect(trailing.publicUrl).toBe('https://x.org');
    expect(trailing.publicOrigin).toBe('https://x.org');

    expect(invalidNames({ ...minimalEnv(), PUBLIC_URL: 'https://x.org/app' })).toEqual(['PUBLIC_URL']);
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

  it('test_config_billing_and_allowlist', () => {
    expect(invalidNames({ ...minimalEnv(), BILLING: 'on' })).toEqual(['BILLING']);

    const config = loadConfig({ ...minimalEnv(), SIGNUP_ALLOWLIST: 'Tom@Example.com, @heitechsoft.com' });
    expect(config.signupAllowlist).toEqual(['tom@example.com', '@heitechsoft.com']);
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
    });
    expect(err.invalid.length).toBeGreaterThan(10);
    const texts = [err.message, ...err.invalid.map((i) => i.reason), ...err.invalid.map((i) => i.name)];
    for (const text of texts) {
      for (const secret of SECRETS) expect(text).not.toContain(secret);
    }
    expect(err.invalid.map((i) => i.name)).toContain('BETTER_AUTH_SECRET');
  });
});

describe('logger', () => {
  function capture(level: LogLevel) {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (line) => lines.push(line) });
    const parsed = () =>
      lines
        .join('')
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { log, lines, parsed };
  }

  it('test_logger_json_lines_and_levels', () => {
    const { log, lines, parsed } = capture('info');
    log.debug('debug.dropped', { n: 1 });
    log.info('server.started', { port: 8787, version: '0.1.0' });
    log.warn('rate.limited', { ok: false, rid: null });
    log.child({ rid: 'r1' }).error('http.error', { status: 500 });

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.endsWith('\n')).toBe(true);
    const [started, limited, failed] = parsed();
    for (const entry of [started, limited, failed]) {
      expect(typeof entry?.t).toBe('string');
      expect(new Date(entry?.t as string).toISOString()).toBe(entry?.t);
    }
    expect(started).toMatchObject({ level: 'info', event: 'server.started', port: 8787, version: '0.1.0' });
    expect(limited).toMatchObject({ level: 'warn', event: 'rate.limited', ok: false, rid: null });
    expect(failed).toMatchObject({ level: 'error', event: 'http.error', rid: 'r1', status: 500 });

    // Fields never replace the three fixed keys.
    log.info('real.event', { event: 'spoofed', level: 'error', t: 'never' });
    const spoof = parsed().at(-1);
    expect(spoof).toMatchObject({ event: 'real.event', level: 'info' });
    expect(spoof?.t).not.toBe('never');

    // There is no way to log an object, even past the type checker.
    log.info('body.attempt', { body: { text: 'post text' } as unknown as string });
    expect(lines.at(-1)).not.toContain('post text');
  });

  it('test_logger_truncates_strings', () => {
    const { log, parsed } = capture('debug');
    log.debug('long.field', { text: 'x'.repeat(300) });
    // No key gets more room, err_stack included.
    log.debug('long.stack', { err_stack: 'z'.repeat(1500) });
    const [entry, stack] = parsed();
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

describe('cli', () => {
  const serverDir = fileURLToPath(new URL('..', import.meta.url));
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['src/cli/check-config.ts'], { env, cwd: serverDir, encoding: 'utf8' });

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
});
