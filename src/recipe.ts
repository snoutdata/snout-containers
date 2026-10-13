/**
 * How a container is run: the names, the network, the limits and the `podman` arguments.
 *
 * Pure. Everything here is a value in and arguments out, so the runner's tests can check the exact
 * command a host will run without a host.
 *
 * ## The engine this assumes
 *
 * The runner talks to a podman service of its own (`CONTAINER_HOST`) whose `containers.conf` makes
 * every container it creates run under the runtime `runsc-snoutct` (gVisor with `--ignore-cgroups
 * --network=host`) in a user namespace of its own (`userns = "auto"`). That is why no runtime and no
 * user namespace appear in the arguments below: podman's remote API accepts neither per container,
 * so they are the service's defaults, and the runner checks the service's runtime before it runs
 * anything (`runner.ts`). README.md, "The engine", is how a host gets it.
 *
 * ## Limits come from a systemd slice, made before the container
 *
 * With `--ignore-cgroups` gVisor creates no cgroup of its own; the whole sandbox lives in the scope
 * podman makes for conmon, and `--cgroup-parent` puts that scope in the container's slice. The slice
 * carries `MemoryMax`, `CPUQuota` and `TasksMax`, set before the container starts.
 *
 * ## A network per project
 *
 * Containers on one bridge reach each other, so two projects never share one. Each project gets
 * `snoutct-<project>` with a /28 of its own from the pool, its gateway at `.1`, and every private
 * range routed to a sink address on the bridge where the packet dies: the instance metadata
 * service, the host's VPC and every other project's /28 are unreachable, the project's own
 * containers and the public internet are not.
 */

import { createHash } from 'node:crypto';

/** A project's name: lower-case letters and digits. A container, network and unit name are built from it. */
const PROJECT = /^[a-z0-9]{1,40}$/;
/** A container's name: a URL segment and part of a container name. */
const CONTAINER = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isProjectName(value: string): boolean {
	return PROJECT.test(value);
}

export function isContainerName(value: string): boolean {
	return CONTAINER.test(value);
}

/** The label on everything this runner makes, and the ones that say whose it is. */
export const LABEL = 'io.snoutdata.container';
export const LABEL_PROJECT = 'io.snoutdata.container.ref';
export const LABEL_NAME = 'io.snoutdata.container.name';
export const LABEL_SPEC = 'io.snoutdata.container.spec';

/** The runtime the engine's service must report, or nothing runs. */
export const RUNTIME = 'runsc-snoutct';

export function containerName(project: string, name: string): string {
	return `snoutct-${project}-${name}`;
}

export function networkName(project: string): string {
	return `snoutct-${project}`;
}

/**
 * The container's slice. A hyphen in a slice's name means "child of", so the container's own name
 * (which may hold hyphens) is hashed rather than written in.
 */
export function sliceName(project: string, name: string): string {
	const tag = createHash('sha256').update(name).digest('hex').slice(0, 10);
	return `snoutct-${project}-c${tag}.slice`;
}

// ------------------------------------------------------------------------------
// Addresses
// ------------------------------------------------------------------------------

function toNumber(address: string): number {
	const parts = address.split('.').map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		throw new Error(`not an IPv4 address: ${address}`);
	}
	return ((parts[0] as number) * 2 ** 24 + (parts[1] as number) * 2 ** 16 + (parts[2] as number) * 2 ** 8 + (parts[3] as number)) >>> 0;
}

function toAddress(value: number): string {
	return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join('.');
}

export function parseCidr(cidr: string): { base: number; bits: number } {
	const [address, bits] = cidr.split('/');
	const size = Number(bits);
	if (!address || !Number.isInteger(size) || size < 0 || size > 32) {
		throw new Error(`not an IPv4 CIDR: ${cidr}`);
	}
	const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
	return { base: (toNumber(address) & mask) >>> 0, bits: size };
}

/** The ranges every container network sends to its sink. */
export const PRIVATE_PREFIXES = ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] as const;

export interface ProjectSubnet {
	readonly subnet: string;
	readonly gateway: string;
	/** The last usable address, held by nothing: denied traffic is routed here and dies. */
	readonly sink: string;
}

/**
 * The first /28 in `pool` that no existing network holds. Throws when the pool is full, which on a
 * /16 is 4,096 projects on one host.
 */
