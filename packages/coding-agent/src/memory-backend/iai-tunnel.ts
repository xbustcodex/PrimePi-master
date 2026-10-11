/**
 * Supervision for the Windows → Ubuntu SSH tunnel backing the IAI bridge.
 *
 * The bridge itself only ever listens on loopback; this module forwards a
 * Windows loopback port to it over an authenticated SSH connection using the
 * dedicated `buster_iai` identity. Bearer authentication stays enabled
 * end-to-end: the tunnel provides transport privacy, not authorization.
 *
 * Process handling is dependency-injected (`TunnelDeps`) so supervision
 * policy — duplicate prevention, bounded backoff, clean shutdown — is
 * unit-testable without spawning real SSH processes.
 */
import * as net from "node:net";
import { unlink } from "node:fs/promises";

export interface IaiTunnelOptions {
	sshPath?: string;
	identityFile: string;
	user: string;
	host: string;
	/** Windows-side bind. Loopback only — never expose the forward. */
	localHost: string;
	localPort: number;
	remoteHost: string;
	remotePort: number;
	/** File holding the supervisor-owned ssh pid. */
	pidFile: string;
	connectTimeoutSec?: number;
}

export interface TunnelProcess {
	pid: number;
}

export interface TunnelDeps {
	spawn(argv: string[], pidFile: string): TunnelProcess;
	isAlive(pid: number): boolean;
	probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	readPidFile(path: string): Promise<number | undefined>;
	writePidFile(path: string, pid: number): Promise<void>;
	removePidFile(path: string): Promise<void>;
}

export const TUNNEL_MAX_ATTEMPTS = 5;
export const TUNNEL_BASE_BACKOFF_MS = 1000;
export const TUNNEL_MAX_BACKOFF_MS = 16_000;

/** Bounded exponential backoff schedule (1s, 2s, 4s, 8s, 16s). */
export function backoffDelays(attempts: number, baseMs = TUNNEL_BASE_BACKOFF_MS): number[] {
	const out: number[] = [];
	let delay = baseMs;
	for (let i = 0; i < attempts; i++) {
		out.push(Math.min(delay, TUNNEL_MAX_BACKOFF_MS));
		delay *= 2;
	}
	return out;
}

/** True for loopback binds only. */
export function isLoopbackBind(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** ssh argv for a non-interactive, host-verified local forward. */
export function tunnelArgs(options: IaiTunnelOptions): string[] {
	const ssh = options.sshPath ?? "ssh";
	return [
		ssh,
		"-N",
		"-o",
		"BatchMode=yes",
		"-o",
		`ConnectTimeout=${options.connectTimeoutSec ?? 15}`,
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-i",
		options.identityFile,
		"-L",
		`${options.localHost}:${options.localPort}:${options.remoteHost}:${options.remotePort}`,
		`${options.user}@${options.host}`,
	];
}

export type TunnelStartResult = { status: "started"; pid: number } | { status: "already-running"; pid: number };

/**
 * Ensure exactly one supervised tunnel: refuse when a live pid owns the
 * pid file, otherwise spawn with bounded backoff and verify the forward
 * accepts connections before reporting success.
 */
export async function ensureTunnel(
	deps: TunnelDeps,
	options: IaiTunnelOptions,
	maxAttempts = TUNNEL_MAX_ATTEMPTS,
): Promise<TunnelStartResult> {
	if (!isLoopbackBind(options.localHost)) {
		throw new Error("Tunnel local bind must be loopback.");
	}
	const existing = await deps.readPidFile(options.pidFile);
	if (existing !== undefined && deps.isAlive(existing)) {
		return { status: "already-running", pid: existing };
	}
	if (existing !== undefined) await deps.removePidFile(options.pidFile);

	const delays = backoffDelays(maxAttempts);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const proc = deps.spawn(tunnelArgs(options), options.pidFile);
		await deps.writePidFile(options.pidFile, proc.pid);
		const reachable = await deps.probeTcp(options.localHost, options.localPort, 5000);
		if (reachable && deps.isAlive(proc.pid)) return { status: "started", pid: proc.pid };
		await deps.removePidFile(options.pidFile);
		if (attempt + 1 < maxAttempts) await deps.sleep(delays[attempt] ?? TUNNEL_BASE_BACKOFF_MS);
	}
	throw new Error(`SSH tunnel failed after ${maxAttempts} attempts.`);
}

/** Stop the supervised tunnel and release the pid file. */
export async function stopTunnel(deps: TunnelDeps, pidFile: string, kill: (pid: number) => void): Promise<boolean> {
	const pid = await deps.readPidFile(pidFile);
	if (pid === undefined) return false;
	try {
		if (deps.isAlive(pid)) kill(pid);
	} finally {
		await deps.removePidFile(pidFile);
	}
	return true;
}

/** Real dependency implementation (Bun/Node runtime). */
export const nodeTunnelDeps: TunnelDeps = {
	spawn(argv: string[]): TunnelProcess {
		const [cmd, ...args] = argv;
		const child = Bun.spawn([cmd ?? "ssh", ...args], {
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
		return { pid: child.pid };
	},
	isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const socket = net.createConnection({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		socket.on("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		return promise;
	},
	async sleep(ms: number): Promise<void> {
		await Bun.sleep(ms);
	},
	async readPidFile(path: string): Promise<number | undefined> {
		try {
			const raw = (await Bun.file(path).text()).trim();
			const pid = Number.parseInt(raw, 10);
			return Number.isInteger(pid) && pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	},
	async writePidFile(path: string, pid: number): Promise<void> {
		await Bun.write(path, `${pid}\n`);
	},
	async removePidFile(path: string): Promise<void> {
		try {
			await unlink(path);
		} catch {
			// Already gone.
		}
	},
};
