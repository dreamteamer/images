// dt-origin-proxy: the authentication boundary. The proxy runs as a child process (a fake editor runs
// in this process, async, so nothing starves it), and every request below is a real HTTP request.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signRaw } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyAssertion, loadPublicKey, loadPublicKeys } from '../hq/origin-proxy.mjs';

const PROXY = fileURLToPath(new URL('../hq/origin-proxy.mjs', import.meta.url));
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicX = publicKey.export({ format: 'jwk' }).x;
const otherPrivate = generateKeyPairSync('ed25519').privateKey;

function mint(claims, key = privateKey) {
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  return `${payload}.${b64url(signRaw(null, Buffer.from(payload), key))}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = (audience) => ({ workspaceId: 'ws_1', requestId: 'req_1', audience, sub: 'usr_1', iat: now(), exp: now() + 60 });

let editor, editorPort, proxy, proxyPort, seen;

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host: 'origin.test', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

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
  // pick a free port for the proxy, then release it so the child can bind it
  const probe = net.createServer();
  proxyPort = await listen(probe);
  await new Promise((r) => probe.close(r));
  proxy = spawn(process.execPath, [PROXY], {
    env: { ...process.env, DT_GATEWAY_PUBLIC_KEY: publicX, DT_PROXY_PORT: String(proxyPort), DT_EDITOR_PORT: String(editorPort), DT_ORIGIN_HOST: 'origin.test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('proxy did not start')), 8000);
    proxy.stdout.on('data', (d) => { if (String(d).includes('assertions required')) { clearTimeout(t); resolve(); } });
    proxy.stderr.on('data', (d) => process.stderr.write(d));
    proxy.on('exit', (c) => reject(new Error(`proxy exited ${c}`)));
  });
});

after(async () => {
  proxy?.kill();
  editor?.closeAllConnections?.();
  await new Promise((r) => editor?.close(r));
});

describe('verifyAssertion (pure)', () => {
  const key = loadPublicKey(publicX);
  test('accepts a valid token for the right audience', () => {
    const claims = good('origin.test');
    assert.deepEqual(verifyAssertion(key, mint(claims), { audience: 'origin.test' }), claims);
  });
  test('refuses another key, a wrong audience, an expired token, and junk', () => {
    assert.throws(() => verifyAssertion(key, mint(good('origin.test'), otherPrivate), { audience: 'origin.test' }), /bad signature/);
    assert.throws(() => verifyAssertion(key, mint(good('elsewhere')), { audience: 'origin.test' }), /audience/);
    assert.throws(() => verifyAssertion(key, mint({ ...good('origin.test'), exp: now() - 1 }), { audience: 'origin.test' }), /expired/);
    assert.throws(() => verifyAssertion(key, 'junk', { audience: 'origin.test' }), /malformed/);
    assert.throws(() => verifyAssertion(key, undefined, { audience: 'origin.test' }), /missing/);
  });
  test('exits without a public key', () => {
    assert.throws(() => loadPublicKey(''), /required/);
  });
});

describe('the proxy in front of the editor', () => {
  test('/healthz is open, and reaches the editor only as its own /healthz probe, with no caller headers', async () => {
    const before = seen.length;
    const r = await request(proxyPort, '/healthz', { 'x-probe-marker': 'caller' });
    assert.equal(r.status, 200);
    const probes = seen.slice(before);
    assert.ok(probes.length <= 1);
    for (const p of probes) {
      assert.equal(p.url, '/healthz');
      assert.equal(p.headers['x-probe-marker'], undefined, 'the caller\'s headers are never forwarded by the health probe');
    }
  });
  test('no assertion → 401, nothing forwarded', async () => {
    const before = seen.length;
    const r = await request(proxyPort, '/?folder=/workspaces/x');
    assert.equal(r.status, 401);
    assert.match(r.body, /gateway/);
    assert.equal(seen.length, before);
  });
  test('a forged assertion (other key) → 401', async () => {
    const r = await request(proxyPort, '/', { 'x-dreamteamer-gateway': mint(good('origin.test'), otherPrivate) });
    assert.equal(r.status, 401);
  });
  test('a valid assertion is forwarded with the header stripped', async () => {
    const r = await request(proxyPort, '/?folder=/workspaces/x', { 'x-dreamteamer-gateway': mint(good('origin.test')), 'x-dreamteamer-user': 'someone@example.test' });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'editor saw /?folder=/workspaces/x');
    const last = seen.at(-1);
    assert.equal(last.headers['x-dreamteamer-gateway'], undefined);
    assert.equal(last.headers['x-dreamteamer-user'], 'someone@example.test');
  });
  test('a WebSocket upgrade needs the assertion too, then is tunnelled', async () => {
    const attempt = (headers) => new Promise((resolve, reject) => {
      const s = net.connect(proxyPort, '127.0.0.1', () => {
        s.write(`GET /ws HTTP/1.1\r\nHost: origin.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`);
      });
      let buf = '';
      s.setTimeout(5000, () => { s.destroy(); reject(new Error('timeout')); });
      s.on('data', (d) => { buf += d; if (buf.includes('\r\n\r\n')) { if (buf.startsWith('HTTP/1.1 101')) { s.write('ping'); } } if (buf.includes('echo:ping') || buf.startsWith('HTTP/1.1 401')) { s.destroy(); resolve(buf); } });
      s.on('error', reject);
    });
    const denied = await attempt('');
    assert.match(denied, /^HTTP\/1\.1 401/);
    const tunnelled = await attempt(`x-dreamteamer-gateway: ${mint(good('origin.test'))}\r\n`);
    assert.match(tunnelled, /^HTTP\/1\.1 101/);
    assert.match(tunnelled, /echo:ping/);
    assert.equal(seen.at(-1).headers['x-dreamteamer-gateway'], undefined);
  });
});

// ---- 0.4.0: key sets, a health check that means something, and a fail-closed start ----

async function startProxy(env) {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const child = spawn(process.execPath, [PROXY], {
    env: { ...process.env, DT_GATEWAY_PUBLIC_KEY: '', DT_GATEWAY_PUBLIC_KEYS: '', DT_PROXY_PORT: String(port), DT_ORIGIN_HOST: 'origin.test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('proxy did not start')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('assertions required')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`proxy exited ${c}`)); });
  });
  return { child, port };
}

function runCheck(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY, '--check'], {
      env: { ...process.env, DT_GATEWAY_PUBLIC_KEY: '', DT_GATEWAY_PUBLIC_KEYS: '', DT_ORIGIN_HOST: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

describe('a set of gateway keys (rotation)', () => {
  const second = generateKeyPairSync('ed25519');
  const secondX = second.publicKey.export({ format: 'jwk' }).x;
  test('loadPublicKeys reads DT_GATEWAY_PUBLIC_KEYS (a JSON array) and DT_GATEWAY_PUBLIC_KEY together', () => {
    assert.equal(loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: JSON.stringify([publicX, secondX]) }).length, 2);
    assert.equal(loadPublicKeys({ DT_GATEWAY_PUBLIC_KEY: publicX }).length, 1);
    assert.equal(loadPublicKeys({ DT_GATEWAY_PUBLIC_KEY: publicX, DT_GATEWAY_PUBLIC_KEYS: JSON.stringify([secondX]) }).length, 2);
  });
  test('loadPublicKeys refuses no key, a non-array, a non-string member and a key that does not import', () => {
    assert.throws(() => loadPublicKeys({}), /required/);
    assert.throws(() => loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: '[]' }), /required/);
    assert.throws(() => loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: '"abc"' }), /JSON array/);
    assert.throws(() => loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: '[1]' }), /JSON array/);
    assert.throws(() => loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: 'not json' }), /JSON array/);
    assert.throws(() => loadPublicKeys({ DT_GATEWAY_PUBLIC_KEY: 'AAAA' }));
  });
  test('an assertion signed by ANY key in the set verifies; a key outside it does not', () => {
    const keys = loadPublicKeys({ DT_GATEWAY_PUBLIC_KEYS: JSON.stringify([publicX, secondX]) });
    assert.ok(verifyAssertion(keys, mint(good('origin.test')), { audience: 'origin.test' }));
    assert.ok(verifyAssertion(keys, mint(good('origin.test'), second.privateKey), { audience: 'origin.test' }));
    assert.throws(() => verifyAssertion(keys, mint(good('origin.test'), otherPrivate), { audience: 'origin.test' }), /bad signature/);
  });
  test('the running proxy accepts the second key of a DT_GATEWAY_PUBLIC_KEYS set', async () => {
    const { child, port } = await startProxy({ DT_GATEWAY_PUBLIC_KEYS: JSON.stringify([publicX, secondX]), DT_EDITOR_PORT: String(editorPort) });
    try {
      const r = await request(port, '/', { 'x-dreamteamer-gateway': mint(good('origin.test'), second.privateKey) });
      assert.equal(r.status, 200);
      assert.equal((await request(port, '/', { 'x-dreamteamer-gateway': mint(good('origin.test'), otherPrivate) })).status, 401);
    } finally { child.kill(); }
  });
});

describe('--check: the entrypoint\'s fail-closed gate', () => {
  test('passes with a key that imports and an audience', async () => {
    const r = await runCheck({ DT_GATEWAY_PUBLIC_KEY: publicX, DT_ORIGIN_HOST: 'origin.test' });
    assert.equal(r.code, 0, r.out);
  });
  test('fails, saying why, with no key, a junk key, or no DT_ORIGIN_HOST', async () => {
    const none = await runCheck({ DT_ORIGIN_HOST: 'origin.test' });
    assert.notEqual(none.code, 0); assert.match(none.out, /DT_GATEWAY_PUBLIC_KEY/);
    const junk = await runCheck({ DT_GATEWAY_PUBLIC_KEY: 'AAAA', DT_ORIGIN_HOST: 'origin.test' });
    assert.notEqual(junk.code, 0);
    const noAud = await runCheck({ DT_GATEWAY_PUBLIC_KEY: publicX });
    assert.notEqual(noAud.code, 0); assert.match(noAud.out, /DT_ORIGIN_HOST/);
  });
  test('the proxy itself refuses to listen without DT_ORIGIN_HOST', async () => {
    await assert.rejects(startProxy({ DT_GATEWAY_PUBLIC_KEY: publicX, DT_ORIGIN_HOST: '', DT_EDITOR_PORT: String(editorPort) }), /exited/);
  });
});

describe('/healthz tells the truth about the editor (IMG-6)', () => {
  test('503 when nothing listens on the editor port', async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    await new Promise((r) => closed.close(r));
    const { child, port } = await startProxy({ DT_GATEWAY_PUBLIC_KEY: publicX, DT_EDITOR_PORT: String(deadPort) });
    try {
      assert.equal((await request(port, '/healthz')).status, 503);
    } finally { child.kill(); }
  });
  test('503 within ~2 s when the editor accepts but never answers', async () => {
    const sockets = [];
    const hung = net.createServer((s) => sockets.push(s));
    const hungPort = await listen(hung);
    const { child, port } = await startProxy({ DT_GATEWAY_PUBLIC_KEY: publicX, DT_EDITOR_PORT: String(hungPort) });
    try {
      const t0 = Date.now();
      const r = await request(port, '/healthz');
      const took = Date.now() - t0;
      assert.equal(r.status, 503);
      assert.ok(took >= 1500 && took < 4000, `took ${took} ms`);
    } finally {
      child.kill();
      for (const s of sockets) s.destroy();
      await new Promise((r) => hung.close(r));
    }
  });
});
