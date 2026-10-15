#!/usr/bin/env bash
# The backup smoke test (CL4-10): builds the server image with apps/server/compose.yaml, starts the server, Postgres and
# the backup service under a throwaway project name, and checks the nightly encrypted backups with the real pg_dump,
# gpg and Postgres. Run it from the repository root, with Docker:
#
#   bash apps/server/scripts/backup-smoke.sh
#
# It writes apps/server/.env for the run (test values only) and refuses to start when one, a backups folder or a key
# folder is already there. On exit it removes them, the project's containers and volume, and the image it built
# (smoke-lib.sh). The private key keygen prints is kept in a temporary folder outside the repository and removed too.
# It is for CI and development machines: never run it on a shared host, where removing volumes and images is not
# allowed.
set -euo pipefail

project="ua-backup-smoke-$RANDOM"
port=8789
# The helpers, the .env with test values and the cleanup on exit.
# shellcheck source=apps/server/scripts/smoke-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/smoke-lib.sh"
failure_logs='server backup'
write_env
# Twelve hours away, so the loop's own nightly run never adds a file while the checks count them.
set_var BACKUP_TIME "$(date -u -d '+12 hours' +%H:%M)"

password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file")"
backups="$dir/backups"
status_file="$backups/status/local.json"
private_mark='BEGIN PGP PRIVATE'

backup_files() {
  shopt -s nullglob
  files=("$backups"/unalgorithm-*.dump.gpg)
  shopt -u nullglob
}

image="$(compose config --images | grep -F ":$project")"
compose build server
compose up -d --wait --wait-timeout 180

# 1. Before a key exists, the loop records the problem at once.
for _ in $(seq 60); do
  [ -f "$status_file" ] && break
  sleep 1
done
[ -f "$status_file" ] || fail 'the backup service writes status/local.json as it starts'
status="$(cat "$status_file")"
grep -qF '"ok":false' <<<"$status" && grep -qF '"error":"no-key"' <<<"$status" ||
  fail 'before a key exists the status says no-key'
ok 'before a key exists the status says no-key'

# 2. keygen writes the public key and prints the private key, which stays outside the repository.
code=0
compose run --rm -T keygen >"$tmp/private.asc" 2>"$tmp/keygen.err" || code=$?
if [ "$code" -ne 0 ]; then
  cat "$tmp/keygen.err" >&2
  fail "keygen exits 0 (exit code $code)"
fi
grep -qF 'BEGIN PGP PUBLIC KEY BLOCK' "$dir/backup-key/backup-public-key.asc" || fail 'keygen writes the public key'
grep -qF "$private_mark KEY BLOCK" "$tmp/private.asc" || fail 'keygen prints a private key block'
ok 'keygen writes the public key and prints the private key'

# 3. A second keygen refuses: backups already made need the first private key.
code=0
compose run --rm -T keygen >"$tmp/again.out" 2>&1 || code=$?
[ "$code" -eq 1 ] || fail "a second keygen exits 1 (exit code $code)"
grep -qF 'A backup key exists' "$tmp/again.out" || fail 'a second keygen says a backup key exists'
ok 'a second keygen refuses to replace the key'

# 4. One backup now: an encrypted file any local user may copy. Its output is kept for check 9.
code=0
compose exec -T backup bash /scripts/backup.sh --once >"$tmp/once.log" || code=$?
[ "$code" -eq 0 ] || fail "backup.sh --once exits 0 (exit code $code)"
backup_files
[ "${#files[@]}" -eq 1 ] || fail "backup.sh --once writes one backup (found ${#files[@]})"
file="${files[0]}"
name="$(basename "$file")"
[ "$(stat -c %a "$file")" = 644 ] || fail 'the backup file has mode 644'
[ "$(head -c 5 "$file")" != PGDMP ] || fail 'the backup is not a plain dump'
ok "backup.sh --once writes $name, mode 644, not a plain dump"

# 5. It is encrypted to a public key.
# shellcheck disable=SC2016 # expanded in the container
packets="$(compose exec -T backup bash -c 'h="$(mktemp -d /tmp/gnupg.XXXXXX)"
  gpg --homedir "$h" --batch --list-packets "/backups/$1" 2>&1
  gpgconf --homedir "$h" --kill all; rm -rf "$h"' bash "$name" || true)"
grep -qF ':pubkey enc packet:' <<<"$packets" || fail 'the backup holds a public-key encrypted packet'
ok 'the backup holds a public-key encrypted packet'

# 6. The private key opens it, and inside is a pg_dump custom-format dump.
# shellcheck disable=SC2016 # expanded in the container
magic="$(compose exec -T backup bash -c 'set -e; h="$(mktemp -d /tmp/gnupg.XXXXXX)"
  gpg --homedir "$h" --batch --quiet --import 2>/dev/null
  gpg --homedir "$h" --batch --quiet --decrypt --output "$h/dump" "/backups/$1" 2>/dev/null
  head -c 5 "$h/dump"
  gpgconf --homedir "$h" --kill all; rm -rf "$h"' bash "$name" <"$tmp/private.asc")"
[ "$magic" = PGDMP ] || fail 'the private key decrypts the backup to a pg_dump archive'
ok 'the private key decrypts the backup to a pg_dump archive'

# 7. The status names the file and its size.
status="$(cat "$status_file")"
grep -qF '"ok":true' <<<"$status" && grep -qF "\"file\":\"$name\"" <<<"$status" &&
  grep -qF "\"bytes\":$(stat -c %s "$file")," <<<"$status" && grep -qF '"error":null' <<<"$status" ||
  fail 'status/local.json has ok true, the file and its size'
ok 'status/local.json has ok true, the file and its size'

# 8. With BACKUP_KEEP=2, three more runs leave the two newest. Names are stamped to the second.
for _ in 1 2 3; do
  sleep 1
  compose exec -T -e BACKUP_KEEP=2 backup bash /scripts/backup.sh --once >>"$tmp/once.log" ||
    fail 'backup.sh --once with BACKUP_KEEP=2 exits 0'
done
backup_files
[ "${#files[@]}" -eq 2 ] || fail "BACKUP_KEEP=2 leaves two backups (found ${#files[@]})"
ok 'BACKUP_KEEP=2 leaves two backups'

# 9. The --once runs logged backup.done (exec output never reaches the container's log), and neither their output nor
# the loop's log holds the password or a private key. Keygen's output is meant to hold the key and is not checked.
[ "$(grep -c '"event":"backup.done"' "$tmp/once.log")" -eq 4 ] || fail 'each --once run logs backup.done'
logs="$(compose logs --no-color backup)"
grep -qF 'backup.started' <<<"$logs" && grep -qF 'backup.no_key' <<<"$logs" ||
  fail 'the loop logs backup.started and backup.no_key'
for output in "$tmp/once.log" <(printf '%s' "$logs"); do
  if grep -qF -- "$password" "$output" || grep -qF "$private_mark" "$output"; then
    fail 'no backup log holds the password or a private key'
  fi
done
ok 'no backup log holds the password or a private key'

# 10. The server reads the status files through its read-only mount (CL4-14), and cannot write the folder.
compose exec -T server node -e "require('node:fs').readFileSync('/backup-status/local.json')" ||
  fail 'the server reads /backup-status/local.json'
if compose exec -T server sh -c 'touch /backup-status/x' 2>/dev/null; then fail 'the server cannot write /backup-status'; fi
ok 'the server reads the status file and cannot write its folder'

echo "backup smoke test passed ($step checks)"
