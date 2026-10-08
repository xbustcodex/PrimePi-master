/**
 * Prime Token Harness — isolated worker entrypoint.
 *
 * Re-entered through the CLI worker-host selector `__omp_worker_harness` (or
 * spawned directly by the backend under `bun test`/SDK hosting via the
 * `resolveWorkerSpawnCmd` fallback). The worker is one-shot and stateless:
 * it reads a JSON request file, resolves the requested op against the shared
 * isolated-op registry, writes a JSON result file, and exits. Killing the
 * worker (or its whole process tree) therefore discards nothing in the parent
 * and cannot affect other sessions.
 *
 * The op registry is a closed set of pure functions; the worker never executes
 * arbitrary code, so "malformed output" is constrained to malformed payloads,
 * which the backend reports and the pipeline routes through fallback.
 */

import { getIsolatedOp } from "@oh-my-pi/pi-agent-core";
import { readFileSync, writeFileSync } from "node:fs";

const HELP_HINT = "usage: <entry> __omp_worker_harness --op <name> --request <file> --result <file>";

function readArgValue(argv: readonly string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

export function mainHarnessIsolatedWorker(argv: readonly string[] = process.argv): void {
	const op = readArgValue(argv, "--op");
	const requestPath = readArgValue(argv, "--request");
	const resultPath = readArgValue(argv, "--result");
	if (!op || !requestPath || !resultPath) {
		process.stderr.write(`${HELP_HINT}\n`);
		process.exit(2);
	}
	let request: { op?: string; payload?: unknown };
	try {
		request = JSON.parse(readFileSync(requestPath, "utf8")) as { op?: string; payload?: unknown };
	} catch (error) {
		writeFileSync(resultPath, JSON.stringify({ ok: false, error: `cannot read request: ${String(error)}` }), "utf8");
		process.exit(0);
	}
	const opFn = getIsolatedOp(op);
	if (!opFn) {
		writeFileSync(resultPath, JSON.stringify({ ok: false, error: `unknown op "${op}"` }), "utf8");
		process.exit(0);
	}
	try {
		const result = opFn(request.payload, {});
		void Promise.resolve(result)
			.then(value => {
				writeFileSync(resultPath, JSON.stringify({ ok: true, payload: value }), "utf8");
				process.exit(0);
			})
			.catch(error => {
				writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error) }), "utf8");
				process.exit(0);
			});
	} catch (error) {
		// Synchronous throw (e.g. the "crash" op, malformed payload).
		writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error) }), "utf8");
		process.exit(0);
	}
}
