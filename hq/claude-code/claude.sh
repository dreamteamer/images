#!/bin/bash
# claude — the image's front for Claude Code (the real binary is REAL below). An interactive session passes
# straight through: its trust dialog holds a folder's hooks and .mcp.json servers until the person trusts it.
# A non-interactive one (-p/--print, or stdout not a terminal) never shows that dialog, and Claude Code 2.1.281
# then runs the folder's hooks and starts its .mcp.json servers anyway. So when the working folder is not
# trusted (dt-claude-trust: ~/.claude.json projects[<path>].hasTrustDialogAccepted, the key the dialog writes),
# this adds --setting-sources user: the folder's .claude/settings*.json (hooks, permissions, plugins) and
# .mcp.json servers are skipped, and so are its CLAUDE.md and skills. User settings, the user's MCP servers
# and managed settings still apply. An explicit --setting-sources later on the line wins, as the caller's choice.
REAL=/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
headless=0
[ -t 1 ] || headless=1
for a in "$@"; do
  case "$a" in
    -p|--print) headless=1 ;;
    --) break ;;
  esac
done
if [ "$headless" = 1 ] && ! /usr/local/bin/node /usr/local/lib/dt/claude-trust.mjs "$PWD"; then
  echo "claude: $PWD is not trusted, so this non-interactive run skips its project settings, hooks, .mcp.json servers, CLAUDE.md and skills. Run claude here once interactively and accept the trust dialog to trust it." >&2
  exec "$REAL" --setting-sources user "$@"
fi
exec "$REAL" "$@"
