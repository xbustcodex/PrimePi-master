import { describe, expect, it } from "bun:test";
import type { HarnessInput } from "@oh-my-pi/pi-agent-core";
import { runTokenHarness } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessage, createUserMessage } from "../helpers";
import {
	bigJsonOutput,
	buildFailureLog,
	longSessionFixture,
	shortSessionFixture,
	testLog,
	toolCallBlock,
	toolResult,
	extractCalls,
} from "./fixtures";

function sceneWith(
	name: string,
	input: HarnessInput,
	config?: { toolResultBudgetTokens?: number },
): {
	name: string;
	inputTokens: number;
	outputTokens: number;
	reductionPct: number;
	ratio: number;
	latencyMs: number;
	artifacts: number;
	prefixTokens: number;
} {
	const started = performance.now();
	const result = runTokenHarness(input, config);
	const elapsed = performance.now() - started;
	return {
		name,
		inputTokens: result.report.inputTokens,
		outputTokens: result.report.outputTokens,
		reductionPct: result.report.reductionPct,
		ratio: result.report.reductionRatio,
		latencyMs: elapsed,
		artifacts: result.report.artifacts.length,
		prefixTokens: result.report.unchangedPrefixTokens,
	};
}

function repeatedToolSession(): HarnessInput {
	const msgs: (
		| ReturnType<typeof createUserMessage>
		| ReturnType<typeof createAssistantMessage>
		| ReturnType<typeof toolResult>
	)[] = [createUserMessage("run the whole pipeline and report")];
	for (let i = 0; i < 12; i++) {
		const call = toolCallBlock("bash", { command: "npm ci && npm test" });
		const assignment = createAssistantMessage([call], "toolUse");
		msgs.push(assignment);
		const ids = extractCalls(assignment);
		msgs.push(toolResult(ids ? ids[0] : { id: `call_x${i}`, name: "bash" }, testLog("pipeline", 50)));
	}
	msgs.push(createAssistantMessage([{ type: "text", text: "done" }], "stop"));
	return { systemPrompt: ["You are PrimePi."], messages: msgs as HarnessInput["messages"] };
}

function hugeOutputSession(): HarnessInput {
	const msgs: (
		| ReturnType<typeof createUserMessage>
		| ReturnType<typeof createAssistantMessage>
		| ReturnType<typeof toolResult>
	)[] = [createUserMessage("list everything")];
	for (let i = 0; i < 10; i++) {
		const call = toolCallBlock("bash", { command: "find . -type f" });
		const assignment = createAssistantMessage([call], "toolUse");
		msgs.push(assignment);
		const ids = extractCalls(assignment);
		msgs.push(toolResult(ids ? ids[0] : { id: `call_y${i}`, name: "bash" }, bigJsonOutput(800)));
	}
	msgs.push(createAssistantMessage([{ type: "text", text: "done" }], "stop"));
	return { systemPrompt: ["You are PrimePi."], messages: msgs as HarnessInput["messages"] };
}

function debugLoopSession(): HarnessInput {
	const msgs: (
		| ReturnType<typeof createUserMessage>
		| ReturnType<typeof createAssistantMessage>
		| ReturnType<typeof toolResult>
	)[] = [createUserMessage("fix the failing test")];
	for (let i = 0; i < 10; i++) {
		const call = toolCallBlock("bash", { command: "bun test --filter fail-" + i });
		const assignment = createAssistantMessage([call], "toolUse");
		msgs.push(assignment);
		const ids = extractCalls(assignment);
		msgs.push(toolResult(ids ? ids[0] : { id: `call_z${i}`, name: "bash" }, buildFailureLog(8)));
	}
	msgs.push(createAssistantMessage([{ type: "text", text: "fixed" }], "stop"));
	return { systemPrompt: ["You are PrimePi."], messages: msgs as HarnessInput["messages"] };
}

function runner(): { report: typeof sceneWith; rows: ReturnType<typeof sceneWith>[] } {
	const report = sceneWith;
	const rows = [
		report("short-session", shortSessionFixture()),
		report("long-session (mixed)", longSessionFixture()),
		report("repeated-tool-output", repeatedToolSession()),
		report("huge-output", hugeOutputSession()),
		report("debug-loop", debugLoopSession()),
	];
	return { report, rows };
}

describe("token-harness benchmark", () => {
	it("measures reduction, latency and cache prefix across representative fixtures", () => {
		const { rows } = runner();
		console.log("\nPRIME TOKEN HARNESS — BENCHMARK");
		console.table(
			rows.map(r => ({
				fixture: r.name,
				input: r.inputTokens,
				output: r.outputTokens,
				reductionPct: `${r.reductionPct.toFixed(1)}%`,
				ratio: `${r.ratio.toFixed(2)}x`,
				latencyMs: `${r.latencyMs.toFixed(1)}`,
				artifacts: r.artifacts,
			})),
		);

		// Contract thresholds (measure-based, not target-based).
		const long = rows.find(r => r.name === "long-session (mixed)")!;
		expect(long.reductionPct).toBeGreaterThan(20);
		expect(long.outputTokens).toBeLessThan(long.inputTokens);
		const repeated = rows.find(r => r.name === "repeated-tool-output")!;
		expect(repeated.reductionPct).toBeGreaterThan(40);
		const huge = rows.find(r => r.name === "huge-output")!;
		expect(huge.artifacts).toBeGreaterThan(0);
		const short = rows.find(r => r.name === "short-session")!;
		expect(short.reductionPct).toBeLessThan(1);
		for (const row of rows) expect(row.latencyMs).toBeLessThan(500);
	});

	it("reports processing latency below the budget and failures visibly", () => {
		const input = longSessionFixture();
		const started = performance.now();
		const result = runTokenHarness(input);
		const latency = performance.now() - started;
		expect(result.ok).toBe(true);
		expect(result.report.latencyMs).toBeLessThan(500);
		expect(latency).toBeCloseTo(result.report.latencyMs, 0);
		for (const module of result.report.modules) {
			expect(module.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});
});
