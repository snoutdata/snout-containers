import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSubnet, networkArgs, runArgs, sliceArgs, sliceName, specHash, registryOf } from './recipe.js';

test('a project gets the first free /28, gateway at .1 and the sink at .14', () => {
	assert.deepEqual(allocateSubnet('10.95.0.0/16', []), { subnet: '10.95.0.0/28', gateway: '10.95.0.1', sink: '10.95.0.14' });
	assert.deepEqual(allocateSubnet('10.95.0.0/16', ['10.95.0.0/28', '10.88.0.0/16']).subnet, '10.95.0.16/28');
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.0/28', '10.95.0.32/28']).subnet, '10.95.0.16/28');
	assert.throws(() => allocateSubnet('10.95.0.0/28', ['10.95.0.0/28']), /no free \/28/);
	// The router's snoutlr (10.95.0.0/24) is listed beside these networks: nothing inside it is given.
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.0/24']).subnet, '10.95.1.0/28');
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.0/24', '10.95.1.0/28']).subnet, '10.95.1.16/28');
	// A wider network around the pool's start, and one that only touches a /28's last address.
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.0/23']).subnet, '10.95.2.0/28');
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.15/32']).subnet, '10.95.0.16/28');
});

test('a project network denies every private range through its sink, and says whose it is', () => {
	const args = networkArgs('acme', { subnet: '10.95.0.16/28', gateway: '10.95.0.17', sink: '10.95.0.30' });
	assert.deepEqual(args.slice(0, 6), ['network', 'create', '--subnet', '10.95.0.16/28', '--gateway', '10.95.0.17']);
	for (const prefix of ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
		assert.ok(args.includes(`${prefix},10.95.0.30`), prefix);
	}
	assert.equal(args.at(-1), 'snoutct-acme');
	assert.ok(args.includes('io.snoutdata.container.ref=acme'));
});

test('a slice is named by a hash of the container name, so a hyphen never nests it', () => {
	assert.match(sliceName('acme', 'mqtt-bridge'), /^snoutct-acme-c[0-9a-f]{10}\.slice$/);
	assert.notEqual(sliceName('acme', 'a-b'), sliceName('acme', 'a_b'));
	assert.deepEqual(sliceArgs('acme', 'wa', { memoryMb: 256, cpuPercent: 50 }).slice(4), ['MemoryMax=256M', 'MemorySwapMax=0', 'CPUQuota=50%', 'TasksMax=512']);
});

test('run arguments: the project network, the slice, the ports, the env FILE, never a value', () => {
	const spec = { name: 'wa', image: 'ghcr.io/acme/wa@sha256:abc', port: 8080, hostPort: 46432, env: { TOKEN: 'secret' } };
	const args = runArgs({ project: 'acme', spec, hash: 'h', bind: ['127.0.0.1', '10.0.1.20'], envFile: '/state/tmp/env', passed: ['PEM'] });
	const line = args.join(' ');
	for (const wanted of ['--network snoutct-acme', `--cgroup-parent ${sliceName('acme', 'wa')}`, '--publish 127.0.0.1:46432:8080', '--publish 10.0.1.20:46432:8080', '--env-file /state/tmp/env', '--env PEM']) {
		assert.ok(line.includes(wanted), wanted);
	}
	assert.ok(!line.includes('secret'));
	assert.ok(!line.includes('--runtime'), 'the runtime is the engine service default, never an argument');
	assert.equal(args.at(-1), 'ghcr.io/acme/wa@sha256:abc');
	const unpublished = runArgs({ project: 'acme', spec: { ...spec, hostPort: null }, hash: 'h', bind: ['127.0.0.1'], envFile: 'f', passed: [] });
	assert.ok(!unpublished.includes('--publish'));
});

