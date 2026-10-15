#!/usr/bin/env bash
# The optional profiles smoke test (CL4-12): builds the server image with apps/server/compose.yaml and checks the caddy
# profile with the real Caddy, server and Postgres: the profile is off by default and on with COMPOSE_PROFILES in .env,
# the Caddyfile validates, Caddy serves /health over HTTPS with a certificate from its own local CA (what it uses for
# localhost instead of Let's Encrypt), redirects HTTP with 308, runs read-only with NET_BIND_SERVICE as its only
# capability, answers 502 while the server is stopped, and logs no client address, header or request address. Run it
# from the repository root, with Docker and nothing else on ports 80 and 443:
#
#   bash apps/server/scripts/profiles-smoke.sh
#
# It writes apps/server/.env for the run (test values only) and refuses to start when one is already there. On exit it
# removes that file, the project's containers and volumes, and the image it built (smoke-lib.sh). It publishes nothing
# but ports 80 and 443 and the server's loopback port. It is for CI and development machines: never run it on a shared
# host, where removing volumes and images is not allowed and ports 80 and 443 belong to the host's own proxy.
set -euo pipefail

project="ua-profiles-smoke-$RANDOM"
port=8791
# The helpers, the .env with test values and the cleanup on exit.
# shellcheck source=apps/server/scripts/smoke-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/smoke-lib.sh"
failure_logs='server caddy'
write_env

# The services `up` starts, one per line, sorted.
services() { compose config --services | sort | tr '\n' ' ' | sed 's/ $//'; }

# 1. Without COMPOSE_PROFILES the default services are unchanged and Caddy is not among them.
[ "$(services)" = 'backup postgres server' ] || fail "the default services are backup, postgres and server ($(services))"
ok 'without COMPOSE_PROFILES the services are backup, postgres and server'

# 2. COMPOSE_PROFILES in .env turns the profile on for every later command, without a --profile flag.
set_var COMPOSE_PROFILES caddy
set_var PUBLIC_URL https://localhost
set_var TRUST_PROXY one-hop
[ "$(services)" = 'backup caddy postgres server' ] || fail "COMPOSE_PROFILES=caddy adds caddy ($(services))"
ok 'COMPOSE_PROFILES=caddy in .env adds the caddy service'

# 3. The Caddyfile is valid, with PUBLIC_URL from .env.
compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
  fail 'caddy validate accepts the Caddyfile'
ok 'caddy validate accepts the Caddyfile'

image="$(compose config --images | grep -F ":$project")"
compose build server
compose up -d --wait --wait-timeout 180

# 4. HTTPS for localhost with a certificate from Caddy's local CA, whose root is copied out of the container. Caddy
# makes the certificate in the background after it starts, so the first requests may fail.
ca="$tmp/root.crt"
https() { curl -4 -sS --cacert "$(native "$ca")" "$@" https://localhost/health; }
health=''
for _ in $(seq 60); do
  if compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt >"$ca" 2>/dev/null &&
    health="$(https -f 2>/dev/null)"; then
    break
  fi
  sleep 1
done
grep -qF '"ok":true' <<<"$health" || fail 'https://localhost/health answers ok with a certificate from the local CA'
ok 'https://localhost/health answers ok with a certificate from the local CA'

# 5. Plain HTTP is redirected to HTTPS, as Caddy does on its own.
redirect="$(curl -4 -sS -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost/health)"
[ "$redirect" = '308 https://localhost/health' ] || fail "http://localhost/health redirects with 308 ($redirect)"
ok 'http://localhost/health redirects to https with 308'

# 6. A read-only root, every capability dropped and NET_BIND_SERVICE alone added (Docker may write it CAP_...).
container="$(compose ps -q caddy)"
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ] || fail 'the caddy root is read-only'
[ "$(docker inspect -f '{{join .HostConfig.CapDrop ","}}' "$container")" = ALL ] || fail 'caddy drops ALL capabilities'
added="$(docker inspect -f '{{join .HostConfig.CapAdd ","}}' "$container")"
[ "${added#CAP_}" = NET_BIND_SERVICE ] || fail "caddy adds NET_BIND_SERVICE only ($added)"
ok 'caddy runs read-only, with every capability dropped but NET_BIND_SERVICE'

# 7. With the server stopped Caddy answers 502, and serves again once it is back.
compose stop server
status="$(https -o /dev/null -w '%{http_code}' || true)"
compose start server
[ "$status" = 502 ] || fail "caddy answers 502 while the server is stopped ($status)"
ok 'caddy answers 502 while the server is stopped'

# 8. Caddy's log, the 502 error included, holds no client address, header or request address.
logs="$(compose logs --no-color caddy)"
for field in remote_ip client_ip remote_port '"headers"' '"uri"' '"remote"'; do
  if grep -qF -- "$field" <<<"$logs"; then fail "the caddy log has no $field"; fi
done
ok 'the caddy log holds no client address, header or request address'

echo "profiles smoke test passed ($step checks)"
