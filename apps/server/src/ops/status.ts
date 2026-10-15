/**
 * The server's own status for the admin page (R43, CL4-14): disk free, database size, error lines in the last 15
 * minutes and the backups' last runs, answered as the `ops` block of `GET /v1/admin/overview`. Content-free: numbers,
 * ISO times, backup kinds and fixed codes only. No path, file name, host name or message reaches the answer or a log
 * line, and nothing from a status file's content is logged.
 *
 * The backup service writes one status file per kind (`<BACKUP_DIR>/status/<kind>.json`, one JSON line, CL4-10); the
 * server reads that folder through a read-only mount (`BACKUP_STATUS_DIR`, compose.yaml).
 */
import type { StatsFs } from 'node:fs';
import { statfs as fsStatfs, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_ERRORS, BackupKindSchema, type BackupStatus, type OpenAlert, type OpsStatus } from '@unalgorithm/protocol';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { type Db, queryErrorFields } from '../db/client.ts';
import type { Logger } from '../log.ts';
import type { ErrorWindow } from './error-window.ts';

/** One status file as the backup scripts write it (CL4-10; the Cloud's off-site copy writes the same, CL4-22). */
export const BackupStatusFileSchema = z.object({
  v: z.literal(1),
  kind: BackupKindSchema,
  ok: z.boolean(),
  finished_at: z.iso.datetime().nullable(),
  last_success_at: z.iso.datetime().nullable(),
  file: z
    .string()
    .regex(/^unalgorithm-\d{8}T\d{6}Z\.dump\.gpg$/)
    .nullable(),
  bytes: z.number().int().min(0).nullable(),
  error: z.enum(BACKUP_ERRORS).nullable(),
});
export const BACKUP_STATUS_FILE_MAX_BYTES = 4096;
export const MAX_BACKUP_STATUS_FILES = 10;

const STATUS_SUFFIX = '.json';

/**
 * The status of every backup kind in `dir`, in name order, at most `MAX_BACKUP_STATUS_FILES`. Files are named
 * `<kind>.json`; other names are ignored. A file that is too large, unreadable, not JSON, not the contract or for
 * another kind than its name gives that kind `error: 'unreadable'`. A folder that cannot be listed (the backup service
 * has not run yet) gives none.
 */
export async function readBackupStatuses(dir: string): Promise<BackupStatus[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const kinds = names
    .filter((name) => name.endsWith(STATUS_SUFFIX))
    .map((name) => name.slice(0, -STATUS_SUFFIX.length))
    .filter((kind) => BackupKindSchema.safeParse(kind).success)
    .sort()
    .slice(0, MAX_BACKUP_STATUS_FILES);
  return Promise.all(kinds.map((kind) => readBackupStatus(dir, kind)));
}

async function readBackupStatus(dir: string, kind: string): Promise<BackupStatus> {
  const text = await readSmallFile(join(dir, `${kind}${STATUS_SUFFIX}`));
  const parsed = BackupStatusFileSchema.safeParse(text === undefined ? undefined : parseJson(text));
  if (!parsed.success || parsed.data.kind !== kind) {
    return { kind, ok: false, finishedAt: null, lastSuccessAt: null, bytes: null, error: 'unreadable' };
  }
  const s = parsed.data;
  return {
    kind,
    ok: s.ok,
    finishedAt: s.finished_at,
    lastSuccessAt: s.last_success_at,
    bytes: s.bytes,
    error: s.error,
  };
}

/** The file's text, or undefined when it cannot be read or holds more than `BACKUP_STATUS_FILE_MAX_BYTES`. */
async function readSmallFile(path: string): Promise<string | undefined> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(BACKUP_STATUS_FILE_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead > BACKUP_STATUS_FILE_MAX_BYTES ? undefined : buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface DiskUsage {
  freeBytes: number;
  totalBytes: number;
}

/**
 * Free and total bytes of the filesystem with the fewest free bytes among `paths` (free: what an unprivileged process
 * may still use), or null when none of them answered.
 */
export async function readDiskUsage(
  paths: readonly string[],
  statfs: (path: string) => Promise<StatsFs> = (path) => fsStatfs(path),
): Promise<DiskUsage | null> {
  const results = await Promise.allSettled(paths.map((path) => statfs(path)));
  let fullest: DiskUsage | null = null;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { bavail, blocks, bsize } = result.value;
    const usage = { freeBytes: bavail * bsize, totalBytes: blocks * bsize };
    if (!fullest || usage.freeBytes < fullest.freeBytes) fullest = usage;
  }
  return fullest;
}

/** The database's size on disk in bytes, or null (logged, without the message) when the query fails. */
export async function databaseBytes(db: Db, log: Logger): Promise<number | null> {
  try {
    const result = await db.execute(sql`select pg_database_size(current_database())::bigint as bytes`);
    // node-postgres and PGlite both answer `{ rows }`; a bigint comes back as text or as a bigint.
    const [row] = (result as unknown as { rows: { bytes: string | number | bigint }[] }).rows;
    return row ? Number(row.bytes) : null;
  } catch (err) {
    log.warn('ops.database_size_failed', queryErrorFields(err));
    return null;
  }
}

export interface OpsDeps {
  db: Db;
  config: Pick<Config, 'backupStatusDir'>;
  log: Logger;
  errors: ErrorWindow;
  /** Open alerts; CL4-15 passes its lister. Default: none. */
  alerts?: () => Promise<OpenAlert[]>;
  /** Tests only. Default: `fs.promises.statfs`. */
  statfs?: (path: string) => Promise<StatsFs>;
  /** ms since the epoch. Default: now. */
  now?: number;
}

/**
 * The `ops` block. Disk usage is that of `/` (inside the container, the Docker data disk the database volume lives on)
 * and of the status folder (the backups disk), whichever has fewer free bytes; `backups` is null when this server does
 * not watch backups (`BACKUP_STATUS_DIR` unset).
 */
export async function readOpsStatus(deps: OpsDeps): Promise<OpsStatus> {
  const { db, config, log, errors, alerts, statfs, now = Date.now() } = deps;
  const dir = config.backupStatusDir;
  const [disk, dbBytes, backups, openAlerts] = await Promise.all([
    readDiskUsage(dir ? ['/', dir] : ['/'], statfs),
    databaseBytes(db, log),
    dir ? readBackupStatuses(dir) : null,
    alerts?.() ?? [],
  ]);
  return {
    diskFreeBytes: disk?.freeBytes ?? null,
    diskTotalBytes: disk?.totalBytes ?? null,
    databaseBytes: dbBytes,
    errors15m: errors.count(now),
    backups,
    openAlerts,
  };
}
