import { describe, expect, it } from "bun:test";
import {
	backoffDelays,
	ensureTunnel,
	isLoopbackBind,
	stopTunnel,
	tunnelArgs,
	type IaiTunnelOptions,
	type TunnelDeps,
} from "../../src/memory-backend/iai-tunnel";

function baseOptions(): IaiTunnelOptions {
	return {
		identityFile: "C:\\key\\buster_iai",
		user: "adzs",
		host: "192.168.1.104",
		localHost: "127.0.0.1",
		localPort: 18420,
		remoteHost: "127.0.0.1",
		remotePort: 8420,
		pidFile: "tunnel.pid",
	};
}

function fakeDeps(overrides: Partial<TunnelDeps> & { pids?: Map<string, number> } = {}): TunnelDeps & {
	spawns: string[][];
	sleeps: number[];
	files: Map<string, string>;
	live: Set<number>;
} {
	const files = new Map<string, string>();
	const live = new Set<number>();
	const spawns: string[][] = [];
	const sleeps: number[] = [];
	let nextPid = 1000;
	return {
		files,
		live,
		spawns,
		sleeps,
		spawn(argv: string[]) {
			spawns.push(argv);
			const pid = nextPid++;
			live.add(pid);
			return { pid };
		},
		isAlive: (pid: number) => live.has(pid),
		probeTcp: async () => true,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		readPidFile: async (path: string) => {
			const raw = files.get(path);
			if (raw === undefined) return undefined;
			const pid = Number.parseInt(raw, 10);
			return Number.isInteger(pid) ? pid : undefined;
		},
		writePidFile: async (path: string, pid: number) => {
			files.set(path, `${pid}\n`);
		},
		removePidFile: async (path: string) => {
			files.delete(path);
		},
		...overrides,
	};
}

describe("iai tunnel supervision", () => {
	it("builds a non-interactive, host-verified forward on loopback", () => {
		const argv = tunnelArgs(baseOptions());
		expect(argv).toContain("-N");
		expect(argv).toContain("BatchMode=yes");
		expect(argv).toContain("StrictHostKeyChecking=yes");
		expect(argv).toContain("ExitOnForwardFailure=yes");
		expect(argv).toContain("127.0.0.1:18420:127.0.0.1:8420");
		expect(argv).toContain("adzs@192.168.1.104");
		expect(argv.join(" ")).not.toContain("0.0.0.0");
	});

	it("refuses non-loopback local binds", () => {
		expect(isLoopbackBind("127.0.0.1")).toBe(true);
		expect(isLoopbackBind("0.0.0.0")).toBe(false);
		expect(isLoopbackBind("192.168.1.50")).toBe(false);
	});

	it("uses bounded exponential backoff", () => {
		expect(backoffDelays(5)).toEqual([1000, 2000, 4000, 8000, 16000]);
		expect(backoffDelays(8)[7]).toBe(16000);
	});

	it("prevents duplicate tunnels", async () => {
		const deps = fakeDeps();
		deps.files.set("tunnel.pid", "4242\n");
		deps.live.add(4242);
		const result = await ensureTunnel(deps, baseOptions());
		expect(result).toEqual({ status: "already-running", pid: 4242 });
		expect(deps.spawns.length).toBe(0);
	});

	it("retries failures then reports success", async () => {
		let probes = 0;
		const deps = fakeDeps({
			probeTcp: async () => {
				probes++;
				return probes >= 3;
			},
		});
		const result = await ensureTunnel(deps, baseOptions(), 5);
		expect(result.status).toBe("started");
		expect(deps.sleeps).toEqual([1000, 2000]);
	});

	it("stops the supervised tunnel and releases the pid file", async () => {
		const deps = fakeDeps();
		deps.files.set("tunnel.pid", "4242\n");
		deps.live.add(4242);
		const killed: number[] = [];
		expect(await stopTunnel(deps, "tunnel.pid", pid => killed.push(pid))).toBe(true);
		expect(killed).toEqual([4242]);
		expect(deps.files.has("tunnel.pid")).toBe(false);
		expect(await stopTunnel(deps, "tunnel.pid", pid => killed.push(pid))).toBe(false);
	});
});
