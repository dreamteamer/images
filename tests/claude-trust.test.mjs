// 0.6.0 image-hardening review, P0: `claude -p` in an untrusted cloned repository ran its .claude/settings.json
// hooks and started its .mcp.json servers (Claude Code 2.1.281 shows no trust dialog on that path). The image's
// `claude` front adds --setting-sources user to a non-interactive run in a folder nobody trusted. The trust rule
// and the front are pinned here; tests/container.test.mjs runs the real CLI against a fixture repository.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { configPath, gitRoot, isTrusted } from '../hq/claude-code/trust.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(ROOT, ...p), 'utf8');
const trusted = (...dirs) => ({ projects: Object.fromEntries(dirs.map((d) => [d, { hasTrustDialogAccepted: true }])) });

describe('the trust rule (Claude Code 2.1.281)', () => {
	const repos = new Set(['/workspaces/acme', '/workspaces/acme/vendor/lib']);
	const exists = (p) => repos.has(path.dirname(p)) && p.endsWith('/.git');
	test('gitRoot: the nearest ancestor holding .git, or null', () => {
		assert.equal(gitRoot('/workspaces/acme/src/a', exists), '/workspaces/acme');
		assert.equal(gitRoot('/workspaces/acme/vendor/lib/x', exists), '/workspaces/acme/vendor/lib');
		assert.equal(gitRoot('/tmp/x', exists), null);
	});
	test('the folder, or an ancestor up to its repository root, carries hasTrustDialogAccepted: true', () => {
		assert.equal(isTrusted(trusted('/workspaces/acme'), '/workspaces/acme', exists), true);
		assert.equal(isTrusted(trusted('/workspaces/acme'), '/workspaces/acme/src/a', exists), true);
		assert.equal(isTrusted(trusted('/workspaces/acme/src'), '/workspaces/acme/src/a', exists), true);
	});
	test('a trusted parent does not trust a repository nested inside it', () => {
		assert.equal(isTrusted(trusted('/workspaces'), '/workspaces/acme', exists), false);
		assert.equal(isTrusted(trusted('/workspaces/acme'), '/workspaces/acme/vendor/lib/x', exists), false);
	});
	test('outside any repository, any ancestor counts', () => {
		assert.equal(isTrusted(trusted('/tmp'), '/tmp/x/y', exists), true);
	});
	test('nothing else trusts: absent, false, a sibling, no config, a malformed one', () => {
		assert.equal(isTrusted({ projects: { '/workspaces/acme': { hasTrustDialogAccepted: false } } }, '/workspaces/acme', exists), false);
		assert.equal(isTrusted({ projects: { '/workspaces/acme': { hasTrustDialogAccepted: 'yes' } } }, '/workspaces/acme', exists), false);
		assert.equal(isTrusted(trusted('/workspaces/acme2'), '/workspaces/acme', exists), false);
		assert.equal(isTrusted(null, '/workspaces/acme', exists), false);
		assert.equal(isTrusted({ projects: [] }, '/workspaces/acme', exists), false);
		assert.equal(isTrusted({}, '/workspaces/acme', exists), false);
	});
	test('the config is ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json', () => {
		assert.equal(configPath({ HOME: '/home/node' }), '/home/node/.claude.json');
		assert.equal(configPath({ HOME: '/home/node', CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg/.claude.json');
	});
});

describe('the claude front', () => {
	// the real script, pointed at a fake CLI that prints its arguments and at this checkout's trust.mjs
	const dir = mkdtempSync(path.join(tmpdir(), 'dt-claude-front-'));
	const fake = path.join(dir, 'claude.exe');
	writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$@"\n');
	chmodSync(fake, 0o755);
	const front = path.join(dir, 'claude');
	writeFileSync(front, read('hq', 'claude-code', 'claude.sh')
		.replace(/^REAL=.*$/m, `REAL=${fake}`)
		.replace('/usr/local/bin/node /usr/local/lib/dt/claude-trust.mjs', `${process.execPath} ${path.join(ROOT, 'hq', 'claude-code', 'trust.mjs')}`));
	chmodSync(front, 0o755);
	const home = path.join(dir, 'home');
	const repo = path.join(dir, 'repo');
	mkdirSync(path.join(repo, '.git'), { recursive: true });
	mkdirSync(home);
	const run = (args) => spawnSync(front, args, { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
	test('the front is what the image installs: REAL is the npm package binary, and it replaces npm\'s link', () => {
		const sh = read('hq', 'claude-code', 'claude.sh');
		assert.match(sh, /^REAL=\/usr\/local\/lib\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/m);
		const df = read('hq', 'Dockerfile');
		assert.match(df, /&& rm \/usr\/local\/bin\/claude \\\n/);
		assert.match(df, /^COPY --chown=root:root --chmod=0755 claude-code\/claude\.sh \/usr\/local\/bin\/claude$/m);
		assert.match(df, /^COPY --chown=root:root --chmod=0644 claude-code\/trust\.mjs \/usr\/local\/lib\/dt\/claude-trust\.mjs$/m);
	});
	test('untrusted and non-interactive: --setting-sources user comes first, the caller\'s arguments follow unchanged, and stderr says why', () => {
		const r = run(['-p', 'say hi', '--output-format', 'json']);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(r.stdout.trim().split('\n'), ['--setting-sources', 'user', '-p', 'say hi', '--output-format', 'json']);
		assert.match(r.stderr, /is not trusted, so this non-interactive run skips its project settings, hooks, \.mcp\.json servers, CLAUDE\.md and skills/);
	});
	test('trusted (the key the trust dialog writes): passed through untouched, nothing said', () => {
		writeFileSync(path.join(home, '.claude.json'), JSON.stringify(trusted(realpathSync(repo))));
		try {
			const r = run(['-p', 'say hi']);
			assert.deepEqual(r.stdout.trim().split('\n'), ['-p', 'say hi']);
			assert.equal(r.stderr, '');
		} finally { writeFileSync(path.join(home, '.claude.json'), '{}'); }
	});
	test('a subcommand keeps working: the flag goes before it', () => {
		assert.deepEqual(run(['mcp', 'list']).stdout.trim().split('\n'), ['--setting-sources', 'user', 'mcp', 'list']);
	});
});
