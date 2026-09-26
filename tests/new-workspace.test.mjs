// dt-new: another workspace on the machine is a folder under /workspaces. Runs the real script against a
// temp root with the real dt-files-folder on PATH and a recording stand-in for npx/npm (no network).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../hq/new-workspace.sh', import.meta.url));
const FILES = fileURLToPath(new URL('../hq/files-folder.sh', import.meta.url));

function setup() {
	const base = mkdtempSync(path.join(tmpdir(), 'dt-new-'));
	const root = path.join(base, 'workspaces');
	const template = path.join(base, 'template');
	const bin = path.join(base, 'bin');
	const log = path.join(base, 'calls.log');
	mkdirSync(root, { recursive: true });
	mkdirSync(path.join(template, '.git'), { recursive: true });
	writeFileSync(path.join(template, 'package.json'), JSON.stringify({ name: 'hq', dreamteamer: {} }));
	writeFileSync(path.join(template, '.env.example'), 'FILES_FOLDER=\n');
	mkdirSync(bin);
	copyFileSync(FILES, path.join(bin, 'dt-files-folder'));
	chmodSync(path.join(bin, 'dt-files-folder'), 0o755);
	for (const tool of ['npx', 'npm']) {
		writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $* (in $PWD)" >> '${log}'\n`);
		chmodSync(path.join(bin, tool), 0o755);
	}
	// a local "remote": a dreamteamer repo and a plain one, cloned over file:// only in the tests
	return { base, root, template, bin, log };
}
function dtNew(s, args, extra = {}) {
	return spawnSync('bash', [SCRIPT, ...args], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, DT_WORKSPACES_ROOT: s.root, DT_TEMPLATE_DIR: s.template, DT_MODE: 'hosted', ...extra },
	});
}
const calls = (s) => (existsSync(s.log) ? readFileSync(s.log, 'utf8') : '');

describe('dt-new', () => {
	test('from the template: a copy, its OWN files folder on the volume, compiled; prints what to open', () => {
		const s = setup();
		const r = dtNew(s, ['second']);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(path.join(s.root, 'second', 'package.json')));
		assert.equal(readFileSync(path.join(s.root, 'second', '.env'), 'utf8'), `FILES_FOLDER=${path.join(s.root, '.files', 'second')}\n`);
		assert.ok(existsSync(path.join(s.root, '.files', 'second')));
		assert.match(calls(s), /npx --no-install dreamteamer compile \(in .*\/second\)/);
		assert.match(r.stdout, new RegExp(`open: \\?folder=${path.join(s.root, 'second')}`));
	});

	test('two workspaces never share a files folder', () => {
		const s = setup();
		assert.equal(dtNew(s, ['a']).status, 0);
		assert.equal(dtNew(s, ['b']).status, 0);
		assert.notEqual(readFileSync(path.join(s.root, 'a', '.env'), 'utf8'), readFileSync(path.join(s.root, 'b', '.env'), 'utf8'));
	});

	test('empty: just the folder, nothing run', () => {
		const s = setup();
		assert.equal(dtNew(s, ['scratch', '--empty']).status, 0);
		assert.ok(existsSync(path.join(s.root, 'scratch')));
		assert.equal(calls(s), '');
	});

	test('names: one rule, reserved names and an existing folder are refused, nothing written', () => {
		const s = setup();
		mkdirSync(path.join(s.root, 'taken'));
		for (const bad of ['', 'Upper', '-lead', 'a b', 'a/b', '../x', '.home', 'files', 'trash', 'x'.repeat(41), 'taken']) {
			const r = dtNew(s, [bad, '--empty']);
			assert.notEqual(r.status, 0, `accepted '${bad}'`);
		}
		assert.ok(!existsSync(path.join(s.root, '.home')));
	});

	test('clone: only https, ssh or git@ URLs; ext:: and file:: transports are refused', () => {
		const s = setup();
		for (const bad of ['ext::sh -c touch% /tmp/pwned', 'file:///etc', '/etc', '--upload-pack=x']) {
			const r = dtNew(s, ['c', '--clone', bad]);
			assert.notEqual(r.status, 0, bad);
			assert.match(r.stderr, /must start with https:\/\/, ssh:\/\/ or git@/);
		}
	});

	test('a cloned dreamteamer repo is NOT installed or compiled unless --install says so (that runs code the repo chose)', () => {
		const s = setup();
		const remote = path.join(s.base, 'remote');
		mkdirSync(remote);
		writeFileSync(path.join(remote, 'package.json'), JSON.stringify({ name: 'r', dreamteamer: {} }));
		writeFileSync(path.join(remote, 'package-lock.json'), '{}');
		execFileSync('git', ['init', '-q'], { cwd: remote });
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: remote });
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: remote });
		// the script only accepts https/ssh/git@, so reach the local remote through git's url rewriting
		const gitcfg = path.join(s.base, 'gitconfig');
		writeFileSync(gitcfg, `[url "${remote}"]\n\tinsteadOf = https://example.test/repo.git\n[protocol "file"]\n\tallow = always\n`);
		const env = { GIT_CONFIG_GLOBAL: gitcfg };
		const r1 = dtNew(s, ['cloned', '--clone', 'https://example.test/repo.git'], env);
		assert.equal(r1.status, 0, r1.stderr);
		assert.ok(existsSync(path.join(s.root, 'cloned', 'package.json')));
		assert.equal(calls(s), '', 'nothing from the repo ran');
		assert.match(r1.stdout, /not installed: trust it/);
		const r2 = dtNew(s, ['cloned2', '--clone', 'https://example.test/repo.git', '--install'], env);
		assert.equal(r2.status, 0, r2.stderr);
		assert.match(calls(s), /npm ci .*\(in .*\/cloned2\)/);
		assert.match(calls(s), /npx --no-install dreamteamer compile \(in .*\/cloned2\)/);
	});
});
