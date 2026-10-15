#!/usr/bin/env bash
# The compose smoke test (CL1-25): builds the server image with apps/server/compose.yaml, starts it with Postgres under
# a throwaway project name, and checks what self-hosters rely on. Run it from the repository root, with Docker:
#
#   bash apps/server/scripts/compose-smoke.sh
#
# It writes apps/server/.env for the run (test values only) and refuses to start when one is already there. On exit it
# removes that file, the project's containers and volume, and the image it built (smoke-lib.sh). It is for CI and
# development machines: never run it on a shared host, where removing volumes and images is not allowed.
set -euo pipefail

project="ua-smoke-$RANDOM"
port=8788
# The helpers, the .env with test values and the cleanup on exit.
# shellcheck source=apps/server/scripts/smoke-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/smoke-lib.sh"
write_env

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

# 12. A single-quoted value with $ in it reaches the server as written (.env.example tells people to quote them).
# shellcheck disable=SC2016 # the $ is meant literally
[ "$(compose exec -T server printenv MAIL_FROM_NAME)" = 'Smoke $PORT test' ] ||
  fail 'a single-quoted value with $ reaches the server unchanged'
ok 'a single-quoted value with $ reaches the server unchanged'

# 13. The link check's egress (R51) refuses the project network's Docker bridge gateway, the host as the container sees
# it: on :3000 for its port, on :80 for its address. Run inside the server container with the image's own Node flags.
gateway="$(docker network inspect "${project}_default" -f '{{(index .IPAM.Config 0).Gateway}}')"
[ -n "$gateway" ] || fail 'the project network has a gateway'
host="$gateway"
case "$host" in *:*) host="[$host]" ;; esac
probes="$(compose exec -T -w /app/apps/server server node --import ./src/require-node.js --input-type=module -e "
import { createEgress } from './src/net/egress.ts';
const egress = createEgress({ publicUrl: process.env.PUBLIC_URL, version: 'smoke' });
const outcomes = [await egress.probe('http://$host:3000/'), await egress.probe('http://$host/')];
console.log(JSON.stringify(outcomes));
")"
[ "$probes" = '[{"kind":"refused","reason":"port"},{"kind":"refused","reason":"address"}]' ] ||
  fail "the egress refuses the bridge gateway $gateway on :3000 (port) and :80 (address) ($probes)"
ok "the egress refuses the bridge gateway $gateway on :3000 (port) and :80 (address)"

echo "compose smoke test passed ($step checks)"
