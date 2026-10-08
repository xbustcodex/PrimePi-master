/**
 * Isolated op registry — the ONLY surface the isolated runtime may execute.
 *
 * Ops are pure, named functions over plain-serializable payloads. A worker or
 * CLI adapter runs only these; it never receives arbitrary code. The registry
 * is shared so conservative in-process fallbacks and the isolated runtimes
 * resolve the exact same op ids (deterministic equivalence between primary and
 * conservative paths).
 */

import { writeFileSync } from "node:fs";

export interface IsolatedOpContext {
	signal?: AbortSignal;
}

export type IsolatedOp = (payload: unknown, ctx: IsolatedOpContext) => unknown | Promise<unknown>;

const ops = new Map<string, IsolatedOp>();

/** Register a named op. Throws on duplicate ids so a backported op can't shadow a platform one. */
export function registerIsolatedOp(name: string, op: IsolatedOp): void {
	if (ops.has(name)) throw new Error(`Isolated op "${name}" is registered twice`);
	ops.set(name, op);
}

export function getIsolatedOp(name: string): (IsolatedOp & { op: string }) | undefined {
	const fn = ops.get(name);
	return fn ? Object.assign(fn, { op: name }) : undefined;
}

export function listIsolatedOps(): string[] {
	return [...ops.keys()];
}

type HeadPayload = { text: string; maxChars: number; keepErrorLines?: boolean };

/**
 * Head-preserving truncation mirroring `util.truncatePreservingErrors`. Runs
 * in the isolated runtime so a pathological input cannot stall the parent.
 * Deterministic and dependency-free (character-budget based; the parent maps
 * token budgets → char budgets before dispatch).
 */
registerIsolatedOp("text.head-and-errors", (payload, ctx) => {
	const p = payload as HeadPayload | undefined;
	if (!p || typeof p.text !== "string" || !Number.isFinite(p.maxChars)) {
		throw new Error("malformed payload for text.head-and-errors");
	}
	const text = p.text;
	if (text.length <= p.maxChars) return { unchanged: true, text };
	const headChars = Math.max(80, Math.floor(p.maxChars * 0.65));
	let head = text.slice(0, headChars);
	const nextNewline = text.indexOf("\n", headChars);
	if (nextNewline !== -1 && nextNewline - headChars < 200) head = text.slice(0, nextNewline);
	const errorLineRe = /\b(error|failed|failure|exception|traceback|fatal|panic|ERR\b|✗|FAILED\b)/i;
	const keep = p.keepErrorLines !== false;
	const keptErrors: string[] = [];
	if (keep) {
		const errorBudget = Math.floor(p.maxChars * 0.2);
		let chars = 0;
		for (const line of text.slice(head.length).split("\n").slice(1)) {
			if (!errorLineRe.test(line)) continue;
			if (line.includes("[prime-token-harness:")) continue;
			if (chars + line.length > errorBudget) break;
			keptErrors.push(line);
			chars += line.length;
		}
		const finalLine = text.trimEnd().split("\n").pop() ?? "";
		if (
			finalLine.trim().length > 0 &&
			errorLineRe.test(finalLine) &&
			!keptErrors.includes(finalLine) &&
			chars + finalLine.length <= errorBudget * 1.5
		) {
			keptErrors.push(finalLine);
		}
		if (keptErrors.length > 0) head = `${head}\n…\n${keptErrors.join("\n")}`;
	}
	return { unchanged: false, text: head, headChars, keptErrorLines: keptErrors.length };
});

/** Test op: sleep for the requested duration; rejects early when the signal fires. */
registerIsolatedOp("sleep", (payload, ctx) => {
	const p = payload as { ms?: number } | undefined;
	const ms = Math.max(0, Math.min(Number(p?.ms) || 0, 60_000));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve({ sleptMs: ms }), ms);
		const { signal } = ctx;
		if (!signal) return;
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("cancelled"));
			},
			{ once: true },
		);
	});
});

/** Test op: CPU-bound infinite loop (only termination stops it). */
registerIsolatedOp("burn", (_payload, _ctx) => {
	for (;;) {
		// intentionally unbreakable from within
	}
});

/** Test op: deterministic crash. */
registerIsolatedOp("crash", () => {
	throw new Error("isolated op crashed as requested");
});

/** Test op: spawn a grandchild (described by pidFile) then burn forever — only a process-tree kill stops both. */
registerIsolatedOp("spawn-and-burn", async (payload, _ctx) => {
	const p = payload as { pidFile?: string; keepAliveMs?: number } | undefined;
	let grandchild: ReturnType<typeof Bun.spawn> | null = null;
	if (p?.pidFile) {
		const proc = Bun.spawn([process.execPath, "-e", `setTimeout(() => {}, 60000)`], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		grandchild = proc;
		writeFileSync(p.pidFile, String(proc.pid), "utf8");
	}
	const keepAlive = p?.keepAliveMs ?? 0;
	try {
		// Burn until the parent terminates the tree; the grandchild must die too.
		if (keepAlive > 0) {
			const started = Date.now();
			while (Date.now() - started < keepAlive) {
				// spin
			}
		} else {
			for (;;) {
				// spin
			}
		}
	} finally {
		if (grandchild) {
			try {
				grandchild.kill("SIGKILL");
			} catch {
				// already dead (tree-killed)
			}
		}
	}
	return { done: true };
});
