// 0.4.0 hardening, pinned on the SOURCES (the built image is exercised by tests/container.test.mjs and
// tests/smoke.sh). Each block names the review finding it closes, so a regression reads as one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const dockerfile = read('hq', 'Dockerfile');
const entrypoint = read('hq', 'entrypoint.sh');
const agents = read('hq-agents', 'Dockerfile');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('IMG-1/IMG-2: the auth boundary is not the workspace user\'s to rewrite or signal', () => {
	test('a dedicated system user runs the proxy: no home, no login shell', () => {
		assert.match(dockerfile, /useradd --system --user-group --no-create-home --home-dir \/nonexistent --shell \/usr\/sbin\/nologin dtproxy/);
	});
	test('the three executables are root-owned and 0755; nothing security-relevant is COPYed as node', () => {
		for (const [src, dst] of [['entrypoint.sh', 'dt-entrypoint'], ['persist-home.sh', 'dt-persist-home'], ['origin-proxy.mjs', 'dt-origin-proxy']]) {
			assert.match(dockerfile, new RegExp(`^COPY --chown=root:root --chmod=0755 ${src.replace('.', '\\.')} /usr/local/bin/${dst}$`, 'm'), dst);
		}
		assert.doesNotMatch(dockerfile, /^COPY --chown=node/m);
	});
	test('the proxy starts as dtproxy with no new privileges, no capabilities, a clean env and SIGUSR1 disabled', () => {
		const c = code(entrypoint);
		assert.match(c, /setpriv --reuid=dtproxy --regid=dtproxy --clear-groups --no-new-privs --inh-caps=-all --bounding-set=-all/);
		assert.match(c, /env -i /, 'the proxy gets a clean environment (no NODE_OPTIONS, no inherited state)');
		assert.match(c, /\/usr\/local\/bin\/node --disable-sigusr1 \/usr\/local\/bin\/dt-origin-proxy/);
	});
	test('code-server runs as node with no new privileges and no capabilities', () => {
		assert.match(code(entrypoint), /setpriv --reuid=node --regid=node --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all/);
		assert.doesNotMatch(code(entrypoint), /setpriv(?![^\n]*--no-new-privs)[^\n]*--reuid/, 'every setpriv sets --no-new-privs');
	});
	test('PID 1 is the root supervisor: it waits on both children and stops when either dies', () => {
		const c = code(entrypoint);
		assert.match(entrypoint, /^#!\/bin\/bash$/m);
		assert.match(c, /wait -n/);
		assert.match(c, /exited[^\n]*stopping/);
		assert.doesNotMatch(c, /^\s*exec [^\n]*dt-origin-proxy/m, 'the proxy is a child of the supervisor, never exec\'d over PID 1');
		assert.match(c, /\(cd \/ && exec "\$\{AS_PROXY\[@\]\}"[^\n]*\) &$/m, 'the proxy is started in the background by the supervisor');
	});
});

describe('F5: the public listener only in explicit hosted mode, with a key that imports', () => {
	const c = code(entrypoint);
	test('hosted mode is DT_MODE=hosted; anything but hosted|local is refused', () => {
		assert.match(c, /MODE="\$\{DT_MODE:-local\}"/);
		assert.match(c, /hosted\|local\)/);
	});
	test('hosted mode runs the proxy\'s --check before anything else, and dies on failure', () => {
		const check = c.indexOf('--check');
		assert.ok(check > 0, 'the entrypoint runs dt-origin-proxy --check');
		assert.ok(check < c.indexOf('apply_egress '), 'the key check precedes the egress policy');
		assert.ok(check < c.indexOf('chown node:node'), 'the key check precedes any filesystem work');
	});
	test('local mode binds loopback unless DT_LOCAL_BIND=0.0.0.0 is explicit', () => {
		assert.match(c, /BIND="\$\{DT_LOCAL_BIND:-127\.0\.0\.1\}"/);
		assert.match(c, /127\.0\.0\.1\|0\.0\.0\.0\)/);
		assert.doesNotMatch(c, /--bind-addr 0\.0\.0\.0/, 'no hard-coded public bind');
	});
});

