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
//
// LOCAL mode (DT_PROXY_MODE=local, Docker Desktop via `dt start container`): the same boundary, keyed by
// a URL token instead of an assertion. The token is a file (DT_URL_TOKEN_FILE, /home/node/.dt/url-token,
// root:dtproxy 0640) that the root entrypoint writes and `dt-url-token rotate` replaces; the proxy re-reads
// it whenever its mtime changes, so a rotation takes effect without a restart.
//   GET <any path>?tkn=<token>  → 302 to the same URL without tkn, setting the session cookie
//   everything else (HTTP and WebSocket) needs the cookie, else 401
//   Host must be localhost, 127.0.0.1 or [::1] (any port), else 403 — DNS rebinding; /healthz included
//   a WebSocket upgrade and every non-GET/HEAD request need an Origin naming exactly this Host, else 403:
//   another localhost port is the same site, so SameSite=Strict alone lets its pages send the cookie
//   /healthz needs no token, and says nothing but 200/503
// The cookie is named per host port (dt_local_<port>): cookies are not port-scoped, so two machines on
// localhost:8100 and localhost:8101 would otherwise overwrite each other's. DT_LOCAL_AUTH=off drops the
// token check (not the Host check), loudly; debugging only. DT_PROXY_BIND: 127.0.0.1 (default) or 0.0.0.0.
// Zero dependencies: node:http, node:net, node:crypto, node:fs.
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

const ASSERTION_HEADER = 'x-dreamteamer-gateway';
const OPEN_PATHS = new Set(['/healthz']);

const HEALTH_TIMEOUT_MS = 2000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_REFUSAL = 'Open this machine with `dt open container <name>`.\n';

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

/** Forwards one HTTP request to the editor with `headers`. */
function forward(req, res, headers, editorPort) {
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
}

/** Tunnels an authorised WebSocket upgrade to the editor; `rewrite(k, v)` returns a header's value, or undefined to drop it. */
function tunnel(req, socket, head, editorPort, rewrite) {
  const target = net.connect(editorPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      const kept = rewrite(k, v);
      if (kept === undefined) continue;
      for (const value of Array.isArray(kept) ? kept : [kept]) lines.push(`${k}: ${value}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.setTimeout(0);
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
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
    forward(req, res, headers, editorPort);
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      authorize(keys, audience, req);
    } catch (e) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nunauthorized (${e.message})\r\n`);
      socket.destroy();
      return;
    }
    tunnel(req, socket, head, editorPort, (k, v) => (k === ASSERTION_HEADER ? undefined : v));
  });

  return server;
}

// ---- local mode: the URL token ----

