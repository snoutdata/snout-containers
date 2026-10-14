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
 * Egress (recipe.ts, `egressRuleset`): before anything is made, the host's firewall must hold the
 * table that limits what containers send. It is checked every minute and after every container
 * made (the network namespace it lives in can be made again under it), and applied when missing or
 * different. With `egress.enforce` (the default) nothing new starts while it cannot be applied;
 * running containers are left running. Once a minute its counters are read, and each container's
 * row carries what it sent, opened, was refused and was throttled in the last hour.
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
	EGRESS_POLICY,
	EGRESS_TABLE,
	egressFingerprint,
	egressRuleset,
	NO_EGRESS,
	parseEgress,
	type EgressCounters,
	type EgressPolicy,
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
	options?: { timeoutMs?: number; env?: Readonly<Record<string, string>>; input?: string }
) => Promise<ExecResult>;

export type Status = 'pending' | 'pulling' | 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface StatusRow {
	readonly project: string;
	readonly name: string;
	readonly status: Status;
	readonly detail: string | null;
	readonly restarts: number;
	/** What it sent in the last hour; absent when egress is not measured on this host. */
	readonly egress?: EgressCounters;
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
	/**
	 * The limits on what containers send. `false` leaves the host's firewall alone (a host whose
	 * engine is not rootless podman, where the table has nowhere to go); `enforce` refuses to start
	 * a container while the limits cannot be put in place.
	 */
	readonly egress?: false | { readonly enforce: boolean; readonly policy?: EgressPolicy };
	/**
	 * How `nft` is run in the network namespace the containers' bridges live in: rootless podman's,
	 * reached through the host user's systemd (the runner is in a container of its own). The script
	 * gets nft's arguments as "$@", and the ruleset on stdin.
	 */
	readonly systemdRun?: string;
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
/** How often the egress table is checked, and its counters read. */
const EGRESS_EVERY_MS = 60_000;
/** How often a table that could not be applied is tried again. */
const EGRESS_RETRY_MS = 15_000;
/** The window a container's egress is summed over. */
const EGRESS_WINDOW_MS = 60 * 60_000;
/**
 * Run on the HOST as its user, by systemd: rootless podman's network namespace, then nft. A shell,
 * because systemd-run looks for the executable in the runner's own filesystem before sending the
 * name to the host's, and /bin/sh is in both.
 */
const NFT_ON_HOST = 'exec podman unshare --rootless-netns /usr/sbin/nft "$@"';

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
	const systemdRun = options.systemdRun ?? 'systemd-run';
	const egressOptions = options.egress === undefined ? { enforce: true } : options.egress;
	const policy = (egressOptions && egressOptions.policy) || EGRESS_POLICY;
	const tracking = new Map<string, Tracking>();
	const logCursor = new Map<string, number>();
	let engine: { ok: boolean; reason: string | null; at: number } | null = null;
	let lastStatus: StatusRow[] = [];
	let egress: { ok: boolean; reason: string | null; at: number } | null = null;
	/** The counters as last read, by address, and what each container sent minute by minute. */
	let lastCounters = new Map<string, EgressCounters>();
	let lastMeasured = 0;
	const sent = new Map<string, { at: number; delta: EgressCounters }[]>();

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

	function nft(args: readonly string[], input?: string): Promise<ExecResult> {
		return exec(
			systemdRun,
			['--user', '--pipe', '--wait', '--quiet', '--collect', '--', '/bin/sh', '-c', NFT_ON_HOST, 'nft', ...args],
			{ timeoutMs: 60_000, input }
		).catch((error: Error) => ({ code: 1, stdout: '', stderr: error.message }));
	}

	/**
	 * Whether the egress table is in place, applying it when it is missing or different. Returns the
	 * counters it read, or null when it could not read them.
	 */
	async function ensureEgress(force = false): Promise<Map<string, EgressCounters> | null> {
		if (!egressOptions) {
			return null;
		}
		if (!force && egress && now() - egress.at < (egress.ok ? EGRESS_EVERY_MS : EGRESS_RETRY_MS)) {
			return null;
		}
		const want = egressFingerprint(pool, policy);
		const read = await nft(['-j', 'list', 'table', 'inet', EGRESS_TABLE]);
		const parsed = read.code === 0 ? parseEgress(read.stdout) : null;
		if (parsed && parsed.fingerprint === want) {
			egress = { ok: true, reason: null, at: now() };
			return parsed.counters;
		}
		const applied = await nft(['-f', '-'], egressRuleset(pool, policy));
		if (applied.code !== 0) {
			egress = { ok: false, reason: `the limits on what containers send could not be put in place: ${lastLines(applied.stderr, 1) || `exit ${applied.code}`}`, at: now() };
			log(egress.reason as string);
			return null;
		}
		log(parsed ? 'egress limits changed; applied again' : 'egress limits applied');
		egress = { ok: true, reason: null, at: now() };
		// A new table counts from zero.
		lastCounters = new Map();
		return new Map();
	}

	/** Each running container's address on its project's network. */
	async function addresses(containers: readonly Actual[]): Promise<Map<string, string>> {
		const found = new Map<string, string>();
		const running = containers.filter((c) => c.state === 'running');
		if (running.length === 0) {
			return found;
		}
		const out = await exec(podman, ['inspect', '--format', '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', ...running.map((c) => c.id)]);
		for (const line of out.stdout.split('\n')) {
			const [id, address] = line.trim().split(/\s+/);
			const container = running.find((c) => c.id === id);
			if (container && address) {
				found.set(`${container.project}/${container.name}`, address);
			}
		}
		return found;
	}

	/** Attributes what the counters moved since the last read to the containers holding each address. */
	function account(counters: Map<string, EgressCounters>, holders: Map<string, string>): void {
		const at = now();
		for (const [key, address] of holders) {
			const current = counters.get(address) ?? NO_EGRESS;
			const before = lastCounters.get(address) ?? NO_EGRESS;
			const reset = (Object.keys(current) as (keyof EgressCounters)[]).some((field) => current[field] < before[field]);
			const base = reset ? NO_EGRESS : before;
			const delta: EgressCounters = {
				sentBytes: current.sentBytes - base.sentBytes,
				sentPackets: current.sentPackets - base.sentPackets,
				opened: current.opened - base.opened,
				refused: current.refused - base.refused,
				throttledBytes: current.throttledBytes - base.throttledBytes
			};
			const samples = sent.get(key) ?? [];
			samples.push({ at, delta });
			sent.set(key, samples);
		}
		for (const [key, samples] of sent) {
			const kept = samples.filter((sample) => at - sample.at < EGRESS_WINDOW_MS);
			if (kept.length === 0) {
				sent.delete(key);
			} else {
				sent.set(key, kept);
			}
		}
		lastCounters = counters;
	}

	function lastHour(key: string): EgressCounters | undefined {
		if (!egressOptions) {
			return undefined;
		}
		const total = { ...NO_EGRESS };
		for (const { delta } of sent.get(key) ?? []) {
			total.sentBytes += delta.sentBytes;
			total.sentPackets += delta.sentPackets;
			total.opened += delta.opened;
			total.refused += delta.refused;
			total.throttledBytes += delta.throttledBytes;
		}
		return total;
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

	/** Why containers may not start for want of the egress limits; null when they may. */
	function fence(): string | null {
		if (!egressOptions || !egressOptions.enforce || egress?.ok) {
			return null;
		}
		return egress?.reason ?? 'the limits on what containers send have not been checked yet';
	}

	async function writeStatus(rows: StatusRow[], errors: { project: string; reason: string }[], engineReason: string | null): Promise<void> {
		await mkdir(options.state, { recursive: true });
		const path = join(options.state, 'status.json');
		const scratch = `${path}.writing`;
		await writeFile(
			scratch,
			`${JSON.stringify(
				{
					updatedAt: new Date(now()).toISOString(),
					engine: engineReason ?? 'ok',
					egress: !egressOptions ? 'off' : (egress?.reason ?? (egress ? 'ok' : 'not checked yet')),
					errors,
					containers: rows
				},
				null,
				'\t'
			)}\n`
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

			// The egress limits, and once a minute what each container sent.
			const measure = Boolean(egressOptions) && now() - lastMeasured >= EGRESS_EVERY_MS;
			const counters = await ensureEgress(measure);
			if (measure) {
				lastMeasured = now();
				if (counters) {
					account(counters, await addresses(actual));
				}
			}
			let made = false;

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
					const base = { project: manifest.project, name: spec.name, egress: lastHour(key) };
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
					const fenced = fence();
					if (fenced) {
						rows.push({ ...base, status: 'failed', detail: `This host cannot start containers right now: ${fenced}.`, restarts: one.restarts });
						continue;
					}
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
						made = true;
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
			// A container made may have made the network namespace the table lives in, so it is
			// looked at again rather than in a minute.
			if (made) {
				await ensureEgress(true);
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

	/** Why new containers cannot start for want of the egress limits; null when they can. */
	function egressReason(): string | null {
		return fence();
	}

	return { step, collectLogs, engineReason, egressReason };
}
