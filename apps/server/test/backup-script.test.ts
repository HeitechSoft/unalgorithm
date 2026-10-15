import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

/**
 * compose.yaml's backup scripts (CL4-10), run by bash with fake `pg_dump`, `gpg` and `gpgconf` first on PATH and the
 * backups folder and key in a temporary folder. The real tools, Postgres and the container are backup-smoke.sh's, in CI.
 */
const BACKUP = fileURLToPath(new URL('../backup/backup.sh', import.meta.url));
const KEYGEN = fileURLToPath(new URL('../backup/keygen.sh', import.meta.url));

const BACKUP_NAME = /^unalgorithm-\d{8}T\d{6}Z\.dump\.gpg$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** An armour header, built at run time so no scanner reads this file as holding a key. */
const armor = (kind: 'PUBLIC' | 'PRIVATE') => ['-----BEGIN PGP ', kind, ' KEY BLOCK-----'].join('');
const PRIVATE_MARK = ['BEGIN PGP', 'PRIVATE'].join(' ');

const FAKE_PG_DUMP = `#!/usr/bin/env bash
printf 'PGDMP fake dump\\n'
if [ "\${FAKE_FAIL-}" = dump ]; then exit 1; fi
`;

/** Records each encrypt call's --output and --recipient-file in FAKE_CALLS; prints FAKE_PUBLIC and FAKE_PRIVATE. */
const FAKE_GPG = `#!/usr/bin/env bash
mode='' out='' recipient=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift ;;
    --recipient-file) recipient=$2; shift ;;
    --homedir | --passphrase | --pinentry-mode) shift ;;
    --encrypt | --list-secret-keys | --export | --export-secret-keys) mode=$1 ;;
  esac
  shift
done
case "$mode" in
  --encrypt)
    printf '%s %s\\n' "$out" "$recipient" >>"$FAKE_CALLS"
    printf 'FAKE-OPENPGP\\n' >"$out"
    if [ "\${FAKE_FAIL-}" = encrypt ]; then exit 1; fi
    cat >>"$out"
    ;;
  --list-secret-keys) echo 'fpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:' ;;
  --export) printf '%s\\n' "$FAKE_PUBLIC" ;;
  --export-secret-keys) printf '%s\\n' "$FAKE_PRIVATE" ;;
esac
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  root: string;
  dir: string;
  key: string;
  env: Record<string, string>;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A backups folder and a key path in a fresh temporary folder, and the fakes first on PATH. */
function sandbox(env: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ua-backup-'));
  sandboxes.push(root);
  const bin = join(root, 'bin');
  const dir = join(root, 'backups');
  const keys = join(root, 'keys');
  for (const folder of [bin, dir, keys]) mkdirSync(folder);
  for (const [name, text] of [
    ['pg_dump', FAKE_PG_DUMP],
    ['gpg', FAKE_GPG],
    ['gpgconf', '#!/usr/bin/env bash\nexit 0\n'],
  ] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const key = join(keys, 'backup-public-key.asc');
  return {
    root,
    dir,
    key,
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      UA_BACKUP_DIR: dir,
      UA_BACKUP_KEY: key,
      FAKE_CALLS: join(root, 'calls'),
      PGPASSWORD: 'pw-not-in-any-log-7f3e',
      ...env,
    },
  };
}

function run(script: string, args: string[], env: Record<string, string>): Run {
  const result = spawnSync('bash', [script, ...args], { env, encoding: 'utf8', timeout: PROCESS_TIMEOUT });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The JSON lines of a run's standard output; every line must be one, in the server's shape. */
function logLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed).toMatchObject({ t: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/), level: expect.any(String) });
      return parsed;
    });
}

function readStatus(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'status', 'local.json'), 'utf8')) as Record<string, unknown>;
}

const backups = (dir: string) => readdirSync(dir).filter((name) => BACKUP_NAME.test(name));
const mode = (path: string) => statSync(path).mode & 0o777;

const PREVIOUS_STATUS = `${JSON.stringify({
  v: 1,
  kind: 'local',
  ok: true,
  finished_at: '2026-10-13T03:17:42Z',
  last_success_at: '2026-10-13T03:17:42Z',
  file: 'unalgorithm-20261013T031705Z.dump.gpg',
  bytes: 120,
  error: null,
})}\n`;

describe.skipIf(process.platform === 'win32')('backup.sh', () => {
  it(
    'test_backup_once_writes_encrypted_file_and_status',
    () => {
      const box = sandbox();
      writeFileSync(box.key, 'public key\n');
      const result = run(BACKUP, ['--once'], box.env);
      expect(result.status, result.stderr).toBe(0);

      const [name, ...others] = backups(box.dir);
      expect(others).toEqual([]);
      expect(name).toMatch(BACKUP_NAME);
      expect(readdirSync(box.dir).sort()).toEqual(['status', name]);
      const file = join(box.dir, name ?? '');
      expect(mode(file)).toBe(0o644);
      // The dump went through gpg to the key, into a .partial- name with the same stamp.
      const stamp = name?.slice('unalgorithm-'.length, -'.dump.gpg'.length);
      expect(readFileSync(box.env.FAKE_CALLS ?? '', 'utf8')).toBe(`${join(box.dir, `.partial-${stamp}`)} ${box.key}\n`);
      expect(readFileSync(file, 'utf8')).toBe('FAKE-OPENPGP\nPGDMP fake dump\n');

      const status = readStatus(box.dir);
      expect(status).toEqual({
        v: 1,
        kind: 'local',
        ok: true,
        finished_at: expect.stringMatching(ISO_SECONDS),
        last_success_at: status.finished_at,
        file: name,
        bytes: statSync(file).size,
        error: null,
      });
      expect(mode(join(box.dir, 'status', 'local.json'))).toBe(0o644);
      expect(readdirSync(join(box.dir, 'status'))).toEqual(['local.json']);

      expect(logLines(result.stdout)).toEqual([
        expect.objectContaining({
          level: 'info',
          event: 'backup.done',
          file: name,
          bytes: statSync(file).size,
          ms: expect.any(Number),
        }),
      ]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_backup_without_key_records_no_key',
    async () => {
      // --once: an empty key file counts as none; the previous success stays in the status.
      const box = sandbox();
      writeFileSync(box.key, '');
      mkdirSync(join(box.dir, 'status'));
      writeFileSync(join(box.dir, 'status', 'local.json'), PREVIOUS_STATUS);
      const once = run(BACKUP, ['--once'], box.env);
      expect(once.status).toBe(1);
      expect(backups(box.dir)).toEqual([]);
      expect(readStatus(box.dir)).toEqual({
        v: 1,
        kind: 'local',
        ok: false,
        finished_at: expect.stringMatching(ISO_SECONDS),
        last_success_at: '2026-10-13T03:17:42Z',
        file: null,
        bytes: null,
        error: 'no-key',
      });
      expect(logLines(once.stdout)).toEqual([
        expect.objectContaining({ level: 'error', event: 'backup.failed', error: 'no-key' }),
      ]);
      expect(existsSync(box.env.FAKE_CALLS ?? '')).toBe(false);

      // The loop writes the status as it starts, long before BACKUP_TIME, and stops on TERM.
      const fresh = sandbox();
      const child = spawn('bash', [BACKUP], { env: fresh.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      const statusPath = join(fresh.dir, 'status', 'local.json');
      const deadline = Date.now() + PROCESS_TIMEOUT;
      while (!existsSync(statusPath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      child.kill('SIGTERM');
      expect(await exited).toBe(0);

      expect(readStatus(fresh.dir)).toMatchObject({ ok: false, last_success_at: null, file: null, bytes: null, error: 'no-key' });
      expect(logLines(stdout)).toEqual([
        expect.objectContaining({ level: 'info', event: 'backup.started', time: '03:17', keep: 14 }),
        expect.objectContaining({ level: 'warn', event: 'backup.no_key' }),
      ]);
      expect(backups(fresh.dir)).toEqual([]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_backup_dump_or_encrypt_failure',
    () => {
      for (const failure of ['dump', 'encrypt']) {
        const box = sandbox({ FAKE_FAIL: failure });
        writeFileSync(box.key, 'public key\n');
        writeFileSync(join(box.dir, 'unalgorithm-20200101T031700Z.dump.gpg'), 'older');
        mkdirSync(join(box.dir, 'status'));
        writeFileSync(join(box.dir, 'status', 'local.json'), PREVIOUS_STATUS);

        const result = run(BACKUP, ['--once'], box.env);
        expect(result.status, failure).toBe(1);
        // The partial file gpg wrote is gone, and no new backup was added (nor the old one pruned).
        expect(readdirSync(box.dir).sort(), failure).toEqual(['status', 'unalgorithm-20200101T031700Z.dump.gpg']);
        expect(readStatus(box.dir), failure).toMatchObject({
          ok: false,
          last_success_at: '2026-10-13T03:17:42Z',
          file: null,
          bytes: null,
          error: failure,
        });
        expect(logLines(result.stdout), failure).toEqual([
          expect.objectContaining({ level: 'error', event: 'backup.failed', error: failure }),
        ]);
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_backup_keeps_newest_only',
    () => {
      const box = sandbox({ BACKUP_KEEP: '2' });
      writeFileSync(box.key, 'public key\n');
      const existing = ['20200101T031700Z', '20200102T031700Z', '20200103T031700Z', '20200104T031700Z'].map(
        (stamp) => `unalgorithm-${stamp}.dump.gpg`,
      );
      for (const name of [...existing, 'notes.txt']) writeFileSync(join(box.dir, name), name);

      const result = run(BACKUP, ['--once'], box.env);
      expect(result.status, result.stderr).toBe(0);
      const made = readStatus(box.dir).file as string;
      expect(made).toMatch(BACKUP_NAME);
      expect(readdirSync(box.dir).sort()).toEqual(['notes.txt', 'status', existing[3], made].sort());
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_backup_schedule_and_config_checks',
    () => {
      const box = sandbox();
      const at = (time: string) => String(Date.parse(`2026-10-14T${time}Z`) / 1000);
      const until = (time: string, env: Record<string, string> = {}) =>
        run(BACKUP, ['--seconds-until', at(time)], { ...box.env, BACKUP_TIME: '03:17', ...env });

      expect(until('03:16:00').stdout).toBe('60\n');
      expect(until('03:18:00').stdout).toBe('86340\n');
      // The minute's own first second waits a whole day, so a fast run does not start again.
      expect(until('03:17:00').stdout).toBe('86400\n');
      expect(until('23:59:30', { BACKUP_TIME: '00:00' }).stdout).toBe('30\n');
      expect(until('00:00:00', { BACKUP_TIME: '23:59' }).stdout).toBe('86340\n');

      for (const [variable, value] of [
        ['BACKUP_TIME', '25:00'],
        ['BACKUP_TIME', '3:17'],
        ['BACKUP_TIME', '03:60'],
        ['BACKUP_KEEP', '0'],
        ['BACKUP_KEEP', '366'],
        ['BACKUP_KEEP', 'two'],
      ] as const) {
        for (const args of [['--once'], ['--seconds-until', at('03:16:00')]]) {
          const result = run(BACKUP, args, { ...box.env, [variable]: value });
          expect(result.status, `${variable}=${value}`).toBe(1);
          expect(logLines(result.stdout)).toEqual([
            expect.objectContaining({ level: 'error', event: 'backup.bad_config', variable }),
          ]);
        }
      }
      expect(run(BACKUP, ['--once'], { ...box.env, BACKUP_KEEP: '365' }).stdout).toContain('backup.failed');
      expect(existsSync(join(box.dir, 'status'))).toBe(true);

      for (const args of [['--now'], ['--once', 'extra'], ['--seconds-until'], ['--seconds-until', 'soon']]) {
        const result = run(BACKUP, args, box.env);
        expect(result.status, args.join(' ')).toBe(2);
        expect(result.stderr).toContain('usage: backup.sh');
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_backup_logs_hold_no_secret',
    () => {
      const outputs: string[] = [];
      const record = (result: Run) => outputs.push(result.stdout, result.stderr);

      const box = sandbox({ FAKE_PRIVATE: `${armor('PRIVATE')}\nfake\n` });
      record(run(BACKUP, ['--once'], box.env));
      writeFileSync(box.key, 'public key\n');
      record(run(BACKUP, ['--once'], box.env));
      record(run(BACKUP, ['--once'], { ...box.env, FAKE_FAIL: 'dump' }));
      record(run(BACKUP, ['--once'], { ...box.env, FAKE_FAIL: 'encrypt' }));
      record(run(BACKUP, ['--once'], { ...box.env, BACKUP_KEEP: '0' }));

      const text = outputs.join('\n');
      expect(text).toContain('backup.done');
      expect(text).toContain('backup.failed');
      expect(text).not.toContain(box.env.PGPASSWORD);
      expect(text).not.toContain(PRIVATE_MARK);
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
      for (const result of outputs.filter((_, i) => i % 2 === 0)) logLines(result);
    },
    SPAWN_TIMEOUT,
  );
});

describe.skipIf(process.platform === 'win32')('keygen.sh', () => {
  it(
    'test_keygen_refuses_to_replace',
    () => {
      const privateKey = `${armor('PRIVATE')}\nfake private key\n`;
      const box = sandbox({ FAKE_PUBLIC: `${armor('PUBLIC')}\nfirst`, FAKE_PRIVATE: privateKey });
      const keys = join(box.key, '..');

      const made = run(KEYGEN, [], box.env);
      expect(made.status, made.stderr).toBe(0);
      expect(readFileSync(box.key, 'utf8')).toBe(`${armor('PUBLIC')}\nfirst\n`);
      expect(mode(box.key)).toBe(0o644);
      // The private key goes to standard output only: not to the instructions on stderr, nor to any file.
      expect(made.stdout).toBe(`${privateKey}\n`);
      expect(made.stderr).toContain('Save the block below on your own computer, outside this server, and keep a second copy.');
      expect(made.stderr).toContain('Without it no backup can be restored.');
      expect(made.stderr).not.toContain(PRIVATE_MARK);
      expect(readdirSync(keys)).toEqual(['backup-public-key.asc']);

      // A second run refuses and changes nothing.
      const again = run(KEYGEN, [], { ...box.env, FAKE_PUBLIC: 'second' });
      expect(again.status).toBe(1);
      expect(again.stdout).toBe('');
      expect(again.stderr).toContain('A backup key exists; backups already made need its private key.');
      expect(readFileSync(box.key, 'utf8')).toBe(`${armor('PUBLIC')}\nfirst\n`);

      // --replace makes a new pair.
      const replaced = run(KEYGEN, ['--replace'], { ...box.env, FAKE_PUBLIC: 'second' });
      expect(replaced.status, replaced.stderr).toBe(0);
      expect(readFileSync(box.key, 'utf8')).toBe('second\n');
      expect(readdirSync(keys)).toEqual(['backup-public-key.asc']);

      for (const args of [['--force'], ['--replace', 'extra']]) {
        const result = run(KEYGEN, args, box.env);
        expect(result.status, args.join(' ')).toBe(2);
        expect(result.stdout).toBe('');
      }
    },
    SPAWN_TIMEOUT,
  );
});
