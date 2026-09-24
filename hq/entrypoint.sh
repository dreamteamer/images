#!/bin/sh
# dt-entrypoint — every start: the workspace dir `dt start container` named (DT_WORKSPACE_DIR,
# /workspaces/<name>) is laid down on first start — from DT_REPO when a clone URL was given, else from
# the prebuilt template — the person's git identity is applied, the runtime is compiled, editor
# defaults are merged into the person's settings, and code-server takes over.
#
# Two modes. LOCAL (Docker Desktop via `dt start container`): the host binds the port to loopback and
# code-server listens on 8080 with no auth of its own. HOSTED (behind the dreamteamer gateway):
# DT_GATEWAY_PUBLIC_KEY is set, so code-server listens on 127.0.0.1:8081 and dt-origin-proxy owns 8080,
# refusing every request that does not carry a gateway assertion; and DT_PERSIST_HOME names a directory
# on the workspace volume that the durable parts of $HOME are moved onto. Nothing here reads or writes a
# credential.
set -e
WS="${DT_WORKSPACE_DIR:-/workspaces/${DT_WORKSPACE:-hq}}"
mkdir -p "$WS"
if [ -n "$DT_PERSIST_HOME" ]; then dt-persist-home "$DT_PERSIST_HOME"; fi
cd "$WS"
if [ ! -f package.json ]; then
  if [ -n "$DT_REPO" ]; then
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
if [ -n "$GIT_AUTHOR_NAME" ]; then git config user.name "$GIT_AUTHOR_NAME"; fi
if [ -n "$GIT_AUTHOR_EMAIL" ]; then git config user.email "$GIT_AUTHOR_EMAIL"; fi
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
if [ -n "$DT_GATEWAY_PUBLIC_KEY" ]; then
  # hosted: the editor is loopback-only and the proxy is the only thing on the published port
  code-server --bind-addr 127.0.0.1:8081 --auth none --disable-telemetry --disable-update-check \
    --extensions-dir /opt/code-server/extensions --user-data-dir /home/node/.local/share/code-server "$WS" &
  exec env DT_PROXY_PORT=8080 DT_EDITOR_PORT=8081 node /usr/local/bin/dt-origin-proxy
fi
exec code-server --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry --disable-update-check \
  --extensions-dir /opt/code-server/extensions --user-data-dir /home/node/.local/share/code-server "$WS"
