/**
 * The runner: make what the manifests say exist, keep it running, say how it is.
 *
 * One `step` every few seconds:
 *
 *   1. Is the engine there? The podman service must report the runtime `runsc-snoutct`. If it does
 *      not, NOTHING is created and every container is reported `failed` with why: a host that would
 *      run customer code under an ordinary runtime is worse than one that runs none.
 *   2. Read the manifests. A file that does not parse is reported and its project left as it is.
 *   3. Remove what no manifest asks for (containers, then each project's network once it is empty).
 *   4. For each container asked for: equal spec and running, nothing; missing or changed, make it
 *      (pull, the project's network, the slice, then `podman run`); stopped on its own, make it again
 *      from its image after a backoff (5 s doubling to 5 minutes; `failed` after five in a row,
 *      cleared after a minute running). Never `podman start`: a container begins from its image.
 *   5. Write `status.json` whole.
 *
 * And every minute, `collectLogs`: what each container printed since last time, as a JSONL file in
 * the spool, which whoever ships logs reads and deletes.
 *
 * Secrets never reach argv: the environment goes through a 0600 env file deleted as soon as `podman
 * run` returns (a value with a newline goes through the runner's own environment by name), and a
 * registry login through an auth file the same way.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifests, type ProjectManifest } from './manifest.js';
import {
	allocateSubnet,
	containerName,
	LABEL,
	LABEL_NAME,
	LABEL_PROJECT,
	LABEL_SPEC,
	networkArgs,
	networkName,
	registryOf,
	runArgs,
	RUNTIME,
	sliceArgs,
	sliceName,
	specHash,
	type ContainerSpec,
	type Limits
} from './recipe.js';

export interface ExecResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type Exec = (
	command: string,
	args: readonly string[],
	options?: { timeoutMs?: number; env?: Readonly<Record<string, string>> }
) => Promise<ExecResult>;

export type Status = 'pending' | 'pulling' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface StatusRow {
	readonly project: string;
	readonly name: string;
	readonly status: Status;
	readonly detail: string | null;
	readonly restarts: number;
}

export interface LogRow {
	readonly project: string;
	readonly name: string;
	readonly stream: 'stdout' | 'stderr';
	readonly message: string;
	/** Epoch milliseconds. */
	readonly at: number;
}

export interface RunnerOptions {
	readonly exec: Exec;
	/** `podman-remote` in the image; it reads CONTAINER_HOST. */
	readonly podman?: string;
	readonly systemctl?: string;
	readonly manifests: string;
	/** Where `status.json`, the log spool (`logs/`) and the short-lived files (`tmp/`) go. */
	readonly state: string;
	/** The addresses a container's host port is published on. */
	readonly bind: readonly string[];
	/** The /28s project networks are carved from. */
	readonly pool?: string;
	readonly now?: () => number;
	readonly log?: (message: string) => void;
}

const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const FAILED_AFTER = 5;
const HEALTHY_AFTER_MS = 60_000;
const PULL_TIMEOUT_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 2 * 60_000;
const MAX_LOG_LINES = 1000;
/** Spool files kept when nobody ships them: an hour of minutes, then the oldest go. */
const MAX_SPOOL_FILES = 60;
/** How often a working engine is asked again. A broken one is asked on every step. */
const ENGINE_RECHECK_MS = 5 * 60_000;

/** Names podman itself reads, refused for a multi-line value (which has to go through podman's environment). */
const PODMAN_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TMPDIR|XDG_[A-Z_]+|DBUS_[A-Z_]+|CONTAINER_[A-Z_]+|CONTAINERS_[A-Z_]+|PODMAN_[A-Z_]+|REGISTRY_AUTH_FILE|NOTIFY_SOCKET|SSL_CERT_[A-Z_]+|HTTPS?_PROXY|NO_PROXY)$/;

