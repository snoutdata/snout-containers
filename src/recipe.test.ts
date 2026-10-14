import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSubnet, networkArgs, runArgs, sliceArgs, sliceName, specHash, registryOf } from './recipe.js';

test('a project gets the first free /28, gateway at .1 and the sink at .14', () => {
	assert.deepEqual(allocateSubnet('10.95.0.0/16', []), { subnet: '10.95.0.0/28', gateway: '10.95.0.1', sink: '10.95.0.14' });
	assert.deepEqual(allocateSubnet('10.95.0.0/16', ['10.95.0.0/28', '10.88.0.0/16']).subnet, '10.95.0.16/28');
	assert.equal(allocateSubnet('10.95.0.0/16', ['10.95.0.0/28', '10.95.0.32/28']).subnet, '10.95.0.16/28');
	assert.throws(() => allocateSubnet('10.95.0.0/28', ['10.95.0.0/28']), /no free \/28/);
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
	assert.ok(!egressRuleset('10.95.0.0/16', { ...EGRESS_POLICY, closedPorts: [] }).includes('dport'));
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
	assert.deepEqual(read?.counters.get('10.95.0.2'), { sentBytes: 44527835, sentPackets: 2067, opened: 0, refused: 5, throttledBytes: 2238636 });
	assert.equal(parseEgress('{"nftables":[{"metainfo":{}}]}'), null);
	assert.equal(parseEgress('not json'), null);
});
