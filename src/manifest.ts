/**
 * The manifest directory: what the runner is told to run.
 *
 * One file per project, `<project>.json`, written whole (a writer renames a finished file into
 * place, so the runner never reads half of one). A project with no file has nothing running: its
 * containers and its network are removed. In SnoutData Cloud the host agent writes these from the
 * control plane; anywhere else a person or a script does.
 *
 *     {
 *       "project": "acme",
 *       "limits": { "memoryMb": 256, "cpuPercent": 50 },
 *       "containers": [
 *         { "name": "whatsapp", "image": "ghcr.io/acme/wa@sha256:…", "port": 8080, "hostPort": 46432,
 *           "env": { "DATABASE_URL": "…" }, "registry": { "username": "…", "password": "…" } }
 *       ],
 *       "egress": { "allow": [{ "destination": "api.example.com", "ports": [443] }, { "destination": "203.0.113.0/24", "ports": [] }] }
 *     }
 *
 * `egress` is optional. Without it a container reaches the public internet (within the limits);
 * with it, only the destinations it lists, a host name, an IPv4 address or an IPv4 range, on the
 * ports it lists (none: any port). An empty `allow` reaches nothing outside the project.
 *
 * A file that does not parse, or breaks a rule, is skipped with its reason and the project's
 * containers are left exactly as they were: a typo must never stop a running container.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isContainerName, isProjectName, normaliseCidr, type ContainerSpec, type Limits } from './recipe.js';

/** One destination of a project's allowlist, as the manifest says it. */
export interface AllowEntry {
	/** A host name, an IPv4 address, or an IPv4 range (`a.b.c.d/n`). */
	readonly destination: string;
	/** The ports it may be reached on; empty means any. */
	readonly ports: readonly number[];
}

export interface ProjectManifest {
	readonly project: string;
	readonly limits: Limits;
	readonly containers: readonly ContainerSpec[];
	/** Where its containers may send, when the project restricts it; null when it does not. */
	readonly egress: { readonly allow: readonly AllowEntry[] } | null;
}

/** The most entries an allowlist holds, and ports one entry names. */
export const MAX_ALLOW = 64;
export const MAX_ALLOW_PORTS = 16;

const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/;

/** Whether a destination is an IPv4 address or range (true), a host name (false), or neither (null). */
export function destinationKind(destination: string): 'address' | 'name' | null {
	if (IPV4.test(destination)) {
		try {
			normaliseCidr(destination);
			return 'address';
		} catch {
			return null;
		}
	}
	return HOST_NAME.test(destination) ? 'name' : null;
}

function checkEgress(value: unknown): { ok: true; egress: ProjectManifest['egress'] } | { ok: false; reason: string } {
	if (value === undefined || value === null) {
		return { ok: true, egress: null };
	}
	const allow = (value as { allow?: unknown }).allow;
	if (typeof value !== 'object' || !Array.isArray(allow)) {
		return { ok: false, reason: 'egress is { "allow": [ … ] }' };
	}
	if (allow.length > MAX_ALLOW) {
		return { ok: false, reason: `egress.allow holds at most ${MAX_ALLOW} destinations` };
	}
	const entries: AllowEntry[] = [];
	for (const item of allow as Record<string, unknown>[]) {
		const destination = String(item?.destination ?? '').trim().toLowerCase();
		if (!destinationKind(destination)) {
			return { ok: false, reason: `egress: ${JSON.stringify(item?.destination)} is not a host name, an IPv4 address or an IPv4 range` };
		}
		const ports = item.ports === undefined ? [] : item.ports;
		if (!Array.isArray(ports) || ports.length > MAX_ALLOW_PORTS || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
			return { ok: false, reason: `egress: ${destination}'s ports are up to ${MAX_ALLOW_PORTS} whole numbers, 1 to 65535` };
		}
		entries.push({ destination, ports: [...new Set(ports as number[])].sort((a, b) => a - b) });
	}
	return { ok: true, egress: { allow: entries } };
}

