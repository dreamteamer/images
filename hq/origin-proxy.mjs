#!/usr/bin/env node
// dt-origin-proxy — the authentication boundary in front of code-server when this image runs behind
// the dreamteamer gateway (a hosted workspace). Every request and every WebSocket upgrade must carry
// an `x-dreamteamer-gateway` assertion signed by the gateway's PRIVATE Ed25519 key; this proxy holds
// only the PUBLIC key (DT_GATEWAY_PUBLIC_KEY, the JWK `x` value) and refuses anything else with 401.
// It forwards what passes to code-server on 127.0.0.1:${DT_EDITOR_PORT} with the assertion removed.
// Only /healthz is open, and it answers here without touching the editor.
//
// Env:  DT_GATEWAY_PUBLIC_KEY  base64url Ed25519 public key (required; the proxy exits without it)
//       DT_ORIGIN_HOST         the audience assertions must name (default: the request's Host header)
//       DT_PROXY_PORT          listen port (default 8080)     DT_EDITOR_PORT  upstream port (default 8081)
// Zero dependencies: node:http, node:net, node:crypto.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

const ASSERTION_HEADER = 'x-dreamteamer-gateway';
const OPEN_PATHS = new Set(['/healthz']);

export function loadPublicKey(x) {
  if (!x) throw new Error('DT_GATEWAY_PUBLIC_KEY is required');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

function b64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Returns the claims of a valid assertion, or throws with a short reason. Pure: no I/O. */
export function verifyAssertion(publicKey, token, { audience, now = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string') throw new Error('missing');
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new Error('malformed');
  const payload = token.slice(0, dot);
  const sig = b64url(token.slice(dot + 1));
  let ok = false;
  try {
    ok = verifySignature(null, Buffer.from(payload), publicKey, sig);
  } catch {
    ok = false;
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

function authorize(publicKey, audience, req) {
  const token = req.headers[ASSERTION_HEADER];
  return verifyAssertion(publicKey, Array.isArray(token) ? token[0] : token, { audience: audience ?? hostOf(req) });
}

export function createProxy({ publicKey, audience, editorPort }) {
  const server = http.createServer((req, res) => {
    if (OPEN_PATHS.has(req.url?.split('?')[0])) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    try {
      authorize(publicKey, audience, req);
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
      authorize(publicKey, audience, req);
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

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const publicKey = loadPublicKey(process.env.DT_GATEWAY_PUBLIC_KEY);
  const port = Number(process.env.DT_PROXY_PORT ?? 8080);
  const editorPort = Number(process.env.DT_EDITOR_PORT ?? 8081);
  const audience = process.env.DT_ORIGIN_HOST || undefined;
  createProxy({ publicKey, audience, editorPort }).listen(port, '0.0.0.0', () => {
    console.log(`dt-origin-proxy: :${port} → 127.0.0.1:${editorPort}, audience ${audience ?? '(request host)'}, assertions required`);
  });
}
