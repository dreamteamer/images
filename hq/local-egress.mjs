#!/usr/bin/env node
// dt-local-egress — renders the LOCAL-mode egress policy (Docker Desktop via `dt-host start container`) as an
// nft ruleset on stdout; the root entrypoint pipes it into `nft -f -` before anything runs as `node`.
//
// Why: a per-container bridge network does not isolate on Docker Desktop. Measured on 29.3.1: from
// container A, both B's container IP and host.docker.internal:<B's published port> reach B. So the
// workspace user (`node`, matched by socket owner) may not open a NEW connection to
//   · private, CGNAT and link-local IPv4 (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16)
//   · IPv6 unique-local and link-local (fc00::/7, fe80::/10)
//   · the host gateways — host.docker.internal and gateway.docker.internal as resolved at start, and the
//     container's own default gateway — whatever range they fall in
// except the resolvers in /etc/resolv.conf on port 53 (Docker's embedded DNS is 127.0.0.11) and loopback.
// The internet stays open. Root and `dtproxy` are unaffected (the proxy only listens), and so are replies
// to connections that came in. DT_LOCAL_EGRESS=open skips the policy (the entrypoint says so loudly).
//
// `dt-local-egress` prints the ruleset built from this container's facts; renderLocalEgress() is the pure
// part the tests pin. Zero dependencies.
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';

export const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'];
export const PRIVATE_V6 = ['fc00::/7', 'fe80::/10'];
export const HOST_NAMES = ['host.docker.internal', 'gateway.docker.internal'];
const TABLE = 'dt_local_egress';

/** The nameserver addresses of a resolv.conf, IPs only (a zone suffix like %eth0 dropped). */
export function parseResolvConf(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*nameserver\s+(\S+)/);
    if (!m) continue;
    const ip = m[1].replace(/%.*$/, '');
    if (net.isIP(ip) && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/** The IPv4 default gateway(s) out of /proc/net/route (hex, little-endian). */
export function parseRoute(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(f[2]) || f[2] === '00000000') continue;
    const ip = f[2].match(/../g).reverse().map((b) => parseInt(b, 16)).join('.');
    if (!out.includes(ip)) out.push(ip);
  }
  return out;
}

/** The IPv6 default gateway(s) out of /proc/net/ipv6_route. */
export function parseRoute6(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !/^0{32}$/.test(f[0]) || f[1] !== '00' || !/^[0-9a-f]{32}$/i.test(f[4]) || /^0{32}$/.test(f[4])) continue;
    const ip = f[4].match(/.{4}/g).join(':').toLowerCase();
    if (!out.includes(ip)) out.push(ip);
  }
  return out;
}

function elements(list) { return list.join(', '); }

/**
 * The ruleset. `uid`: node's uid. `resolvers`: addresses allowed on port 53. `hosts`: host-gateway
 * addresses blocked whatever range they fall in. Anything that is not an IP address is refused, so no
 * input can add a rule.
 */
export function renderLocalEgress({ uid, resolvers = [], hosts = [] }) {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`the workspace user's uid must be a positive integer (got ${uid})`);
  for (const ip of [...resolvers, ...hosts]) if (!net.isIP(ip)) throw new Error(`not an IP address: ${JSON.stringify(ip)}`);
  const v4 = [...PRIVATE_V4, ...hosts.filter((ip) => net.isIPv4(ip))];
  const v6 = [...PRIVATE_V6, ...hosts.filter((ip) => net.isIPv6(ip))];
  const dns = resolvers.flatMap((ip) => {
    const fam = net.isIPv4(ip) ? 'ip' : 'ip6';
    return [`\t\t${fam} daddr ${ip} udp dport 53 accept`, `\t\t${fam} daddr ${ip} tcp dport 53 accept`];
  });
  return `#!/usr/sbin/nft -f
# dt-local-egress: the local-mode egress policy (rendered at start; see /usr/local/bin/dt-local-egress)
table inet ${TABLE}
delete table inet ${TABLE}

table inet ${TABLE} {
	set blocked_v4 {
		type ipv4_addr
		flags interval
		auto-merge
		elements = { ${elements(v4)} }
	}

	set blocked_v6 {
		type ipv6_addr
		flags interval
		auto-merge
		elements = { ${elements(v6)} }
	}

	chain output {
		type filter hook output priority filter; policy accept;

		oifname "lo" accept
		ct state established,related accept
		meta skuid != ${uid} accept
${dns.join('\n')}${dns.length ? '\n' : ''}
		ip daddr @blocked_v4 limit rate 6/minute log prefix "dt-local-egress " level warn
		ip daddr @blocked_v4 counter reject with icmpx type admin-prohibited
		ip6 daddr @blocked_v6 limit rate 6/minute log prefix "dt-local-egress " level warn
		ip6 daddr @blocked_v6 counter reject with icmpx type admin-prohibited
	}
}
`;
}

/** Every address a name resolves to, or [] within `ms` (a name Docker does not define is simply absent). */
async function resolveAll(name, ms = 3000) {
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r([]), ms); });
  const lookup = dns.lookup(name, { all: true }).then((a) => a.map((x) => x.address), () => []);
  try { return await Promise.race([lookup, timeout]); } finally { clearTimeout(timer); }
}
const readOr = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** This container's facts: node's uid, its resolvers, its host gateways. */
export async function gather({ user = 'node' } = {}) {
  const line = readOr('/etc/passwd').split('\n').find((l) => l.startsWith(`${user}:`));
  const uid = line ? Number(line.split(':')[2]) : NaN;
  const resolvers = parseResolvConf(readOr('/etc/resolv.conf'));
  const hosts = [];
  for (const ip of [...(await Promise.all(HOST_NAMES.map((n) => resolveAll(n)))).flat(), ...parseRoute(readOr('/proc/net/route')), ...parseRoute6(readOr('/proc/net/ipv6_route'))]) {
    if (!hosts.includes(ip)) hosts.push(ip);
  }
  return { uid, resolvers, hosts };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const facts = await gather();
    process.stdout.write(renderLocalEgress(facts));
    console.error(`dt-local-egress: uid ${facts.uid}; resolvers ${facts.resolvers.join(' ') || 'none'}; host gateways ${facts.hosts.join(' ') || 'none'}`);
  } catch (e) {
    console.error(`dt-local-egress: ${e.message}`);
    process.exit(1);
  }
}
