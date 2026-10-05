// dt-origin-proxy in LOCAL mode (0.6.0): the URL token. The proxy runs as a child process against a
// token file in a temp dir, a fake editor runs in this process, and every request is a real HTTP request.
import { spawn } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { cookieName, localHostName, tokenMatches } from '../hq/origin-proxy.mjs';

const PROXY = fileURLToPath(new URL('../hq/origin-proxy.mjs', import.meta.url));
const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);

let editor, editorPort, seen, dir, tokenFile;
const children = new Set();

async function listen(server) {
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return server.address().port;
}
async function freePort() {
	const probe = net.createServer();
	const port = await listen(probe);
	await new Promise((r) => probe.close(r));
	return port;
}
function request(port, urlPath, headers = {}, method = 'GET') {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
			let body = '';
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
		});
		req.setTimeout(5000, () => req.destroy(new Error('timeout')));
		req.on('error', reject);
		req.end();
	});
}
function upgrade(port, headers) {
	return new Promise((resolve, reject) => {
		const s = net.connect(port, '127.0.0.1', () => {
			s.write(`GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`);
		});
		let buf = '';
		s.setTimeout(5000, () => { s.destroy(); reject(new Error('timeout')); });
		s.on('data', (d) => {
			buf += d;
			if (buf.startsWith('HTTP/1.1 101') && !buf.includes('echo:')) s.write('ping');
			if (buf.includes('echo:ping') || /^HTTP\/1\.1 40[13]/.test(buf)) { s.destroy(); resolve(buf); }
		});
		s.on('error', reject);
	});
}
async function startLocal(env = {}) {
	const port = await freePort();
	const child = spawn(process.execPath, [PROXY], {
		env: { ...process.env, DT_PROXY_MODE: 'local', DT_URL_TOKEN_FILE: tokenFile, DT_PROXY_PORT: String(port), DT_EDITOR_PORT: String(editorPort), DT_LOCAL_AUTH: '', ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.add(child);
	let err = '';
	child.stderr.on('data', (d) => (err += d));
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('proxy did not start')), 8000);
		child.stdout.on('data', (d) => { if (String(d).includes('dt-origin-proxy: local')) { clearTimeout(t); resolve(); } });
		child.on('exit', (c) => { clearTimeout(t); reject(new Error(`proxy exited ${c}: ${err}`)); });
	});
	return { child, port, stderr: () => err };
}
/** Replaces the token file the way dt-url-token rotate does: a new file renamed over the old one. */
function rotate(token) {
	const tmp = path.join(dir, '.url-token.tmp');
	writeFileSync(tmp, `${token}\n`);
	renameSync(tmp, tokenFile);
}
const cookie = (port, token) => ({ cookie: `other=1; ${cookieName(`localhost:${port}`)}=${token}` });

before(async () => {
	seen = [];
	editor = http.createServer((req, res) => {
		seen.push({ url: req.url, headers: req.headers });
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end(`editor saw ${req.url}`);
	});
	editor.on('upgrade', (req, socket) => {
		seen.push({ url: req.url, headers: req.headers, upgrade: true });
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
		socket.on('data', (d) => socket.write(`echo:${d}`));
	});
	editorPort = await listen(editor);
	dir = mkdtempSync(path.join(tmpdir(), 'dt-local-proxy-'));
	tokenFile = path.join(dir, 'url-token');
	writeFileSync(tokenFile, `${TOKEN_A}\n`);
});
after(async () => {
	for (const c of children) c.kill();
	editor?.closeAllConnections?.();
	await new Promise((r) => editor?.close(r));
});

describe('pure helpers', () => {
	test('localHostName strips the port and understands [::1]; junk is empty', () => {
		assert.equal(localHostName('LOCALHOST:8100'), 'localhost');
		assert.equal(localHostName('127.0.0.1'), '127.0.0.1');
		assert.equal(localHostName('[::1]:8100'), '[::1]');
		assert.equal(localHostName('localhost.evil.test:8100'), 'localhost.evil.test');
		assert.equal(localHostName('a:b:c'), '');
		assert.equal(localHostName(undefined), '');
	});
	test('the cookie is named per port, so two machines on localhost never overwrite each other', () => {
		assert.equal(cookieName('localhost:8100'), 'dt_local_8100');
		assert.notEqual(cookieName('localhost:8100'), cookieName('localhost:8101'));
		assert.equal(cookieName('localhost'), 'dt_local_80');
	});
	test('tokenMatches: equal only; empty, missing, and a prefix never match', () => {
		assert.equal(tokenMatches(TOKEN_A, TOKEN_A), true);
		assert.equal(tokenMatches(TOKEN_A, TOKEN_B), false);
		assert.equal(tokenMatches(TOKEN_A, TOKEN_A.slice(0, 10)), false);
		assert.equal(tokenMatches(TOKEN_A, ''), false);
		assert.equal(tokenMatches(null, TOKEN_A), false);
		assert.equal(tokenMatches('', ''), false);
	});
});

