#!/usr/bin/env bash
# Nightly encrypted backups of the server's database (CL4-10), run by compose.yaml's `backup` service on the
# postgres:17.11 image, whose pg_dump matches the server's Postgres and which ships GnuPG.
#
#   backup.sh                        one backup a day at BACKUP_TIME (UTC, HH:MM), forever
#   backup.sh --once                 one backup now; exits 0 when it was written, 1 when not
#   backup.sh --seconds-until EPOCH  the seconds from EPOCH to the next BACKUP_TIME (for tests)
#
# Each dump is encrypted to the public key keygen.sh made, so this machine can never read its own backups and the files
# are safe to copy anywhere; only the operator's private key opens them. Every run writes status/local.json in the
# backups folder (the contract the server's status reader, CL4-14, reads). Logs are one JSON line per event on standard
# output, the server's shape, and never hold a password, a key or a connection string (pg_dump reads PGPASSWORD from the
# environment). UA_BACKUP_DIR and UA_BACKUP_KEY exist for tests only; compose.yaml never sets them.
set -euo pipefail
export LC_ALL=C

BACKUP_TIME="${BACKUP_TIME:-03:17}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
dir="${UA_BACKUP_DIR:-/backups}"
key="${UA_BACKUP_KEY:-/keys/backup-public-key.asc}"
kind=local
status_file="$dir/status/$kind.json"
ISO_TIME='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'

usage() {
  echo 'usage: backup.sh [--once | --seconds-until EPOCH]' >&2
  exit 2
}

# A JSON string. The values are this script's own (codes, file names, checked settings); quotes and backslashes are
# escaped all the same.
json_str() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# log LEVEL EVENT [NAME JSON_VALUE]...: one line, {"t":…,"level":…,"event":…} and flat fields.
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

config_error() {
  log error backup.bad_config variable "$(json_str "$1")"
  exit 1
}

[[ "$BACKUP_TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || config_error BACKUP_TIME
[[ "$BACKUP_KEEP" =~ ^[0-9]{1,3}$ ]] && ((10#$BACKUP_KEEP >= 1 && 10#$BACKUP_KEEP <= 365)) || config_error BACKUP_KEEP
BACKUP_KEEP=$((10#$BACKUP_KEEP))

# The seconds from epoch $1 to the next BACKUP_TIME in UTC: a whole day, not 0, when $1 is that minute's first second,
# so a run that ends within its own second does not start again.
seconds_until() {
  local target=$((10#${BACKUP_TIME%%:*} * 3600 + 10#${BACKUP_TIME#*:} * 60))
  local wait=$(((target - $1 % 86400 + 86400) % 86400))
  echo $((wait == 0 ? 86400 : wait))
}

# The previous status file's last_success_at, as a JSON value: a quoted time, or null.
previous_success() {
  local value=''
  if [ -f "$status_file" ]; then
    value="$(sed -n 's/.*"last_success_at":"\([^"]*\)".*/\1/p' "$status_file" 2>/dev/null || true)"
  fi
  if [[ "$value" =~ $ISO_TIME ]]; then json_str "$value"; else echo null; fi
}

# write_status OK FILE BYTES ERROR (JSON values): status/local.json, written to a temporary name and renamed.
write_status() {
  local finished last
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$1" = true ]; then last="\"$finished\""; else last="$(previous_success)"; fi
  mkdir -p "$dir/status"
  printf '{"v":1,"kind":"%s","ok":%s,"finished_at":"%s","last_success_at":%s,"file":%s,"bytes":%s,"error":%s}\n' \
    "$kind" "$1" "$finished" "$last" "$2" "$3" "$4" >"$status_file.tmp"
  chmod 0644 "$status_file.tmp"
  mv -f "$status_file.tmp" "$status_file"
}

# A run that wrote no backup: its status and its log line.
failed() {
  write_status false null null "$(json_str "$1")"
  log error backup.failed error "$(json_str "$1")"
}

# Keeps the newest BACKUP_KEEP backups (their names sort by time) and deletes the older ones; nothing else.
prune() {
  local files i
  shopt -s nullglob
  files=("$dir"/unalgorithm-*.dump.gpg)
  shopt -u nullglob
  for ((i = 0; i < ${#files[@]} - BACKUP_KEEP; i++)); do rm -f -- "${files[i]}"; done
}

# One backup: returns 0 when it was written, 1 (with a failed status) when not.
run_once() {
  local started stamp name partial tmp_home dump_status encrypt_status bytes error=''
  started="$(date +%s%3N)"
  [ -s "$key" ] || {
    failed no-key
    return 1
  }
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="unalgorithm-$stamp.dump.gpg"
  partial="$dir/.partial-$stamp"
  tmp_home="$(mktemp -d /tmp/gnupg.XXXXXX)"

  set +e
  pg_dump --format=custom |
    gpg --homedir "$tmp_home" --batch --no-tty --quiet --trust-model always --recipient-file "$key" --encrypt --output "$partial"
  dump_status=${PIPESTATUS[0]} encrypt_status=${PIPESTATUS[1]}
  set -e
  gpgconf --homedir "$tmp_home" --kill all >/dev/null 2>&1 || true
  rm -rf "$tmp_home"

  # pg_dump killed by SIGPIPE (141) only means gpg stopped reading first: the failure is gpg's.
  if [ "$dump_status" -ne 0 ] && ! { [ "$dump_status" -eq 141 ] && [ "$encrypt_status" -ne 0 ]; }; then
    error=dump
  elif [ "$encrypt_status" -ne 0 ]; then
    error=encrypt
  # Mode 0644: the file is ciphertext, so any local user may copy it off the box.
  elif ! { chmod 0644 "$partial" && mv -f "$partial" "$dir/$name"; }; then
    error=write
  fi
  if [ -n "$error" ]; then
    rm -f "$partial"
    failed "$error"
    return 1
  fi

  prune
  bytes="$(wc -c <"$dir/$name")"
  bytes=$((bytes))
  write_status true "$(json_str "$name")" "$bytes" null
  log info backup.done file "$(json_str "$name")" bytes "$bytes" ms "$(($(date +%s%3N) - started))"
}

case "${1-}" in
--once)
  [ "$#" -eq 1 ] || usage
  run_once
  exit
  ;;
--seconds-until)
  [ "$#" -eq 2 ] && [[ "$2" =~ ^[0-9]+$ ]] || usage
  seconds_until "$2"
  exit 0
  ;;
'') [ "$#" -eq 0 ] || usage ;;
*) usage ;;
esac

# The loop. A stop (TERM, INT) ends the wait at once; a failed run does not stop the loop.
sleeper=''
stop() {
  if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null || true; fi
  exit 0
}
trap stop TERM INT

log info backup.started time "$(json_str "$BACKUP_TIME")" keep "$BACKUP_KEEP"
if [ ! -s "$key" ]; then
  # Recorded at once, so the admin page shows the missing key without waiting for the night.
  log warn backup.no_key
  write_status false null null '"no-key"'
fi
while true; do
  sleep "$(seconds_until "$(date -u +%s)")" </dev/null >/dev/null 2>&1 &
  sleeper=$!
  wait "$sleeper" || true
  sleeper=''
  run_once || true
done
