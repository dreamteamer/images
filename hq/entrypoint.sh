#!/bin/bash
# dt-entrypoint — every start: the workspace dir `dt start container` named (DT_WORKSPACE_DIR,
# /workspaces/<name>) is laid down on first start — from DT_REPO when a clone URL was given, else from
# the prebuilt template — the person's git identity is applied, the runtime is compiled, editor
# defaults are merged into the person's settings, and code-server takes over.
#
# Two modes, chosen EXPLICITLY by DT_MODE:
#   local (default)  Docker Desktop via `dt start container`. code-server serves port 8080 with no auth of
#                    its own, bound to 127.0.0.1 unless DT_LOCAL_BIND=0.0.0.0 — which a Docker port
#                    mapping needs, and which `dt start container` must therefore pass (the host side
#                    of the mapping is loopback already).
#   hosted           behind the dreamteamer gateway. Refuses to start unless DT_GATEWAY_PUBLIC_KEY (or
#                    DT_GATEWAY_PUBLIC_KEYS) imports and DT_ORIGIN_HOST is set; applies the egress policy
#                    (/etc/dt/egress.nft + a tc bandwidth cap; failure is fatal, DT_EGRESS_POLICY=off is
#                    the loud debugging opt-out); then code-server listens on 127.0.0.1:8081 and
#                    dt-origin-proxy owns 8080, as its own user `dtproxy`, refusing every request without
#                    a gateway assertion. DT_PERSIST_HOME names a directory on the workspace volume that the
#                    durable parts of $HOME are moved onto.
#
# Privilege: the image starts as root. This script stays root as a small supervisor (PID 1), so the
# workspace user can signal neither it nor the proxy; everything else runs with setpriv, no new
# privileges and no capabilities — the workspace preparation and code-server as `node`, the proxy as
# `dtproxy`. When either child exits, the supervisor stops the other and exits non-zero, so the
# platform restarts the machine. Nothing here reads or writes a credential.
set -euo pipefail

log() { echo "dt-entrypoint: $*" >&2; }
die() { echo "✖ dt-entrypoint: $*" >&2; exit 1; }

WS="${DT_WORKSPACE_DIR:-/workspaces/${DT_WORKSPACE:-hq}}"
EDITOR_ARGS=(--auth none --disable-telemetry --disable-update-check --extensions-dir /opt/code-server/extensions --user-data-dir /home/node/.local/share/code-server)

# ---- the workspace, prepared as node (the root phase re-enters this script with --prepare) ----
prepare() {
  mkdir -p "$WS"
  if [ -n "${DT_PERSIST_HOME:-}" ]; then dt-persist-home "$DT_PERSIST_HOME"; fi
  cd "$WS"
  if [ ! -f package.json ]; then
    if [ -n "${DT_REPO:-}" ]; then
      echo "… first start: cloning $DT_REPO into $WS"
      # into the (empty) volume in place — a clone cannot replace a mount point, so clone beside and copy
      git clone --quiet "$DT_REPO" "$WS.clone" && cp -a "$WS.clone/." "$WS/" && rm -rf "$WS.clone"
      if [ ! -f package.json ]; then echo "✖ $DT_REPO has no package.json — not a dreamteamer workspace" >&2; exit 1; fi
      # the engine the workspace PINS, then its runtime — never the image's copy of either
      npm install --no-audit --no-fund
    else
      echo "… first start: laying down the ${DT_TEMPLATE:-hq} workspace at $WS"
      cp -a /opt/dt-template/. "$WS/"
    fi
  fi
  if [ -n "${GIT_AUTHOR_NAME:-}" ]; then git config user.name "$GIT_AUTHOR_NAME"; fi
  if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then git config user.email "$GIT_AUTHOR_EMAIL"; fi
  if [ ! -f .env ]; then printf 'FILES_FOLDER=%s\n' "${FILES_FOLDER:-/files}" > .env; fi
  # Editor settings the person should never be asked about — git.autofetch answers "periodically run
  # git fetch?" once — merged into the settings file in the home volume, adding only keys it lacks.
  SETTINGS=/home/node/.local/share/code-server/User/settings.json
  mkdir -p "$(dirname "$SETTINGS")"
  node -e '
const fs = require("fs"); const p = process.argv[1];
let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
const defaults = { "git.autofetch": true, "git.confirmSync": false, "workbench.startupEditor": "none" };
let changed = false;
for (const [k, v] of Object.entries(defaults)) if (!(k in s)) { s[k] = v; changed = true; }
if (changed) fs.writeFileSync(p, JSON.stringify(s, null, "\t") + "\n");
' "$SETTINGS"
  npx dreamteamer compile
}

if [ "${1:-}" = "--prepare" ]; then prepare; exit 0; fi

# ---- mode ----
MODE="${DT_MODE:-local}"
case "$MODE" in
  hosted|local) ;;
  *) die "DT_MODE must be hosted or local (got '$MODE')" ;;
esac
BIND="${DT_LOCAL_BIND:-127.0.0.1}"
case "$BIND" in
  127.0.0.1|0.0.0.0) ;;
  *) die "DT_LOCAL_BIND must be 127.0.0.1 or 0.0.0.0 (got '$BIND')" ;;
esac
if [ "$MODE" = local ] && [ -n "${DT_GATEWAY_PUBLIC_KEY:-}${DT_GATEWAY_PUBLIC_KEYS:-}" ]; then
  log "a gateway key is set but DT_MODE is not hosted: serving LOCAL mode on $BIND:8080, no origin proxy"
