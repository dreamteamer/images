#!/bin/bash
# dt-new — makes another workspace on this machine: a folder under /workspaces, opened in its own tab at
# ?folder=/workspaces/<name>. Runs as the workspace user (the machine's launcher calls it in a terminal,
# so git's credential prompt reaches the editor). Many workspaces, one machine, one home and one set of
# logins: separation between people or clients is a second machine, not a second folder.
#
#   dt-new <name>                  from the dreamteamer hq template (copied, compiled)
#   dt-new <name> --empty          an empty folder
#   dt-new <name> --clone <url> [--install]
#                                  git clone (https://, ssh:// or git@). Installing and compiling a cloned
#                                  dreamteamer repo RUNS CODE THE REPO CHOSE (its lockfile can name any
#                                  tarball, and compile runs the engine it installed), so it happens only
#                                  with --install, which the launcher asks for explicitly.
#
# A dreamteamer workspace gets its OWN files folder, /workspaces/.files/<name> (hosted), written into its
# .env, so two workspaces never share recording or document paths. Exit 0 prints the folder to open.
set -euo pipefail
ROOT="${DT_WORKSPACES_ROOT:-/workspaces}"
TEMPLATE="${DT_TEMPLATE_DIR:-/opt/dt-template}"
die() { echo "✖ dt-new: $*" >&2; exit 1; }

name="${1:-}"; shift || true
mode=template; url=""; install=0
case "${1:-}" in
  "") ;;
  --empty) mode=empty ;;
  --clone)
    mode=clone; url="${2:-}"; [ -n "$url" ] || die "--clone needs a repository URL"
    case "${3:-}" in "") ;; --install) install=1 ;; *) die "unknown option '$3'" ;; esac
    ;;
  *) die "unknown option '$1' (use --empty or --clone <url> [--install])" ;;
esac

# one rule for every way a workspace is made: it becomes a URL path and a folder beside the home
[[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]] || die "name must be 1–40 of a-z, 0-9 and '-', starting with a letter or digit (got '$name')"
case "$name" in files|lost-found|trash) die "'$name' is reserved on this machine" ;; esac
dest="$ROOT/$name"
[ ! -e "$dest" ] && [ ! -L "$dest" ] || die "$dest already exists"

is_dreamteamer() { [ -f "$1/package.json" ] && node -e 'process.exit(require(process.argv[1]).dreamteamer ? 0 : 1)' "$1/package.json" 2>/dev/null; }

files_folder() {
  if [ "${DT_MODE:-local}" = hosted ]; then dt-files-folder "$1" hosted /files "$ROOT/.files/$name"
  else dt-files-folder "$1" local /files /files; fi
}

case "$mode" in
  template)
    [ -d "$TEMPLATE" ] || die "no template at $TEMPLATE"
    echo "… new workspace $name from the hq template"
    cp -a "$TEMPLATE/." "$dest/"
    files_folder "$dest"
    (cd "$dest" && npx --no-install dreamteamer compile)
    ;;
  empty)
    mkdir -p "$dest"
    echo "… new empty workspace $name"
    ;;
  clone)
    [[ "$url" =~ ^(https://|ssh://|git@)[^[:space:]]+$ ]] || die "the URL must start with https://, ssh:// or git@ (got '$url')"
    echo "… cloning $url into $dest"
    git clone -- "$url" "$dest"
    if is_dreamteamer "$dest"; then
      files_folder "$dest"
      if [ "$install" = 1 ]; then
        echo "… a dreamteamer workspace: installing its pinned engine and compiling"
        if [ -f "$dest/package-lock.json" ]; then (cd "$dest" && npm ci --no-audit --no-fund --prefer-offline)
        else (cd "$dest" && npm install --no-audit --no-fund --prefer-offline); fi
        (cd "$dest" && npx --no-install dreamteamer compile)
      else
        echo "… a dreamteamer workspace, not installed: trust it, then run 'npm ci && npx dreamteamer compile' inside it"
      fi
    else
      echo "… not a dreamteamer workspace; open it as it is, or run 'npx dreamteamer init' inside it"
    fi
    ;;
esac
echo "✔ $dest"
echo "open: ?folder=$dest"
