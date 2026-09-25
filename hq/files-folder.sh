#!/bin/bash
# dt-files-folder — decides where the workspace's FILES_FOLDER lives and writes it into the workspace
# .env. Called by the entrypoint (as node) on every start.
#   usage: dt-files-folder <workspace-dir> <local|hosted> <legacy-dir> <volume-dir>
#          (the entrypoint passes /files and /workspaces/files)
# local   unchanged: when .env is absent, write FILES_FOLDER=${FILES_FOLDER:-<legacy-dir>}.
# hosted  FILES_FOLDER must be on the persistent volume, because the image's /files is not, so a
#         replaced machine would lose it. Create <volume-dir>. A fresh .env names it. An existing .env
#         that still names <legacy-dir> has that one value rewritten. Whatever sits in <legacy-dir> is
#         moved over, never overwriting a name already on the volume (a clash stays put and is logged).
#         Running it again changes nothing.
set -euo pipefail
WS="${1:?usage: dt-files-folder <workspace-dir> <local|hosted> <legacy-dir> <volume-dir>}"
MODE="${2:?mode}"; LEGACY="${3:?legacy dir}"; TARGET="${4:?volume dir}"
ENVFILE="$WS/.env"

if [ "$MODE" != hosted ]; then
  [ -f "$ENVFILE" ] || printf 'FILES_FOLDER=%s\n' "${FILES_FOLDER:-$LEGACY}" > "$ENVFILE"
  exit 0
fi

mkdir -p "$TARGET"
if [ ! -f "$ENVFILE" ]; then
  printf 'FILES_FOLDER=%s\n' "$TARGET" > "$ENVFILE"
elif grep -qx "FILES_FOLDER=$LEGACY/\{0,1\}" "$ENVFILE"; then
  tmp="$ENVFILE.dt-files-folder.$$"
  awk -v legacy="$LEGACY" -v target="$TARGET" '$0 == "FILES_FOLDER=" legacy || $0 == "FILES_FOLDER=" legacy "/" { print "FILES_FOLDER=" target; next } { print }' "$ENVFILE" > "$tmp"
  cat "$tmp" > "$ENVFILE" && rm -f "$tmp"
  echo "… hosted: FILES_FOLDER in $ENVFILE rewritten from $LEGACY to $TARGET (on the volume)"
fi

if [ -d "$LEGACY" ]; then
  moved=0
  shopt -s dotglob nullglob
  for entry in "$LEGACY"/*; do
    name="$(basename "$entry")"
    if [ -e "$TARGET/$name" ] || [ -L "$TARGET/$name" ]; then
      echo "… hosted: $LEGACY/$name left in place: $TARGET/$name already exists"
      continue
    fi
    mv "$entry" "$TARGET/$name"
    moved=$((moved + 1))
  done
  [ "$moved" = 0 ] || echo "… hosted: moved $moved entr$([ "$moved" = 1 ] && echo y || echo ies) from $LEGACY to $TARGET"
fi
