/**
 * Prime Token Harness — isolated subprocess backend.
 *
 * Runs harness plugin ops in a dedicated one-shot Bun child that re-enters the
 * CLI worker host (`__omp_worker_harness`), so termination is a process
 * boundary: killing the child (plus its process tree) cannot corrupt the parent
 * or any other session.
 *
 * Process-tree containment: `@oh-my-pi/pi-utils/ptree`'s `spawn` is used with
 * `detached: true`, which on Windows retains the root process handle and kills
 * the descendant tree via the Toolhelp walk (`killTree`), and on POSIX makes
 * the child a process-group leader so `kill(group)` covers descendants. We do
 * not assume a parent PID kill reaches children.
 *
 * Each attempt gets a strict per-request deadline (`timeout`), and the parent
 * passes the pipeline's overall deadline down by choosing per-attempt budgets.
 * Because the child is one-shot, "worker replacement" is automatic: every run
 * spawns a fresh worker, so a killed/hung worker never poisons the next run.
 */

import { ptree } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { IsolatedBackend, IsolatedRequest, IsolatedRunResult } from "@oh-my-pi/pi-agent-core";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";

export const HARNESS_WORKER_ARG = "__omp_worker_harness";

/** Bound on a single isolated op (defensive; the pipeline sets the real budget). */
const MAX_EXECUTION_MS = 60_000;

interface WorkerResultFile {
	ok?: boolean;
	payload?: unknown;
	error?: string;
}

export class HarnessSubprocessBackend implements IsolatedBackend {
	readonly kind = "omp-subprocess";

	constructor(
		readonly options: {
			/** Override for tests / non-CLI hosting. */
			workerArg?: string;
			/** Per-run grace added to the requested timeout so `wait` can settle. */
			teardownGraceMs?: number;
		} = {},
	) {}

	async run(
		request: IsolatedRequest,
		options: { timeoutMs: number; signal?: AbortSignal },
	): Promise<IsolatedRunResult> {
		const startedAt = performance.now();
		const requested = Math.max(1, Math.min(options.timeoutMs, MAX_EXECUTION_MS));
		const timeoutMs = requested + (this.options.teardownGraceMs ?? 100);
		const workerArg = this.options.workerArg ?? HARNESS_WORKER_ARG;

		const tmp = TempDir.createSync("omp-harness-");
		const requestPath = join(tmp.absolute(), "request.json");
		const resultPath = join(tmp.absolute(), "result.json");
		try {
			writeFileSync(requestPath, JSON.stringify(request), "utf8");
			const spawnCommand = resolveWorkerSpawnCmd(workerArg);
			const child = ptree.spawn(
				[...spawnCommand.cmd, workerArg, "--op", request.op, "--request", requestPath, "--result", resultPath],
				{
					env: workerEnvFromParent(),
					cwd: spawnCommand.cwd,
					detached: true,
					timeout: timeoutMs,
					signal: options.signal,
				},
			);
			// `wait` resolves with the kill/timeout/abort recorded; it never
			// throws for the states we classify here.
			await child.wait({ allowNonZero: true, allowAbort: true });

			// Do not trust `child.killed` for classification: Bun reports it true even
			// after a clean exit, and Windows reports a non-null exit code when a
			// worker tree is terminated. The authoritative timeout marker is the
			// ptree TimeoutError the deadline recorded (POSIX leaves exitCode
			// null; Windows terminates the tree but keeps an exit code).
			if (options.signal?.aborted) {
				return {
					ok: false,
					reason: "cancelled",
					message: "cancelled by caller",
					elapsedMs: performance.now() - startedAt,
				};
			}
			const exitCode = child.proc.exitCode;
			if (existsSync(resultPath) && exitCode === 0) {
				const file = JSON.parse(readFileSync(resultPath, "utf8")) as WorkerResultFile;
				if (file.ok === true) {
					return { ok: true, payload: file.payload, elapsedMs: performance.now() - startedAt };
				}
				return {
					ok: false,
					reason: "crash",
					message: file.error ?? "worker reported failure",
					elapsedMs: performance.now() - startedAt,
				};
			}
			if (child.exitReason instanceof ptree.TimeoutError || exitCode === null) {
				return {
					ok: false,
					reason: "timeout",
					message: `terminated after ${requested}ms`,
					elapsedMs: performance.now() - startedAt,
				};
			}
			if (exitCode === 0) {
				return {
					ok: false,
					reason: "crash",
					message: "worker produced no result",
					elapsedMs: performance.now() - startedAt,
				};
			}
			return {
				ok: false,
				reason: "crash",
				message: `worker exited with code ${exitCode}`,
				elapsedMs: performance.now() - startedAt,
			};
		} catch (error) {
			return {
				ok: false,
				reason: "unavailable",
				message: error instanceof Error ? error.message : String(error),
				elapsedMs: performance.now() - startedAt,
			};
		} finally {
			void tmp.remove().catch(() => {});
		}
	}
}

/** Convenience constructor used by tests and future wiring. */
export function createHarnessSubprocessBackend(options?: HarnessSubprocessBackendOptions): HarnessSubprocessBackend {
	return new HarnessSubprocessBackend(options);
}

export type HarnessSubprocessBackendOptions = ConstructorParameters<typeof HarnessSubprocessBackend>[0];
