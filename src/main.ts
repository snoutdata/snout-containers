/**
 * snout-containers: the process.
 *
 * Configuration is the environment, like every other SnoutData component:
 *
 *   SNOUT_CONTAINERS_MANIFESTS   the manifest directory (default /manifests), read-only is fine
 *   SNOUT_CONTAINERS_STATE       where status.json and the log spool go (default /state)
 *   SNOUT_CONTAINERS_BIND        comma-separated addresses a container's hostPort is published on
 *                                (default 127.0.0.1)
 *   SNOUT_CONTAINERS_POOL        the range project networks are carved from (default 10.95.0.0/16)
 *   SNOUT_CONTAINERS_STEP_MS     how often to reconcile (default 5000)
 *   CONTAINER_HOST               the engine's podman socket, unix:///run/snoutct/podman.sock
 *   DBUS_SESSION_BUS_ADDRESS     the host user's systemd bus, for the containers' slices
 *   PORT                         where /health answers (default 8080)
 *
 * `/health` answers 200 once a step has run and the engine is gVisor, 503 with the reason otherwise.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createRunner, type Exec } from './runner.js';

const exec: Exec = (command, args, options = {}) =>
	new Promise((resolve, reject) => {
		execFile(
			command,
			[...args],
			{
				timeout: options.timeoutMs ?? 0,
				maxBuffer: 16 * 1024 * 1024,
				env: options.env ? { ...process.env, ...options.env } : process.env
			},
			(error, stdout, stderr) => {
				if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
					reject(error);
					return;
				}
				const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			}
		);
	});

function log(message: string): void {
	console.log(`[snout-containers ${new Date().toISOString()}] ${message}`);
}

const runner = createRunner({
	exec,
	podman: process.env.SNOUT_CONTAINERS_PODMAN ?? 'podman-remote',
	manifests: process.env.SNOUT_CONTAINERS_MANIFESTS ?? '/manifests',
	state: process.env.SNOUT_CONTAINERS_STATE ?? '/state',
	bind: (process.env.SNOUT_CONTAINERS_BIND ?? '127.0.0.1')
		.split(',')
		.map((one) => one.trim())
		.filter(Boolean),
	pool: process.env.SNOUT_CONTAINERS_POOL ?? '10.95.0.0/16',
	log
});

let health: { ok: boolean; detail: string } = { ok: false, detail: 'starting' };
const stepMs = Number(process.env.SNOUT_CONTAINERS_STEP_MS ?? 5000);
let stopping = false;

async function loop(): Promise<void> {
	let lastLogs = 0;
	while (!stopping) {
		const rows = await runner.step();
		const engine = runner.engineReason();
		health = engine ? { ok: false, detail: engine } : { ok: true, detail: `${rows.length} container(s)` };
		if (Date.now() - lastLogs >= 60_000) {
			lastLogs = Date.now();
			await runner.collectLogs();
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

const server = createServer((req, res) => {
	if (req.url === '/health') {
		res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ name: 'snout-containers', ok: health.ok, detail: health.detail }));
		return;
	}
	res.writeHead(404, { 'content-type': 'application/json' });
	res.end('{"error":"not found"}');
});
server.listen(Number(process.env.PORT ?? 8080), () => log(`listening on ${process.env.PORT ?? 8080}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.on(signal, () => {
		// The containers are not children of this process: they keep running, and the next runner
		// finds them where they were.
		stopping = true;
		server.close();
		setTimeout(() => process.exit(0), 200);
	});
}

loop().catch((error) => {
	log(`stopped: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
