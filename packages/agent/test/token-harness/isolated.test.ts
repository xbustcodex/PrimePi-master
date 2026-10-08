import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	createIsolatedModule,
	HarnessIsolationRequiredError,
	runTokenHarness,
	runTokenHarnessIsolated,
	type IsolatedBackend,
	type IsolatedRequest,
	type IsolatedRunResult,
} from "@oh-my-pi/pi-agent-core";
import { createAssistantMessage, createUserMessage } from "../helpers";
import { longSessionFixture, toolCallBlock, toolResult, extractCalls } from "./fixtures";

class FakeBackend implements IsolatedBackend {
	readonly kind = "fake";
	runs = 0;
	constructor(
		private readonly behavior: (
			request: IsolatedRequest,
			opts: { timeoutMs: number; signal?: AbortSignal },
		) => Promise<IsolatedRunResult> | IsolatedRunResult,
	) {}

	async run(request: IsolatedRequest, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<IsolatedRunResult> {
		this.runs++;
		return this.behavior(request, opts);
	}
}

/** An isolated module that stacks a deterministic marker into every old tool result. */
function markerIsolatedModule(name: string, marker: string) {
	return createIsolatedModule({
		name,
		stage: "suppress",
		priority: 5,
		isolated: {
			op: "test.marker",
			prepare(state) {
				const target = state.messages.findIndex(
					m => m.role === "toolResult" && m.toolName === "bash" && m.timestamp < 1_700_000_100_000,
				);
				if (target < 0) return undefined;
				return { op: "test.marker", payload: { marker, index: target } };
			},
			apply(state, _ctx, result) {
				const r = result as { index?: number; marker?: string };
				const prefix = typeof r.marker === "string" ? r.marker : marker;
				const message = state.messages[r.index ?? -1];
				if (r.index !== undefined && message && message.role === "toolResult") {
					const clone = { ...message, content: [...message.content] };
					const first = clone.content.findIndex(block => block.type === "text");
					if (first >= 0 && clone.content[first].type === "text") {
						clone.content = clone.content.map(block =>
							block.type === "text" ? { ...block, text: `${prefix} ${block.text}` } : block,
						);
					}
					state.messages[r.index] = clone;
					state.mutated[name] = (state.mutated[name] ?? 0) + 1;
				}
			},
		},
		conservativeProcess(state) {
			for (let i = 0; i < state.messages.length; i++) {
				const m = state.messages[i];
				if (m.role !== "toolResult" || m.toolName !== "bash") continue;
				if (m.timestamp >= 1_700_000_100_000) continue;
				const clone = {
					...m,
					content: m.content.map(block =>
						block.type === "text" ? { ...block, text: `${name}-conservative ${block.text}` } : block,
					),
				};
				state.messages[i] = clone;
				state.mutated[name] = (state.mutated[name] ?? 0) + 1;
			}
		},
	});
}

function stubBaseline(): Message[] {
	const msgs: Message[] = [];
	msgs.push(createUserMessage("run it"));
	const call = toolCallBlock("bash", { command: "bun test" });
	const assistant = createAssistantMessage([call], "toolUse");
	msgs.push(assistant);
	msgs.push(toolResult(extractCalls(assistant)[0], "old output that must be processed"));
	msgs.push(createAssistantMessage([{ type: "text", text: "done" }], "stop"));
	return msgs;
}

function isolatedModules(name = "isolate.suppress", marker = "[PRIMARY]") {
	return [markerIsolatedModule(name, marker)];
}

describe("token-harness isolated pipeline", () => {
	it("runs the primary isolated plugin and applies the validated result", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const backend = new FakeBackend(() => ({ ok: true, payload: { index: 2, marker: "[PRIMARY]" }, elapsedMs: 1 }));
		const result = await runTokenHarnessIsolated(input, undefined, { backends: backend, modules: isolatedModules() });
		expect(result.ok).toBe(true);
		expect(result.report.modules.find(m => m.module === "isolate.suppress")?.status).toBe("applied-isolated");
		const text = (result.messages[2] as { content: { text: string }[] }).content[0].text;
		expect(text.startsWith("[PRIMARY]")).toBe(true);
	});

	it("falls back to the alternative backend on timeout, then validates", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const primary = new FakeBackend(() => ({ ok: false, reason: "timeout", message: "deadline", elapsedMs: 20 }));
		const alternative = new FakeBackend(() => ({ ok: true, payload: { index: 2, marker: "[ALT]" }, elapsedMs: 5 }));
		const result = await runTokenHarnessIsolated(input, undefined, {
			backends: [primary, alternative],
			modules: isolatedModules(),
		});
		expect(result.ok).toBe(true);
		expect(primary.runs).toBe(1);
		expect(alternative.runs).toBe(1);
		const text = (result.messages[2] as { content: { text: string }[] }).content[0].text;
		expect(text.startsWith("[ALT]")).toBe(true);
	});