interface Actual {
	readonly id: string;
	readonly project: string;
	readonly name: string;
	readonly spec: string;
	readonly state: string;
	readonly exitCode: number;
}

interface Tracking {
	failures: number;
	nextAttemptAt: number;
	restarts: number;
	startedAt: number | null;
	detail: string | null;
}

function lastLines(text: string, count = 3): string {
	return text
		.split('\n')
		.map((line) => line.replace(/^\S+Z\s/, '').trim())
		.filter((line) => line && !/level=error.*(Netlink|delete --force)/.test(line))
		.slice(-count)
		.join(' | ')
		.slice(0, 600);
}

export function createRunner(options: RunnerOptions) {
	const podman = options.podman ?? 'podman-remote';
	const systemctl = options.systemctl ?? 'systemctl';
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const pool = options.pool ?? '10.95.0.0/16';
	const exec = options.exec;
	const tracking = new Map<string, Tracking>();
	const logCursor = new Map<string, number>();
	let engine: { ok: boolean; reason: string | null; at: number } | null = null;
	let lastStatus: StatusRow[] = [];

	function track(key: string): Tracking {
		let one = tracking.get(key);
		if (!one) {
			one = { failures: 0, nextAttemptAt: 0, restarts: 0, startedAt: null, detail: null };
			tracking.set(key, one);
		}
		return one;
	}

	function backoff(one: Tracking, detail: string): void {
		one.failures += 1;
		one.detail = detail;
		one.startedAt = null;
		one.nextAttemptAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (one.failures - 1));
	}

	/** Whether the service this runner talks to runs containers under gVisor. */
	async function checkEngine(): Promise<{ ok: boolean; reason: string | null }> {
		if (engine && engine.ok && now() - engine.at < ENGINE_RECHECK_MS) {
			return engine;
		}
		const info = await exec(podman, ['info', '--format', '{{.Host.OCIRuntime.Name}}'], { timeoutMs: 30_000 }).catch(
			(error: Error) => ({ code: 1, stdout: '', stderr: error.message })
		);
		const name = info.stdout.trim();
		engine =
			info.code !== 0
				? { ok: false, reason: `the container engine does not answer: ${lastLines(info.stderr, 1)}`, at: now() }
				: name !== RUNTIME
					? { ok: false, reason: `the container engine runs ${name || 'an unknown runtime'}, not ${RUNTIME}`, at: now() }
					: { ok: true, reason: null, at: now() };
		return engine;
	}

	async function list(): Promise<Actual[]> {
		const result = await exec(podman, ['ps', '--all', '--filter', `label=${LABEL}=1`, '--format', 'json']);
		if (result.code !== 0) {
			throw new Error(`podman ps failed: ${lastLines(result.stderr, 1)}`);
		}
		const rows = JSON.parse(result.stdout || '[]') as {
			Id?: string;
			Names?: string[];
			Labels?: Record<string, string>;
			State?: string;
			ExitCode?: number;
		}[];
		return rows.flatMap((row) => {
			const labels = row.Labels ?? {};
			const project = labels[LABEL_PROJECT];
			const name = labels[LABEL_NAME];
			if (!project || !name) {
				return [];
			}
			return [
				{
					id: row.Names?.[0] ?? row.Id ?? containerName(project, name),
					project,
					name,
					spec: labels[LABEL_SPEC] ?? '',
					state: String(row.State ?? 'unknown').toLowerCase(),
					exitCode: Number(row.ExitCode ?? 0)
				}
			];
		});
	}

	async function networks(): Promise<{ name: string; subnets: string[]; project: string | null }[]> {
		const result = await exec(podman, ['network', 'ls', '--format', 'json']);
		if (result.code !== 0) {
			throw new Error(`podman network ls failed: ${lastLines(result.stderr, 1)}`);
		}
		const rows = JSON.parse(result.stdout || '[]') as {
			name?: string;
			subnets?: { subnet?: string }[];
			labels?: Record<string, string>;
		}[];
		return rows.map((row) => ({
			name: String(row.name ?? ''),
			subnets: (row.subnets ?? []).map((s) => String(s.subnet ?? '')).filter(Boolean),
			project: row.labels?.[LABEL_PROJECT] ?? null
		}));
	}

	async function ensureNetwork(project: string, existing: { name: string; subnets: string[] }[]): Promise<void> {
		if (existing.some((network) => network.name === networkName(project))) {
			return;
		}
		const subnet = allocateSubnet(
			pool,
			existing.flatMap((network) => network.subnets)
		);
		const created = await exec(podman, networkArgs(project, subnet));
		if (created.code !== 0) {
			throw new Error(`could not make the project's network: ${lastLines(created.stderr, 1)}`);
		}
		existing.push({ name: networkName(project), subnets: [subnet.subnet] });
		log(`${project}: network ${networkName(project)} on ${subnet.subnet}`);
	}

	async function remove(container: Actual): Promise<void> {
		await exec(podman, ['rm', '--force', '--time', '10', container.id], { timeoutMs: RUN_TIMEOUT_MS });
		await exec(systemctl, ['--user', 'stop', sliceName(container.project, container.name)]).catch(() => undefined);
	}

	async function create(project: string, spec: ContainerSpec, limits: Limits, hash: string): Promise<void> {
		const tmp = join(options.state, 'tmp');
		await mkdir(tmp, { recursive: true, mode: 0o700 });
		const stamp = randomBytes(8).toString('hex');
		const authFile = join(tmp, `auth-${stamp}.json`);
		const envFile = join(tmp, `env-${stamp}`);
		try {
			const have = await exec(podman, ['image', 'exists', spec.image]);
			if (have.code !== 0) {
				const pull = ['pull', '--quiet'];
				if (spec.registry) {
					const auth = Buffer.from(`${spec.registry.username}:${spec.registry.password}`).toString('base64');
					await writeFile(authFile, JSON.stringify({ auths: { [registryOf(spec.image)]: { auth } } }), { mode: 0o600 });
					pull.push('--authfile', authFile);
				}
				pull.push(spec.image);
				const pulled = await exec(podman, pull, { timeoutMs: PULL_TIMEOUT_MS });
				if (pulled.code !== 0) {
					throw new Error(`could not pull ${spec.image}: ${lastLines(pulled.stderr, 2)}`);
				}
			}

			const slice = await exec(systemctl, sliceArgs(project, spec.name, limits));
			if (slice.code !== 0) {
				// Refused rather than started without limits: a container with no memory cap can take
				// the whole host down with it.
				throw new Error(`could not set the container's limits: ${lastLines(slice.stderr, 1)}`);
			}

			const fileLines: string[] = [];
			const passed: string[] = [];
			const passedEnv: Record<string, string> = {};
			for (const [key, value] of Object.entries(spec.env ?? {})) {
				if (!value.includes('\n')) {
					fileLines.push(`${key}=${value}`);
				} else if (PODMAN_ENV.test(key)) {
					throw new Error(`${key} holds several lines, and that name cannot be passed that way. Store it on one line.`);
				} else {
					passed.push(key);
					passedEnv[key] = value;
				}
			}
			await writeFile(envFile, `${fileLines.join('\n')}\n`, { mode: 0o600 });

			await exec(podman, ['rm', '--force', '--time', '10', containerName(project, spec.name)], { timeoutMs: RUN_TIMEOUT_MS });
			const ran = await exec(podman, runArgs({ project, spec, hash, bind: options.bind, envFile, passed }), {
				timeoutMs: RUN_TIMEOUT_MS,
				env: passedEnv
			});
			if (ran.code !== 0) {
				throw new Error(`could not start: ${lastLines(ran.stderr, 2)}`);
			}
		} finally {
			await rm(authFile, { force: true });
			await rm(envFile, { force: true });
		}
	}

	async function tail(id: string): Promise<string> {
		const out = await exec(podman, ['logs', '--tail', '5', id]).catch(() => null);
		return out ? lastLines(`${out.stdout}\n${out.stderr}`) : '';
	}

	async function writeStatus(rows: StatusRow[], errors: { project: string; reason: string }[], engineReason: string | null): Promise<void> {
		await mkdir(options.state, { recursive: true });
		const path = join(options.state, 'status.json');
		const scratch = `${path}.writing`;
		await writeFile(
			scratch,
			`${JSON.stringify({ updatedAt: new Date(now()).toISOString(), engine: engineReason ?? 'ok', errors, containers: rows }, null, '\t')}\n`
		);
		await rename(scratch, path);
	}

	async function step(): Promise<StatusRow[]> {
		const rows: StatusRow[] = [];
		const errors: { project: string; reason: string }[] = [];
		let engineReason: string | null = null;
		try {
			const reads = await readManifests(options.manifests);
			const wanted = new Map<string, ProjectManifest>();
			const broken = new Set<string>();
			for (const read of reads) {
				if (read.ok) {
					wanted.set(read.manifest.project, read.manifest);
				} else {
					broken.add(read.project);
					errors.push({ project: read.project, reason: read.reason });
				}
			}

			// The engine FIRST. Without it nothing below can be trusted to be what it says, so every
			// container asked for is reported failed with why, and podman is not touched at all.
			const check = await checkEngine();
			engineReason = check.reason;
			if (!check.ok) {
				for (const manifest of wanted.values()) {
					for (const spec of manifest.containers) {
						rows.push({
							project: manifest.project,
							name: spec.name,
							status: 'failed',
							detail: `This host cannot run containers yet: ${check.reason}.`,
							restarts: 0
						});
					}
				}
				lastStatus = rows;
				await writeStatus(rows, errors, engineReason).catch((error: Error) => log(`could not write status: ${error.message}`));
				return rows;
			}

			const actual = await list();

			// Whatever no manifest asks for goes, unless its manifest is merely unreadable this time.
			for (const container of actual) {
				const manifest = wanted.get(container.project);
				const keep = broken.has(container.project) || manifest?.containers.some((c) => c.name === container.name);
				if (!keep) {
					log(`${container.project}: removing ${container.name}`);
					await remove(container);
					tracking.delete(`${container.project}/${container.name}`);
				}
			}
			const nets = await networks();
			for (const network of nets) {
				if (network.project && !wanted.has(network.project) && !broken.has(network.project)) {
					await exec(podman, ['network', 'rm', '--force', network.name]);
					log(`${network.project}: network removed`);
				}
			}

			for (const manifest of wanted.values()) {
				for (const spec of manifest.containers) {
					const key = `${manifest.project}/${spec.name}`;
					const one = track(key);
					const base = { project: manifest.project, name: spec.name };
					const hash = specHash(manifest.project, spec, manifest.limits, options.bind);
					const current = actual.find((c) => c.project === manifest.project && c.name === spec.name);

					if (current && current.spec === hash && current.state === 'running') {
						if (one.startedAt === null) {
							one.startedAt = now();
						}
						if (one.failures > 0 && now() - one.startedAt >= HEALTHY_AFTER_MS) {
							one.failures = 0;
							one.detail = null;
						}
						rows.push({ ...base, status: 'running', detail: null, restarts: one.restarts });
						continue;
					}

					const crashed = Boolean(current && current.spec === hash);
					if (now() < one.nextAttemptAt) {
						rows.push({
							...base,
							status: crashed && one.failures < FAILED_AFTER ? 'restarting' : 'failed',
							detail: one.detail,
							restarts: one.restarts
						});
						continue;
					}
					if (crashed && current) {
						const printed = await tail(current.id);
						backoff(one, `exited with code ${current.exitCode}${printed ? `: ${printed}` : ''}`);
						one.restarts += 1;
					}
					try {
						await ensureNetwork(manifest.project, nets);
						await create(manifest.project, spec, manifest.limits, hash);
						one.startedAt = now();
						if (!crashed) {
							one.detail = null;
						}
						log(`${manifest.project}: started ${spec.name} (${spec.image})`);
						rows.push({
							...base,
							status: crashed ? (one.failures >= FAILED_AFTER ? 'failed' : 'restarting') : 'starting',
							detail: crashed ? one.detail : null,
							restarts: one.restarts
						});
					} catch (error) {
						const detail = error instanceof Error ? error.message : String(error);
						if (!crashed) {
							backoff(one, detail);
						} else {
							one.detail = `${one.detail}; could not start it again: ${detail}`;
						}
						log(`${manifest.project}: ${spec.name} did not start: ${detail}`);
						rows.push({ ...base, status: 'failed', detail: one.detail, restarts: one.restarts });
					}
				}
			}
			// Keep the last word for a project whose manifest did not read this time.
			for (const project of broken) {
				rows.push(...lastStatus.filter((row) => row.project === project));
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			log(`could not reconcile: ${reason}`);
			// Said in the status rather than hidden behind the last good one, and the engine is asked
			// again on the next step rather than trusted for five minutes.
			engineReason = engineReason ?? `the runner could not reconcile: ${reason}`;
			engine = null;
			rows.push(...lastStatus);
		}
		lastStatus = rows;
		await writeStatus(rows, errors, engineReason).catch((error: Error) => log(`could not write status: ${error.message}`));
		return rows;
	}

	async function collectLogs(): Promise<LogRow[]> {
		const rows: LogRow[] = [];
		try {
			const actual = await list();
			for (const container of actual) {
				const since = logCursor.get(container.id) ?? now() - 60_000;
				const out = await exec(podman, ['logs', '--timestamps', '--since', new Date(since).toISOString(), container.id]);
				if (out.code !== 0) {
					continue;
				}
				const lines: LogRow[] = [];
				for (const [stream, text] of [
					['stdout', out.stdout],
					['stderr', out.stderr]
				] as const) {
					for (const line of text.split('\n')) {
						const match = /^(\S+Z)\s(.*)$/.exec(line);
						if (!match) {
							continue;
						}
						const at = Date.parse(match[1] ?? '');
						if (Number.isNaN(at) || at <= since) {
							continue;
						}
						lines.push({ project: container.project, name: container.name, stream, message: match[2] ?? '', at });
					}
				}
				lines.sort((a, b) => a.at - b.at);
				const kept = lines.slice(-MAX_LOG_LINES);
				logCursor.set(container.id, kept.at(-1)?.at ?? since);
				rows.push(...kept);
			}
			for (const id of [...logCursor.keys()]) {
				if (!actual.some((c) => c.id === id)) {
					logCursor.delete(id);
				}
			}
			if (rows.length > 0) {
				const spool = join(options.state, 'logs');
				await mkdir(spool, { recursive: true });
				const name = `${String(now()).padStart(15, '0')}-${randomBytes(4).toString('hex')}.jsonl`;
				await writeFile(join(spool, `${name}.writing`), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
				await rename(join(spool, `${name}.writing`), join(spool, name));
				const files = (await readdir(spool)).filter((f) => f.endsWith('.jsonl')).sort();
				for (const old of files.slice(0, Math.max(0, files.length - MAX_SPOOL_FILES))) {
					await rm(join(spool, old), { force: true });
				}
			}
		} catch (error) {
			log(`could not collect logs: ${error instanceof Error ? error.message : String(error)}`);
		}
		return rows;
	}

	/** Why the engine cannot be used, as of the last step; null when it can. */
	function engineReason(): string | null {
		return engine === null ? 'not checked yet' : engine.reason;
	}

	return { step, collectLogs, engineReason };
}
