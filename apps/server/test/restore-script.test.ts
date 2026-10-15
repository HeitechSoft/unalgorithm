import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_TIMEOUT, SPAWN_TIMEOUT } from './support/timeouts.ts';

/**
 * compose.yaml's restore script (CL4-11), run by bash with fake `gpg`, `gpgconf`, `pg_restore`, `psql`, `dropdb` and
 * `createdb` first on PATH. Each fake records its arguments in FAKE_CALLS and fails on demand through FAKE_FAIL. The
 * real tools, Postgres and the container are restore-smoke.sh's, in CI.
 */
const RESTORE = fileURLToPath(new URL('../backup/restore.sh', import.meta.url));

/** An armour header, built at run time so no scanner reads this file as holding a key. */
const PRIVATE_MARK = ['BEGIN PGP', 'PRIVATE'].join(' ');
const KEY = `-----${PRIVATE_MARK} KEY BLOCK-----\nfake private key\n`;
/** What the fake gpg decrypts to: a pg_dump header, then padding past the 64 KiB a pipe holds. */
const PLAINTEXT_BYTES = 5 + 70_000;

/** Records the fake's name and arguments (shell-quoted, so an empty one shows as ''), and `note`, in FAKE_CALLS. */
const HEADER = `#!/usr/bin/env bash
log_call() { printf '%s%s%s\\n' "$(basename "$0")" "$(printf ' %q' "$@")" "\${note-}" >>"$FAKE_CALLS"; }
`;

/** Records the GnuPG home of each import in FAKE_HOMES. A decrypt writes more than a pipe holds and fails when the
 * reader stops early (SIGPIPE, or a write error). */
const FAKE_GPG = `${HEADER}
case " $* " in
*' --import '*)
  log_call "$@"
  printf '%s\\n' "$GNUPGHOME" >>"$FAKE_HOMES"
  [ -d "$GNUPGHOME" ] || exit 2
  key="$(cat)"
  if [ "\${FAKE_FAIL-}" = key ] || [ -z "$key" ]; then echo 'gpg: no valid OpenPGP data found.' >&2; exit 2; fi
  printf '%s' "$key" >"$GNUPGHOME/imported"
  ;;
*' --decrypt '*)
  log_call "$@"
  if [ "\${FAKE_FAIL-}" = decrypt ]; then echo 'gpg: decryption failed: No secret key' >&2; exit 2; fi
  magic=PGDMP
  if [ "\${FAKE_FAIL-}" = archive ]; then magic=NOTPG; fi
  printf '%s%070000d' "$magic" 0 || exit 2
  ;;
*) log_call "$@" ;;
esac
`;

/** Reads standard input as far as the real one does: the first bytes of a non-archive, the header and table of contents
 * with --list, and all of it with --file or -d. */
const FAKE_PG_RESTORE = `${HEADER}
magic=''
IFS= read -r -N 5 magic || true
if [ "$magic" != PGDMP ]; then
  note=' # not an archive' log_call "$@"
  echo 'pg_restore: error: input file does not appear to be a valid archive' >&2
  exit 1
fi
case " $* " in
*' --list '*) note=' # header only' log_call "$@"; exit 0 ;;
esac
bytes=$((5 + $(wc -c)))
note=" # read $bytes" log_call "$@"
case " $* " in
*' -d '*) if [ "\${FAKE_FAIL-}" = restore ]; then exit 1; fi ;;
esac
exit 0
`;

/** Appends the SQL it reads to FAKE_SQL; the connection count is FAKE_CONNECTIONS. */
const FAKE_PSQL = `${HEADER}
sql="$(cat)"
printf '%s\\n' "$sql" >>"$FAKE_SQL"
log_call "$@"
if [ "\${FAKE_FAIL-}" = psql ]; then echo 'psql: error: connection refused' >&2; exit 2; fi
case "$sql" in
*pg_stat_activity*) echo "\${FAKE_CONNECTIONS:-0}" ;;
*) printf 'user|50001\\ndevices|3\\nmigrations|14\\n' ;;
esac
`;

