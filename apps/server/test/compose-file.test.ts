import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The compose model self-hosters run (`apps/server/compose.yaml`), as Compose reads it, and the caddy profile's
 * Caddyfile. The container checks are compose-smoke.sh's, backup-smoke.sh's and profiles-smoke.sh's, in CI.
 */
interface Service {
  image?: string;
  profiles?: string[];
  [setting: string]: unknown;
}

const COMPOSE = parse(readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8')) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const { server, postgres, backup, keygen, caddy, ollama, searxng } = COMPOSE.services;
const CADDYFILE = readFileSync(fileURLToPath(new URL('../caddy/Caddyfile', import.meta.url)), 'utf8');
const SEARXNG_SETTINGS = parse(readFileSync(new URL('../searxng/settings.yml', import.meta.url), 'utf8')) as {
  use_default_settings?: unknown;
  server?: Record<string, unknown>;
  search?: { formats?: string[] };
  [setting: string]: unknown;
};

const HARDENING = { read_only: true, tmpfs: ['/tmp'], security_opt: ['no-new-privileges:true'] };

describe('compose.yaml', () => {
  it('test_compose_backup_service', () => {
    // On the Postgres image the file already uses: pg_dump matches the server's Postgres, and no image of our own.
    expect(postgres?.image).toBe('postgres:17.11');
    expect(backup).toEqual({
      image: 'postgres:17.11',
      command: ['bash', '/scripts/backup.sh'],
      environment: {
        PGHOST: 'postgres',
        PGUSER: 'unalgorithm',
        PGDATABASE: 'unalgorithm',
        PGPASSWORD: `$\{POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}`,
        BACKUP_TIME: `$\{BACKUP_TIME:-03:17}`,
        BACKUP_KEEP: `$\{BACKUP_KEEP:-14}`,
      },
      volumes: ['./backup:/scripts:ro', `$\{BACKUP_DIR:-./backups}:/backups`, './backup-key:/keys:ro'],
      depends_on: { postgres: { condition: 'service_healthy' } },
      restart: 'unless-stopped',
      ...HARDENING,
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });
    // Started by `up` (no profile), never published, and only keygen writes the key folder.
    expect(backup).not.toHaveProperty('profiles');
    expect(backup).not.toHaveProperty('ports');
    expect(backup?.volumes).toContain('./backup-key:/keys:ro');
  });

  it('test_compose_keygen_service', () => {
    expect(keygen).toEqual({
      image: 'postgres:17.11',
      profiles: ['tools'],
      // An entrypoint, not a command: `run --rm -T keygen --replace` passes --replace to the script.
      entrypoint: ['bash', '/scripts/keygen.sh'],
      volumes: ['./backup:/scripts:ro', './backup-key:/keys'],
      ...HARDENING,
      // The private key it prints never reaches a log file on the server's disk.
      logging: { driver: 'none' },
    });
    expect(keygen?.profiles).toEqual(['tools']);
    for (const setting of ['ports', 'environment', 'depends_on', 'command', 'restart']) {
      expect(keygen, setting).not.toHaveProperty(setting);
    }
    // Only these two services run the backup scripts; the server never mounts them or the key (only the status folder of
    // the backups, CL4-14).
    const mounting = Object.entries(COMPOSE.services)
      .filter(([, service]) => ((service.volumes as string[] | undefined) ?? []).some((v) => /^\.\/backup(-key)?:/.test(v)))
      .map(([name]) => name);
    expect(mounting.sort()).toEqual(['backup', 'keygen']);
  });

  it('test_compose_caddy_service', () => {
    expect(caddy).toEqual({
      image: 'caddy:2.11.7',
      profiles: ['caddy'],
      environment: { PUBLIC_URL: `$\{PUBLIC_URL:?set PUBLIC_URL in .env}` },
      ports: ['80:80', '443:443', '443:443/udp'],
      volumes: ['./caddy/Caddyfile:/etc/caddy/Caddyfile:ro', 'caddy-data:/data', 'caddy-config:/config'],
      depends_on: { server: { condition: 'service_healthy' } },
      restart: 'unless-stopped',
      read_only: true,
      tmpfs: ['/tmp'],
      cap_drop: ['ALL'],
      cap_add: ['NET_BIND_SERVICE'],
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });
    // The certificates and the ACME account outlive `docker compose down` in named volumes.
    expect(COMPOSE.volumes).toHaveProperty('caddy-data');
    expect(COMPOSE.volumes).toHaveProperty('caddy-config');
  });

  it('test_compose_ollama_service', () => {
    expect(ollama).toEqual({
      image: 'ollama/ollama:0.40.4',
      profiles: ['ollama'],
      volumes: ['ollama:/root/.ollama'],
      healthcheck: { test: ['CMD', 'ollama', 'list'], interval: '10s', timeout: '5s', retries: 12 },
      restart: 'unless-stopped',
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });
    // Only the server reaches it, on the project network; Ollama writes runner files at start, so no read-only root.
    for (const setting of ['ports', 'read_only', 'depends_on']) expect(ollama, setting).not.toHaveProperty(setting);
    // The models outlive `docker compose down` in a named volume.
    expect(COMPOSE.volumes).toHaveProperty('ollama');
    // A dependency on a profiled service would break `docker compose up` without the profile.
    for (const [name, service] of Object.entries(COMPOSE.services)) {
      const dependsOn = service.depends_on;
      const names = Array.isArray(dependsOn) ? dependsOn : Object.keys((dependsOn as object | undefined) ?? {});
      expect(names, `${name} depends_on`).not.toContain('ollama');
    }
    const always = Object.entries(COMPOSE.services)
      .filter(([, service]) => !('profiles' in service))
      .map(([name]) => name);
    expect(always.sort()).toEqual(['backup', 'postgres', 'server']);
  });

  it('test_compose_searxng_service', () => {
    expect(searxng).toEqual({
      image: expect.stringMatching(/^searxng\/searxng:\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{7,}$/),
      profiles: ['searxng'],
      // `:-`, not `:?`: a required value would break `docker compose config` for everyone without the profile.
      environment: { SEARXNG_SECRET: `$\{SEARXNG_SECRET:-}` },
      volumes: ['./searxng/settings.yml:/etc/searxng/settings.yml:ro'],
      healthcheck: {
        test: [
          'CMD',
          '/usr/local/searxng/.venv/bin/python',
          '-c',
          "import urllib.request; urllib.request.urlopen('http://localhost:8080/healthz', timeout=4)",
        ],
        interval: '10s',
        timeout: '5s',
        retries: 12,
      },
      restart: 'unless-stopped',
      security_opt: ['no-new-privileges:true'],
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
    });
    expect(searxng?.image).not.toMatch(/:latest$/);
    // Only the server reaches it, on the project network, and nothing waits for it.
    for (const setting of ['ports', 'depends_on']) expect(searxng, setting).not.toHaveProperty(setting);
    for (const [name, service] of Object.entries(COMPOSE.services)) {
      const dependsOn = service.depends_on;
      const names = Array.isArray(dependsOn) ? dependsOn : Object.keys((dependsOn as object | undefined) ?? {});
      expect(names, `${name} depends_on`).not.toContain('searxng');
    }
    const always = Object.entries(COMPOSE.services)
      .filter(([, service]) => !('profiles' in service))
      .map(([name]) => name);
    expect(always.sort()).toEqual(['backup', 'postgres', 'server']);

    // The instance: internal only, with the JSON API the server's adapter calls; the secret comes from the environment.
    expect(SEARXNG_SETTINGS.use_default_settings).toBe(true);
    expect(SEARXNG_SETTINGS.server).toEqual({ limiter: false, image_proxy: false, public_instance: false });
    expect(SEARXNG_SETTINGS.search).toEqual({ formats: ['html', 'json'], safe_search: 0 });
    expect(SEARXNG_SETTINGS.outgoing).toEqual({ request_timeout: 5.0 });
    expect(JSON.stringify(SEARXNG_SETTINGS)).not.toContain('secret');
  });

  it('test_compose_server_reads_backup_status', () => {
    // The backup service's status folder, read-only: the server stays read_only and cannot write it.
    expect(server?.environment).toMatchObject({ BACKUP_STATUS_DIR: '/backup-status' });
    expect(server?.volumes).toEqual([`$\{BACKUP_DIR:-./backups}/status:/backup-status:ro`]);
    expect(server?.read_only).toBe(true);
    // The same folder the backup service writes its status into.
    expect(backup?.volumes).toContain(`$\{BACKUP_DIR:-./backups}:/backups`);
  });

  it('test_compose_default_services_unchanged', () => {
    const always = Object.entries(COMPOSE.services)
      .filter(([, service]) => !('profiles' in service))
      .map(([name]) => name);
    expect(always.sort()).toEqual(['backup', 'postgres', 'server']);
    expect(postgres).not.toHaveProperty('ports');
    expect(backup).not.toHaveProperty('ports');
    expect(server?.ports).toEqual([`$\{BIND_ADDRESS:-127.0.0.1}:$\{PORT:-8787}:8787`]);
  });
});

describe('caddy/Caddyfile', () => {
  it('test_caddyfile_keeps_no_client_address', () => {
    const lines = CADDYFILE.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('admin off');
    // Caddy's own log lines lose every client address, header and request address, ACME's top-level `remote` included.
    const deletes = lines.filter((line) => line.endsWith(' delete'));
    expect(deletes.sort()).toEqual(
      [
        'request>remote_ip delete',
        'request>remote_port delete',
        'request>client_ip delete',
        'request>headers delete',
        'request>uri delete',
        'remote delete',
      ].sort(),
    );

    // The site block: from `{$PUBLIC_URL} {` to its closing brace.
    const start = CADDYFILE.indexOf('{$PUBLIC_URL} {');
    expect(start).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let end = -1;
    for (let i = CADDYFILE.indexOf('{', start + '{$PUBLIC_URL}'.length); i < CADDYFILE.length; i++) {
      if (CADDYFILE[i] === '{') depth++;
      else if (CADDYFILE[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    expect(end).toBeGreaterThan(start);
    const site = CADDYFILE.slice(start, end + 1);
    expect(site).toMatch(/^\s*reverse_proxy server:8787 \{$/m);
    expect(site).toMatch(/^\s*header_up X-Forwarded-For \{remote_host\}$/m);
    // No access log, and no client is trusted to set X-Forwarded-For.
    expect(site).not.toMatch(/^\s*log\b/m);
    expect(CADDYFILE).not.toContain('trusted_proxies');
  });
});
