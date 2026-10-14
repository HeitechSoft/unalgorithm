import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findHostMarkers } from '../../../scripts/scan-public-repo.mjs';
import { CONFIG_VARIABLES, ConfigError, loadConfig } from '../src/config.ts';

/**
 * `apps/server/.env.example` is the self-hoster's copy of the configuration (CL1-25): every variable `loadConfig` reads
 * is in it with a comment, and it holds placeholders only.
 */
const ENV_EXAMPLE = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

/** Read by compose.yaml only (interpolation), never by the server. */
const COMPOSE_ONLY = ['POSTGRES_PASSWORD', 'BIND_ADDRESS', 'UNALGORITHM_VERSION'];
/** Pinned in compose.yaml's `environment:`, which wins over `env_file`: a value in `.env` would do nothing. */
const SET_BY_COMPOSE = ['HOST', 'WEB_DIST', 'DATABASE_URL'];
/** Their values are secrets: the example leaves every one of them empty. */
const SECRET_NAMES = ['BETTER_AUTH_SECRET', 'AI_API_KEY', 'SMTP_PASSWORD', 'GOOGLE_CLIENT_SECRET', 'POSTGRES_PASSWORD'];

interface EnvExampleEntry {
  name: string;
  value: string;
  /** A `# NAME=` line: documented, but not set. */
  commented: boolean;
  /** The prose comment above the entry (or above its group), one line per comment line; undefined when there is none. */
  comment: string | undefined;
}

/** `NAME=value`, or the same commented out. Prose comments never start with `NAME=`. */
const ENTRY = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * The entries of an env file in order. A comment belongs to the entries right below it, up to the next prose comment
 * or blank line, so a group of entries can share one comment.
 */
