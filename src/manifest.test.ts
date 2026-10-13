import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifest, readManifests } from './manifest.js';

const good = {
	project: 'acme',
	limits: { memoryMb: 256, cpuPercent: 50 },
	containers: [{ name: 'wa', image: 'ghcr.io/acme/wa:1', port: 9000, hostPort: 46432, env: { TOKEN: 't' } }]
};

test('a good manifest reads, and PORT is given unless env sets it', () => {
	const read = checkManifest('acme', good);
	assert.equal(read.ok, true);
	if (read.ok) {
		assert.equal(read.manifest.containers[0]?.env?.PORT, '9000');
		assert.equal(read.manifest.containers[0]?.hostPort, 46432);
	}
	const own = checkManifest('acme', { ...good, containers: [{ ...good.containers[0], env: { PORT: '7000' } }] });
	assert.equal(own.ok && own.manifest.containers[0]?.env?.PORT, '7000');
});

test('every refusal is a sentence', () => {
	const cases: [unknown, RegExp][] = [
		[{ ...good, project: 'other' }, /names the project/],
		[{ ...good, limits: { memoryMb: 1, cpuPercent: 50 } }, /memoryMb/],
		[{ ...good, containers: [{ ...good.containers[0], name: 'Bad' }] }, /not a container name/],
		[{ ...good, containers: [good.containers[0], good.containers[0]] }, /two containers are called wa/],
		[{ ...good, containers: [{ ...good.containers[0], image: 'a b' }] }, /not an image reference/],
		[{ ...good, containers: [{ ...good.containers[0], hostPort: 80 }] }, /hostPort/],
		[{ ...good, containers: [{ ...good.containers[0], env: { '1X': 'v' } }] }, /env/],
		[{ ...good, containers: [{ ...good.containers[0], registry: { username: 'u' } }] }, /registry/]
	];
	for (const [value, reason] of cases) {
		const read = checkManifest('acme', value);
		assert.equal(read.ok, false);
		assert.match((read as { reason: string }).reason, reason);
	}
});

test('the directory: one file per project, bad names and bad JSON reported, a missing directory empty', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'man-'));
	await writeFile(join(dir, 'acme.json'), JSON.stringify(good));
	await writeFile(join(dir, 'Bad.json'), '{}');
	await writeFile(join(dir, 'zeta.json'), '{not json');
	await writeFile(join(dir, 'notes.txt'), 'ignored');
	const reads = await readManifests(dir);
	assert.deepEqual(reads.map((r) => `${r.ok ? r.manifest.project : r.project}:${r.ok}`), ['Bad:false', 'acme:true', 'zeta:false']);
	assert.deepEqual(await readManifests(join(dir, 'nope')), []);
});
