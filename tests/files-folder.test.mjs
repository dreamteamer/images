// dt-files-folder: in hosted mode FILES_FOLDER must be on the persistent volume (/workspaces/files),
// not the image's /files (Codex second review #4). Local mode keeps /files. Runs the real script on
// temp dirs standing in for /files and /workspaces/files.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../hq/files-folder.sh', import.meta.url));
function setup() {
	const base = mkdtempSync(path.join(tmpdir(), 'files-folder-'));
	const ws = path.join(base, 'workspaces', 'hq');
	const legacy = path.join(base, 'files');
	const target = path.join(base, 'workspaces', 'files');
	mkdirSync(ws, { recursive: true });
	mkdirSync(legacy, { recursive: true });
	return { ws, legacy, target, env: path.join(ws, '.env') };
}
const run = (s, mode, extraEnv = {}) =>
	execFileSync('bash', [SCRIPT, s.ws, mode, s.legacy, s.target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FILES_FOLDER: '', ...extraEnv } });

describe('dt-files-folder', () => {
	test('hosted, fresh workspace: .env names the volume folder, which exists', () => {
		const s = setup();
		run(s, 'hosted');
		assert.equal(readFileSync(s.env, 'utf8'), `FILES_FOLDER=${s.target}\n`);
		assert.ok(statSync(s.target).isDirectory());
	});
	test('hosted ignores a FILES_FOLDER=/files handed in by the environment', () => {
		const s = setup();
		run(s, 'hosted', { FILES_FOLDER: s.legacy });
		assert.equal(readFileSync(s.env, 'utf8'), `FILES_FOLDER=${s.target}\n`);
	});
	test('hosted, existing .env on /files: rewrites only that value, moves the content once, logs it', () => {
		const s = setup();
		writeFileSync(s.env, `OTHER=1\nFILES_FOLDER=${s.legacy}\nLAST=2\n`);
		mkdirSync(path.join(s.legacy, 'meetings'), { recursive: true });
		writeFileSync(path.join(s.legacy, 'meetings', 'a.txt'), 'A');
		writeFileSync(path.join(s.legacy, 'b.txt'), 'B');
		const out = run(s, 'hosted');
		assert.equal(readFileSync(s.env, 'utf8'), `OTHER=1\nFILES_FOLDER=${s.target}\nLAST=2\n`);
		assert.equal(readFileSync(path.join(s.target, 'meetings', 'a.txt'), 'utf8'), 'A');
		assert.equal(readFileSync(path.join(s.target, 'b.txt'), 'utf8'), 'B');
		assert.deepEqual(readdirSync(s.legacy), []);
		assert.match(out, /FILES_FOLDER/);
		assert.match(out, /moved 2/);
		// idempotent: a second run changes nothing and moves nothing
		const again = run(s, 'hosted');
		assert.equal(readFileSync(s.env, 'utf8'), `OTHER=1\nFILES_FOLDER=${s.target}\nLAST=2\n`);
		assert.doesNotMatch(again, /moved/);
		assert.equal(readFileSync(path.join(s.target, 'b.txt'), 'utf8'), 'B');
	});
	test('hosted never overwrites what is already on the volume: a name in both stays put in /files and is reported', () => {
		const s = setup();
		mkdirSync(s.target, { recursive: true });
		writeFileSync(path.join(s.target, 'same.txt'), 'VOLUME');
		writeFileSync(path.join(s.legacy, 'same.txt'), 'IMAGE');
		const out = run(s, 'hosted');
		assert.equal(readFileSync(path.join(s.target, 'same.txt'), 'utf8'), 'VOLUME');
		assert.equal(readFileSync(path.join(s.legacy, 'same.txt'), 'utf8'), 'IMAGE');
		assert.match(out, /same\.txt/);
	});
	test('hosted leaves a FILES_FOLDER the person chose (not /files) alone', () => {
		const s = setup();
		writeFileSync(s.env, 'FILES_FOLDER=/workspaces/hq/my-files\n');
		run(s, 'hosted');
		assert.equal(readFileSync(s.env, 'utf8'), 'FILES_FOLDER=/workspaces/hq/my-files\n');
	});
	test('local: unchanged — writes FILES_FOLDER (default the legacy /files) only when .env is absent, moves nothing', () => {
		const s = setup();
		writeFileSync(path.join(s.legacy, 'keep.txt'), 'K');
		run(s, 'local', { FILES_FOLDER: s.legacy });
		assert.equal(readFileSync(s.env, 'utf8'), `FILES_FOLDER=${s.legacy}\n`);
		assert.ok(existsSync(path.join(s.legacy, 'keep.txt')));
		assert.ok(!existsSync(s.target));
		writeFileSync(s.env, `FILES_FOLDER=${s.legacy}\nX=1\n`);
		run(s, 'local');
		assert.equal(readFileSync(s.env, 'utf8'), `FILES_FOLDER=${s.legacy}\nX=1\n`);
	});
});