describe('the local proxy', () => {
	let p;
	before(async () => { rotate(TOKEN_A); p = await startLocal(); });

	test('/healthz needs no token and says only ok', async () => {
		const r = await request(p.port, '/healthz');
		assert.equal(r.status, 200);
		assert.equal(r.body, 'ok\n');
	});
	test('/healthz answers only a local Host: a page on another site cannot fingerprint a running machine', async () => {
		// the engine's readiness probe (node:http to 127.0.0.1:<port>) sends Host 127.0.0.1:<port>
		for (const host of [`127.0.0.1:${p.port}`, `[::1]:${p.port}`, `localhost:${p.port}`]) assert.equal((await request(p.port, '/healthz', { host })).status, 200, host);
		for (const host of [`evil.test:${p.port}`, `localhost.evil.test:${p.port}`, `192.168.1.5:${p.port}`]) {
			const r = await request(p.port, '/healthz', { host });
			assert.equal(r.status, 403, host);
			assert.doesNotMatch(r.body, /ok|editor/);
		}
	});
	test('no cookie → 401 naming `dt-host open container`, nothing forwarded', async () => {
		const n = seen.length;
		const r = await request(p.port, '/?folder=/workspaces/x');
		assert.equal(r.status, 401);
		assert.match(r.body, /dt-host open container <name>/);
		assert.equal(seen.length, n);
	});
	test('editor icon URLs with an empty tkn use the authenticated session, never bypass it', async () => {
		const url = '/stable-test/vscode-remote-resource?path=%2Fextensions%2Ficon.svg&tkn=';
		assert.equal((await request(p.port, url)).status, 401);
		assert.equal((await request(p.port, url, cookie(p.port, TOKEN_B))).status, 401);
		const valid = await request(p.port, url, cookie(p.port, TOKEN_A));
		assert.equal(valid.status, 200);
		assert.equal(valid.headers['set-cookie'], undefined);
		assert.equal((await request(p.port, '/?tkn=' + TOKEN_B, cookie(p.port, TOKEN_A))).status, 401);
	});
	test('a wrong ?tkn= → 401 and no cookie', async () => {
		const r = await request(p.port, `/?tkn=${TOKEN_B}`);
		assert.equal(r.status, 401);
		assert.equal(r.headers['set-cookie'], undefined);
	});
	test('the right ?tkn= → 302 to the same URL without it, with an HttpOnly SameSite=Strict cookie', async () => {
		const r = await request(p.port, `/?folder=%2Fworkspaces%2Fx&tkn=${TOKEN_A}`);
		assert.equal(r.status, 302);
		assert.equal(r.headers.location, '/?folder=%2Fworkspaces%2Fx');
		assert.deepEqual(r.headers['set-cookie'], [`dt_local_${p.port}=${TOKEN_A}; HttpOnly; SameSite=Strict; Path=/`]);
		assert.equal((await request(p.port, `/?tkn=${TOKEN_A}`)).headers.location, '/');
	});
	test('the redirect never leaves the origin, whatever the path', async () => {
		for (const bad of ['//evil.test/x', '/\\evil.test/x']) {
			const r = await request(p.port, `${bad}?tkn=${TOKEN_A}`);
			assert.equal(r.status, 302);
			assert.match(r.headers.location, /^\/[^/\\]/, r.headers.location);
		}
	});
	test('with the cookie → forwarded; the editor never sees the session cookie, but sees the others', async () => {
		const r = await request(p.port, '/?folder=/workspaces/x', cookie(p.port, TOKEN_A));
		assert.equal(r.status, 200);
		assert.equal(r.body, 'editor saw /?folder=/workspaces/x');
		assert.equal(seen.at(-1).headers.cookie, 'other=1');
	});
	test('another port\'s cookie does not open this machine', async () => {
		const r = await request(p.port, '/', { cookie: `dt_local_${p.port + 1}=${TOKEN_A}` });
		assert.equal(r.status, 401);
	});
	test('Host must be localhost, 127.0.0.1 or [::1] (any port), else 403 even with the cookie (DNS rebinding)', async () => {
		for (const host of [`127.0.0.1:${p.port}`, `[::1]:${p.port}`, 'localhost']) {
			const c = { cookie: `${cookieName(host)}=${TOKEN_A}` };
			assert.equal((await request(p.port, '/', { host, ...c })).status, 200, host);
		}
		for (const host of [`evil.test:${p.port}`, `localhost.evil.test:${p.port}`, `192.168.1.5:${p.port}`]) {
			const r = await request(p.port, `/?tkn=${TOKEN_A}`, { host, ...cookie(p.port, TOKEN_A) });
			assert.equal(r.status, 403, host);
			assert.equal(r.headers['set-cookie'], undefined);
		}
		const noHost = await new Promise((resolve, reject) => {
			const s = net.connect(p.port, '127.0.0.1', () => s.write(`GET /?tkn=${TOKEN_A} HTTP/1.0\r\n\r\n`));
			let buf = ''; s.setTimeout(5000, () => { s.destroy(); reject(new Error('timeout')); });
			s.on('data', (d) => (buf += d)); s.on('end', () => resolve(buf)); s.on('error', reject);
		});
		assert.match(noHost, /^HTTP\/1\.[01] 403/, 'no Host header at all');
	});
	test('a WebSocket upgrade needs the cookie and a local Host, then is tunnelled without the cookie', async () => {
		const same = `Origin: http://localhost:${p.port}\r\n`;
		assert.match(await upgrade(p.port, same), /^HTTP\/1\.1 401/);
		assert.match(await upgrade(p.port, `${same}Cookie: dt_local_${p.port}=${TOKEN_B}\r\n`), /^HTTP\/1\.1 401/);
		const ok = await upgrade(p.port, `Cookie: dt_local_${p.port}=${TOKEN_A}\r\nOrigin: http://localhost:${p.port}\r\n`);
		assert.match(ok, /^HTTP\/1\.1 101/);
		assert.match(ok, /echo:ping/);
		assert.equal(seen.at(-1).upgrade, true);
		assert.equal(seen.at(-1).headers.cookie, undefined);
		const rebound = await new Promise((resolve, reject) => {
			const s = net.connect(p.port, '127.0.0.1', () => s.write(`GET /ws HTTP/1.1\r\nHost: evil.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: dt_local_80=${TOKEN_A}\r\n\r\n`));
			let buf = ''; s.setTimeout(5000, () => { s.destroy(); reject(new Error('timeout')); });
			s.on('data', (d) => { buf += d; s.destroy(); resolve(buf); });
			s.on('error', reject);
		});
		assert.match(rebound, /^HTTP\/1\.1 403/);
	});
	test('cross-site WebSocket hijacking: an upgrade with the cookie still needs an Origin naming this exact host and port', async () => {
		const c = `Cookie: dt_local_${p.port}=${TOKEN_A}\r\n`;
		const n = seen.length;
		// another localhost port is SAME-SITE, so the SameSite=Strict cookie rides along; Origin is what differs
		for (const origin of ['', `Origin: http://localhost:${p.port + 1}\r\n`, `Origin: http://127.0.0.1:${p.port}\r\n`, `Origin: https://localhost:${p.port}\r\n`, 'Origin: null\r\n', `Origin: http://evil.test\r\n`]) {
			assert.match(await upgrade(p.port, c + origin), /^HTTP\/1\.1 403/, JSON.stringify(origin));
		}
		assert.equal(seen.length, n, 'nothing reached the editor');
		assert.match(await upgrade(p.port, `${c}Origin: HTTP://LOCALHOST:${p.port}\r\n`), /^HTTP\/1\.1 101/, 'scheme and host compare without case');
	});
	test('every request that is not GET/HEAD needs a same-origin Origin; a GET or HEAD without one (a navigation) passes', async () => {
		const c = cookie(p.port, TOKEN_A);
		const n = seen.length;
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			assert.equal((await request(p.port, '/x', c, method)).status, 403, `${method}, no Origin`);
			assert.equal((await request(p.port, '/x', { ...c, origin: `http://localhost:${p.port + 1}` }, method)).status, 403, `${method}, another port`);
		}
		assert.equal((await request(p.port, `/?tkn=${TOKEN_A}`, { origin: `http://localhost:${p.port + 1}` }, 'POST')).status, 403, 'a cross-origin ?tkn= never sets the cookie');
		assert.equal(seen.length, n, 'nothing reached the editor');
		assert.equal((await request(p.port, '/x', { ...c, origin: `http://localhost:${p.port}` }, 'POST')).status, 200);
		assert.equal((await request(p.port, '/x', c, 'GET')).status, 200);
		assert.equal((await request(p.port, '/x', c, 'HEAD')).status, 200);
		// a GET that DOES carry a foreign Origin is a cross-origin fetch, never a navigation
		assert.equal((await request(p.port, '/x', { ...c, origin: `http://localhost:${p.port + 1}` }, 'GET')).status, 403);
	});
	test('the Origin check holds with DT_LOCAL_AUTH=off too: it is not the token check', async () => {
		const q = await startLocal({ DT_LOCAL_AUTH: 'off', DT_URL_TOKEN_FILE: path.join(dir, 'absent') });
		try {
			assert.equal((await request(q.port, '/x', {}, 'POST')).status, 403);
			assert.match(await upgrade(q.port, `Origin: http://localhost:${q.port + 1}\r\n`), /^HTTP\/1\.1 403/);
			assert.match(await upgrade(q.port, `Origin: http://localhost:${q.port}\r\n`), /^HTTP\/1\.1 101/);
		} finally { q.child.kill(); }
	});
	test('rotation takes effect without a restart: the old cookie is refused, the new token works', async () => {
		assert.equal((await request(p.port, '/', cookie(p.port, TOKEN_A))).status, 200);
		rotate(TOKEN_B);
		assert.equal((await request(p.port, '/', cookie(p.port, TOKEN_A))).status, 401);
		assert.equal((await request(p.port, `/?tkn=${TOKEN_A}`)).status, 401);
		assert.equal((await request(p.port, `/?tkn=${TOKEN_B}`)).status, 302);
		assert.equal((await request(p.port, '/', cookie(p.port, TOKEN_B))).status, 200);
		rotate(TOKEN_A);
	});
	test('a missing token file refuses everything but /healthz (fail closed)', async () => {
		renameSync(tokenFile, `${tokenFile}.away`);
		try {
			assert.equal((await request(p.port, '/', cookie(p.port, TOKEN_A))).status, 401);
			assert.equal((await request(p.port, `/?tkn=${TOKEN_A}`)).status, 401);
			assert.equal((await request(p.port, '/healthz')).status, 200);
		} finally { renameSync(`${tokenFile}.away`, tokenFile); }
	});
});

