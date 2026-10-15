import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The compose model self-hosters run (`apps/server/compose.yaml`), as Compose reads it. The container checks are
 * compose-smoke.sh's and backup-smoke.sh's, in CI.
 */
interface Service {
  image?: string;
  profiles?: string[];
  [setting: string]: unknown;
}

const COMPOSE = parse(readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8')) as {
  services: Record<string, Service>;
};
const { postgres, backup, keygen } = COMPOSE.services;

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
});
