#!/bin/bash
# dt-url-token — the local-mode URL token: 32 random bytes, base64url, in /home/node/.dt/url-token (the home
# volume, so it survives a restart). The file is root:dtproxy 0640 in a root:dtproxy 0750 directory, so the
# origin proxy (dtproxy) reads it and the workspace user (node) cannot. The engine reads it through a root
# `docker exec` and prints the one URL that carries it; nothing else ever does.
#
#   dt-url-token show     print the token (creating it if absent)
#   dt-url-token rotate   write a new token atomically and print it; the proxy picks it up by mtime, so
#                         every browser holding the old cookie is refused from the next request on
#   dt-url-token ensure   create it if absent, print nothing (the entrypoint, every start)
#
# Root only. /home/node is node's own directory, so node can put anything at .dt: a symlink or a foreign
# directory there is removed and recreated rather than followed.
set -euo pipefail
DIR=/home/node/.dt
FILE="$DIR/url-token"
die() { echo "✖ dt-url-token: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (docker exec -u root <container> dt-url-token ${1:-show})"
id dtproxy >/dev/null 2>&1 || die "the dtproxy user is missing from the image"

secure_dir() {
  if [ -L "$DIR" ] || { [ -e "$DIR" ] && [ ! -d "$DIR" ]; } || { [ -d "$DIR" ] && [ "$(stat -c %u "$DIR")" != 0 ]; }; then
    rm -rf -- "$DIR"
  fi
  mkdir -p "$DIR"
  chown -h root:dtproxy "$DIR"
  chmod 0750 "$DIR"
}

write_new() {
  local tmp token
  token=$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')
  [ "${#token}" = 43 ] || die "could not generate a token"
  tmp=$(mktemp "$DIR/.url-token.XXXXXX")
  printf '%s\n' "$token" > "$tmp"
  chown root:dtproxy "$tmp"
  chmod 0640 "$tmp"
  mv -f "$tmp" "$FILE"
}

valid() { [ -f "$FILE" ] && [ ! -L "$FILE" ] && grep -qE '^[A-Za-z0-9_-]{43}$' "$FILE"; }

case "${1:-show}" in
  ensure) secure_dir; valid || write_new ;;
  show) secure_dir; valid || write_new; cat "$FILE" ;;
  rotate) secure_dir; write_new; cat "$FILE" ;;
  *) die "usage: dt-url-token show|rotate" ;;
esac