describe('IMG-3: no setuid path', () => {
	test('setuid/setgid bits are stripped at build, after every install', () => {
		const strip = dockerfile.indexOf('find / -xdev -perm /6000 -type f -exec chmod a-s {} +');
		assert.ok(strip > 0);
		assert.ok(strip > dockerfile.lastIndexOf('npm install'), 'after the last install');
		assert.match(agents, /find \/ -xdev -perm \/6000 -type f -exec chmod a-s \{\} \+/, 'hq-agents strips what it adds, too');
	});
});

describe('F4: egress policy', () => {
	const nft = read('hq', 'egress.nft');
	test('ships in the image, root-owned and not executable', () => {
		assert.match(dockerfile, /^COPY --chown=root:root --chmod=0644 egress\.nft \/etc\/dt\/egress\.nft$/m);
		assert.match(dockerfile, /apt-get install -y --no-install-recommends[^\n]*\bnftables\b[^\n]*\biproute2\b/);
	});
	test('drops SMTP and the common mining-pool ports', () => {
		for (const p of [25, 465, 587, 3333, 4444, 5555, 7777, 8333, 9999, 14444, 14433, 45700]) assert.match(nft, new RegExp(`\\b${p}\\b`), String(p));
		assert.match(nft, /tcp dport @blocked_ports[^\n]*drop/);
	});
	test('drops private, CGNAT, link-local and Fly 6PN destinations, except the resolver on 53', () => {
		for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16']) assert.ok(nft.includes(cidr), cidr);
		assert.match(nft, /ip6 daddr fdaa::\/16[^\n]*drop/);
		const dns = nft.indexOf('ip6 daddr fdaa::3 udp dport 53 accept');
		assert.ok(dns > 0 && nft.indexOf('ip6 daddr fdaa::3 tcp dport 53 accept') > 0);
		assert.ok(dns < nft.indexOf('ip6 daddr fdaa::/16'), 'the resolver exception precedes the 6PN drop');
		assert.doesNotMatch(code(nft), /4280/, '_api.internal is not allowed');
	});
	test('replies to inbound connections pass before any drop; new connections are rate-limited', () => {
		const rules = code(nft);
		const est = rules.indexOf('ct state established,related accept');
		assert.ok(est > 0 && est < rules.indexOf('drop'));
		assert.match(nft, /ct state new limit rate over 50\/second burst 100 packets[^\n]*drop/);
		assert.match(nft, /policy accept/);
	});
	test('the entrypoint applies nft + tc in hosted mode, fatally, before dropping privileges; DT_EGRESS_POLICY=off is loud', () => {
		const c = code(entrypoint);
		assert.match(c, /nft -f \/etc\/dt\/egress\.nft/);
		assert.match(c, /tc qdisc replace dev "\$dev" root tbf rate "\$\{mbit\}mbit" burst 32kbit latency 400ms/);
		assert.match(c, /DT_EGRESS_MBIT:-20/);
		assert.match(c, /DT_EGRESS_POLICY:-on/);
		assert.match(c, /DT_EGRESS_POLICY=off[^\n]*NO EGRESS POLICY/);
		assert.ok(c.indexOf('apply_egress ') < c.indexOf('"${AS_NODE[@]}"'), 'the policy lands before anything runs as node');
	});
});

