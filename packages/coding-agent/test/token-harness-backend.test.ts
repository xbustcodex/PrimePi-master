import { afterAll, describe, expect, it } from "bun:test";
import type { IsolatedRunResult } from "@oh-my-pi/pi-agent-core";
import { readFileSync } from "node:fs";

import { join } from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getIsolatedOp } from "@oh-my-pi/pi-agent-core";
import {
	createHarnessSubprocessBackend,
	HARNESS_WORKER_ARG,
} from "@oh-my-pi/pi-coding-agent/session/token-harness-backend";

const LONG_TEXT = "line\n".repeat(2_000);

type FailedRun = Extract<IsolatedRunResult, { ok: false }>;
function expectFailure(result: IsolatedRunResult): FailedRun {
	expect(result.ok).toBe(false);
	return result as FailedRun;
}

describe("token-harness subprocess isolated backend", () => {
	afterAll(async () => {
		// one-shot children never persist; nothing to clean besides temp dirs which self-remove
	});

	it("round-trips a successful op through a real child process", async () => {
		const backend = createHarnessSubprocessBackend();
		const result = await backend.run(
			{ op: "text.head-and-errors", payload: { text: `${LONG_TEXT}error: boom\nend`, maxChars: 400 } },
			{ timeoutMs: 4_000 },
		);
		expect(result.ok).toBe(true);
		const payload = (result as { payload?: { unchanged?: boolean; text?: string } }).payload;
		expect(payload?.unchanged).toBe(false);
		expect(payload?.text).toBeString();
		expect(payload!.text!.length).toBeLessThan(1_000);
		expect(payload!.text!).toContain("boom");
	});

	it("terminates a hung (never-completing) worker on deadline — not merely a message", async () => {
		const backend = createHarnessSubprocessBackend();
		const started = performance.now();
		const result = await backend.run({ op: "sleep", payload: { ms: 60_000 } }, { timeoutMs: 350 });
		const elapsed = performance.now() - started;
		const failed = expectFailure(result);
		expect(failed.reason).toBe("timeout");
		expect(elapsed).toBeLessThan(4_000);
	});

	it("terminates a CPU-bound infinite loop (termination is real, not a wait timeout)", async () => {
		const backend = createHarnessSubprocessBackend();
		const started = performance.now();
		const result = await backend.run({ op: "burn", payload: {} }, { timeoutMs: 350 });
		const elapsed = performance.now() - started;
		const failed = expectFailure(result);
		expect(failed.reason).toBe("timeout");
		expect(elapsed).toBeLessThan(4_000);
	});

	it("reports a deliberate crash and surfaces its message", async () => {
		const backend = createHarnessSubprocessBackend();
		const result = await backend.run({ op: "crash", payload: {} }, { timeoutMs: 4_000 });
		const failed = expectFailure(result);
		expect(failed.reason).toBe("crash");
		expect(failed.message).toContain("crashed");
	});

	it("reports an unknown op as a worker-side failure", async () => {
		const backend = createHarnessSubprocessBackend();
		const result = await backend.run({ op: "no.such.op", payload: {} }, { timeoutMs: 4_000 });
		const failed = expectFailure(result);
		expect(failed.message).toContain("unknown op");
	});

	it("stops a running worker when the caller aborts (cancellation)", async () => {
		const backend = createHarnessSubprocessBackend();
		const abortController = new AbortController();
		const started = performance.now();
		const promise = backend.run(
			{ op: "sleep", payload: { ms: 60_000 } },
			{ timeoutMs: 30_000, signal: abortController.signal },
		);
		setTimeout(() => abortController.abort(), 100);
		const result = await promise;
		const failed = expectFailure(result);
		expect(failed.reason).toBe("cancelled");
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("replaces a killed worker transparently for the next run (no poisoned state)", async () => {
		const backend = createHarnessSubprocessBackend();
		const hung = await backend.run({ op: "sleep", payload: { ms: 60_000 } }, { timeoutMs: 250 });
		const hungFail = expectFailure(hung);
		expect(hungFail.reason).toBe("timeout");
		const fresh = await backend.run(
			{ op: "text.head-and-errors", payload: { text: "x".repeat(500), maxChars: 100 } },
			{ timeoutMs: 4_000 },
		);
		expect(fresh.ok).toBe(true);
	});

	it("keeps concurrent sessions on independent workers", async () => {
		const backend = createHarnessSubprocessBackend();
		const [a, b] = await Promise.all([
			backend.run({ op: "sleep", payload: { ms: 300 } }, { timeoutMs: 4_000 }),
			backend.run(
				{ op: "text.head-and-errors", payload: { text: "y".repeat(2_000), maxChars: 200 } },
				{ timeoutMs: 4_000 },
			),
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
	});

	it("kills subprocess descendants when terminating the worker tree (Windows-safe)", async () => {
		// The op spawns a grandchild, writes its pid, then burns forever. Killing
		// the worker MUST kill the grandchild too — a parent-PID kill alone would
		// orphan it (the exact Windows case the brief calls out).
		const temp = TempDir.createSync("omp-harness-tree-");
		const pidFile = join(temp.absolute(), "grandchild.pid");
		try {
			const backend = createHarnessSubprocessBackend();
			const result = await backend.run(
				{ op: "spawn-and-burn", payload: { pidFile, keepAliveMs: 600_000 } },
				{ timeoutMs: 2_000 },
			);
			const failed = expectFailure(result);
			expect(failed.reason).toBe("timeout");
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			// Poll for the grandchild to actually exit (try/catch: kill(pid,0)
			// throws ESRCH once it is gone, and returns on Windows otherwise).
			let alive = true;
			for (let i = 0; i < 40; i++) {
				try {
					process.kill(pid, 0);
				} catch {
					alive = false;
					break;
				}
				await Bun.sleep(50);
			}
			expect(alive).toBe(false);
		} finally {
			await temp.remove();
		}
	});

	it("registers the built-in test/spawn ops used by the backend tests", () => {
		for (const op of ["text.head-and-errors", "sleep", "burn", "crash", "spawn-and-burn"]) {
			expect(getIsolatedOp(op)).toBeDefined();
		}
		expect(HARNESS_WORKER_ARG).toBe("__omp_worker_harness");
	});
});
