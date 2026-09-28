// 0.6.0, pinned on the SOURCES: local mode runs behind the URL token, dt-url-token is the only way to it,
// and the agent CLIs start under trust (R2.7). The built image is exercised by tests/container.test.mjs.
import { spawnSync } from 'node:child_process';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const dockerfile = read('hq', 'Dockerfile');
const agents = read('hq-agents', 'Dockerfile');
const entrypoint = code(read('hq', 'entrypoint.sh'));
const urlToken = read('hq', 'url-token.sh');

describe('local mode: the proxy in front of the editor, as in hosted', () => {
	test('the supervisor starts the proxy in BOTH modes, and code-server only on loopback 8081 opening the machine home', () => {
		const supervise = entrypoint.slice(entrypoint.indexOf('declare -A NAMES'));
		assert.doesNotMatch(supervise, /if \[ "\$MODE" = hosted \]; then\s*\n\s*\(cd \/ && exec/, 'the proxy is no longer hosted-only');
		assert.match(supervise, /^\(cd \/ && exec "\$\{AS_PROXY\[@\]\}" env -i [^\n]*"\$\{PROXY_ENV\[@\]\}" \/usr\/local\/bin\/node --disable-sigusr1 \/usr\/local\/bin\/dt-origin-proxy\) &$/m);
		assert.match(supervise, /code-server --bind-addr 127\.0\.0\.1:8081 "\$\{EDITOR_ARGS\[@\]\}" --ignore-last-opened "\$LAUNCHER"/);
		assert.doesNotMatch(supervise, /--bind-addr "\$BIND:8080"/, 'the supervised editor never binds 8080 itself');
	});
	test('the local proxy env: local mode, the bind, the token file, the auth switch', () => {
		assert.match(entrypoint, /PROXY_ENV=\(DT_PROXY_MODE=local DT_PROXY_PORT=8080 DT_EDITOR_PORT=8081 "DT_PROXY_BIND=\$BIND" DT_URL_TOKEN_FILE=\/home\/node\/\.dt\/url-token "DT_LOCAL_AUTH=\$LOCAL_AUTH"\)/);
	});
	test('the token is ensured as root before anything runs as node; DT_LOCAL_AUTH=off is loud', () => {
		const ensure = entrypoint.indexOf('/usr/local/bin/dt-url-token ensure');
		assert.ok(ensure > 0);
		assert.ok(ensure < entrypoint.indexOf('"${AS_NODE[@]}" /usr/local/bin/dt-entrypoint --prepare'));
		assert.match(entrypoint, /DT_LOCAL_AUTH=off[^\n]*NO URL TOKEN/);
		assert.match(entrypoint, /DT_LOCAL_AUTH must be on or off/);
	});
	test('a non-root start has no token, so it refuses 0.0.0.0 unless DT_LOCAL_AUTH=off', () => {
		const nonRoot = entrypoint.slice(entrypoint.indexOf('if [ "$(id -u)" != "0" ]'), entrypoint.indexOf('# ---- root phase'));
		assert.match(nonRoot, /\[ "\$BIND" = 0\.0\.0\.0 \] && \[ "\$LOCAL_AUTH" != off \]/);
		assert.match(nonRoot, /die "[^"]*no URL token/);
	});
	test('the hosted proxy start is untouched: no DT_PROXY_MODE in hosted, so the proxy stays assertion-only', () => {
		const raw = read('hq', 'entrypoint.sh');
		const hosted = raw.slice(raw.indexOf('if [ "$MODE" = hosted ]; then\n  # fail closed'), raw.indexOf('\nelse\n  id dtproxy'));
		assert.ok(hosted.length > 100, 'found the hosted block');
		assert.match(hosted, /PROXY_ENV=\(DT_PROXY_PORT=8080 DT_EDITOR_PORT=8081 "DT_ORIGIN_HOST=\$DT_ORIGIN_HOST"\)/);
		assert.doesNotMatch(hosted, /DT_PROXY_MODE/);
	});
});