fi

# Not root (a `docker run -u node`, or an image that ends on USER node): local mode only, unsupervised.
if [ "$(id -u)" != "0" ]; then
  [ "$MODE" = local ] || die "hosted mode must start as root: it applies the egress policy and runs the origin proxy as its own user"
  prepare
  exec code-server --bind-addr "$BIND:8080" "${EDITOR_ARGS[@]}" "$WS"
fi

# ---- root phase ----
PROXY_ENV=()
if [ "$MODE" = hosted ]; then
  # fail closed, fast: no key that imports, or no audience, and nothing listens
  /usr/local/bin/node /usr/local/bin/dt-origin-proxy --check || die "hosted mode needs DT_GATEWAY_PUBLIC_KEY (or DT_GATEWAY_PUBLIC_KEYS) and DT_ORIGIN_HOST — refusing to start the public listener"
  id dtproxy >/dev/null 2>&1 || die "the dtproxy user is missing from the image"
  PROXY_ENV=(DT_PROXY_PORT=8080 DT_EDITOR_PORT=8081 "DT_ORIGIN_HOST=$DT_ORIGIN_HOST")
  [ -z "${DT_GATEWAY_PUBLIC_KEY:-}" ] || PROXY_ENV+=("DT_GATEWAY_PUBLIC_KEY=$DT_GATEWAY_PUBLIC_KEY")
  [ -z "${DT_GATEWAY_PUBLIC_KEYS:-}" ] || PROXY_ENV+=("DT_GATEWAY_PUBLIC_KEYS=$DT_GATEWAY_PUBLIC_KEYS")
fi

apply_egress() {
  local policy="${DT_EGRESS_POLICY:-on}" mbit="${DT_EGRESS_MBIT:-20}" dev
  if [ "$policy" = off ]; then
    log "⚠ ⚠ ⚠  DT_EGRESS_POLICY=off — NO EGRESS POLICY: this workspace can reach SMTP, mining pools, private ranges and 6PN, unthrottled. Debugging only."
    return 0
  fi
  [ "$policy" = on ] || die "DT_EGRESS_POLICY must be on or off (got '$policy')"
  [[ "$mbit" =~ ^[1-9][0-9]{0,4}$ ]] || die "DT_EGRESS_MBIT must be a whole number of megabits (got '$mbit')"
  nft -f /etc/dt/egress.nft || die "could not apply the egress policy (/etc/dt/egress.nft): nft needs CAP_NET_ADMIN — refusing to serve a hosted workspace without it"
  dev=$(ip -o route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  [ -n "$dev" ] || dev=$(ip -o -6 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
  [ -n "$dev" ] || die "could not apply the egress policy: no default route to find the egress interface"
  tc qdisc replace dev "$dev" root tbf rate "${mbit}mbit" burst 32kbit latency 400ms || die "could not apply the egress policy: tc tbf on $dev failed (CAP_NET_ADMIN, sch_tbf)"
  log "egress policy applied: /etc/dt/egress.nft, ${mbit} Mbit/s on $dev"
}
if [ "$MODE" = hosted ]; then apply_egress ; fi

# A freshly attached volume (Fly, or any raw block device) mounts owned by root; a Docker named volume
# inherits the image's ownership. Only the two fixed mount points are touched, never their contents.
for d in /workspaces /files; do
  if [ -d "$d" ] && [ "$(stat -c %u "$d")" != "$(id -u node)" ]; then chown node:node "$d"; fi
done

AS_NODE=(setpriv --reuid=node --regid=node --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all env HOME=/home/node USER=node LOGNAME=node)
AS_PROXY=(setpriv --reuid=dtproxy --regid=dtproxy --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all)

"${AS_NODE[@]}" /usr/local/bin/dt-entrypoint --prepare

# ---- supervise ----
declare -A NAMES=()
STOPPING=0
if [ "$MODE" = hosted ]; then
  (cd / && exec "${AS_PROXY[@]}" env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent "${PROXY_ENV[@]}" /usr/local/bin/node --disable-sigusr1 /usr/local/bin/dt-origin-proxy) &
  NAMES[$!]=dt-origin-proxy
  (cd "$WS" && exec "${AS_NODE[@]}" code-server --bind-addr 127.0.0.1:8081 "${EDITOR_ARGS[@]}" "$WS") &
  NAMES[$!]=code-server
else
  (cd "$WS" && exec "${AS_NODE[@]}" code-server --bind-addr "$BIND:8080" "${EDITOR_ARGS[@]}" "$WS") &
  NAMES[$!]=code-server
fi

stop_children() { kill -TERM "${!NAMES[@]}" 2>/dev/null || true; }
trap 'STOPPING=1; stop_children' TERM INT

set +e
wait -n "${!NAMES[@]}"
status=$?
if [ "$STOPPING" = 1 ]; then
  wait
  exit 0
fi
dead=""
for pid in "${!NAMES[@]}"; do kill -0 "$pid" 2>/dev/null || dead="${dead:+$dead, }${NAMES[$pid]}"; done
log "${dead:-a child} exited (status $status); stopping the machine"
stop_children
( sleep 10; kill -KILL "${!NAMES[@]}" 2>/dev/null ) &
wait "${!NAMES[@]}" 2>/dev/null
[ "$status" -ne 0 ] || status=1
exit "$status"
