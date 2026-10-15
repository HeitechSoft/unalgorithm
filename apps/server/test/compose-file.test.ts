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
const { server, postgres, backup, keygen, caddy } = COMPOSE.services;
const CADDYFILE = readFileSync(fileURLToPath(new URL('../caddy/Caddyfile', import.meta.url)), 'utf8');

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
    // Only these two services run the backup scripts; the server never mounts them or the key.
    const mounting = Object.entries(COMPOSE.services)
      .filter(([, service]) => JSON.stringify(service.volumes ?? []).includes('./backup'))
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
