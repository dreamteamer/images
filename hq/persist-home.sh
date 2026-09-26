#!/bin/sh
# dt-persist-home — makes the WHOLE home of the workspace user live on the workspace volume. Called by the
# entrypoint (as node) when DT_PERSIST_HOME names a directory on that volume (a hosted workspace); the
# entrypoint then runs node's processes with HOME=<persist-root>. A Docker Desktop container has its own
# home volume and never sets it.
#
# Why the whole home (layout 2, 2026-09-25): a Fly machine's own filesystem is rebuilt from the image on
# EVERY stop/start (measured: a file in ~ was gone after one stop and start; the volume kept its copy).
# Layout 1 persisted a fixed list of paths, so everything else in ~ — git's saved credentials, shell
# history, ~/.npmrc, ~/.local/bin, caches — was silently lost at every stop. Nothing the image ships lives
# in the home (CLIs are under /usr/local, editor extensions under /opt/code-server/extensions, the
# template under /opt/dt-template), so persisting all of it hides no image update.
#
#   usage: dt-persist-home <persist-root>
#
# Layout 1 kept its entries under short names (claude, code-server, config, …); they are moved to their
# real paths once. The shell's skeleton dotfiles are seeded only when absent. A version marker records
# the layout, so a later image can migrate rather than guess. Running it again changes nothing.
set -e
ROOT="$1"
[ -n "$ROOT" ] || { echo "usage: dt-persist-home <persist-root>" >&2; exit 2; }
LAYOUT=2
mkdir -p "$ROOT"
chmod 700 "$ROOT" 2>/dev/null || true

was="$(cat "$ROOT/.dt-persist-layout" 2>/dev/null || echo none)"
if [ "$was" = 1 ]; then
  # layout-1 name : real path under the home
  for pair in \
    code-server:.local/share/code-server \
    config:.config \
    claude:.claude \
    claude.json:.claude.json \
    codex:.codex \
    gemini:.gemini \
    antigravity:.antigravity \
    gitconfig:.gitconfig \
    ssh:.ssh
  do
    old="$ROOT/${pair%%:*}"; new="$ROOT/${pair#*:}"
    [ -e "$old" ] || [ -L "$old" ] || continue
    if [ -e "$new" ] || [ -L "$new" ]; then
      echo "… home layout 1→2: $new already exists, $old left in place"
      continue
    fi
    mkdir -p "$(dirname "$new")"
    mv "$old" "$new"
  done
  echo "… home layout 1→2: $ROOT is now the home itself"
fi

# the shell's defaults, once: after that the person's copies are theirs
for f in .bashrc .profile .bash_logout; do
  [ -e "$ROOT/$f" ] || [ ! -f "/etc/skel/$f" ] || cp "/etc/skel/$f" "$ROOT/$f"
done
mkdir -p "$ROOT/.local/share/code-server/User"
[ -d "$ROOT/.ssh" ] && chmod 700 "$ROOT/.ssh" || true
printf '%s\n' "$LAYOUT" > "$ROOT/.dt-persist-layout"
echo "… home on the volume: $ROOT (layout $LAYOUT)"