describe('starting in local mode', () => {
	test('refuses to listen without a readable token file', async () => {
		await assert.rejects(startLocal({ DT_URL_TOKEN_FILE: path.join(dir, 'absent') }), /no readable URL token/);
	});
	test('refuses a DT_PROXY_BIND other than 127.0.0.1 or 0.0.0.0, and an unknown DT_LOCAL_AUTH', async () => {
		await assert.rejects(startLocal({ DT_PROXY_BIND: '10.0.0.1' }), /DT_PROXY_BIND/);
		await assert.rejects(startLocal({ DT_LOCAL_AUTH: 'maybe' }), /DT_LOCAL_AUTH/);
	});
	test('DT_LOCAL_AUTH=off: no token needed, said loudly; the Host check still holds', async () => {
		const p = await startLocal({ DT_LOCAL_AUTH: 'off', DT_URL_TOKEN_FILE: path.join(dir, 'absent') });
		assert.equal((await request(p.port, '/')).status, 200);
		assert.equal((await request(p.port, '/', { host: 'evil.test' })).status, 403);
		assert.match(p.stderr(), /DT_LOCAL_AUTH=off[^\n]*NO URL TOKEN/);
		p.child.kill();
	});
	test('without DT_PROXY_MODE=local the proxy is the hosted one: no gateway key, no start', async () => {
		await assert.rejects(startLocal({ DT_PROXY_MODE: '', DT_GATEWAY_PUBLIC_KEY: '', DT_GATEWAY_PUBLIC_KEYS: '' }), /exited/);
	});
});
