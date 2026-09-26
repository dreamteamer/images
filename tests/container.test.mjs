// The BUILT image, run under Docker: what the source tests can only assert as text. Skipped unless
// HQ_IMAGE names an image (CI sets HQ_IMAGE=hq:candidate after the build; locally:
// `HQ_IMAGE=hq:sec node --test tests/container.test.mjs`). Every docker call carries a hard timer.
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const IMG = process.env.HQ_IMAGE;
const PUB = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
const names = new Set();

function docker(args, { timeout = 60_000 } = {}) {
	return new Promise((resolve) => {
		execFile('docker', args, { timeout, killSignal: 'SIGKILL', maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
			resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout), err: String(stderr), killed: Boolean(err?.killed) });
		});
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostedEnv = ['-e', 'DT_MODE=hosted', '-e', `DT_GATEWAY_PUBLIC_KEY=${PUB}`, '-e', 'DT_ORIGIN_HOST=origin.test', '-e', 'DT_WORKSPACE=ct', '-e', 'DT_PERSIST_HOME=/workspaces/.home'];

async function run(name, args) {
	names.add(name);
	await docker(['rm', '-f', name]);
	const r = await docker(['run', '-d', '--name', name, ...args, IMG]);
	assert.equal(r.code, 0, r.err);
}
async function execIn(name, cmd, user = 'root') {
	return docker(['exec', '-u', user, name, 'bash', '-c', cmd], { timeout: 30_000 });
}
async function waitHealthy(name, seconds = 240) {
	for (let i = 0; i < seconds / 2; i++) {
		const r = await execIn(name, "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8080/healthz || true");
		if (r.out.trim() === '200') return;
		const st = await docker(['inspect', '-f', '{{.State.Running}}', name]);
		if (st.out.trim() !== 'true') break;
		await sleep(2000);
	}
	const logs = await docker(['logs', name]);
	assert.fail(`${name} never answered /healthz 200\n${logs.out}${logs.err}`);
}
/** Runs the image in the foreground and returns how it ended, within `seconds`. */
async function runToExit(args, seconds) {
	const t0 = Date.now();
	const r = await docker(['run', '--rm', ...args, IMG], { timeout: seconds * 1000 });
	return { ...r, took: Date.now() - t0 };
}

after(async () => { for (const n of names) await docker(['rm', '-f', n]); });

