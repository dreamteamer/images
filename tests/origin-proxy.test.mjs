// dt-origin-proxy: the authentication boundary. The proxy runs as a child process (a fake editor runs
// in this process, async, so nothing starves it), and every request below is a real HTTP request.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign as signRaw } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyAssertion, loadPublicKey } from '../hq/origin-proxy.mjs';

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
  test('/healthz is open and never reaches the editor', async () => {
    const before = seen.length;
    const r = await request(proxyPort, '/healthz');
    assert.equal(r.status, 200);
    assert.equal(seen.length, before);
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
