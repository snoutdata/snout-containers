import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner, type ExecResult } from './runner.js';

interface Call {
	command: string;
	args: readonly string[];
	env?: Readonly<Record<string, string>>;
	files: Record<string, string>;
}

/** A podman (and systemctl) that keeps a table of containers and networks the test can poke. */
function fakeEngine(runtime = 'runsc-snoutct') {
	const calls: Call[] = [];
	const containers: { Names: string[]; Labels: Record<string, string>; State: string; ExitCode: number }[] = [];
	const nets: { name: string; subnets: { subnet: string }[]; labels: Record<string, string> }[] = [
		{ name: 'podman', subnets: [{ subnet: '10.88.0.0/16' }], labels: {} }
	];
	const images = new Set<string>();
	const exec = async (command: string, args: readonly string[], options?: { env?: Readonly<Record<string, string>> }): Promise<ExecResult> => {
		const files: Record<string, string> = {};
		for (const [i, arg] of args.entries()) {
			if ((arg === '--env-file' || arg === '--authfile') && existsSync(args[i + 1] as string)) {
				files[arg] = readFileSync(args[i + 1] as string, 'utf8');
			}
		}
		calls.push({ command, args, env: options?.env, files });
		const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
		if (command === 'systemctl') {
			return ok();
		}
		const [verb, sub] = args;
		if (verb === 'info') return ok(`${runtime}\n`);
		if (verb === 'ps') return ok(JSON.stringify(containers));
		if (verb === 'network' && sub === 'ls') return ok(JSON.stringify(nets));
		if (verb === 'network' && sub === 'create') {
			const name = args.at(-1) as string;
			const subnet = args[args.indexOf('--subnet') + 1] as string;
			const labels: Record<string, string> = {};
			for (const [i, a] of args.entries()) if (a === '--label') { const [k, v] = (args[i + 1] as string).split('='); labels[k as string] = v as string; }
			nets.push({ name, subnets: [{ subnet }], labels });
			return ok(name);
		}
		if (verb === 'network' && sub === 'rm') {
			const at = nets.findIndex((n) => n.name === args.at(-1));
			if (at !== -1) nets.splice(at, 1);
			return ok();
		}
		if (verb === 'image' && sub === 'exists') return images.has(args[2] as string) ? ok() : { code: 1, stdout: '', stderr: '' };
		if (verb === 'pull') { images.add(args.at(-1) as string); return ok(); }
		if (verb === 'rm') {
			const at = containers.findIndex((c) => c.Names[0] === args.at(-1));
			if (at !== -1) containers.splice(at, 1);
			return ok();
		}
		if (verb === 'run') {
			const labels: Record<string, string> = {};
			let name = '';
			for (const [i, a] of args.entries()) {
				if (a === '--label') { const [k, v] = (args[i + 1] as string).split('='); labels[k as string] = v as string; }
				if (a === '--name') name = args[i + 1] as string;
			}
			containers.push({ Names: [name], Labels: labels, State: 'running', ExitCode: 0 });
			return ok('id');
		}
		if (verb === 'logs') {
			return args.includes('--timestamps')
				? { code: 0, stdout: '2026-10-13T19:00:01.000000000Z connected\n', stderr: '2026-10-13T19:00:02.000000000Z slow\n' }
				: ok('2026-10-13T19:00:00.000000000Z boom\n');
		}
		return ok();
	};
	return { exec, calls, containers, nets, images };
}

async function setup(runtime?: string) {
	const root = await mkdtemp(join(tmpdir(), 'ct-'));
	const manifests = join(root, 'manifests');
	const state = join(root, 'state');
	await mkdir(manifests);
	const engine = fakeEngine(runtime);
	let clock = Date.parse('2026-10-13T19:00:00.500Z');
	const runner = createRunner({ exec: engine.exec, manifests, state, bind: ['127.0.0.1', '10.0.1.20'], now: () => clock });
	const put = (project: string, body: unknown) => writeFile(join(manifests, `${project}.json`), typeof body === 'string' ? body : JSON.stringify(body));
	const status = () => JSON.parse(readFileSync(join(state, 'status.json'), 'utf8'));
	return { root, manifests, state, engine, runner, put, status, advance: (ms: number) => (clock += ms) };
}

function manifest(project: string, extra: Record<string, unknown> = {}) {
	return {
		project,
		limits: { memoryMb: 256, cpuPercent: 50 },
		containers: [{ name: 'wa', image: `ghcr.io/${project}/wa@sha256:1`, port: 8080, hostPort: 46432, env: { TOKEN: 'secret-value', PEM: 'a\nb' }, ...extra }]
	};
}

test('an engine that is not gVisor runs nothing, and every container says why', async () => {
	const t = await setup('crun');
	await t.put('acme', manifest('acme'));
	const rows = await t.runner.step();
	assert.equal(t.engine.calls.filter((c) => c.args[0] === 'run' || c.args[0] === 'pull').length, 0);
	assert.equal(rows[0]?.status, 'failed');
	assert.match(rows[0]?.detail ?? '', /cannot run containers yet: the container engine runs crun/);
	assert.equal(t.status().engine, 'the container engine runs crun, not runsc-snoutct');
});

