// The machine launcher (hq/launcher): which folders count as workspaces. The extension's listing runs
// in the extension host; here it runs against a temp root with a stand-in `vscode` module.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const EXT = fileURLToPath(new URL('../hq/launcher/extension.js', import.meta.url));

function loadWith(root) {
	process.env.DT_WORKSPACES_ROOT = root;
	const orig = Module._load;
	Module._load = function (req, ...rest) { return req === 'vscode' ? {} : orig.call(this, req, ...rest); };
	try {
		delete require.cache[EXT];
		return require(EXT);
	} finally {
		Module._load = orig;
	}
}

describe('dt-machine launcher', () => {
	test('lists visible folders only: never the home, the files folders or lost+found; knows a dreamteamer workspace', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'launcher-'));
		for (const d of ['hq', 'plain', 'repo/.git', '.home/.claude', '.files/hq', 'files', 'lost+found', 'trash']) mkdirSync(path.join(root, d), { recursive: true });
		writeFileSync(path.join(root, 'hq', 'package.json'), JSON.stringify({ dreamteamer: {} }));
		writeFileSync(path.join(root, 'loose-file'), 'x');
		const { listWorkspaces } = loadWith(root);
		assert.deepEqual(listWorkspaces().map((w) => [w.name, w.kind]), [['hq', 'dreamteamer'], ['plain', 'folder'], ['repo', 'git']]);
	});

	test('the manifest declares untrusted-workspace support (it executes nothing) and no virtual workspaces', () => {
		const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../hq/launcher/package.json', import.meta.url)), 'utf8'));
		assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
		assert.equal(pkg.capabilities.virtualWorkspaces, false);
		for (const id of ['dtMachine.newWorkspace', 'dtMachine.cloneRepository', 'dtMachine.openWorkspace', 'dtMachine.switchWorkspace', 'dtMachine.deleteWorkspace']) {
			assert.ok(pkg.contributes.commands.some((c) => c.command === id), id);
		}
	});
});
