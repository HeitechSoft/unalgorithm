#!/usr/bin/env bash
# Restores a backup made by backup.sh (CL4-11). Run it from the folder with compose.yaml, the private key keygen.sh
# printed on standard input:
#
#   docker compose run --rm -T backup bash /scripts/restore.sh --check /backups/<file> < backup-private-key.asc
#   docker compose stop server
#   docker compose run --rm -T backup bash /scripts/restore.sh --yes /backups/<file> < backup-private-key.asc
#   docker compose start server
#   docker compose exec server node apps/server/src/cli/sync-new-epoch.ts
#
# --check decrypts the whole backup and reads every block of the archive without touching any database. --yes does the
# same check, refuses while anything (the server) is connected to the database, then replaces the database with the
# backup and logs a row count per table as proof. The key goes into a temporary GnuPG home under /tmp (a tmpfs in the
# container) that is removed on exit; the plaintext dump only ever exists in a pipe. It restores into whatever PGHOST,
# PGUSER, PGPASSWORD and PGDATABASE name. Logs are one JSON line per step on standard output, the shape of backup.sh's,
# and never hold a password, a key or a row's content. Exit code 0 when done, 1 when a step failed, 2 for usage.
#
# After every restore run sync-new-epoch in the server container (the last line above), so no device trusts a sync
# cursor from after the backup. The restored server needs the BETTER_AUTH_SECRET it had when the backup was made.
set -euo pipefail
export LC_ALL=C

usage() {
  echo 'usage: restore.sh --check FILE < backup-private-key.asc   (decrypt and check the backup only)' >&2
  echo '       restore.sh --yes FILE < backup-private-key.asc     (replace the database with the backup)' >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
case "$1" in
--check | --yes) mode=$1 ;;
*) usage ;;
esac
file=$2
[ -f "$file" ] || usage
if [ -t 0 ]; then
  echo "Pipe your private key in: docker compose run --rm -T backup bash /scripts/restore.sh $mode $file < backup-private-key.asc" >&2
  exit 2
fi

# A JSON string, escaped as backup.sh's.
json_str() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# log LEVEL EVENT [NAME JSON_VALUE]...: one line, {"t":…,"level":…,"event":…} and flat fields (backup.sh's shape).
log() {
  local line
  line="{\"t\":\"$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)\",\"level\":\"$1\",\"event\":\"$2\""
  shift 2
  while [ "$#" -ge 2 ]; do
    line+=",\"$1\":$2"
    shift 2
  done
  printf '%s}\n' "$line"
}

# failed CODE [HINT]: the step's failure line, then exit 1.
failed() {
  if [ "$#" -ge 2 ]; then
    log error restore.failed error "$(json_str "$1")" hint "$(json_str "$2")"
  else
    log error restore.failed error "$(json_str "$1")"
  fi
  exit 1
}

started="$(date +%s%3N)"
name="$(json_str "$(basename "$file")")"

# 6. Always: stop the agent gpg started and remove the home with the key.
GNUPGHOME="$(mktemp -d /tmp/gnupg.XXXXXX)"
export GNUPGHOME
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "$GNUPGHOME"
}
trap cleanup EXIT

decrypt() { gpg --batch --quiet --pinentry-mode loopback --passphrase '' --decrypt "$file"; }

# 1. The key, from standard input.
gpg --batch --quiet --import || failed key
log info restore.key_imported

# 2. The check. Without -d, pg_restore reads every data block and writes the script to /dev/null. What it leaves unread
# (all of it, when the archive is bad) is drained, so gpg always writes to the end and checks its integrity tag, and a
# gpg failure is always the decryption's, never a closed pipe's.
set +e
decrypt | {
  pg_restore --file=/dev/null
  read_status=$?
  cat >/dev/null
  exit "$read_status"
}
statuses=("${PIPESTATUS[@]}")
set -e
[ "${statuses[0]}" -eq 0 ] || failed decrypt
[ "${statuses[1]}" -eq 0 ] || failed archive
log info restore.checked file "$name" ms "$(($(date +%s%3N) - started))"
[ "$mode" = --yes ] || exit 0

# 3. Nothing else may be connected. psql variables only work in SQL read from a file or standard input (CL1-35).
connections="$(psql -X -d postgres -At -v ON_ERROR_STOP=1 -v db="$PGDATABASE" -f - <<'SQL'
select count(*) from pg_stat_activity where datname = :'db' and pid <> pg_backend_pid();
SQL
)" || failed database
[[ "$connections" =~ ^[0-9]+$ ]] || failed database
if [ "$connections" -gt 0 ]; then
  log error restore.server_running connections "$connections" hint '"Stop the server first: docker compose stop server"'
  exit 1
fi

# 4. Replace the database, through the maintenance database.
log info restore.replacing file "$name"
again='The database is now empty or partial: run the restore again.'
dropdb --maintenance-db=postgres --if-exists "$PGDATABASE" || failed restore "$again"
createdb --maintenance-db=postgres "$PGDATABASE" || failed restore "$again"
set +e
decrypt | pg_restore --no-owner --no-acl --exit-on-error -d "$PGDATABASE"
statuses=("${PIPESTATUS[@]}")
set -e
[ "${statuses[0]}" -eq 0 ] && [ "${statuses[1]}" -eq 0 ] || failed restore "$again"
log info restore.restored file "$name" ms "$(($(date +%s%3N) - started))"

# 5. The proof: a row count for each of these tables that exists, never a row's content.
counts="$(psql -X -d "$PGDATABASE" -At -v ON_ERROR_STOP=1 -f - <<'SQL'
select format('select %L, count(*) from %s', name, to_regclass(reg))
from (values
  (1, 'user', 'public."user"'),
  (2, 'devices', 'public.devices'),
  (3, 'usage_events', 'public.usage_events'),
  (4, 'user_limits', 'public.user_limits'),
  (5, 'ai_routes', 'public.ai_routes'),
  (6, 'signup_invites', 'public.signup_invites'),
  (7, 'migrations', 'drizzle.__drizzle_migrations')
) as t (i, name, reg)
where to_regclass(reg) is not null
order by i
\gexec
SQL
)" || failed database
while IFS='|' read -r table rows; do
  [ -n "$table" ] || continue
  [[ "$rows" =~ ^[0-9]+$ ]] || failed database
  log info restore.rows table "$(json_str "$table")" rows "$rows"
done <<<"$counts"
log info restore.done file "$name" ms "$(($(date +%s%3N) - started))"