describe('IMG-5/IMG-7: supply chain', () => {
	test('the base image is pinned by digest', () => {
		assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
	});
	test('code-server comes from the release .deb, checked against a pinned sha256 per arch; no curl | sh', () => {
		assert.match(dockerfile, /^ARG CODE_SERVER_SHA256_AMD64=[0-9a-f]{64}$/m);
		assert.match(dockerfile, /^ARG CODE_SERVER_SHA256_ARM64=[0-9a-f]{64}$/m);
		assert.match(dockerfile, /github\.com\/coder\/code-server\/releases\/download\/v\$\{CODE_SERVER_VERSION\}/);
		assert.match(dockerfile, /sha256sum -c -/);
		assert.doesNotMatch(dockerfile, /\|\s*(ba)?sh\b/);
	});
	test('pipefail on every RUN, apt without recommends', () => {
		assert.match(dockerfile, /^SHELL \["\/bin\/bash", "-o", "pipefail", "-c"\]$/m);
		for (const l of dockerfile.split('\n').filter((l) => /apt-get install/.test(l))) assert.match(l, /--no-install-recommends/);
	});
	test('hq-agents builds FROM the hq digest CI just pushed, and hands back to root for the entrypoint to drop', () => {
		assert.match(agents, /^ARG HQ_DIGEST=sha256:[0-9a-f]{64}$/m);
		assert.match(agents, /^FROM ghcr\.io\/dreamteamer\/hq@\$\{HQ_DIGEST\}$/m);
		assert.match(agents, /^USER root$/m);
	});
	test('the final USER root is a deliberate, commented hadolint exception', () => {
		assert.match(dockerfile, /# hadolint ignore=DL3002\nUSER root\nRUN find \/ -xdev -perm \/6000 [^\n]*\nENTRYPOINT \["dt-entrypoint"\]/);
		assert.equal((dockerfile.slice(dockerfile.lastIndexOf('USER root')).match(/^USER /gm) || []).length, 1, 'nothing switches user after the last USER root');
	});
});

describe('CI: pinned, least privilege, gated, recorded, signed', () => {
	const w = read('.github', 'workflows', 'images.yml');
	test('every action is pinned by a 40-char SHA', () => {
		const uses = [...w.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
		assert.ok(uses.length > 5);
		for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
	});
	test('workflow-level permissions are empty; each job asks for what it needs', () => {
		assert.match(w, /^permissions: \{\}$/m);
		assert.doesNotMatch(w, /^permissions:\n\s+contents/m);
		const jobs = w.slice(w.indexOf('\njobs:'));
		const names = [...jobs.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
		for (const n of names) {
			const body = jobs.slice(jobs.indexOf(`  ${n}:`)).split(/\n  [a-z-]+:\n/)[0];
			assert.match(body, /permissions:/, `${n} declares permissions`);
			assert.match(body, /timeout-minutes:/, `${n} has a timeout`);
		}
	});
	test('runs on pull requests and v* tags; publishing only on tags', () => {
		assert.match(w, /pull_request:/);
		assert.match(w, /tags: \['v\*'\]/);
		assert.match(w, /if: github\.ref_type == 'tag'/);
	});
	test('the built image is smoked, the container tests run, and Trivy gates CRITICAL on tags', () => {
		assert.match(w, /tests\/smoke\.sh hq:candidate/);
		assert.match(w, /HQ_IMAGE=hq:candidate/);
		assert.match(w, /aquasecurity\/trivy-action@[0-9a-f]{40}/);
		assert.match(w, /severity: CRITICAL/);
		assert.match(w, /ignore-unfixed: true/);
		assert.match(w, /exit-code: '1'/);
	});
	test('pushes by digest, records digest.txt, SBOM, and cosign keyless signs the digest', () => {
		assert.match(w, /digest\.txt/);
		assert.match(w, /actions\/upload-artifact@[0-9a-f]{40}/);
		assert.match(w, /anchore\/sbom-action@[0-9a-f]{40}/);
		assert.match(w, /sigstore\/cosign-installer@[0-9a-f]{40}/);
		assert.match(w, /cosign sign --yes "?ghcr\.io\/dreamteamer\/hq@\$\{\{ steps\.push\.outputs\.digest \}\}"?/);
		assert.match(w, /HQ_DIGEST=\$\{\{ needs\.hq\.outputs\.digest \}\}/);
	});
	test('the leak gate counts matches and never prints them', () => {
		assert.match(w, /grep -RIcE|grep -RIlE[^\n]*\| wc -l|grep -RIE[^\n]*-c/);
		assert.doesNotMatch(w, /grep -RInE/, 'grep -n prints the matching line, i.e. the leak, into a public log');
	});
});

describe('0.4.0', () => {
	test('package.json and the CHANGELOG agree on the version', () => {
		assert.equal(JSON.parse(read('package.json')).version, '0.4.0');
		assert.match(read('CHANGELOG.md'), /^## 0\.4\.0/m);
	});
});
