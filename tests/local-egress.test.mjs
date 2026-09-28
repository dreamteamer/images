// 0.6.0 security review, P0: a per-container bridge network does not isolate on Docker Desktop, so local
// mode applies its own egress policy (dt-local-egress, applied by the root entrypoint). The rendering is
// pinned here; the built image is exercised by tests/container.test.mjs (two containers, A cannot reach B).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResolvConf, parseRoute, parseRoute6, renderLocalEgress, PRIVATE_V4, PRIVATE_V6 } from '../hq/local-egress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const code = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const rules = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('reading the container\'s facts', () => {
	test('resolv.conf: every nameserver that is an IP, in order, once; comments and junk ignored', () => {
		assert.deepEqual(parseResolvConf('# generated\nsearch acme.test\nnameserver 127.0.0.11\noptions ndots:0\n'), ['127.0.0.11']);
		assert.deepEqual(parseResolvConf('nameserver 10.0.0.2\nnameserver fe80::1%eth0\nnameserver 10.0.0.2\nnameserver not-an-ip\n#nameserver 1.1.1.1\n'), ['10.0.0.2', 'fe80::1']);
		assert.deepEqual(parseResolvConf(''), []);
	});
	test('/proc/net/route: the default route\'s gateway, decoded from little-endian hex', () => {
		const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n'
			+ 'eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n'
			+ 'eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';
		assert.deepEqual(parseRoute(route), ['172.18.0.1']);
		assert.deepEqual(parseRoute('Iface\tDestination\n'), []);
	});
	test('/proc/net/ipv6_route: the default route\'s next hop', () => {
		const r6 = `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 eth0\n`
			+ `fd000000000000000000000000000000 40 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00000100 00000001 00000000 00000001 eth0\n`;
		assert.deepEqual(parseRoute6(r6), ['fe80:0000:0000:0000:0000:0000:0000:0001']);
	});
});

describe('the rendered ruleset', () => {
	const nft = renderLocalEgress({ uid: 1000, resolvers: ['127.0.0.11'], hosts: ['192.168.65.254', '203.0.113.7', 'fdc4:f303:9324::254'] });
	const r = rules(nft);
	test('its own table, replaced atomically on every start; the hosted table is not touched', () => {
		assert.match(nft, /^table inet dt_local_egress\ndelete table inet dt_local_egress\n/m);
		assert.doesNotMatch(nft, /\bdt_egress\b/);
	});
	test('blocks private, CGNAT and link-local IPv4, and IPv6 ULA and link-local', () => {
		for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', 'fc00::/7', 'fe80::/10']) assert.ok(nft.includes(cidr), cidr);
		assert.deepEqual([...PRIVATE_V4, ...PRIVATE_V6].length, 7);
		assert.ok(r.includes('ip daddr @blocked_v4 counter reject with icmpx type admin-prohibited'));
		assert.ok(r.includes('ip6 daddr @blocked_v6 counter reject with icmpx type admin-prohibited'));
	});
	test('the host gateways are blocked whatever range they are in (a public one too)', () => {
		const v4 = nft.slice(nft.indexOf('set blocked_v4'), nft.indexOf('set blocked_v6'));
		const v6 = nft.slice(nft.indexOf('set blocked_v6'), nft.indexOf('chain output'));
		assert.match(v4, /192\.168\.65\.254/);
		assert.match(v4, /203\.0\.113\.7/);
		assert.match(v6, /fdc4:f303:9324::254/);
	});
	test('only the workspace user is filtered: every other uid (root, dtproxy) is accepted before any block', () => {
		const skuid = r.indexOf('meta skuid != 1000 accept');
		assert.ok(skuid > 0);
		assert.ok(skuid < r.findIndex((l) => l.includes('@blocked_v4')));
	});
	test('loopback, replies and the resolver on 53 come first; the internet is the default (policy accept)', () => {
		const firstBlock = r.findIndex((l) => l.includes('@blocked_v4'));
		for (const rule of ['oifname "lo" accept', 'ct state established,related accept', 'ip daddr 127.0.0.11 udp dport 53 accept', 'ip daddr 127.0.0.11 tcp dport 53 accept']) {
			const i = r.indexOf(rule);
			assert.ok(i >= 0 && i < firstBlock, rule);
		}
		assert.ok(r.includes('type filter hook output priority filter; policy accept;'));
		assert.equal(r.filter((l) => /\bdrop\b|\breject\b/.test(l)).length, 2, 'nothing else is blocked');
	});
	test('an IPv6 resolver is allowed as ip6; no resolver renders no port-53 rule', () => {
		assert.match(renderLocalEgress({ uid: 1000, resolvers: ['fd00::53'] }), /ip6 daddr fd00::53 udp dport 53 accept/);
		assert.doesNotMatch(renderLocalEgress({ uid: 1000 }), /dport 53/);
	});
	test('nothing that is not an IP address, and no uid that is not a positive integer, reaches the ruleset', () => {
		assert.throws(() => renderLocalEgress({ uid: 1000, hosts: ['1.2.3.4 } ; flush ruleset ; {'] }), /not an IP address/);
		assert.throws(() => renderLocalEgress({ uid: 1000, resolvers: ['example.test'] }), /not an IP address/);
		assert.throws(() => renderLocalEgress({ uid: 0 }), /uid/);
		assert.throws(() => renderLocalEgress({ uid: Number.NaN }), /uid/);
	});
});