export type Read = { ok: true; manifest: ProjectManifest } | { ok: false; project: string; reason: string };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Check one parsed file. Every refusal is a sentence. */
export function checkManifest(fileProject: string, value: unknown): Read {
	const fail = (reason: string): Read => ({ ok: false, project: fileProject, reason });
	if (typeof value !== 'object' || value === null) {
		return fail('the file is not a JSON object');
	}
	const raw = value as Record<string, unknown>;
	if (raw.project !== fileProject) {
		return fail(`the file is ${fileProject}.json and names the project ${JSON.stringify(raw.project)}`);
	}
	const limits = raw.limits as Record<string, unknown> | undefined;
	const memoryMb = Number(limits?.memoryMb);
	const cpuPercent = Number(limits?.cpuPercent);
	if (!Number.isInteger(memoryMb) || memoryMb < 32 || memoryMb > 65536) {
		return fail('limits.memoryMb is a whole number of megabytes, 32 to 65536');
	}
	if (!Number.isInteger(cpuPercent) || cpuPercent < 1 || cpuPercent > 6400) {
		return fail('limits.cpuPercent is a whole percentage of one core, 1 to 6400');
	}
	if (!Array.isArray(raw.containers)) {
		return fail('containers is a list');
	}
	const containers: ContainerSpec[] = [];
	const names = new Set<string>();
	const ports = new Set<number>();
	for (const item of raw.containers as Record<string, unknown>[]) {
		const name = String(item?.name ?? '');
		if (!isContainerName(name)) {
			return fail(`${JSON.stringify(name)} is not a container name (lower-case letters, digits, - and _, up to 32)`);
		}
		if (names.has(name)) {
			return fail(`two containers are called ${name}`);
		}
		names.add(name);
		const image = String(item.image ?? '');
		if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/.test(image)) {
			return fail(`${name}: ${JSON.stringify(image)} is not an image reference`);
		}
		const port = Number(item.port ?? 8080);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return fail(`${name}: port is 1 to 65535`);
		}
		const hostPort = item.hostPort === undefined || item.hostPort === null ? null : Number(item.hostPort);
		if (hostPort !== null && (!Number.isInteger(hostPort) || hostPort < 1024 || hostPort > 65535)) {
			return fail(`${name}: hostPort is 1024 to 65535, or absent`);
		}
		if (hostPort !== null && ports.has(hostPort)) {
			return fail(`${name}: hostPort ${hostPort} is taken by another container of this project`);
		}
		if (hostPort !== null) {
			ports.add(hostPort);
		}
		const env: Record<string, string> = {};
		for (const [key, envValue] of Object.entries((item.env ?? {}) as Record<string, unknown>)) {
			if (!ENV_NAME.test(key) || typeof envValue !== 'string') {
				return fail(`${name}: env ${JSON.stringify(key)} is not a name with a string value`);
			}
			env[key] = envValue;
		}
		if (!('PORT' in env)) {
			env.PORT = String(port);
		}
		const registry = item.registry as Record<string, unknown> | null | undefined;
		if (registry && (typeof registry.username !== 'string' || typeof registry.password !== 'string')) {
			return fail(`${name}: registry is a username and a password`);
		}
		containers.push({
			name,
			image,
			port,
			hostPort,
			restartGeneration: Number.isInteger(item.restartGeneration) ? Number(item.restartGeneration) : 0,
			registry: registry ? { username: String(registry.username), password: String(registry.password) } : null,
			env
		});
	}
	const egress = checkEgress(raw.egress);
	if (!egress.ok) {
		return fail(egress.reason);
	}
	return { ok: true, manifest: { project: fileProject, limits: { memoryMb, cpuPercent }, containers, egress: egress.egress } };
}

/** Every `<project>.json` in the directory. A missing directory is an empty one. */
export async function readManifests(directory: string): Promise<Read[]> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch {
		return [];
	}
	const out: Read[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith('.json')) {
			continue;
		}
		const project = entry.slice(0, -5);
		if (!isProjectName(project)) {
			out.push({ ok: false, project, reason: `${entry} is not a project name (lower-case letters and digits)` });
			continue;
		}
		try {
			out.push(checkManifest(project, JSON.parse(await readFile(join(directory, entry), 'utf8'))));
		} catch (error) {
			out.push({ ok: false, project, reason: `${entry} is not JSON: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	return out;
}
