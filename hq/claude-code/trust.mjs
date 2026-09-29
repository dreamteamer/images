#!/usr/bin/env node
// dt-claude-trust <dir> — exits 0 when Claude Code would call <dir> trusted, 1 when not. The `claude` wrapper
// (/usr/local/bin/claude) asks it before a non-interactive run.
//
// The rule, read out of Claude Code 2.1.281 itself: a folder is trusted when ~/.claude.json (or
// $CLAUDE_CONFIG_DIR/.claude.json) has projects[<path>].hasTrustDialogAccepted for the folder or for an
// ancestor, walking up no further than the folder's git repository root (so a trusted parent does not trust
// a repository nested inside it); outside any repository the walk goes to /. The interactive trust dialog
// is what writes that key. An unreadable or malformed config trusts nothing. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The nearest ancestor of `dir` (itself included) that holds a `.git`, or null. */
export function gitRoot(dir, exists = fs.existsSync) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, '.git'))) return d;
    if (d === path.dirname(d)) return null;
  }
}

/** True when `config.projects` trusts `dir` (absolute, resolved) under the rule above. Pure but for `exists`. */
export function isTrusted(config, dir, exists = fs.existsSync) {
  const projects = config && typeof config === 'object' ? config.projects : null;
  if (!projects || typeof projects !== 'object') return false;
  const root = gitRoot(dir, exists);
  for (let d = dir; ; d = path.dirname(d)) {
    if (projects[d]?.hasTrustDialogAccepted === true) return true;
    if (d === root || d === path.dirname(d)) return false;
  }
}

export function configPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || env.HOME || os.homedir(), '.claude.json');
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${fs.realpathSync(process.argv[1])}`).href;
if (isMain) {
  let config = null;
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch {}
  let dir;
  try { dir = fs.realpathSync(process.argv[2] || process.cwd()); } catch { process.exit(1); }
  process.exit(isTrusted(config, dir) ? 0 : 1);
}
