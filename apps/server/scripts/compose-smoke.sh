#!/usr/bin/env bash
# The compose smoke test (CL1-25): builds the server image with apps/server/compose.yaml, starts it with Postgres under
# a throwaway project name, and checks what self-hosters rely on. Run it from the repository root, with Docker:
#
#   bash apps/server/scripts/compose-smoke.sh
#
# It writes apps/server/.env for the run (test values only) and refuses to start when one is already there. On exit it
# removes that file, the project's containers and volume, and the image it built. It is for CI and development
# machines: never run it on a shared host, where removing volumes and images is not allowed.
set -euo pipefail

# Git Bash on Windows rewrites arguments that look like paths; container paths must reach Docker unchanged, and
# `native` turns a local temporary path into one Docker can open.
export MSYS_NO_PATHCONV=1
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

dir=apps/server
env_file="$dir/.env"
project="ua-smoke-$RANDOM"
port=8788

if [ ! -f "$dir/compose.yaml" ]; then
  echo "run this from the repository root" >&2
  exit 1
fi
if [ -e "$env_file" ]; then
  echo "$env_file exists: move it away first (this script writes and removes its own)" >&2
  exit 1
fi

compose() { docker compose -p "$project" -f "$dir/compose.yaml" "$@"; }

tmp="$(mktemp -d)"
image=''
cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$image" ]; then
    echo '--- server log ---' >&2
    compose logs --no-color server >&2 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [ -n "$image" ]; then docker image rm -f "$image" >/dev/null 2>&1 || true; fi
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

# The server's image, tagged with the project name above (the other image is Postgres).
image="$(compose config --images | grep -F ":$project")"
compose build server

# The image itself.
[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = node ] || fail 'the image runs as node'
licence="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$image")"
[ "$licence" = AGPL-3.0-only ] || fail 'the image is labelled AGPL-3.0-only'
echo '# image: runs as node, labelled AGPL-3.0-only'

# 1. Without POSTGRES_PASSWORD the stack does not start. A copy of the .env without it, so the real one stays intact.
grep -v '^POSTGRES_PASSWORD=' "$env_file" >"$tmp/no-password.env"
if out="$(compose --env-file "$(native "$tmp/no-password.env")" config 2>&1)"; then
  fail 'compose refuses to start without POSTGRES_PASSWORD'
fi
grep -qF 'set POSTGRES_PASSWORD in .env' <<<"$out" || fail 'the error says: set POSTGRES_PASSWORD in .env'
ok 'compose refuses to start without POSTGRES_PASSWORD'

# 2. The image with no environment exits 1 and names the missing variables.
code=0
out="$(docker run --rm "$image" 2>&1)" || code=$?
[ "$code" -eq 1 ] || fail "the server exits 1 without configuration (exit code $code)"
grep -qF 'missing:' <<<"$out" && grep -qF 'PUBLIC_URL' <<<"$out" || fail 'the server names the missing variables'
ok 'without configuration the server exits 1 and names the missing variables'

compose up -d --wait --wait-timeout 180

# 3. and 4. Reachable on the published port, although the .env says HOST=127.0.0.1 and PORT=8788.
health="$(curl -fsS "http://127.0.0.1:$port/health")"
grep -qF '"ok":true' <<<"$health" || fail '/health answers ok'
ok '/health answers ok'
well_known="$(curl -fsS "http://127.0.0.1:$port/.well-known/unalgorithm.json")"
grep -qF '"v":1' <<<"$well_known" && grep -qF '"billing":false' <<<"$well_known" ||
  fail 'the discovery document has v 1 and billing off'
ok 'the discovery document has v 1 and billing off'

# 5. and 6. Only the server is published, on 127.0.0.1.
[ "$(compose port server 8787)" = "127.0.0.1:$port" ] || fail "the server is published on 127.0.0.1:$port"
ok "the server is published on 127.0.0.1:$port"
# `docker port` lists every published port of the container. (`compose port` cannot say "none" the same way in every
# Compose version: some print an error, some `invalid IP:0`.)
[ -z "$(docker port "$(compose ps -q postgres)")" ] || fail 'Postgres is not published'
ok 'Postgres is not published'

# 7. The server started and applied the migrations.
logs="$(compose logs --no-color server)"
grep -qF 'server.started' <<<"$logs" && grep -qF 'db.migrations.done' <<<"$logs" ||
  fail 'the log has server.started and db.migrations.done'
ok 'the log has server.started and db.migrations.done'

# 8. and 9. The root filesystem is read-only: even the node user's own home cannot be written.
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$(compose ps -q server)")" = true ] ||
  fail 'the root filesystem is read-only'
ok 'the root filesystem is read-only'
if compose exec -T server sh -c 'touch /home/node/x' 2>/dev/null; then fail 'writing to /home/node fails'; fi
ok 'writing to /home/node fails'

# 10. The licence is in the image, and no .env is (this script wrote apps/server/.env before building).
compose exec -T server sh -c 'test -f /app/LICENSE && test ! -e /app/apps/server/.env' ||
  fail 'the image has /app/LICENSE and no .env'
ok 'the image has /app/LICENSE and no .env'

# 11. route-eval runs inside the container: it finds the stored route, reaches no provider, and stores nothing.
code=0
out="$(compose exec -T server node apps/server/src/cli/route-eval.ts 2>&1)" || code=$?
[ "$code" -eq 1 ] || fail "route-eval exits 1 without a provider (exit code $code)"
grep -qF 'route openai-compatible/mock-model: not evaluated' <<<"$out" ||
  fail 'route-eval reports the route as not evaluated'
if grep -qF 'ERR_MODULE_NOT_FOUND' <<<"$out"; then fail 'route-eval finds all its modules'; fi
ok 'route-eval runs in the image'

echo "compose smoke test passed ($step checks)"