test('the spec hash moves with what the container is made from, and only that', () => {
	const spec = { name: 'wa', image: 'i', port: 8080, hostPort: 1, env: { A: '1' } };
	const limits = { memoryMb: 256, cpuPercent: 50 };
	const a = specHash('p', spec, limits, ['127.0.0.1']);
	assert.equal(specHash('p', { ...spec }, limits, ['127.0.0.1']), a);
	assert.notEqual(specHash('p', { ...spec, env: { A: '2' } }, limits, ['127.0.0.1']), a);
	assert.notEqual(specHash('p', { ...spec, restartGeneration: 1 }, limits, ['127.0.0.1']), a);
	assert.notEqual(specHash('p', spec, { memoryMb: 512, cpuPercent: 50 }, ['127.0.0.1']), a);
});

test('the registry of an image, as docker reads it', () => {
	assert.equal(registryOf('ghcr.io/acme/wa@sha256:x'), 'ghcr.io');
	assert.equal(registryOf('acme/wa:1'), 'docker.io');
	assert.equal(registryOf('nginx'), 'docker.io');
	assert.equal(registryOf('localhost:5000/x'), 'localhost:5000');
});

test('the egress ruleset: one table, the pool only, port 25 closed, the rate, the count and the bandwidth', async () => {
	const { egressRuleset, egressFingerprint, EGRESS_POLICY } = await import('./recipe.js');
	const rules = egressRuleset('10.95.0.0/16');
	assert.match(rules, /^table inet snoutct\ndelete table inet snoutct\ntable inet snoutct \{/);
	assert.ok(rules.includes(`comment "${egressFingerprint('10.95.0.0/16', EGRESS_POLICY)}"`));
	assert.ok(rules.includes('ip saddr != 10.95.0.0/16 return'));
	assert.ok(rules.includes('ct direction reply return'), 'connections to the container must not be limited');
	assert.ok(rules.includes('tcp dport { 25 } jump refuse'));
	assert.ok(rules.includes('limit rate over 20/second burst 200 packets'));
	assert.ok(rules.includes('ct count over 1000'));
	assert.ok(rules.includes('limit rate over 2097152 bytes/second burst 8388608 bytes'));
	assert.notEqual(egressFingerprint('10.95.0.0/16', EGRESS_POLICY), egressFingerprint('10.96.0.0/16', EGRESS_POLICY));
	assert.ok(!egressRuleset('10.95.0.0/16', { ...EGRESS_POLICY, closedPorts: [] }).includes('tcp dport {'));
	assert.throws(() => egressRuleset('nope'), /not an IPv4 CIDR/);
});

test('nft -j output reads back as each address\'s counters and the table\'s fingerprint', async () => {
	const { parseEgress } = await import('./recipe.js');
	const json = JSON.stringify({
		nftables: [
			{ metainfo: { version: '1.1.3' } },
			{ table: { family: 'inet', name: 'snoutct', handle: 19, comment: 'abc' } },
			{ set: { family: 'inet', name: 'sent', table: 'snoutct', elem: [{ elem: { val: '10.95.0.2', counter: { packets: 2067, bytes: 44527835 } } }] } },
			{ set: { family: 'inet', name: 'refused', table: 'snoutct', elem: [{ elem: { val: '10.95.0.2', counter: { packets: 5, bytes: 300 } } }] } },
			{ set: { family: 'inet', name: 'throttled', table: 'snoutct', elem: [{ elem: { val: '10.95.0.2', counter: { packets: 39, bytes: 2238636 } } }] } },
			{ set: { family: 'inet', name: 'rate', table: 'snoutct', elem: [{ elem: { val: '10.95.0.2' } }] } }
		]
	});
	const read = parseEgress(json);
	assert.equal(read?.fingerprint, 'abc');
	assert.deepEqual(read?.counters.get('10.95.0.2'), { sentBytes: 44527835, sentPackets: 2067, opened: 0, refused: 5, throttledBytes: 2238636, blocked: 0 });
	assert.equal(parseEgress('{"nftables":[{"metainfo":{}}]}'), null);
	assert.equal(parseEgress('not json'), null);
});

test('IPv6 from a project bridge is dropped, forwarded or not, before any IPv4 rule', async () => {
	const { egressRuleset } = await import('./recipe.js');
	const rules = egressRuleset('10.95.0.0/16', undefined, { bridges: ['podman3', 'podman4'], restricted: [] });
	assert.ok(rules.includes('set bridges { type ifname; elements = { "podman3", "podman4" }; }'));
	const forward = rules.slice(rules.indexOf('chain forward {'));
	const lines = forward.split('\n').map((line) => line.trim());
	assert.equal(lines[2], 'meta nfproto ipv6 iifname @bridges counter drop', 'the IPv6 drop is the first rule');
	assert.equal(lines[3], 'meta nfproto != ipv4 return');
	const input = rules.slice(rules.indexOf('chain input {'), rules.indexOf('chain forward {'));
	assert.match(input, /hook input .*\n\t\tmeta nfproto ipv6 iifname @bridges counter drop/);
	// With no bridges the set is empty, never `elements = { }`, which nft refuses.
	assert.ok(egressRuleset('10.95.0.0/16').includes('set bridges { type ifname; }'));
	// A name nft would read as something else never gets in.
	assert.ok(!egressRuleset('10.95.0.0/16', undefined, { bridges: ['x"; flush ruleset; "'], restricted: [] }).includes('flush'));
});

test('an allowlist: its own /28, what it lists on any port, each listed port, no overlaps, every packet checked', async () => {
	const { egressRuleset, egressElements, egressMembersScript, egressMembersKey } = await import('./recipe.js');
	const members = {
		bridges: ['podman3'],
		restricted: [
			{
				subnet: '10.95.0.16/28',
				allow: [
					{ cidrs: ['203.0.113.9'], ports: [443, 8443] },
					{ cidrs: ['198.51.100.0/24', '198.51.100.7'], ports: [] },
					{ cidrs: ['198.51.100.8'], ports: [443] },
					{ cidrs: ['203.0.113.0/28'], ports: [443] }
				]
			}
		]
	};
	const elements = egressElements(members);
	assert.deepEqual(elements.restricted, ['10.95.0.16/28']);
	assert.deepEqual(elements.allowAny, ['10.95.0.16/28 . 10.95.0.16/28', '10.95.0.16/28 . 198.51.100.0/24']);
	assert.deepEqual(elements.allowPort, ['10.95.0.16/28 . 203.0.113.0/28 . 443', '10.95.0.16/28 . 203.0.113.9/32 . 8443']);
	const rules = egressRuleset('10.95.0.0/16', undefined, members);
	const forward = rules.slice(rules.indexOf('chain forward {'), rules.indexOf('chain allowlist {'));
	assert.ok(forward.indexOf('ct direction reply return') < forward.indexOf('ip saddr @restricted jump allowlist'), 'replies to callers are never checked');
	assert.ok(forward.indexOf('ip saddr @restricted jump allowlist') < forward.indexOf('ct state new jump open'), 'every packet, not only a new connection');
	assert.match(rules, /chain allowlist \{\n\t\tip saddr \. ip daddr @allow_any return\n\t\tmeta l4proto \{ tcp, udp \} ip saddr \. ip daddr \. th dport @allow_port return\n\t\tupdate @blocked \{ ip saddr \}/);
	assert.ok(rules.includes('set allow_port { type ipv4_addr . ipv4_addr . inet_service; flags interval; elements = { 10.95.0.16/28 . 203.0.113.0/28 . 443, 10.95.0.16/28 . 203.0.113.9/32 . 8443 }; }'));
	const script = egressMembersScript(members);
	assert.match(script, /^flush set inet snoutct bridges\nadd element inet snoutct bridges \{ "podman3" \}\nflush set inet snoutct restricted\n/);
	assert.ok(script.includes('add element inet snoutct allow_any { 10.95.0.16/28 . 10.95.0.16/28, 10.95.0.16/28 . 198.51.100.0/24 }'));
	assert.equal(egressMembersScript({ bridges: [], restricted: [] }), 'flush set inet snoutct bridges\nflush set inet snoutct restricted\nflush set inet snoutct allow_any\nflush set inet snoutct allow_port\n');
	assert.equal(egressMembersKey(members), egressMembersKey({ ...members }));
	assert.notEqual(egressMembersKey(members), egressMembersKey({ ...members, restricted: [] }));
});