const FAKE_DB_TOOL = `${HEADER}
log_call "$@"
if [ "\${FAKE_FAIL-}" = "$(basename "$0")" ]; then exit 1; fi
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  root: string;
  file: string;
  env: Record<string, string>;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A backup file in a fresh temporary folder, and the fakes first on PATH. */
function sandbox(env: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'ua-restore-'));
  sandboxes.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [
    ['gpg', FAKE_GPG],
    ['gpgconf', FAKE_DB_TOOL],
    ['pg_restore', FAKE_PG_RESTORE],
    ['psql', FAKE_PSQL],
    ['dropdb', FAKE_DB_TOOL],
    ['createdb', FAKE_DB_TOOL],
  ] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const file = join(root, 'unalgorithm-20261014T031705Z.dump.gpg');
  writeFileSync(file, 'FAKE-OPENPGP\n');
  return {
    root,
    file,
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      FAKE_CALLS: join(root, 'calls'),
      FAKE_HOMES: join(root, 'homes'),
      FAKE_SQL: join(root, 'sql'),
      PGHOST: 'postgres',
      PGUSER: 'unalgorithm',
      PGDATABASE: 'unalgorithm',
      PGPASSWORD: 'pw-not-in-any-log-5c1d',
      ...env,
    },
  };
}

function run(args: string[], env: Record<string, string>, input = KEY): Run {
  const result = spawnSync('bash', [RESTORE, ...args], { env, input, encoding: 'utf8', timeout: PROCESS_TIMEOUT });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);
const calls = (box: Sandbox) => lines(box.env.FAKE_CALLS ?? '');
const tools = (box: Sandbox) => calls(box).map((line) => line.split(' ')[0]);

/** The JSON lines of a run's standard output; every line must be one, in backup.sh's shape. */
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
const events = (stdout: string) => logLines(stdout).map((line) => line.event);

const IMPORT = 'gpg --batch --quiet --import';
const decryptCall = (box: Sandbox) => `gpg --batch --quiet --pinentry-mode loopback --passphrase '' --decrypt ${box.file}`;
const CHECK_READ = `pg_restore --file=/dev/null # read ${PLAINTEXT_BYTES}`;
const KILL = 'gpgconf --kill all';

