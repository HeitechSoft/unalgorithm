# Shared by the container smoke tests (compose-smoke.sh, backup-smoke.sh, restore-smoke.sh, profiles-smoke.sh); not run
# on its own. A script sets `project` (its own throwaway Compose project name) and `port` (the host port the server is
# published on), then sources this from the repository root:
#
#   project="ua-smoke-$RANDOM"
#   port=8788
#   . apps/server/scripts/smoke-lib.sh
#
# It refuses to start when apps/server/.env, apps/server/backups or apps/server/backup-key is already there, so
# an operator's own files are never touched. On exit it removes the .env it wrote (write_env), the project's containers
# and volumes, the image it built (`image`), the backups and key folders Docker made, and its temporary folder. For CI
# and development machines only: never run it on a shared host, where removing volumes and images is not allowed.

# Git Bash on Windows rewrites arguments that look like paths; container paths must reach Docker unchanged, and
# `native` turns a local temporary path into one Docker can open.
export MSYS_NO_PATHCONV=1
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

dir=apps/server
env_file="$dir/.env"

if [ ! -f "$dir/compose.yaml" ]; then
  echo "run this from the repository root" >&2
  exit 1
fi
if [ -e "$env_file" ]; then
  echo "$env_file exists: move it away first (this script writes and removes its own)" >&2
  exit 1
fi
for folder in "$dir/backups" "$dir/backup-key"; do
  if [ -e "$folder" ]; then
    echo "$folder exists: move it away first (this script removes the one Docker makes)" >&2
    exit 1
  fi
done

compose() { docker compose -p "$project" -f "$dir/compose.yaml" "$@"; }

tmp="$(mktemp -d)"
image=''
# The services whose logs a failed run prints.
failure_logs=server
# Docker makes the backups and backup-key folders, as root, for the backup and keygen bind mounts: the Postgres image
# (already pulled) removes them, so a runner that is not root can. Used by the cleanup and by restore-smoke.sh's wipe.
remove_backup_folders() {
  if [ -e "$dir/backups" ] || [ -e "$dir/backup-key" ]; then
    docker run --rm -v "$(native "$(pwd)/$dir"):/w" postgres:17.11 rm -rf /w/backups /w/backup-key >/dev/null 2>&1 || true
  fi
}
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$image" ]; then
    echo "--- $failure_logs log ---" >&2
    # shellcheck disable=SC2086 # one word per service
    compose logs --no-color $failure_logs >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$image" ]; then docker image rm -f "$image" >/dev/null 2>&1 || true; fi
  remove_backup_folders
  rm -f "$env_file"
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

# Sets NAME=value in the .env, replacing its active or commented line, or adding one.
set_var() {
  local name=$1 value=$2
  if grep -Eq "^(# ?)?$name=" "$env_file"; then
    awk -v n="$name" -v v="$value" '$0 ~ ("^(# ?)?" n "=") { print n "=" v; next } { print }' "$env_file" >"$tmp/env"
    cat "$tmp/env" >"$env_file"
  else
    printf '%s=%s\n' "$name" "$value" >>"$env_file"
  fi
}

step=0
ok() {
  step=$((step + 1))
  echo "ok $step - $1"
}
fail() {
  echo "not ok $((step + 1)) - $1" >&2
  exit 1
}

# The .env: .env.example with test values. HOST and PORT are the ones compose.yaml must override inside the container.
write_env() {
  cp "$dir/.env.example" "$env_file"
  set_var UNALGORITHM_VERSION "$project"
  set_var PUBLIC_URL "http://127.0.0.1:$port"
  set_var HOST 127.0.0.1
  set_var PORT "$port"
  set_var SMTP_HOST localhost
  set_var SMTP_SECURE none
  set_var AI_PROVIDER openai-compatible
  # Nothing listens on port 9 (discard): route-eval reaches no provider.
  set_var AI_BASE_URL http://127.0.0.1:9/v1
  set_var AI_MODEL mock-model
  set_var AI_DATA_POLICY self-hosted
  set_var BETTER_AUTH_SECRET "$(openssl rand -hex 32)"
  set_var POSTGRES_PASSWORD "$(openssl rand -hex 32)"
  # Single-quoted as .env.example advises, so Compose keeps $PORT as written; unquoted, it would put 8788 in its place.
  set_var MAIL_FROM_NAME "'Smoke \$PORT test'"
}
