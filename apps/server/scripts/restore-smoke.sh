#!/usr/bin/env bash
# The restore smoke test (CL4-11): builds the server image with apps/server/compose.yaml, fills the database with a
# marker account and several MB of rows, backs it up with the backup service, wipes the whole stack, rebuilds it and
# restores the backup with restore.sh, with the real pg_dump, pg_restore, gpg and Postgres. Run it from the repository
# root, with Docker:
#
#   bash apps/server/scripts/restore-smoke.sh
#
# It writes apps/server/.env for the run (test values only) and refuses to start when one, a backups folder or a key
# folder is already there. On exit it removes them, the project's containers and volume, and the image it built
# (smoke-lib.sh). The private keys keygen prints and the backup copy are kept in a temporary folder outside the
# repository and removed too. It is for CI and development machines: never run it on a shared host, where removing
# volumes and images is not allowed.
set -euo pipefail

project="ua-restore-smoke-$RANDOM"
port=8790
# The helpers, the .env with test values and the cleanup on exit.
# shellcheck source=apps/server/scripts/smoke-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/smoke-lib.sh"
failure_logs='server backup'
write_env
# Twelve hours away, so the loop's own nightly run never adds a file while the checks run.
set_var BACKUP_TIME "$(date -u -d '+12 hours' +%H:%M)"

password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file")"
private_mark='BEGIN PGP PRIVATE'

