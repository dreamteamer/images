#!/bin/sh
# dt-persist-home — makes the parts of $HOME that must outlive the machine live on the workspace
# volume. Called by the entrypoint when DT_PERSIST_HOME names a directory on that volume (a hosted
# workspace); a Docker Desktop container has its own home volume and never sets it.
#
# For each path: if the persistent copy does not exist yet and the home path holds baked-in files,
# those are MOVED in (so nothing the image shipped is hidden); then the home path becomes a symlink.
# A version marker records which layout was applied, so a later image can migrate rather than guess.
#   usage: dt-persist-home <persist-root> [home]
set -e
ROOT="$1"; HOME_DIR="${2:-$HOME}"
[ -n "$ROOT" ] || { echo "usage: dt-persist-home <persist-root> [home]" >&2; exit 2; }
LAYOUT=1
mkdir -p "$ROOT"
# relative-to-home path  →  name under $ROOT.  Editor state, every agent CLI's login, git and ssh config.
PAIRS="
.local/share/code-server:code-server
.config:config
.claude:claude
.claude.json:claude.json
.codex:codex
.gemini:gemini
.antigravity:antigravity
.gitconfig:gitconfig
.ssh:ssh
"
for pair in $PAIRS; do
  rel="${pair%%:*}"; name="${pair##*:}"
  src="$HOME_DIR/$rel"; dst="$ROOT/$name"
  if [ -L "$src" ]; then
    # already a link: only accept ours
    [ "$(readlink "$src")" = "$dst" ] && continue
    rm -f "$src"
  fi
  if [ ! -e "$dst" ] && [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"; mv "$src" "$dst"
  fi
  if [ -e "$src" ]; then rm -rf "$src"; fi
  mkdir -p "$(dirname "$src")"
  ln -s "$dst" "$src"
done
chmod 700 "$ROOT" 2>/dev/null || true
[ -d "$ROOT/ssh" ] && chmod 700 "$ROOT/ssh" || true
printf '%s\n' "$LAYOUT" > "$ROOT/.dt-persist-layout"
echo "… home state persisted under $ROOT (layout $LAYOUT)"