describe('dt-url-token', () => {
	test('is installed root-owned 0755, and the image lists url-token in /opt/dt-image/features', () => {
		assert.match(dockerfile, /^COPY --chown=root:root --chmod=0755 url-token\.sh \/usr\/local\/bin\/dt-url-token$/m);
		assert.match(dockerfile, /printf '%s\\n' url-token > \/opt\/dt-image\/features/);
	});
	test('refuses to run unless root', () => {
		if (process.getuid?.() === 0) return;
		for (const verb of ['show', 'rotate']) {
			const r = spawnSync('bash', [path.join(ROOT, 'hq', 'url-token.sh'), verb], { encoding: 'utf8' });
			assert.notEqual(r.status, 0);
			assert.match(r.stderr, /run as root/);
			assert.equal(r.stdout, '');
		}
	});
	test('32 random bytes as base64url; root:dtproxy 0640 in a root:dtproxy 0750 dir; written atomically; a symlinked dir is never followed', () => {
		assert.match(urlToken, /head -c 32 \/dev\/urandom \| base64 -w0 \| tr '\+\/' '-_' \| tr -d '='/);
		assert.match(urlToken, /chown -h root:dtproxy "\$DIR"\n\s*chmod 0750 "\$DIR"/);
		assert.match(urlToken, /chown root:dtproxy "\$tmp"\n\s*chmod 0640 "\$tmp"\n\s*mv -f "\$tmp" "\$FILE"/);
		assert.match(urlToken, /tmp=\$\(mktemp "\$DIR\/\.url-token\.XXXXXX"\)/);
		assert.match(urlToken, /if \[ -L "\$DIR" \]/);
		assert.match(urlToken, /^DIR=\/home\/node\/\.dt$/m);
	});
});

describe('R2.7: agent CLIs under trust', () => {
	test('Claude Code (hq): managed settings pin enableAllProjectMcpServers=false, root-owned, readable', () => {
		assert.deepEqual(JSON.parse(read('hq', 'claude-code', 'managed-settings.json')), { enableAllProjectMcpServers: false });
		assert.match(dockerfile, /^COPY --chown=root:root --chmod=0644 claude-code\/managed-settings\.json \/etc\/claude-code\/managed-settings\.json$/m);
		assert.ok(dockerfile.indexOf('RUN install -d -m 0755 /etc/claude-code') > 0, 'the directory is made 0755 first');
		assert.ok(dockerfile.indexOf('RUN install -d -m 0755 /etc/claude-code') < dockerfile.indexOf('/etc/claude-code/managed-settings.json\n'));
	});
	test('Gemini CLI (hq-agents): the system settings file pins folder trust on', () => {
		assert.equal(JSON.parse(read('hq-agents', 'gemini-cli', 'settings.json')).security.folderTrust.enabled, true);
		assert.match(agents, /^RUN install -d -m 0755 \/etc\/gemini-cli\nCOPY --chown=root:root --chmod=0644 gemini-cli\/settings\.json \/etc\/gemini-cli\/settings\.json$/m);
	});
	test('Codex (hq-agents): nothing in the image marks a project trusted', () => {
		const all = [dockerfile, agents, read('hq', 'entrypoint.sh'), read('hq', 'new-workspace.sh')].join('\n');
		assert.doesNotMatch(all, /trust_level/);
		assert.doesNotMatch(all, /GEMINI_CLI_TRUST_WORKSPACE|--skip-trust|hasTrustDialogAccepted/);
	});
	test('the README states what each CLI does and does not cover', () => {
		const r = read('README.md');
		const section = r.slice(r.indexOf('## Agents and trust'));
		assert.ok(r.includes('## Agents and trust'));
		for (const w of ['Claude Code', 'Codex', 'Gemini CLI', 'Antigravity', 'claude -p', 'gap']) assert.ok(section.includes(w), w);
	});
});

describe('a volume mounted below /workspaces', () => {
	test('each mount point under /workspaces is handed to node before anything runs as node: the point only, never via a symlink, a read-only one tolerated', () => {
		const raw = read('hq', 'entrypoint.sh');
		const loop = raw.slice(raw.indexOf('while IFS= read -r m; do'), raw.indexOf("done < <(findmnt -rn -o TARGET"));
		assert.ok(loop.length > 50, 'the loop over findmnt');
		assert.match(loop, /case "\$m" in \/workspaces\/\?\*\) ;; \*\) continue ;; esac/);
		assert.match(loop, /\[ ! -L "\$m" \]/);
		assert.match(loop, /chown -h node:node "\$m" 2>\/dev\/null \|\| log /);
		assert.doesNotMatch(loop, /chown -R/);
		assert.ok(raw.indexOf("done < <(findmnt -rn -o TARGET") < raw.indexOf('"${AS_NODE[@]}" /usr/local/bin/dt-entrypoint --prepare'));
	});
});