function parseEnvExample(text: string): EnvExampleEntry[] {
  const entries: EnvExampleEntry[] = [];
  let comment: string[] = [];
  let afterEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const entry = ENTRY.exec(line);
    if (entry) {
      const [, hash, name = '', value = ''] = entry;
      entries.push({ name, value, commented: hash !== undefined, comment: comment.join('\n') || undefined });
      afterEntry = true;
    } else if (line.startsWith('#')) {
      if (afterEntry) comment = [];
      comment.push(line.replace(/^#\s*/, ''));
      afterEntry = false;
    } else {
      comment = [];
      afterEntry = false;
    }
  }
  return entries;
}

const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.]*\d)/g;
/** Hosts in URLs (after any user info) and in email addresses. */
const URL_HOST = /\b[a-z][a-z\d+.-]*:\/\/(?:[^/\s@]*@)?([^/\s:?#]+)/gi;
const EMAIL_DOMAIN = /[\w.+-]+@([a-z\d-]+(?:\.[a-z\d-]+)+)/gi;
/** A bare host name in prose, with a common top-level domain (file names such as compose.yaml do not end in one). */
const BARE_HOST = /\b(?:[a-z\d-]+\.)+(?:com|net|org|io|app|dev|cloud|co|ai|sh|me|eu|de|uk|info|xyz)\b/gi;
/** A host name with any top-level domain: its last label starts with a letter, so 0.8 and IPv4 addresses are not. */
const HOST_NAME = /^(?:[a-z\d-]+\.)+[a-z][a-z\d-]*$/i;
const ALLOWED_HOST = /^(?:localhost|127\.0\.0\.1|(?:[a-z\d-]+\.)*example\.org)$/i;
/** Key prefixes, and a long token of letters and digits mixed, as generated secrets are. */
const SECRET_LIKE = [/^(?:sk-|sk_|pk_|rk_|ghp_|gho_|github_pat_|xox[abp]-|AKIA|SG\.)/, /^(?=.*\d)(?=.*[a-z])[\w+/=-]{20,}$/i];

/**
 * The host names in an entry's value, whatever their top-level domain: a bare host (SMTP_HOST, with or without a port),
 * and the domain of an email address or an @domain list entry. A value may be quoted and comma-separated.
 */
function valueHosts(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) =>
      item
        .replace(/^['"]|['"]$/g, '')
        .replace(/^.*@/, '')
        .replace(/:\d+$/, ''),
    )
    .filter((item) => HOST_NAME.test(item));
}

/** What makes an env example unfit to publish: addresses, host names and secret-like values, by kind. */
function findHostsAndSecrets(text: string): string[] {
  const found: string[] = [];
  const entries = parseEnvExample(text);
  for (const [address] of text.matchAll(IPV4)) if (address !== '127.0.0.1') found.push(`ipv4 ${address}`);
  const hosts = [
    ...[...text.matchAll(URL_HOST)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(EMAIL_DOMAIN)].map((m) => m[1] ?? ''),
    ...[...text.matchAll(BARE_HOST)].map((m) => m[0]),
    ...entries.flatMap((e) => valueHosts(e.value)),
  ];
  for (const host of new Set(hosts)) if (!ALLOWED_HOST.test(host)) found.push(`host ${host}`);
  for (const { name, value } of entries) {
    const v = value.trim();
    if (SECRET_NAMES.includes(name) && v) found.push(`secret ${name} has a value`);
    else if (SECRET_LIKE.some((re) => re.test(v))) found.push(`secret-like ${name}`);
  }
  for (const marker of findHostMarkers(text)) found.push(`${marker.kind} line ${marker.line}`);
  return found;
}

/** The names `loadConfig` looks up in `env`, whatever it finds there. */
function namesRead(env: Record<string, string>): Set<string> {
  const read = new Set<string>();
  const watched = new Proxy(env, {
    get(target, name) {
      if (typeof name === 'string') read.add(name);
      return Reflect.get(target, name);
    },
  });
  try {
    loadConfig(watched);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }
  return read;
}

describe('configuration parity', () => {
  it('test_config_variables_are_the_names_load_config_reads', () => {
    const compatible = {
      PUBLIC_URL: 'https://unalgorithm.example.org',
      DATABASE_URL: 'postgres://unalgorithm@postgres:5432/unalgorithm',
      BETTER_AUTH_SECRET: 'x'.repeat(32),
      SMTP_HOST: 'smtp.example.org',
      MAIL_FROM: 'signin@example.org',
      AI_PROVIDER: 'openai-compatible',
      AI_BASE_URL: 'http://127.0.0.1:11434/v1',
      AI_MODEL: 'local-model',
      AI_DATA_POLICY: 'self-hosted',
    };
    for (const env of [{}, compatible, { ...compatible, AI_PROVIDER: 'anthropic' }]) {
      expect([...namesRead(env)].sort()).toEqual([...CONFIG_VARIABLES].sort());
    }
    expect(new Set(CONFIG_VARIABLES).size).toBe(CONFIG_VARIABLES.length);
  });

  it('test_env_example_documents_every_variable', () => {
    const entries = parseEnvExample(ENV_EXAMPLE);
    const names = entries.map((e) => e.name);
    expect(new Set(names).size, 'each name appears once').toBe(names.length);
    expect(names.filter((n) => !COMPOSE_ONLY.includes(n)).sort()).toEqual([...CONFIG_VARIABLES].sort());
    expect(names).toEqual(expect.arrayContaining(COMPOSE_ONLY));
    for (const entry of entries) {
      expect(entry.comment, `${entry.name} has a comment`).toBeTruthy();
      expect(entry.comment, `${entry.name}'s comment is one line`).not.toContain('\n');
    }

    // Commented `# NAME=` lines count as documented; compose.yaml sets these three, so they stay commented and empty.
    for (const name of SET_BY_COMPOSE) {
      const entry = entries.find((e) => e.name === name);
      expect(entry, name).toMatchObject({ commented: true, value: '' });
      expect(entry?.comment).toMatch(/set by compose\.yaml; any value here is ignored/i);
    }

    // loadConfig refuses a longer INSTANCE_NAME, and an unset one when the PUBLIC_URL host it falls back to is longer.
    expect(entries.find((e) => e.name === 'INSTANCE_NAME')?.comment).toMatch(/up to 80 characters.*host.*over 80/);

    // The parser counts both kinds of line, and only those.
    expect(
      parseEnvExample('# Prose.\nA=1\n# B=\n\n# Shared,\n# on two lines.\n# C=\nD=x\n# Not=an entry\nE=\n').map((e) => [
        e.name,
        e.comment,
      ]),
    ).toEqual([
      ['A', 'Prose.'],
      ['B', 'Prose.'],
      ['C', 'Shared,\non two lines.'],
      ['D', 'Shared,\non two lines.'],
      ['E', 'Not=an entry'],
    ]);
  });

  it('test_env_example_has_no_hosts_or_secrets', () => {
    expect(findHostsAndSecrets(ENV_EXAMPLE)).toEqual([]);

    const password = parseEnvExample(ENV_EXAMPLE).find((e) => e.name === 'POSTGRES_PASSWORD');
    expect(password?.comment).toContain('openssl rand -hex');
    for (const name of SECRET_NAMES) {
      expect(
        parseEnvExample(ENV_EXAMPLE)
          .find((e) => e.name === name)
          ?.value.trim(),
        name,
      ).toBe('');
    }

    // The checks find what they look for. The token is built at runtime, so no secret scanner reads it as a key.
    const token = ['Q7xv', '2Lk9', 'Pz4m', 'Wn8r', 'T5yb'].join('');
    const planted = [
      '# Reach it at 192.0.2.10 or https://user:pw@cloud.vendor.net/path.',
      'MAIL_FROM=signin@mail.vendor.net',
      'SMTP_HOST=smtp.vendor.com',
      `AI_API_KEY=${token}`,
      `# SOURCE_URL=${token}`,
      'PUBLIC_URL=https://unalgorithm.example.org',
      'SMTP_PORT=587',
      '# SMTP_HOST=mail.vendor.internal:25',
      "SIGNUP_ALLOWLIST='someone@example.org, @vendor.ca'",
      'ROUTE_EVAL_MIN_AGREEMENT=0.8',
    ].join('\n');
    expect(findHostsAndSecrets(planted)).toEqual([
      'ipv4 192.0.2.10',
      'host cloud.vendor.net',
      'host mail.vendor.net',
      'host smtp.vendor.com',
      // Bare hosts with a top-level domain the prose check does not know.
      'host mail.vendor.internal',
      'host vendor.ca',
      'secret AI_API_KEY has a value',
      'secret-like SOURCE_URL',
    ]);
  });
});