describe('the entrypoint applies it', () => {
	const c = code(read('hq', 'entrypoint.sh'));
	const fn = c.slice(c.indexOf('apply_local_egress() {'), c.indexOf('if [ "$MODE" = local ]; then apply_local_egress ; fi'));
	test('in local mode, as root, before anything runs as node', () => {
		const call = c.indexOf('if [ "$MODE" = local ]; then apply_local_egress ; fi');
		assert.ok(call > 0);
		assert.ok(call < c.indexOf('"${AS_NODE[@]}" /usr/local/bin/dt-entrypoint --prepare'));
		assert.ok(call > c.indexOf('# ---- root phase'));
		assert.match(fn, /ruleset=\$\(\/usr\/local\/bin\/node \/usr\/local\/bin\/dt-local-egress\) \|\| die/);
		assert.match(fn, /nft -f - <<<"\$ruleset" \|\| die/);
	});
	test('DT_LOCAL_EGRESS=open skips it loudly; an unknown value is refused', () => {
		assert.match(fn, /open\)\s*\n\s*log "⚠ ⚠ ⚠  DT_LOCAL_EGRESS=open — NO LOCAL ISOLATION[^\n]*"\s*\n\s*return 0/);
		assert.match(fn, /die "DT_LOCAL_EGRESS must be isolated or open/);
	});
	test('without CAP_NET_ADMIN (an older engine): a loud warning and the start goes on; hosted stays fatal', () => {
		const noCap = fn.slice(fn.indexOf('if ! has_net_admin; then'), fn.indexOf('ruleset='));
		assert.match(noCap, /log "⚠ ⚠ ⚠  no CAP_NET_ADMIN — LOCAL ISOLATION IS OFF/);
		assert.match(noCap, /return 0/);
		assert.doesNotMatch(noCap, /die/);
		assert.match(c, /\(\( \(16#\$eff >> 12\) & 1 \)\)/, 'CAP_NET_ADMIN is bit 12 of CapEff');
		assert.match(c, /nft -f \/etc\/dt\/egress\.nft \|\| die/, 'the hosted policy is still fatal');
	});
	test('installed root-owned 0755', () => {
		assert.match(read('hq', 'Dockerfile'), /^COPY --chown=root:root --chmod=0755 local-egress\.mjs \/usr\/local\/bin\/dt-local-egress$/m);
	});
});
