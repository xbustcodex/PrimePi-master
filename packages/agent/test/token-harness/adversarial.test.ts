import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { runTokenHarness, type HarnessInput } from "@oh-my-pi/pi-agent-core";
import { createUserMessage, createAssistantMessage } from "../helpers";
import {
	bigJsonOutput,
	buildFailureLog,
	extractCalls,
	fencedCodeFile,
	testLog,
	toolCallBlock,
	toolResult,
} from "./fixtures";

function textOf(message: Message): string {
	if (message.role === "toolResult") {
		return message.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("\n");
	}
	if (message.role === "user" || message.role === "developer") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter(b => b.type === "text")
			.map(b => b.text)
			.join("\n");
	}
	return message.content
		.filter(b => b.type === "text")
		.map(b => b.text)
		.join("\n");
}

/** Syncs a user → [assistant call → tool result]* sequence with a fixed clock. */
function scene(systemPrompt: string[], msgs: Message[]): HarnessInput {
	return { systemPrompt, messages: msgs, tools: undefined };
}

describe("token-harness adversarial tests", () => {
	it("keeps toolCall ↔ toolResult pairing intact after suppression/dedup", () => {
		const msgs: Message[] = [];
		msgs.push(createUserMessage("debug the failing build"));
		for (let i = 0; i < 10; i++) {
			const call = toolCallBlock("bash", { command: `build ${i}` });
			const assistant = createAssistantMessage([call], "toolUse");
			msgs.push(assistant);
			const ids = extractCalls(assistant)[0];
			msgs.push(toolResult(ids, i % 3 === 0 ? testLog("ci", 60) : buildFailureLog(3)));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "Done." }], "stop"));

		const result = runTokenHarness(scene(["sys"], msgs));
		expect(result.ok).toBe(true);
		const calls = new Set<string>();
		const results: string[] = [];
		for (const m of result.messages) {
			if (m.role === "assistant") {
				for (const b of m.content) if (b.type === "toolCall") calls.add(b.id);
			}
			if (m.role === "toolResult") results.push(m.toolCallId);
		}
		expect(results).toHaveLength(10);
		for (const id of results) expect(calls.has(id)).toBe(true);
	});

	it("keeps a fenced code block byte-identical through compress", () => {
		const msgs: Message[] = [];
		const call = toolCallBlock("read", { path: "parser.py" });
		const assistant = createAssistantMessage([call], "toolUse");
		msgs.push(createUserMessage("show me parser.py"));
		msgs.push(assistant);
		msgs.push(toolResult(extractCalls(assistant)[0], fencedCodeFile()));
		// 8 filler turns force the code below the recent window; 40 blank-line
		// runs inside the fence would be a compress target if it were blind.
		for (let i = 0; i < 8; i++) {
			const c2 = toolCallBlock("ls", { path: "." });
			const a2 = createAssistantMessage([c2], "toolUse");
			msgs.push(a2);
			msgs.push(toolResult(extractCalls(a2)[0], testLog("unit", 2)));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "ok" }], "stop"));

		const result = runTokenHarness(scene(["sys"], msgs));
		expect(result.ok).toBe(true);
		const codeText = result.messages.find(m => m.role === "toolResult" && textOf(m).includes("```python"))!;
		expect(textOf(codeText)).toContain("def parse(line):");
		expect(textOf(codeText)).toContain("# trailing spaces inside fence must survive   ");
		expect(textOf(codeText)).toContain("    return line.split(':')[1]");
	});

	it("keeps JSON tool output structurally valid (untruncated head stays parseable slice)", () => {
		const msgs: Message[] = [];
		const call = toolCallBlock("bash", { command: "ls artifacts" });
		const assistant = createAssistantMessage([call], "toolUse");
		msgs.push(createUserMessage("inspect artifacts"));
		msgs.push(assistant);
		msgs.push(toolResult(extractCalls(assistant)[0], bigJsonOutput(2000)));
		for (let i = 0; i < 8; i++) {
			const c2 = toolCallBlock("grep", { pattern: "x", path: "." });
			const a2 = createAssistantMessage([c2], "toolUse");
			msgs.push(a2);
			msgs.push(toolResult(extractCalls(a2)[0], "no matches"));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "done" }], "stop"));

		const result = runTokenHarness(scene(["sys"], msgs), { toolResultBudgetTokens: 800 });
		expect(result.ok).toBe(true);
		const big = result.messages.find(m => m.role === "toolResult" && textOf(m).includes("artifacts"))!;
		const text = textOf(big);
		expect(text).toContain('"artifacts"');
		// Head line-boundary cut must never split a JSON string value mid-line.
		const headLine = text.split("\n").find(line => line.includes("artifact-"))!;
		expect(headLine.trim().endsWith(",") || headLine.trim().endsWith("{") || headLine.trim().endsWith("}")).toBe(
			true,
		);
		expect(text).toContain("local artifact pth:");
	});

	it("preserves error lines when a failing tool output is suppressed", () => {
		const msgs: Message[] = [];
		const call = toolCallBlock("bash", { command: "npm run build" });
		const assistant = createAssistantMessage([call], "toolUse");
		msgs.push(createUserMessage("build it"));
		msgs.push(assistant);
		msgs.push(toolResult(extractCalls(assistant)[0], buildFailureLog(5)));
		for (let i = 0; i < 8; i++) {
			const c2 = toolCallBlock("ls", { path: "." });
			const a2 = createAssistantMessage([c2], "toolUse");
			msgs.push(a2);
			msgs.push(toolResult(extractCalls(a2)[0], testLog("unit", 2)));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "ok" }], "stop"));

		const result = runTokenHarness(scene(["sys"], msgs), { toolResultBudgetTokens: 200 });
		expect(result.ok).toBe(true);
		const text = result.messages.map(m => textOf(m)).join("\n");
		expect(text).toContain("error TS2345:");
		expect(text).toContain("Build failed with");
	});

	it("collapses repeated identical tool outputs to references (dedup)", () => {
		const dup = buildFailureLog(2);
		const msgs: Message[] = [];
		msgs.push(createUserMessage("run it"));
		let firstDupIndex = -1;
		for (let i = 0; i < 3; i++) {
			const call = toolCallBlock("bash", { command: "bun test" });
			const assistant = createAssistantMessage([call], "toolUse");
			msgs.push(assistant);
			const ids = extractCalls(assistant)[0];
			if (firstDupIndex < 0) firstDupIndex = msgs.length;
			msgs.push(toolResult(ids, dup));
		}
		for (let i = 0; i < 8; i++) {
			const c2 = toolCallBlock("ls", { path: "." });
			const a2 = createAssistantMessage([c2], "toolUse");
			msgs.push(a2);
			msgs.push(toolResult(extractCalls(a2)[0], testLog("unit", 1)));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "ok" }], "stop"));

		const result = runTokenHarness(scene(["sys"], msgs));
		expect(result.ok).toBe(true);
		const dupRefs = result.messages.filter(
			m => m.role === "toolResult" && textOf(m).includes("duplicate of tool output"),
		);
		expect(dupRefs.length).toBeGreaterThanOrEqual(2);
		expect(textOf(result.messages[firstDupIndex] as Message)).toContain(dup.slice(0, 40));
	});

	it("is a near no-op on an already-minimal session (no noise added)", () => {
		const msgs: Message[] = [
			createUserMessage("What is 2+2?"),
			createAssistantMessage([{ type: "text", text: "4." }], "stop"),
		];
		const result = runTokenHarness(scene(["Be brief."], msgs));
		expect(result.ok).toBe(true);
		expect(result.report.reductionPct).toBeLessThan(1);
	});

	it("long-session stress: 100+ messages process within the latency budget", () => {
		const msgs: Message[] = [];
		msgs.push(createUserMessage("long session"));
		for (let i = 0; i < 48; i++) {
			const call = toolCallBlock("bash", { command: `cmd ${i}` });
			const assistant = createAssistantMessage([call], "toolUse");
			msgs.push(assistant);
			msgs.push(toolResult(extractCalls(assistant)[0], testLog("ci", 30)));
			if (i % 5 === 0)
				msgs.push(createAssistantMessage([{ type: "thinking", thinking: "Note ".repeat(80) }], "stop"));
		}
		msgs.push(createAssistantMessage([{ type: "text", text: "conclusion" }], "stop"));

		const started = performance.now();
		const result = runTokenHarness(scene(["sys"], msgs));
		const elapsed = performance.now() - started;
		expect(result.ok).toBe(true);
		expect(result.report.modules.find(m => m.status === "applied")?.mutatedMessages ?? 0).toBeGreaterThan(0);
		expect(elapsed).toBeLessThan(500);
	});
});