	it("routes to the conservative in-process path when every backend fails", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const backend = new FakeBackend(() => ({ ok: false, reason: "timeout", message: "deadline", elapsedMs: 20 }));
		const result = await runTokenHarnessIsolated(input, undefined, {
			backends: backend,
			modules: isolatedModules("isolate.suppress"),
		});
		expect(result.ok).toBe(true);
		const stat = [...result.report.modules].reverse().find(m => m.module === "isolate.suppress");
		expect(stat?.status).toBe("conservative");
		const text = (result.messages[2] as { content: { text: string }[] }).content[0].text;
		expect(text.startsWith("isolate.suppress-conservative")).toBe(true);
	});

	it("fails open to the original context when conservative validation cannot establish safety", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const backend = new FakeBackend(() => ({ ok: false, reason: "crash", message: "boom", elapsedMs: 5 }));
		// Conservative path mutates the recent window → validate fails → fail-open.
		const bad = createIsolatedModule({
			name: "isolate.bad",
			stage: "suppress",
			isolated: {
				op: "test.x",
				prepare: () => ({ op: "test.x", payload: {} }),
				apply: () => {},
			},
			conservativeProcess(state) {
				const i = state.messages.length - 1;
				state.messages[i] = { ...state.messages[i] } as Message; // identity change on a recent message
			},
			validate: state => {
				const last = state.messages[state.messages.length - 1];
				const base = state.baseline.messages[state.baseline.messages.length - 1];
				return last === base ? [] : ["recent-window message mutated by conservative path"];
			},
		});
		const result = await runTokenHarnessIsolated(input, undefined, { backends: backend, modules: [bad] });
		expect(result.ok).toBe(false);
		expect(result.report.failure?.module).toBe("isolate.bad");
		expect(result.report.failure?.reason).toContain("conservative fallback failed validation");
		expect(result.messages).toBe(input.messages);
	});

	it("treats malformed apply output as failure and falls back (rollback + conservative)", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const backend = new FakeBackend(() => ({ ok: true, payload: { index: 2, marker: "[BAD]" }, elapsedMs: 1 }));
		const bad = createIsolatedModule({
			name: "isolate.bad",
			stage: "suppress",
			isolated: {
				op: "test.bad",
				prepare: () => ({ op: "test.bad", payload: {} }),
				apply() {
					throw new Error("malformed apply");
				},
			},
			conservativeProcess(state) {
				const i = state.messages.findIndex(m => m.role === "toolResult");
				if (i >= 0) {
					const m = state.messages[i] as Extract<Message, { role: "toolResult" }>;
					state.messages[i] = {
						...m,
						content: m.content.map(b => (b.type === "text" ? { ...b, text: `conservative ${b.text}` } : b)),
					};
					state.mutated["isolate.bad"] = 1;
				}
			},
		});
		const result = await runTokenHarnessIsolated(input, undefined, { backends: backend, modules: [bad] });
		expect(result.ok).toBe(true);
		const stat = [...result.report.modules].reverse().find(m => m.module === "isolate.bad");
		expect(stat?.status).toBe("conservative");
		// Rollback removed the malformed primary mutation, then conservative applied.
		const text = (result.messages[2] as { content: { text: string }[] }).content[0].text;
		expect(text.startsWith("conservative")).toBe(true);
		expect(text.startsWith("[BAD]")).toBe(false);
	});

	it("enforces the shared overall deadline so fallback cannot spin forever", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		// Backends report their OWN enforced deadline promptly (as the real
		// subprocess backend does); the pipeline's overall budget must cap how
		// many attempts any single round may make.
		const attempts = new FakeBackend(() => ({ ok: false, reason: "timeout", message: "deadline", elapsedMs: 0 }));
		const started = performance.now();
		const result = await runTokenHarnessIsolated(input, undefined, {
			backends: attempts,
			budget: { moduleBudgetMs: 0, overallBudgetMs: 0 },
			modules: isolatedModules("isolate.hung"),
			clock: () => performance.now(),
		});
		const elapsed = performance.now() - started;
		expect(result.ok).toBe(true);
		const stat = [...result.report.modules].reverse().find(m => m.module === "isolate.hung");
		expect(stat?.status).toBe("conservative");
		expect(elapsed).toBeLessThan(500);
		expect(attempts.runs).toBe(0); // one module budget unit could not afford even one attempt
	});

	it("stops when the caller aborts, failing open with the original context", async () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		const abortController = new AbortController();
		const signalLeak = new FakeBackend((request, opts) => {
			// A backend that only resolves when it is aborted (mirrors the
			// subprocess backend, which terminates the worker on abort).
			return new Promise<IsolatedRunResult>((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => reject(new Error("worker terminated on abort")), {
					once: true,
				});
			});
		});
		const started = performance.now();
		const promise = runTokenHarnessIsolated(input, undefined, {
			backends: signalLeak,
			modules: isolatedModules("isolate.hung"),
			signal: abortController.signal,
		});
		setTimeout(() => abortController.abort(), 30);
		const result = await promise;
		expect(result.ok).toBe(false);
		expect(result.report.failure?.module).toBe("isolate.hung");
		expect(result.report.failure?.reason).toContain("cancelled");
		expect(result.messages).toBe(input.messages);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("keeps concurrent sessions independent", async () => {
		const inputA = { systemPrompt: ["sys"], messages: stubBaseline() };
		const inputB = longSessionFixture();
		const backend = new FakeBackend(() => ({ ok: true, payload: { index: 2, marker: "[P]" }, elapsedMs: 1 }));
		const [resultA, resultB] = await Promise.all([
			runTokenHarnessIsolated(inputA, undefined, { backends: backend, modules: isolatedModules() }),
			runTokenHarnessIsolated(inputB, undefined, { backends: backend, modules: isolatedModules() }),
		]);

		expect(resultA.ok).toBe(true);
		expect(resultB.ok).toBe(true);
		expect((resultA.messages[2] as { content: { text: string }[] }).content[0].text.startsWith("[P]")).toBe(true);
		expect((resultB.messages[2] as { content: { text: string }[] }).content[0].text.startsWith("[P]")).toBe(true);
		expect(resultA.report.inputTokens).not.toBe(resultB.report.inputTokens);
	});

	it("sync runTokenHarness refuses modules that require isolation", () => {
		const input = { systemPrompt: ["sys"], messages: stubBaseline() };
		expect(() => runTokenHarness(input, undefined, { modules: isolatedModules() })).toThrow(
			HarnessIsolationRequiredError,
		);
	});
});