describe.skipIf(process.platform === 'win32')('restore.sh', () => {
  it(
    'test_restore_usage_and_terminal_refusal',
    () => {
      const box = sandbox();
      const folder = join(box.root, 'bin');
      for (const args of [
        [],
        ['--check'],
        ['--yes'],
        [box.file],
        ['--force', box.file],
        ['--check', join(box.root, 'missing.dump.gpg')],
        ['--yes', folder],
        ['--yes', box.file, 'extra'],
      ]) {
        const result = run(args, box.env);
        expect(result.status, args.join(' ')).toBe(2);
        expect(result.stderr).toContain('usage: restore.sh --check FILE');
        expect(result.stdout).toBe('');
      }

      // A terminal on standard input, from util-linux `script`: refused before the key is read.
      const terminal = spawnSync('script', ['-qec', `bash ${RESTORE} --yes ${box.file}`, '/dev/null'], {
        env: box.env,
        encoding: 'utf8',
        timeout: PROCESS_TIMEOUT,
      });
      expect(terminal.error, 'util-linux script').toBeUndefined();
      expect(terminal.status).toBe(2);
      expect(terminal.stdout).toContain(
        `Pipe your private key in: docker compose run --rm -T backup bash /scripts/restore.sh --yes ${box.file} < backup-private-key.asc`,
      );
      expect(calls(box)).toEqual([]);
      expect(lines(box.env.FAKE_HOMES ?? '')).toEqual([]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_key_decrypt_archive_failures',
    () => {
      for (const mode of ['--check', '--yes']) {
        for (const [failure, input, steps] of [
          ['key', KEY, ['gpg']],
          ['key', '', ['gpg']],
          ['decrypt', KEY, ['gpg', 'gpg', 'pg_restore']],
          ['archive', KEY, ['gpg', 'gpg', 'pg_restore']],
        ] as const) {
          const box = sandbox({ FAKE_FAIL: input ? failure : '' });
          const label = `${mode} ${failure} ${input ? 'fake failure' : 'no key'}`;
          const result = run([mode, box.file], box.env, input);
          expect(result.status, label).toBe(1);
          const log = logLines(result.stdout);
          expect(log.at(-1), label).toEqual(expect.objectContaining({ level: 'error', event: 'restore.failed', error: failure }));
          expect(
            log.map((line) => line.event),
            label,
          ).not.toContain('restore.checked');
          // The database is untouched: no connection check, no dropdb, no createdb.
          expect(tools(box), label).toEqual([...steps, 'gpgconf']);
        }
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_refuses_while_server_connected',
    () => {
      const box = sandbox({ FAKE_CONNECTIONS: '2' });
      const result = run(['--yes', box.file], box.env);
      expect(result.status).toBe(1);
      expect(logLines(result.stdout).at(-1)).toEqual(
        expect.objectContaining({
          level: 'error',
          event: 'restore.server_running',
          connections: 2,
          hint: 'Stop the server first: docker compose stop server',
        }),
      );
      expect(calls(box)).toEqual([
        IMPORT,
        decryptCall(box),
        CHECK_READ,
        'psql -X -d postgres -At -v ON_ERROR_STOP=1 -v db=unalgorithm -f -',
        KILL,
      ]);
      // The database's name reaches the query as a psql variable, in SQL read from standard input.
      expect(readFileSync(box.env.FAKE_SQL ?? '', 'utf8')).toContain(
        "select count(*) from pg_stat_activity where datname = :'db' and pid <> pg_backend_pid();",
      );

      // A connection check that cannot run changes nothing either.
      const down = sandbox({ FAKE_FAIL: 'psql' });
      const failed = run(['--yes', down.file], down.env);
      expect(failed.status).toBe(1);
      expect(logLines(failed.stdout).at(-1)).toEqual(expect.objectContaining({ event: 'restore.failed', error: 'database' }));
      expect(tools(down)).toEqual(['gpg', 'gpg', 'pg_restore', 'psql', 'gpgconf']);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_failure_code',
    () => {
      for (const [failure, last] of [
        ['restore', 'pg_restore'],
        ['dropdb', 'dropdb'],
        ['createdb', 'createdb'],
      ] as const) {
        const box = sandbox({ FAKE_FAIL: failure });
        const result = run(['--yes', box.file], box.env);
        expect(result.status, failure).toBe(1);
        expect(logLines(result.stdout).at(-1), failure).toEqual(
          expect.objectContaining({
            level: 'error',
            event: 'restore.failed',
            error: 'restore',
            hint: 'The database is now empty or partial: run the restore again.',
          }),
        );
        const used = tools(box);
        expect(used.at(-2), failure).toBe(last);
        expect(
          used.filter((tool) => tool === 'psql'),
          failure,
        ).toHaveLength(1);
      }
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_check_changes_nothing',
    () => {
      const box = sandbox();
      const result = run(['--check', box.file], box.env);
      expect(result.status, result.stderr).toBe(0);
      expect(logLines(result.stdout)).toEqual([
        expect.objectContaining({ level: 'info', event: 'restore.key_imported' }),
        expect.objectContaining({
          level: 'info',
          event: 'restore.checked',
          file: 'unalgorithm-20261014T031705Z.dump.gpg',
          ms: expect.any(Number),
        }),
      ]);
      // The whole decrypted stream went to pg_restore --file=/dev/null; nothing reached a database.
      expect(calls(box)).toEqual([IMPORT, decryptCall(box), CHECK_READ, KILL]);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_runs_steps_in_order',
    () => {
      const box = sandbox();
      const result = run(['--yes', box.file], box.env);
      expect(result.status, result.stderr).toBe(0);
      expect(calls(box)).toEqual([
        IMPORT,
        decryptCall(box),
        CHECK_READ,
        'psql -X -d postgres -At -v ON_ERROR_STOP=1 -v db=unalgorithm -f -',
        'dropdb --maintenance-db=postgres --if-exists unalgorithm',
        'createdb --maintenance-db=postgres unalgorithm',
        decryptCall(box),
        `pg_restore --no-owner --no-acl --exit-on-error -d unalgorithm # read ${PLAINTEXT_BYTES}`,
        'psql -X -d unalgorithm -At -v ON_ERROR_STOP=1 -f -',
        KILL,
      ]);
      expect(calls(box).join('\n')).not.toContain('--list');
      // The counts: each table only when it exists, through psql's \gexec.
      const sql = readFileSync(box.env.FAKE_SQL ?? '', 'utf8');
      for (const table of ['public."user"', 'public.devices', 'public.usage_events', 'public.user_limits', 'public.ai_routes']) {
        expect(sql).toContain(`'${table}'`);
      }
      expect(sql).toContain("'drizzle.__drizzle_migrations'");
      expect(sql).toContain('where to_regclass(reg) is not null');
      expect(sql).toContain('\\gexec');

      const log = logLines(result.stdout);
      expect(log.map((line) => line.event)).toEqual([
        'restore.key_imported',
        'restore.checked',
        'restore.replacing',
        'restore.restored',
        'restore.rows',
        'restore.rows',
        'restore.rows',
        'restore.done',
      ]);
      expect(log.filter((line) => line.event === 'restore.rows')).toEqual([
        expect.objectContaining({ level: 'info', table: 'user', rows: 50001 }),
        expect.objectContaining({ level: 'info', table: 'devices', rows: 3 }),
        expect.objectContaining({ level: 'info', table: 'migrations', rows: 14 }),
      ]);
      expect(log.at(-1)).toEqual(
        expect.objectContaining({ event: 'restore.done', file: 'unalgorithm-20261014T031705Z.dump.gpg', ms: expect.any(Number) }),
      );
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_removes_gnupg_home',
    () => {
      const box = sandbox();
      const runs: [string, Record<string, string>][] = [
        ['--check', {}],
        ['--yes', {}],
        ['--yes', { FAKE_FAIL: 'key' }],
        ['--yes', { FAKE_FAIL: 'decrypt' }],
        ['--check', { FAKE_FAIL: 'archive' }],
        ['--yes', { FAKE_CONNECTIONS: '1' }],
        ['--yes', { FAKE_FAIL: 'restore' }],
      ];
      for (const [mode, env] of runs) run([mode, box.file], { ...box.env, ...env });
      const homes = lines(box.env.FAKE_HOMES ?? '');
      // One fresh home under /tmp per run; the fake gpg found each one in place, and every one is gone.
      expect(homes).toHaveLength(runs.length);
      expect(new Set(homes).size).toBe(runs.length);
      for (const home of homes) {
        expect(home).toMatch(/^\/tmp\/gnupg\.\w{6}$/);
        expect(existsSync(home), home).toBe(false);
      }
      expect(tools(box).filter((tool) => tool === 'gpgconf')).toHaveLength(runs.length);
    },
    SPAWN_TIMEOUT,
  );

  it(
    'test_restore_output_holds_no_secret',
    () => {
      const box = sandbox();
      const outputs: Run[] = [
        run(['--check', box.file], box.env),
        run(['--yes', box.file], box.env),
        run(['--yes', box.file], { ...box.env, FAKE_FAIL: 'key' }),
        run(['--yes', box.file], { ...box.env, FAKE_FAIL: 'decrypt' }),
        run(['--yes', box.file], { ...box.env, FAKE_FAIL: 'archive' }),
        run(['--yes', box.file], { ...box.env, FAKE_CONNECTIONS: '1' }),
        run(['--yes', box.file], { ...box.env, FAKE_FAIL: 'psql' }),
        run(['--yes', box.file], { ...box.env, FAKE_FAIL: 'restore' }),
        run(['--yes'], box.env),
      ];
      expect(outputs.map((result) => result.status)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 2]);
      const text = outputs.flatMap((result) => [result.stdout, result.stderr]).join('\n');
      expect(text).toContain('restore.done');
      expect(text).not.toContain(PRIVATE_MARK);
      expect(text).not.toContain(box.env.PGPASSWORD);
      for (const result of outputs) events(result.stdout);
    },
    SPAWN_TIMEOUT,
  );
});
