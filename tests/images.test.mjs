// The promises every template image makes, pinned on its SOURCES — because the image is public and
// whatever is in it travels to everyone who pulls it. Nothing personal or secret; every version
// pinned; the labels that make it a template present and honest; hq-agents built from hq.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const TEMPLATES = ['hq', 'hq-agents'];
const sources = TEMPLATES.flatMap((t) => fs.readdirSync(path.join(ROOT, t)).map((f) => [`${t}/${f}`, read(t, f)]));
const label = (dockerfile, name) => dockerfile.match(new RegExp(`dreamteamer\\.${name}="([^"]*)"`))?.[1];

describe('nothing personal, nothing secret — in any template', () => {
	for (const [file, text] of sources) {
		test(`${file}: no credential-shaped ENV/ARG, no copied .env, no literal credential`, () => {
			for (const line of text.split('\n')) {
				assert.doesNotMatch(line, /^(ENV|ARG)\s+\S*(TOKEN|SECRET|PASSWORD|API_KEY|OAUTH)/i, line);
				assert.doesNotMatch(line, /^COPY\s+.*\.env\b/, line);
				assert.doesNotMatch(line, /sk-ant-|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN/, line);
			}
		});
		test(`${file}: no host path, mail address, private name or Hebrew`, () => {
			assert.doesNotMatch(text, /\/Users\/|\/home\/(?!node\b)[a-z]+/, 'a host path');
			assert.doesNotMatch(text, /[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|io|co\.il|net|org)\b/i, 'a mail address');
			// assembled, not spelled: a literal here would itself be a hit for the same rule elsewhere
			assert.doesNotMatch(text, new RegExp(['gk-' + 'brain', 'dt-' + 'hq', 'hq[23]\\b'].join('|')), 'a private name');
			assert.doesNotMatch(text, /\p{Script=Hebrew}/u, 'Hebrew');
		});
	}
	test('the entrypoint writes one .env line (FILES_FOLDER) and never a token or password', () => {
		const e = read('hq', 'entrypoint.sh');
		const writes = e.split('\n').filter((l) => /\.env\b/.test(l) && !/^\s*#/.test(l));
		assert.equal(writes.length, 1, writes.join('\n'));
		assert.match(writes[0], /FILES_FOLDER/);
		assert.doesNotMatch(e, /TOKEN|PASSWORD|SECRET/i);
	});
});

describe('one version of everything', () => {
	test('hq pins engine, bundle, Claude Code and code-server through exact ARGs, never @latest', () => {
		const d = read('hq', 'Dockerfile');
		for (const arg of ['DT_VERSION', 'EXT_VERSION', 'CLAUDE_VERSION', 'CODE_SERVER_VERSION']) assert.match(d, new RegExp(`^ARG ${arg}=\\d+\\.\\d+\\.\\d+$`, 'm'), arg);
		assert.doesNotMatch(d, /npm install[^\n]*@latest/);
		assert.match(d, /npm install -g[^\n]*dreamteamer@\$\{DT_VERSION\}/);
		assert.match(d, /npm install[^\n]*dreamteamer@\$\{DT_VERSION\}[^\n]*@dreamteamer\/extensions@\$\{EXT_VERSION\}/, 'the template must pin the same engine as the global install');
	});
	test('hq-agents is built FROM the hq of the same version and pins codex and gemini', () => {
		const d = read('hq-agents', 'Dockerfile');
		assert.match(d, /^ARG HQ_VERSION=/m);
		assert.match(d, /^FROM ghcr\.io\/dreamteamer\/hq:\$\{HQ_VERSION\}$/m);
		for (const arg of ['CODEX_VERSION', 'GEMINI_VERSION']) assert.match(d, new RegExp(`^ARG ${arg}=\\d+\\.\\d+\\.\\d+$`, 'm'), arg);
		assert.doesNotMatch(d, /@latest/);
		assert.match(d, /USER node\s*$/m, 'hq-agents must hand back to the node user');
	});
	test('the workflow builds hq-agents with the hq version it just built', () => {
		const w = read('.github', 'workflows', 'images.yml');
		assert.match(w, /HQ_VERSION=\$\{\{ needs\.hq\.outputs\.version \}\}/);
		assert.match(w, /needs: gate/);
		assert.match(w, /npm test/);
	});
});

describe('what makes an image a template', () => {
	test('hq carries template, ports, modules and engine labels; the modules label names real modules of the bundle', () => {
		const d = read('hq', 'Dockerfile');
		assert.equal(label(d, 'template'), 'hq');
		assert.equal(label(d, 'ports'), '8080');
		assert.equal(label(d, 'engine'), '${DT_VERSION}');
		const disabled = JSON.parse(d.match(/p\.dreamteamer\.disable=(\[[^\]]*\])/)[1].replace(/'/g, '"'));
		const bundle = ['assets', 'contacts', 'meetings', 'notebooks', 'perspective', 'projects', 'recordings', 'rnd', 'search', 'users'];
		assert.deepEqual(label(d, 'modules').split(',').sort(), bundle.filter((m) => !disabled.includes(m)).sort());
	});
	test('hq-agents relabels the template and names its agents', () => {
		const d = read('hq-agents', 'Dockerfile');
		assert.equal(label(d, 'template'), 'hq-agents');
		assert.equal(label(d, 'agents'), 'claude,codex,gemini,agy');
	});
	test('the devcontainer.metadata label names both editor extensions and runs as node', () => {
		const meta = JSON.parse(read('hq', 'Dockerfile').match(/devcontainer\.metadata='(\[.*\])'/)[1]);
		assert.equal(meta[0].remoteUser, 'node');
		assert.deepEqual(meta[0].customizations.vscode.extensions, ['dreamteamer.dreamteamer-vscode', 'anthropic.claude-code']);
	});
	test('both editor extensions are baked outside the home volume, the server reads that directory, and the template recommends them', () => {
		const d = read('hq', 'Dockerfile'); const e = read('hq', 'entrypoint.sh');
		assert.match(d, /--extensions-dir \/opt\/code-server\/extensions --install-extension anthropic\.claude-code/);
		assert.match(d, /--extensions-dir \/opt\/code-server\/extensions --install-extension dreamteamer\.dreamteamer-vscode/);
		assert.match(e, /--extensions-dir \/opt\/code-server\/extensions/);
		assert.match(d, /"recommendations": \["dreamteamer\.dreamteamer-vscode", "anthropic\.claude-code", "ms-vscode-remote\.remote-containers"\]/);
	});
});

describe('the entrypoint', () => {
	const e = read('hq', 'entrypoint.sh');
	test('opens the workspace dir dt named, clones DT_REPO on first start, else lays the template down', () => {
		assert.match(e, /WS="\$\{DT_WORKSPACE_DIR:-\/workspaces\/\$\{DT_WORKSPACE:-hq\}\}"/);
		assert.match(e, /if \[ -n "\$DT_REPO" \]/);
		assert.match(e, /git clone --quiet "\$DT_REPO"/);
		assert.match(e, /cp -a \/opt\/dt-template\/\. "\$WS\/"/);
		assert.match(e, /exec code-server --bind-addr 0\.0\.0\.0:8080 --auth none[\s\S]*?"\$WS"$/m);
	});
	test('answers the git-autofetch prompt by merging defaults into the person\'s settings, never replacing them', () => {
		assert.match(e, /"git\.autofetch": true/);
		assert.match(e, /if \(!\(k in s\)\)/);
		assert.match(e, /\.local\/share\/code-server\/User\/settings\.json/);
	});
	test('compiles before it serves', () => {
		assert.ok(e.indexOf('dreamteamer compile') < e.indexOf('exec code-server'));
	});
});

test('the entrypoint starts as root only to hand the mount points to node, then drops privileges', () => {
  const dockerfile = readFileSync(new URL('../hq/Dockerfile', import.meta.url), 'utf8');
  const entrypoint = readFileSync(new URL('../hq/entrypoint.sh', import.meta.url), 'utf8');
  assert.match(dockerfile, /USER root\nENTRYPOINT \["dt-entrypoint"\]/);
  assert.match(entrypoint, /chown node:node "\$d"/);
  assert.match(entrypoint, /exec setpriv --reuid=node --regid=node --init-groups/);
  // everything that runs as node comes after the drop
  assert.ok(entrypoint.indexOf('exec setpriv') < entrypoint.indexOf('mkdir -p "$WS"'));
});