describe('the built image', { skip: !IMG && 'set HQ_IMAGE=<image ref> to run against a built image' }, () => {
	test('hosted mode without a gateway key exits non-zero within 5 s, saying why, and never listens', async () => {
		const r = await runToExit(['-e', 'DT_MODE=hosted', '-e', 'DT_ORIGIN_HOST=origin.test'], 5);
		assert.equal(r.killed, false, `still running after 5 s: ${r.out}${r.err}`);
		assert.notEqual(r.code, 0);
		assert.match(r.err, /DT_GATEWAY_PUBLIC_KEY/);
		assert.doesNotMatch(r.out + r.err, /dt-origin-proxy: :8080/);
	});
	test('hosted mode with a key that does not import exits non-zero', async () => {
		const r = await runToExit(['-e', 'DT_MODE=hosted', '-e', 'DT_GATEWAY_PUBLIC_KEYS=["AAAA"]', '-e', 'DT_ORIGIN_HOST=origin.test'], 5);
		assert.equal(r.killed, false);
		assert.notEqual(r.code, 0);
	});
	test('an unknown DT_MODE is refused', async () => {
		const r = await runToExit(['-e', 'DT_MODE=public'], 5);
		assert.notEqual(r.code, 0);
		assert.match(r.err, /DT_MODE/);
	});
	test('hosted mode without CAP_NET_ADMIN fails clearly: the egress policy is not optional', async () => {
		const r = await runToExit(hostedEnv, 20);
		assert.equal(r.killed, false);
		assert.notEqual(r.code, 0);
		assert.match(r.err, /egress policy/i);
		assert.match(r.err, /NET_ADMIN/);
	});

	describe('hosted, with CAP_NET_ADMIN', () => {
		const name = `dt-ct-hosted-${process.pid}`;
		test('starts and answers /healthz 200 once the editor is up', async () => {
			await run(name, ['--cap-add', 'NET_ADMIN', ...hostedEnv]);
			await waitHealthy(name);
		});
		test('the egress ruleset is live: SMTP and mining ports, private ranges, 6PN, rate limit; tbf on the default interface', async () => {
			const r = await execIn(name, 'nft list ruleset');
			assert.equal(r.code, 0, r.err);
			assert.match(r.out, /table inet dt_egress/);
			assert.match(r.out, /\b25\b[^\n]*\b465\b[^\n]*\b587\b/);
			assert.match(r.out, /tcp dport @blocked_ports[^\n]*drop/);
			assert.match(r.out, /ip6 daddr fdaa::\/16[^\n]*drop/);
			assert.match(r.out, /10\.0\.0\.0\/8/);
			assert.match(r.out, /limit rate over 50\/second burst 100 packets[^\n]*drop/);
			const tc = await execIn(name, 'tc qdisc show');
			assert.match(tc.out, /qdisc tbf[^\n]*rate 20Mbit/);
		});
		test('an outbound SMTP connection is dropped', async () => {
			// 192.0.2.1 is TEST-NET-1: nothing answers there anyway, so assert on the rule's counter
			await execIn(name, 'timeout 3 bash -c "</dev/tcp/192.0.2.1/25" 2>/dev/null; true', 'node');
			const r = await execIn(name, 'nft list ruleset');
			assert.match(r.out, /tcp dport @blocked_ports counter packets [1-9]/);
		});
		test('PID 1 is root, the proxy runs as dtproxy, code-server as node', async () => {
			const r = await execIn(name, 'ps -eo pid=,user=,args=');
			const lines = r.out.split('\n').map((l) => l.trim());
			assert.match(lines.find((l) => /^1 /.test(l)), /^1 root /);
			assert.ok(lines.some((l) => /^\d+ dtproxy .*node --disable-sigusr1 \/usr\/local\/bin\/dt-origin-proxy/.test(l)), r.out);
			for (const l of lines.filter((l) => /code-server/.test(l) && !/bash -c/.test(l))) assert.match(l, /^\d+ node /, l);
		});
		test('as node: PID 1 and the proxy cannot be signalled; the proxy, entrypoint and /usr/local/bin cannot be written', async () => {
			const pid = (await execIn(name, 'pgrep -u dtproxy -f dt-origin-proxy | head -1')).out.trim();
			assert.match(pid, /^\d+$/);
			for (const cmd of ['kill -0 1', `kill -0 ${pid}`, 'test -w /usr/local/bin/dt-origin-proxy', 'test -w /usr/local/bin/dt-entrypoint', 'test -w /usr/local/bin/dt-persist-home', 'test -w /usr/local/bin', 'echo x >> /usr/local/bin/dt-origin-proxy']) {
				const r = await execIn(name, cmd, 'node');
				assert.notEqual(r.code, 0, `as node, "${cmd}" succeeded`);
			}
			const st = await execIn(name, 'stat -c "%U:%G %a" /usr/local/bin/dt-origin-proxy /usr/local/bin/dt-entrypoint /usr/local/bin/dt-persist-home');
			assert.deepEqual(st.out.trim().split('\n'), ['root:root 755', 'root:root 755', 'root:root 755']);
		});
		test('everything the workspace user runs descends from a NoNewPrivs=1, capability-free code-server; so does the proxy', async () => {
			// a terminal in code-server is a child of code-server, so it inherits these
			// match code-server's own processes, not this exec's shell (whose command line also says code-server)
			const r = await execIn(name, 'for p in $(pgrep -u node -f "^/usr/lib/code-server/lib/node"); do grep -E "^(NoNewPrivs|CapEff|CapBnd):" /proc/$p/status; done', 'node');
			assert.match(r.out, /NoNewPrivs/, 'found no code-server process');
			assert.match(r.out, /NoNewPrivs:\s+1/);
			assert.doesNotMatch(r.out, /NoNewPrivs:\s+0/);
			assert.doesNotMatch(r.out, /CapEff:\s+(?!0{16})/);
			assert.doesNotMatch(r.out, /CapBnd:\s+(?!0{16})/);
			const p = await execIn(name, 'grep -E "^(NoNewPrivs|CapEff):" /proc/$(pgrep -u dtproxy -f dt-origin-proxy | head -1)/status');
			assert.match(p.out, /NoNewPrivs:\s+1/);
			assert.match(p.out, /CapEff:\s+0{16}/);
		});
		test('a child of code-server really has NoNewPrivs: 1 (the terminal case)', async () => {
			const cs = (await execIn(name, 'pgrep -u node -o -f "^/usr/lib/code-server/lib/node"')).out.trim();
			assert.match(cs, /^\d+$/);
			const r = await execIn(name, `ps -o pid= --ppid ${cs} | head -1 | xargs -I{} grep NoNewPrivs /proc/{}/status`);
			assert.match(r.out, /NoNewPrivs:\s+1/);
		});
		test('no setuid or setgid file is left in the image', async () => {
			const r = await execIn(name, 'find / -xdev -perm /6000 -type f 2>/dev/null');
			assert.equal(r.out.trim(), '');
		});
		test('SIGUSR1 does not open an inspector on the proxy', async () => {
			await execIn(name, 'kill -USR1 $(pgrep -u dtproxy -f dt-origin-proxy | head -1)');
			await sleep(1000);
			const r = await execIn(name, "cat /proc/net/tcp /proc/net/tcp6 | awk '$4==\"0A\"{print $2}'");
			assert.doesNotMatch(r.out, /:240D\b/i, 'something listens on 9229');
			const alive = await execIn(name, 'pgrep -u dtproxy -f dt-origin-proxy');
			assert.equal(alive.code, 0, 'the proxy survived SIGUSR1');
		});
		test('when code-server dies the supervisor stops the container non-zero (the proxy-side 503 is pinned in origin-proxy.test.mjs)', async () => {
			await execIn(name, 'pkill -KILL -u node -f "code-server" || true');
			let status = '';
			for (let i = 0; i < 30; i++) {
				status = (await docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name])).out.trim();
				if (status.startsWith('exited')) break;
				await sleep(1000);
			}
			assert.match(status, /^exited [1-9]/, status);
			const logs = await docker(['logs', name]);
			assert.match(logs.err + logs.out, /code-server exited[^\n]*stopping/);
		});
	});

	describe('local mode', () => {
		test('default: code-server listens on loopback only, never 0.0.0.0', async () => {
			const name = `dt-ct-local-${process.pid}`;
			await run(name, ['-e', 'DT_WORKSPACE=ct']);
			await waitHealthy(name);
			const r = await execIn(name, "cat /proc/net/tcp /proc/net/tcp6 | awk '$4==\"0A\"{print $2}'");
			assert.match(r.out, /0100007F:1F90/);
			assert.doesNotMatch(r.out, /^00000000:1F90$/m);
			assert.doesNotMatch(r.out, /^0{32}:1F90$/m);
			await docker(['rm', '-f', name]);
		});
		test('DT_LOCAL_BIND=0.0.0.0 (what `dt start container` needs) serves the mapped port', async () => {
			const name = `dt-ct-local-open-${process.pid}`;
			await run(name, ['-e', 'DT_WORKSPACE=ct', '-e', 'DT_LOCAL_BIND=0.0.0.0', '-p', '127.0.0.1::8080']);
			await waitHealthy(name);
			const port = (await docker(['port', name, '8080/tcp'])).out.trim().split('\n')[0].split(':').pop();
			const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
			assert.equal(res.status, 200);
			await docker(['rm', '-f', name]);
		});
		test('DT_LOCAL_BIND must be 127.0.0.1 or 0.0.0.0', async () => {
			const r = await runToExit(['-e', 'DT_LOCAL_BIND=10.0.0.1'], 10);
			assert.notEqual(r.code, 0);
			assert.match(r.err, /DT_LOCAL_BIND/);
		});
	});

	test('hosted FILES_FOLDER is on the volume; a workspace that was local on /files is migrated once, idempotently', async () => {
		const tag = `${process.pid}`;
		const vols = [`dt-ct-ws-${tag}`, `dt-ct-files-${tag}`];
		const mounts = ['-v', `${vols[0]}:/workspaces`, '-v', `${vols[1]}:/files`];
		try {
			// 1. a local start on those volumes: .env says /files, and a file lands in /files
			const local = `dt-ct-mig-local-${tag}`;
			await run(local, [...mounts, '-e', 'DT_WORKSPACE=hq']);
			await waitHealthy(local);
			assert.equal((await execIn(local, 'cat /workspaces/hq/.env')).out, 'FILES_FOLDER=/files\n');
			await execIn(local, 'mkdir -p /files/meetings && echo A > /files/meetings/a.txt', 'node');
			await docker(['rm', '-f', local]);
			// 2. the same volumes, hosted: value rewritten, content moved, dir owned by node, code-server sees it
			const hosted = `dt-ct-mig-hosted-${tag}`;
			await run(hosted, ['--cap-add', 'NET_ADMIN', ...mounts, ...hostedEnv, '-e', 'DT_WORKSPACE=hq'] /* the later -e wins */);
			await waitHealthy(hosted);
			assert.equal((await execIn(hosted, 'cat /workspaces/hq/.env')).out, 'FILES_FOLDER=/workspaces/files\n');
			assert.equal((await execIn(hosted, 'cat /workspaces/files/meetings/a.txt')).out, 'A\n');
			assert.equal((await execIn(hosted, 'ls -A /files')).out, '');
			assert.equal((await execIn(hosted, 'stat -c %U /workspaces/files')).out.trim(), 'node');
			// not exported machine-wide any more: each workspace names its own in its .env (a second workspace
			// on the machine must never inherit the first one's)
			const env = await execIn(hosted, 'tr "\\0" "\\n" < /proc/$(pgrep -u node -o -f "^/usr/lib/code-server/lib/node")/environ | grep -c ^FILES_FOLDER= || true', 'node');
			assert.equal(env.out.trim(), '0');
			const logs = await docker(['logs', hosted]);
			assert.match(logs.out + logs.err, /rewritten from \/files to \/workspaces\/files/);
			assert.match(logs.out + logs.err, /moved 1 entry from \/files to \/workspaces\/files/);
			// 3. restart: nothing to do, nothing logged, content intact
			await docker(['restart', '-t', '5', hosted], { timeout: 60_000 });
			await waitHealthy(hosted);
			assert.equal((await execIn(hosted, 'cat /workspaces/files/meetings/a.txt')).out, 'A\n');
			assert.equal((await execIn(hosted, 'cat /workspaces/hq/.env')).out, 'FILES_FOLDER=/workspaces/files\n');
			const all = await docker(['logs', hosted]); // both starts
			assert.equal((all.out + all.err).match(/moved \d+ entr/g).length, 1, 'the second start moved nothing');
			assert.equal((all.out + all.err).match(/rewritten from/g).length, 1, 'the second start rewrote nothing');
			await docker(['rm', '-f', hosted]);
		} finally {
			for (const v of vols) await docker(['volume', 'rm', '-f', v]);
		}
	});

	test('hosted: the whole home is on the volume and survives a replaced machine; a layout-1 home is migrated', async () => {
		const tag = `${process.pid}`;
		const vol = `dt-ct-home-${tag}`;
		const mounts = ['-v', `${vol}:/workspaces`];
		try {
			// a volume as layout 1 left it: short names, marker 1
			const seed = await docker(['run', '--rm', '--entrypoint', 'bash', '-u', 'root', ...mounts, IMG, '-c',
				'mkdir -p /workspaces/.home/claude && echo login > /workspaces/.home/claude/.credentials.json && echo 1 > /workspaces/.home/.dt-persist-layout && chown -R node:node /workspaces']);
			assert.equal(seed.code, 0, seed.err);
			const first = `dt-ct-home-a-${tag}`;
			await run(first, ['--cap-add', 'NET_ADMIN', ...mounts, ...hostedEnv]);
			await waitHealthy(first);
			assert.equal((await execIn(first, 'cat /workspaces/.home/.claude/.credentials.json')).out, 'login\n');
			const home = await execIn(first, 'tr "\\0" "\\n" < /proc/$(pgrep -u node -o -f "^/usr/lib/code-server/lib/node")/environ | grep -E "^(HOME|DISABLE_AUTOUPDATER)="', 'node');
			assert.deepEqual(home.out.trim().split('\n').sort(), ['DISABLE_AUTOUPDATER=1', 'HOME=/workspaces/.home']);
			// what layout 1 lost at every stop: anything else in ~
			await execIn(first, 'cd ~ && echo hist > .bash_history && mkdir -p .local/bin && echo t > .local/bin/tool && printf "https://u:p@example.test\\n" > .git-credentials', 'node');
			assert.equal((await execIn(first, 'git config --global credential.helper', 'node')).out.trim(), 'store');
			await docker(['rm', '-f', first]);
			// a brand-new container on the same volume: a replaced machine
			const second = `dt-ct-home-b-${tag}`;
			await run(second, ['--cap-add', 'NET_ADMIN', ...mounts, ...hostedEnv]);
			await waitHealthy(second);
			assert.equal((await execIn(second, 'cat ~/.bash_history ~/.local/bin/tool ~/.git-credentials', 'node')).out, 'hist\nt\nhttps://u:p@example.test\n');
			await docker(['rm', '-f', second]);
		} finally {
			await docker(['volume', 'rm', '-f', vol]);
		}
	});

	test('hosted: a bare URL opens the machine home (not the last folder); trust stays on; the launcher and dt-new are installed', async () => {
		const name = `dt-ct-launch-${process.pid}`;
		await run(name, ['--cap-add', 'NET_ADMIN', ...hostedEnv]);
		await waitHealthy(name);
		const cmd = await execIn(name, 'ps -o args= -u node | grep -m1 "code-server.*--bind-addr 127.0.0.1:8081"');
		assert.match(cmd.out, /--ignore-last-opened \/opt\/dt-launcher\s*$/);
		const settings = JSON.parse((await execIn(name, 'cat ~/.local/share/code-server/User/settings.json', 'node')).out);
		assert.equal(settings['task.allowAutomaticTasks'], 'off');
		assert.equal(settings['chat.disableAIFeatures'], true);
		assert.notEqual(settings['security.workspace.trust.enabled'], false);
		assert.match((await execIn(name, 'ls /opt/code-server/extensions')).out, /dreamteamer-hosted\.dt-machine-/);
		assert.match((await execIn(name, 'stat -c "%U %a" /usr/local/bin/dt-new')).out, /^root 755/);
		// dt-new, for real, as the workspace user: a second workspace with its own files folder, compiled
		const r = await execIn(name, 'dt-new second', 'node');
		assert.equal(r.code, 0, r.out + r.err);
		assert.equal((await execIn(name, 'cat /workspaces/second/.env')).out, 'FILES_FOLDER=/workspaces/.files/second\n');
		assert.equal((await execIn(name, 'test -d /workspaces/second/.dreamteamer && echo compiled')).out.trim(), 'compiled');
		assert.notEqual((await execIn(name, 'dt-new files --empty', 'node')).code, 0);
		await docker(['rm', '-f', name]);
	});

	test('DT_EGRESS_POLICY=off starts hosted without NET_ADMIN, and says so loudly', async () => {
		const name = `dt-ct-noegress-${process.pid}`;
		await run(name, [...hostedEnv, '-e', 'DT_EGRESS_POLICY=off']);
		await waitHealthy(name);
		const logs = await docker(['logs', name]);
		assert.match(logs.err, /DT_EGRESS_POLICY=off[^\n]*NO EGRESS POLICY/);
		await docker(['rm', '-f', name]);
	});
});
