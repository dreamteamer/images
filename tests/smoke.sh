#!/usr/bin/env bash
# tests/smoke.sh <image-ref>: runs the BUILT image in hosted mode (with CAP_NET_ADMIN, as Fly's init
# has) and checks what the internet, and the workspace user, would see. Exit 0 or the first failure.
set -euo pipefail
IMG="${1:?usage: smoke.sh <image-ref>}"; NAME="dt-smoke-$$"; PORT="${SMOKE_PORT:-18080}"
PUB=$(node -e "const c=require('crypto');process.stdout.write(c.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x)")
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
fail() { echo "✗ $*"; docker logs "$NAME" 2>&1 | tail -20; exit 1; }
ok() { echo "✔ $*"; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || true; }
as_node() { timeout 30 docker exec -u node "$NAME" bash -c "$1"; }

# fail-closed first: hosted with no key must exit non-zero within 5 s and never listen
t0=$(date +%s)
if timeout 10 docker run --rm -e DT_MODE=hosted -e DT_ORIGIN_HOST=origin.test "$IMG" >/dev/null 2>&1; then fail "hosted mode without a key started"; fi
[ $(( $(date +%s) - t0 )) -le 6 ] || fail "hosted mode without a key took more than 5 s to refuse"
ok "hosted without DT_GATEWAY_PUBLIC_KEY exits non-zero in $(( $(date +%s) - t0 )) s"

timeout 60 docker run -d --name "$NAME" --cap-add NET_ADMIN -p "127.0.0.1:$PORT:8080" \
  -e DT_MODE=hosted -e DT_GATEWAY_PUBLIC_KEY="$PUB" -e DT_ORIGIN_HOST=origin.test \
  -e DT_PERSIST_HOME=/workspaces/.home -e DT_WORKSPACE=smoke "$IMG" >/dev/null
for _ in $(seq 1 120); do [ "$(code "http://127.0.0.1:$PORT/healthz")" = 200 ] && break; sleep 2; done
[ "$(code "http://127.0.0.1:$PORT/healthz")" = 200 ] || fail "/healthz never answered 200"
ok "/healthz 200 with the editor up"
[ "$(code "http://127.0.0.1:$PORT/")" = 401 ] || fail "/ without an assertion is not 401"
ok "/ without an assertion 401"
[ "$(code -H 'x-dreamteamer-gateway: e30.e30.AAAA' "http://127.0.0.1:$PORT/")" = 401 ] || fail "a forged assertion is not 401"
ok "forged assertion 401"
[ "$(code -H 'connection: upgrade' -H 'upgrade: websocket' -H 'sec-websocket-version: 13' -H 'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$PORT/")" = 401 ] || fail "an unauthenticated WebSocket upgrade is not 401"
ok "unauthenticated WebSocket upgrade 401"

[ "$(timeout 30 docker exec "$NAME" ps -o user= -p 1 | tr -d ' ')" = root ] || fail "PID 1 is not the root supervisor"
PROXY_PID=$(timeout 30 docker exec "$NAME" pgrep -u dtproxy -f dt-origin-proxy | head -1)
[ -n "$PROXY_PID" ] || fail "the origin proxy is not running as dtproxy"
if as_node 'kill -0 1' 2>/dev/null; then fail "node can signal PID 1"; fi
if as_node "kill -0 $PROXY_PID" 2>/dev/null; then fail "node can signal the origin proxy"; fi
ok "PID 1 (root) and the proxy (dtproxy, pid $PROXY_PID) are not signalable by node"
if as_node 'test -w /usr/local/bin/dt-origin-proxy || test -w /usr/local/bin/dt-entrypoint || test -w /usr/local/bin'; then fail "node can write the auth boundary"; fi
ok "dt-origin-proxy / dt-entrypoint / /usr/local/bin not writable by node"
timeout 30 docker exec "$NAME" sh -c 'ps -eo user=,args= | grep "[c]ode-server" | grep -v "^node "' && fail "code-server runs as a user other than node"
nnp=$(as_node 'grep NoNewPrivs /proc/$(pgrep -u node -o -f "^/usr/lib/code-server/lib/node")/status' | awk '{print $2}')
[ "$nnp" = 1 ] || fail "code-server does not run with NoNewPrivs"
ok "code-server runs as node with NoNewPrivs: 1"
# Read the ruleset once: `nft … | grep -q` under pipefail fails when grep exits early and nft gets SIGPIPE.
ruleset=$(timeout 30 docker exec "$NAME" nft list ruleset)
grep -q 'tcp dport @blocked_ports' <<<"$ruleset" || fail "the egress policy is not applied"
grep -q 'ip6 daddr fdaa::/16' <<<"$ruleset" || fail "the 6PN drop is not applied"
ok "egress policy live (SMTP/mining ports, private ranges, 6PN)"
[ "$(timeout 30 docker exec "$NAME" cat /workspaces/smoke/.env)" = "FILES_FOLDER=/workspaces/files" ] || fail "hosted FILES_FOLDER is not on the volume"
[ "$(timeout 30 docker exec "$NAME" stat -c %U /workspaces/files)" = node ] || fail "/workspaces/files is not owned by node"
ok "FILES_FOLDER=/workspaces/files (on the volume, owned by node)"
extra=$(timeout 30 docker exec "$NAME" sh -c 'cat /proc/net/tcp /proc/net/tcp6' | awk '$4=="0A"{split($2,a,":"); if (a[1]!="0100007F" && a[1]!="00000000000000000000000001000000" && a[2]!="1F90") print $2}')
[ -z "$extra" ] || fail "unexpected non-loopback listeners: $extra"
ok "only :8080 exposed"
echo "✔ smoke: healthz 200, / 401, forged 401, ws 401, PID1 root + proxy dtproxy unsignalable by node, proxy not writable, egress on, FILES_FOLDER on the volume, only :8080 exposed"