export function allocateSubnet(pool: string, taken: readonly string[]): ProjectSubnet {
	const { base, bits } = parseCidr(pool);
	if (bits > 28) {
		throw new Error(`the pool ${pool} is smaller than one /28`);
	}
	const used = new Set(taken.flatMap((cidr) => {
		try {
			return [parseCidr(cidr).base];
		} catch {
			return [];
		}
	}));
	const count = 2 ** (28 - bits);
	for (let i = 0; i < count; i++) {
		const start = (base + i * 16) >>> 0;
		if (!used.has(start)) {
			return { subnet: `${toAddress(start)}/28`, gateway: toAddress(start + 1), sink: toAddress(start + 14) };
		}
	}
	throw new Error(`no free /28 left in ${pool}`);
}

/** `podman network create` for a project's network, with the deny routes. */
export function networkArgs(project: string, subnet: ProjectSubnet): string[] {
	const args = ['network', 'create', '--subnet', subnet.subnet, '--gateway', subnet.gateway];
	for (const prefix of PRIVATE_PREFIXES) {
		args.push('--route', `${prefix},${subnet.sink}`);
	}
	args.push('--label', `${LABEL}=1`, '--label', `${LABEL_PROJECT}=${project}`, networkName(project));
	return args;
}

// ------------------------------------------------------------------------------
// The container
// ------------------------------------------------------------------------------

export interface Limits {
	readonly memoryMb: number;
	readonly cpuPercent: number;
}

export interface ContainerSpec {
	readonly name: string;
	/** `registry/repository@sha256:…` ideally; a tag is accepted and pulled as it is. */
	readonly image: string;
	/** The port the image listens on, also given to it as PORT unless env sets one. */
	readonly port: number;
	/** Where it is published on the host. Null: not published (it reaches out, nothing reaches in). */
	readonly hostPort: number | null;
	/** Bumped to make a container again from its image. */
	readonly restartGeneration?: number;
	readonly registry?: { readonly username: string; readonly password: string } | null;
	readonly env?: Readonly<Record<string, string>>;
}

/** `systemctl --user set-property` for the container's slice. */
export function sliceArgs(project: string, name: string, limits: Limits): string[] {
	return [
		'--user',
		'set-property',
		'--runtime',
		sliceName(project, name),
		`MemoryMax=${limits.memoryMb}M`,
		'MemorySwapMax=0',
		`CPUQuota=${limits.cpuPercent}%`,
		'TasksMax=512'
	];
}

/** Everything the container is made from, hashed: equal and running means nothing to do. */
export function specHash(project: string, spec: ContainerSpec, limits: Limits, bind: readonly string[]): string {
	const env = Object.keys(spec.env ?? {})
		.sort()
		.map((key) => [key, spec.env?.[key]]);
	return createHash('sha256')
		.update(
			JSON.stringify([
				'snoutct-1',
				project,
				spec.name,
				spec.image,
				spec.port,
				spec.hostPort,
				spec.restartGeneration ?? 0,
				limits.memoryMb,
				limits.cpuPercent,
				bind,
				env
			])
		)
		.digest('hex')
		.slice(0, 32);
}

/** `podman run`, without the env file's path and the names passed by environment. */
export function runArgs(input: {
	project: string;
	spec: ContainerSpec;
	hash: string;
	bind: readonly string[];
	envFile: string;
	passed: readonly string[];
}): string[] {
	const { project, spec } = input;
	const args = [
		'run',
		'--detach',
		'--name',
		containerName(project, spec.name),
		'--hostname',
		spec.name,
		'--label',
		`${LABEL}=1`,
		'--label',
		`${LABEL_PROJECT}=${project}`,
		'--label',
		`${LABEL_NAME}=${spec.name}`,
		'--label',
		`${LABEL_SPEC}=${input.hash}`,
		'--cgroup-parent',
		sliceName(project, spec.name),
		'--network',
		networkName(project),
		'--log-driver',
		'k8s-file',
		'--log-opt',
		'max-size=5mb',
		'--stop-timeout',
		'10'
	];
	if (spec.hostPort !== null) {
		for (const address of input.bind) {
			args.push('--publish', `${address}:${spec.hostPort}:${spec.port}`);
		}
	}
	args.push('--env-file', input.envFile);
	for (const name of input.passed) {
		args.push('--env', name);
	}
	args.push(spec.image);
	return args;
}

/** The registry an image is pulled from, as an auth file keys it. */
export function registryOf(image: string): string {
	const first = image.split('/')[0] ?? '';
	if (image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
		return first.toLowerCase();
	}
	return 'docker.io';
}