/** The host name of a Host header without its port, lowercased; '' when absent or malformed. */
export function localHostName(host) {
  const h = String(host ?? '').toLowerCase();
  const m = h.match(/^(\[[0-9a-f:.]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/);
  return m ? m[1] : '';
}
/** The session cookie's name for this Host header: dt_local_<port>, so two machines never share one. */
export function cookieName(host) {
  const m = String(host ?? '').match(/:(\d{1,5})$/);
  return `dt_local_${m ? m[1] : '80'}`;
}
function digest(s) { return createHash('sha256').update(String(s)).digest(); }
/** Constant-time: both sides hashed to 32 bytes first, so neither the length nor a prefix leaks. */
export function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || !expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(digest(expected), digest(given));
}
function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
/** The Cookie header with our own session cookie removed: code-server never needs to see the token. */
function withoutCookie(header, name) {
  const rest = String(header ?? '').split(';').filter((p) => p.trim() && p.split('=')[0].trim() !== name);
  return rest.length ? rest.map((p) => p.trim()).join('; ') : undefined;
}

/** Reads the token file, re-reading only when its mtime, inode or size changed. Unreadable → null. */
export function tokenReader(file) {
  let stamp = null, token = null;
  return () => {
    let st;
    try { st = fs.statSync(file); } catch { stamp = null; token = null; return null; }
    const s = `${st.mtimeMs}:${st.ino}:${st.size}`;
    if (s !== stamp) {
      try { token = fs.readFileSync(file, 'utf8').trim() || null; } catch { token = null; }
      stamp = s;
    }
    return token;
  };
}

function plain(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

const FOREIGN_HOST = { status: 403, body: 'forbidden: this machine answers only to localhost\n' };
/** True when the Host header names this computer: localhost, 127.0.0.1 or [::1], any port. */
export function isLocalHost(host) { return LOCAL_HOSTS.has(localHostName(host)); }

const CROSS_ORIGIN = { status: 403, body: 'forbidden: a request from another origin\n' };
/**
 * True when the request may come from a page that is not this machine's own. Every localhost port is
 * the SAME SITE, so a page on localhost:<other> gets the SameSite=Strict cookie sent along with its
 * fetches and WebSockets; the Origin header is what tells them apart. A WebSocket upgrade and every
 * method but GET/HEAD must carry an Origin naming exactly this Host (scheme http, same host, same port);
 * a GET/HEAD without one is a navigation and passes, and one WITH a foreign Origin is a cross-origin fetch.
 */
export function crossOrigin(req, { upgrade = false } = {}) {
  const origin = req.headers.origin;
  if (origin === undefined) return upgrade || !['GET', 'HEAD'].includes(req.method);
  return String(origin).toLowerCase() !== `http://${String(req.headers.host ?? '').toLowerCase()}`;
}

/** Decides one local request: { status, … } to answer, or { forward: true } to pass on. Pure but for readToken. */
export function localDecision(req, { readToken, auth = true, upgrade = false }) {
  if (!isLocalHost(req.headers.host)) return FOREIGN_HOST;
  if (crossOrigin(req, { upgrade })) return CROSS_ORIGIN;
  const raw = String(req.url ?? '/');
  const q = raw.indexOf('?');
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
  const name = cookieName(req.headers.host);
  if (params.has('tkn')) {
    const token = auth ? readToken() : null;
    if (auth && !tokenMatches(token, params.get('tkn'))) return { status: 401, body: LOCAL_REFUSAL };
    params.delete('tkn');
    // the same path, never another origin: a leading '//' or '/\' would make it one
    const path = '/' + (q < 0 ? raw : raw.slice(0, q)).replace(/^[/\\]+/, '');
    const location = path + (params.size ? `?${params}` : '');
    const headers = { location };
    if (auth) headers['set-cookie'] = `${name}=${token}; HttpOnly; SameSite=Strict; Path=/`;
    return { status: 302, headers, body: '' };
  }
  if (auth && !tokenMatches(readToken(), cookieValue(req.headers.cookie, name))) return { status: 401, body: LOCAL_REFUSAL };
  return { forward: true, cookie: name };
}

export function createLocalProxy({ tokenFile, readToken = tokenReader(tokenFile), auth = true, editorPort, healthTimeoutMs = HEALTH_TIMEOUT_MS }) {
  const server = http.createServer((req, res) => {
    // the Host check comes first, /healthz included: a page on any site could otherwise probe
    // localhost ports for one that answers 'ok' and learn a machine is running
    if (!isLocalHost(req.headers.host)) { plain(res, FOREIGN_HOST.status, FOREIGN_HOST.body); return; }
    if (OPEN_PATHS.has(req.url?.split('?')[0])) {
      editorAnswers(editorPort, healthTimeoutMs).then((up) => plain(res, up ? 200 : 503, up ? 'ok\n' : 'editor unavailable\n'));
      return;
    }
    const d = localDecision(req, { readToken, auth });
    if (!d.forward) { plain(res, d.status, d.body, d.headers); return; }
    const headers = { ...req.headers };
    const cookie = withoutCookie(headers.cookie, d.cookie);
    if (cookie) headers.cookie = cookie; else delete headers.cookie;
    forward(req, res, headers, editorPort);
  });
  server.on('upgrade', (req, socket, head) => {
    const d = localDecision(req, { readToken, auth, upgrade: true });
    if (!d.forward) {
      const status = d.status === 403 ? 403 : 401; // a ?tkn= upgrade is refused too: the cookie is set by a page load
      socket.write(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${status === 403 ? 'forbidden' : 'unauthorized'}\r\n`);
      socket.destroy();
      return;
    }
    tunnel(req, socket, head, editorPort, (k, v) => (k === 'cookie' ? withoutCookie(v, d.cookie) : v));
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

/** Local mode's start: a token file the proxy can read (unless DT_LOCAL_AUTH=off), a bind it knows. */
export function loadLocalConfig(env = process.env) {
  const mode = env.DT_LOCAL_AUTH || 'on';
  if (!['on', 'off'].includes(mode)) throw new Error(`DT_LOCAL_AUTH must be on or off (got '${mode}')`);
  const auth = mode === 'on';
  const bind = env.DT_PROXY_BIND || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bind)) throw new Error(`DT_PROXY_BIND must be 127.0.0.1 or 0.0.0.0 (got '${bind}')`);
  const tokenFile = env.DT_URL_TOKEN_FILE || '/home/node/.dt/url-token';
  if (auth && !tokenReader(tokenFile)()) throw new Error(`no readable URL token at ${tokenFile}`);
  return { auth, bind, tokenFile };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain && process.env.DT_PROXY_MODE === 'local') {
  let config;
  try {
    config = loadLocalConfig(process.env);
  } catch (e) {
    console.error(`dt-origin-proxy: refusing to start: ${e.message}`);
    process.exit(1);
  }
  const port = Number(process.env.DT_PROXY_PORT ?? 8080);
  const editorPort = Number(process.env.DT_EDITOR_PORT ?? 8081);
  if (!config.auth) console.error('dt-origin-proxy: ⚠ ⚠ ⚠  DT_LOCAL_AUTH=off — NO URL TOKEN: any page in any browser on this computer can open this machine. Debugging only.');
  createLocalProxy({ tokenFile: config.tokenFile, auth: config.auth, editorPort }).listen(port, config.bind, () => {
    console.log(`dt-origin-proxy: local ${config.bind}:${port} → 127.0.0.1:${editorPort}, ${config.auth ? 'URL token required' : 'NO TOKEN (DT_LOCAL_AUTH=off)'}`);
  });
} else if (isMain) {
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
