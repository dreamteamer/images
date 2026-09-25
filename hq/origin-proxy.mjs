#!/usr/bin/env node
// dt-origin-proxy — the authentication boundary in front of code-server when this image runs behind
// the dreamteamer gateway (a hosted workspace). Every request and every WebSocket upgrade must carry
// an `x-dreamteamer-gateway` assertion signed by one of the gateway's PRIVATE Ed25519 keys; this proxy
// holds only the PUBLIC keys and refuses anything else with 401. It forwards what passes to
// code-server on 127.0.0.1:${DT_EDITOR_PORT} with the assertion removed. Only /healthz is open: it
// answers 200 when the editor answers its own /healthz within 2 s, and 503 otherwise.
//
// It runs as its own system user (`dtproxy`), from a root-owned file, under `node --disable-sigusr1`,
// so the workspace user (`node`) can neither rewrite it, signal it, nor open its inspector.
//
// Env:  DT_GATEWAY_PUBLIC_KEY   base64url Ed25519 public key (the JWK `x` value), and/or
//       DT_GATEWAY_PUBLIC_KEYS  a JSON array of them (rotation: an assertion from ANY key verifies)
//       DT_ORIGIN_HOST          the audience assertions must name (required)
//       DT_PROXY_PORT           listen port (default 8080)     DT_EDITOR_PORT  upstream port (default 8081)
// `dt-origin-proxy --check` loads the keys and the audience, prints why on failure, and exits: the
// entrypoint runs it before anything else, so a hosted machine without a usable key never listens.
// Zero dependencies: node:http, node:net, node:crypto.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const ASSERTION_HEADER = 'x-dreamteamer-gateway';
const OPEN_PATHS = new Set(['/healthz']);

const HEALTH_TIMEOUT_MS = 2000;

export function loadPublicKey(x) {
  if (!x) throw new Error('DT_GATEWAY_PUBLIC_KEY is required');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/** Every key the gateway may sign with: DT_GATEWAY_PUBLIC_KEYS (a JSON array) plus DT_GATEWAY_PUBLIC_KEY. */
export function loadPublicKeys(env = process.env) {
  const xs = [];
  if (env.DT_GATEWAY_PUBLIC_KEYS) {
    let list;
    try { list = JSON.parse(env.DT_GATEWAY_PUBLIC_KEYS); } catch { list = null; }
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x)) throw new Error('DT_GATEWAY_PUBLIC_KEYS must be a JSON array of base64url Ed25519 public keys');
    xs.push(...list);
  }
  if (env.DT_GATEWAY_PUBLIC_KEY) xs.push(env.DT_GATEWAY_PUBLIC_KEY);
  if (!xs.length) throw new Error('DT_GATEWAY_PUBLIC_KEY (or DT_GATEWAY_PUBLIC_KEYS) is required');
  return xs.map((x) => {
    const key = loadPublicKey(x);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('a gateway key is not Ed25519');
    return key;
  });
}

function b64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Returns the claims of a valid assertion, or throws with a short reason. Pure: no I/O. */
export function verifyAssertion(publicKeys, token, { audience, now = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string') throw new Error('missing');
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new Error('malformed');
  const payload = token.slice(0, dot);
  const sig = b64url(token.slice(dot + 1));
  let ok = false;
  for (const key of Array.isArray(publicKeys) ? publicKeys : [publicKeys]) {
    try {
      ok = verifySignature(null, Buffer.from(payload), key, sig);
    } catch {
      ok = false;
    }
    if (ok) break;
  }
  if (!ok) throw new Error('bad signature');
  let claims;
  try {
    claims = JSON.parse(b64url(payload).toString('utf8'));
  } catch {
    throw new Error('malformed claims');
  }
  if (claims.audience !== audience) throw new Error('wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('expired');
  if (typeof claims.workspaceId !== 'string' || typeof claims.requestId !== 'string') throw new Error('malformed claims');
  return claims;
}

function hostOf(req) {
  return String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
}

function refuse(res, reason) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`unauthorized: this workspace is reached through its gateway (${reason})\n`);
}

function authorize(publicKeys, audience, req) {
  const token = req.headers[ASSERTION_HEADER];
  return verifyAssertion(publicKeys, Array.isArray(token) ? token[0] : token, { audience: audience ?? hostOf(req) });
}

/** Resolves true when the editor answers GET /healthz with any status below 500 within `timeoutMs`. */
function editorAnswers(editorPort, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port: editorPort, method: 'GET', path: '/healthz', headers: { host: `127.0.0.1:${editorPort}` } }, (res) => {
      res.resume();
      finish((res.statusCode ?? 500) < 500);
    });
    const timer = setTimeout(() => { req.destroy(); finish(false); }, timeoutMs);
    req.on('error', () => finish(false));
    req.end();
  });
}

export function createProxy({ publicKeys, publicKey, audience, editorPort, healthTimeoutMs = HEALTH_TIMEOUT_MS }) {
  const keys = publicKeys ?? [publicKey];
  const server = http.createServer((req, res) => {
    if (OPEN_PATHS.has(req.url?.split('?')[0])) {
      editorAnswers(editorPort, healthTimeoutMs).then((up) => {
        res.writeHead(up ? 200 : 503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end(up ? 'ok\n' : 'editor unavailable\n');
      });
      return;
    }
    try {
      authorize(keys, audience, req);
    } catch (e) {
      refuse(res, e.message);
      return;
    }
    const headers = { ...req.headers };
    delete headers[ASSERTION_HEADER];
    const upstream = http.request({ host: '127.0.0.1', port: editorPort, method: req.method, path: req.url, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('editor unavailable\n');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      authorize(keys, audience, req);
    } catch (e) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nunauthorized (${e.message})\r\n`);
      socket.destroy();
      return;
    }
    const target = net.connect(editorPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === ASSERTION_HEADER) continue;
        for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
      }
      target.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.setTimeout(0);
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
  });

  return server;
}

/** The fail-closed start: keys that import and an audience, or a reason. */
export function loadConfig(env = process.env) {
  const publicKeys = loadPublicKeys(env);
  const audience = String(env.DT_ORIGIN_HOST ?? '').trim();
  if (!audience) throw new Error('DT_ORIGIN_HOST is required: the audience every assertion must name');
  return { publicKeys, audience };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(`dt-origin-proxy: refusing to start: ${e.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    console.log(`dt-origin-proxy: ${config.publicKeys.length} gateway key(s), audience ${config.audience}`);
    process.exit(0);
  }
  const port = Number(process.env.DT_PROXY_PORT ?? 8080);
  const editorPort = Number(process.env.DT_EDITOR_PORT ?? 8081);
  createProxy({ publicKeys: config.publicKeys, audience: config.audience, editorPort }).listen(port, '0.0.0.0', () => {
    console.log(`dt-origin-proxy: :${port} → 127.0.0.1:${editorPort}, audience ${config.audience}, ${config.publicKeys.length} key(s), assertions required`);
  });
}