test('a new container: its project network, pulled, limited, run, nothing secret on argv', async () => {
	const t = await setup();
	await t.put('acme', manifest('acme'));
	const rows = await t.runner.step();
	assert.equal(rows[0]?.status, 'starting');
	const net = t.engine.nets.find((n) => n.name === 'snoutct-acme');
	assert.equal(net?.subnets[0]?.subnet, '10.95.0.0/28');
	const run = t.engine.calls.find((c) => c.args[0] === 'run');
	assert.ok(run);
	const line = run.args.join(' ');
	assert.ok(line.includes('--network snoutct-acme'));
	assert.ok(!line.includes('secret-value'));
	assert.match(run.files['--env-file'] ?? '', /^TOKEN=secret-value$/m);
	assert.equal(run.env?.PEM, 'a\nb');
	assert.ok(t.engine.calls.some((c) => c.command === 'systemctl' && c.args.includes('MemoryMax=256M')));
	assert.deepEqual(await readdir(join(t.state, 'tmp')), [], 'the env file was left behind');
	assert.equal((await t.runner.step())[0]?.status, 'running');
	assert.equal(t.engine.calls.filter((c) => c.args[0] === 'run').length, 1, 'a settled container was made again');
});

test('two projects get two networks on two /28s', async () => {
	const t = await setup();
	await t.put('acme', manifest('acme'));
	await t.put('beta', manifest('beta', { hostPort: 47432 }));
	await t.runner.step();
	const subnets = t.engine.nets.filter((n) => n.name.startsWith('snoutct-')).map((n) => `${n.name}=${n.subnets[0]?.subnet}`).sort();
	assert.deepEqual(subnets, ['snoutct-acme=10.95.0.0/28', 'snoutct-beta=10.95.0.16/28']);
});

test('a crash is made again from its image with a backoff, never podman start', async () => {
	const t = await setup();
	await t.put('acme', manifest('acme'));
	await t.runner.step();
	Object.assign(t.engine.containers[0] as object, { State: 'exited', ExitCode: 1 });
	const rows = await t.runner.step();
	assert.equal(rows[0]?.status, 'restarting');
	assert.equal(rows[0]?.restarts, 1);
	assert.match(rows[0]?.detail ?? '', /exited with code 1: boom/);
	const runs = () => t.engine.calls.filter((c) => c.args[0] === 'run').length;
	assert.equal(runs(), 2);
	assert.equal(t.engine.calls.filter((c) => c.args[0] === 'start').length, 0);
	Object.assign(t.engine.containers[0] as object, { State: 'exited' });
	await t.runner.step();
	assert.equal(runs(), 2, 'the backoff did not hold');
	t.advance(10_000);
	await t.runner.step();
	assert.equal(runs(), 3);
});

test('a manifest that stops reading leaves its containers alone; a removed one takes them and the network', async () => {
	const t = await setup();
	await t.put('acme', manifest('acme'));
	await t.runner.step();
	await t.put('acme', '{broken');
	const rows = await t.runner.step();
	assert.equal(t.engine.containers.length, 1);
	assert.equal(rows[0]?.status, 'starting', 'the last word was not kept');
	assert.match(t.status().errors[0].reason, /not JSON/);
	await writeFile(join(t.manifests, 'acme.json'), JSON.stringify({ ...manifest('acme'), containers: [] }));
	await t.runner.step();
	assert.equal(t.engine.containers.length, 0);
	const { rm } = await import('node:fs/promises');
	await rm(join(t.manifests, 'acme.json'));
	await t.runner.step();
	assert.equal(t.engine.nets.some((n) => n.name === 'snoutct-acme'), false);
});

test('logs go to the spool as JSONL, both streams, since the last collection', async () => {
	const t = await setup();
	await t.put('acme', manifest('acme'));
	await t.runner.step();
	const rows = await t.runner.collectLogs();
	assert.deepEqual(rows.map((r) => `${r.stream}:${r.message}`), ['stdout:connected', 'stderr:slow']);
	const files = await readdir(join(t.state, 'logs'));
	assert.equal(files.length, 1);
	assert.match(files[0] ?? '', /\.jsonl$/);
});

test('no engine at all: the manifests are still read, every container failed with why, podman never asked for more', async () => {
	const t = await setup();
	const broken = async (command: string, args: readonly string[]) =>
		command === 'systemctl' ? { code: 0, stdout: '', stderr: '' } : { code: 125, stdout: '', stderr: 'Cannot connect to Podman: no such file or directory' };
	const root = await mkdtemp(join(tmpdir(), 'ct-'));
	await mkdir(join(root, 'm'));
	await writeFile(join(root, 'm', 'acme.json'), JSON.stringify(manifest('acme')));
	const runner = createRunner({ exec: broken, manifests: join(root, 'm'), state: join(root, 's'), bind: ['127.0.0.1'] });
	const rows = await runner.step();
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.status, 'failed');
	assert.match(rows[0]?.detail ?? '', /cannot run containers yet: the container engine does not answer/);
	assert.match(runner.engineReason() ?? '', /does not answer/);
	void t;
});