# SQL from standard input, run by psql in the Postgres container; prints unaligned rows.
sql() { compose exec -T postgres psql -X -U unalgorithm -d unalgorithm -At -v ON_ERROR_STOP=1 -f -; }
# restore.sh in a one-off backup container, the private key in $1 on standard input; its output is appended to
# $tmp/restore.log (checked in step 7) and also kept in $tmp/last.log.
restore() {
  local key=$1 code=0
  shift
  compose run --rm -T backup bash /scripts/restore.sh "$@" <"$key" >"$tmp/last.log" 2>&1 || code=$?
  cat "$tmp/last.log" >>"$tmp/restore.log"
  return "$code"
}
wait_healthy() {
  for _ in $(seq 90); do
    if curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null | grep -qF '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

image="$(compose config --images | grep -F ":$project")"
compose build server
compose up -d --wait --wait-timeout 180

# 1. A marker account with its own cap, then several MB of random rows in a table the restore counts, so the dump is far
# past the 64 KiB a pipe holds and compression cannot shrink it under that.
wait_healthy || fail 'the server answers /health before the data goes in'
sql >/dev/null <<'SQL'
insert into "user" (id, name, email, email_verified, created_at, updated_at)
  values ('smoke-user', '', 'smoke@example.org', true, now(), now());
insert into user_limits (user_id, daily_post_cap) values ('smoke-user', 7);
insert into "user" (id, name, email, email_verified, created_at, updated_at)
  select 'bulk-' || g, md5(random()::text) || md5(random()::text), 'bulk-' || g || '@example.org', true, now(), now()
  from generate_series(1, 50000) g;
SQL
[ "$(sql <<<'select count(*) from "user";')" -ge 50001 ] || fail 'the marker account and the bulk rows are in'
ok 'a marker account with cap 7 and 50,000 bulk rows are in the database'

# 2. A key pair, one backup larger than 1 MB, and a copy of it outside the backups folder, as an operator keeps one.
code=0
compose run --rm -T keygen >"$tmp/private.asc" 2>"$tmp/keygen.err" || code=$?
if [ "$code" -ne 0 ]; then
  cat "$tmp/keygen.err" >&2
  fail "keygen exits 0 (exit code $code)"
fi
compose exec -T backup bash /scripts/backup.sh --once >"$tmp/once.log" || fail 'backup.sh --once exits 0'
shopt -s nullglob
files=("$dir"/backups/unalgorithm-*.dump.gpg)
shopt -u nullglob
[ "${#files[@]}" -eq 1 ] || fail "backup.sh --once writes one backup (found ${#files[@]})"
name="$(basename "${files[0]}")"
bytes="$(stat -c %s "${files[0]}")"
[ "$bytes" -gt 1000000 ] || fail "the backup is larger than 1 MB ($bytes bytes)"
cp "${files[0]}" "$tmp/$name"
ok "backup.sh --once writes $name ($bytes bytes), copied off the backups folder"

# 3. --check opens the backup with its key and refuses it with an unrelated one. keygen --replace makes that other key;
# the public key it leaves behind goes with the wipe.
restore "$tmp/private.asc" --check "/backups/$name" || fail "restore.sh --check exits 0 ($(cat "$tmp/last.log"))"
grep -qF '"event":"restore.checked"' "$tmp/last.log" || fail 'restore.sh --check logs restore.checked'
compose run --rm -T keygen --replace >"$tmp/other.asc" 2>/dev/null || fail 'keygen --replace makes a second key'
code=0
restore "$tmp/other.asc" --check "/backups/$name" || code=$?
[ "$code" -eq 1 ] && grep -qF '"error":"decrypt"' "$tmp/last.log" ||
  fail "restore.sh --check with an unrelated key exits 1 with decrypt (exit code $code)"
ok 'restore.sh --check exits 0 with the key and 1 with decrypt with an unrelated one'

# 4. The wipe: containers, the database volume, the backups and the key folder. The server migrates an empty database.
compose down -v --remove-orphans
remove_backup_folders
[ ! -e "$dir/backups" ] && [ ! -e "$dir/backup-key" ] || fail 'the wipe removes backups/ and backup-key/'
compose up -d --wait --wait-timeout 180
wait_healthy || fail 'the server starts on an empty database after the wipe'
[ "$(sql <<<"select count(*) from \"user\" where email = 'smoke@example.org';")" -eq 0 ] ||
  fail 'the wiped database has no marker account'
ok 'the stack is wiped and starts again on an empty database'

# 5. The backup goes back through the container, as the guide does (Docker made backups/ as root again). The restore
# refuses while the server is connected and without --yes, then restores the several-MB backup.
# shellcheck disable=SC2016 # expanded in the container
compose exec -T backup sh -c 'cat > "/backups/$1"' sh "$name" <"$tmp/$name" || fail 'the backup copy goes back in'
code=0
restore "$tmp/private.asc" --yes "/backups/$name" || code=$?
[ "$code" -eq 1 ] && grep -qF '"event":"restore.server_running"' "$tmp/last.log" ||
  fail "restore.sh --yes while the server runs exits 1 with restore.server_running (exit code $code)"
compose stop server
code=0
restore "$tmp/private.asc" "/backups/$name" || code=$?
[ "$code" -eq 2 ] || fail "restore.sh without --yes exits 2 (exit code $code)"
restore "$tmp/private.asc" --yes "/backups/$name" || fail "restore.sh --yes exits 0 ($(cat "$tmp/last.log"))"
grep -qF '"event":"restore.checked"' "$tmp/last.log" && grep -qF '"event":"restore.done"' "$tmp/last.log" ||
  fail 'restore.sh --yes logs restore.checked and restore.done'
user_rows="$(grep -F '"event":"restore.rows"' "$tmp/last.log" | grep -F '"table":"user"' | sed -n 's/.*"rows":\([0-9]*\).*/\1/p')"
[ -n "$user_rows" ] && [ "$user_rows" -ge 50001 ] || fail "restore.rows counts 50,001 or more users (found '$user_rows')"
ok "restore.sh refuses while the server runs and without --yes, then restores $user_rows users"

# 6. The restored server: healthy, the marker account and its cap back, migrations applied on start, and a new sync
# epoch, the last step of every restore.
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
compose start server
wait_healthy || fail 'the restored server answers /health'
[ "$(sql <<<"select u.email || ' ' || l.daily_post_cap from \"user\" u join user_limits l on l.user_id = u.id
  where u.id = 'smoke-user';")" = 'smoke@example.org 7' ] || fail 'the marker account and its cap 7 are back'
server_log="$(compose logs --no-color --since "$since" server)"
grep -qF 'db.migrations.done' <<<"$server_log" || fail 'the restarted server logs db.migrations.done'
! grep -qF 'server.start_failed' <<<"$server_log" || fail 'the restarted server logs no server.start_failed'
epoch="$(compose exec -T server node apps/server/src/cli/sync-new-epoch.ts)" || fail 'sync-new-epoch exits 0'
grep -qF 'new sync epoch for' <<<"$epoch" || fail 'sync-new-epoch prints new sync epoch for'
ok 'the restored server is healthy, has the marker account and cap 7, and starts a new sync epoch'

# 7. Neither the backup service's log nor restore.sh's output holds a private key or the password. Keygen's output is
# meant to hold the key and is not checked.
logs="$(compose logs --no-color backup)"
for output in "$tmp/restore.log" "$tmp/once.log" <(printf '%s' "$logs"); do
  if grep -qF -- "$password" "$output" || grep -qF "$private_mark" "$output"; then
    fail 'no backup or restore output holds the password or a private key'
  fi
done
ok 'no backup or restore output holds the password or a private key'

echo "restore smoke test passed ($step checks)"
