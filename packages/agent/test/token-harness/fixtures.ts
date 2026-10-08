/**
 * Representative coding-agent session fixtures for the Prime Token Harness
 * prototype. All timestamps are fixed for deterministic tests.
 */
import type { AssistantMessage, ToolResultMessage, Tool } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import type { HarnessInput } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessage, createUserMessage } from "../helpers";

const TS = 1_700_000_000_000;
let callSeq = 0;

export function toolCallBlock(name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
	return { type: "toolCall", id: `call_${++callSeq}`, name, arguments: args };
}

export function assistantCall(
	call: ReturnType<typeof toolCallBlock>,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return createAssistantMessage([call], stopReason);
}

export function toolResult(call: { id: string; name: string }, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: TS,
	};
}

type ToolCallBlock = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export function extractCalls(message: AssistantMessage): { id: string; name: string }[] {
	return message.content
		.filter((block): block is ToolCallBlock => block.type === "toolCall")
		.map(block => ({ id: block.id, name: block.name }));
}

/** A repeating CI test log — the classic resent-every-turn tool output. */
export function testLog(suite: string, rounds: number): string {
	const lines: string[] = [`> ${suite} :: run`, ""];
	for (let i = 0; i < rounds; i++) {
		lines.push(`ok ${i + 1} - should compute value ${i}`);
		lines.push(`ok ${i + 2} - should handle input ${i}`);
	}
	lines.push(`# tests ${rounds * 2}`, `# pass ${rounds * 2}`, `# fail 0`, `# duration 3.4s`);
	return lines.join("\n");
}

/** A compiler-style failure log with error lines scattered deep in the body. */
export function buildFailureLog(errors: number): string {
	const lines: string[] = ["$ tsc -p . --noEmit"];
	for (let i = 0; i < 40; i++) lines.push(`src/generated/file-${i}.ts: compiling…`);
	for (let i = 0; i < errors; i++) {
		lines.push(`src/module-${i}.ts(12,5): error TS2345: Argument of type 'string' is not assignable.`);
		lines.push(`    at compile (src/compiler.ts:88:9)`);
	}
	lines.push("Build failed with 40 errors.");
	return lines.join("\n");
}

export function bigJsonOutput(count: number): string {
	const rows = Array.from({ length: count }, (_, i) => ({
		id: i,
		name: `artifact-${i}`,
		size: 1024 + i,
		tags: ["generated", "fixture", `batch-${Math.floor(i / 10)}`],
	}));
	return JSON.stringify({ artifacts: rows }, null, 2);
}

export function fencedCodeFile(): string {
	return [
		"# Implementation notes",
		"",
		"The parser below is load-bearing:",
		"",
		"```python",
		"def parse(line):",
		"    # trailing spaces inside fence must survive   ",
		"",
		"",
		"",
		"    return line.split(':')[1]",
		"```",
		"",
		"End of notes.",
		"",
		"",
		"",
		"   ",
		"Trailing-whitespace line outside fence   ",
	].join("\n");
}

export function toolsFixture(): Tool[] {
	return [
		{
			name: "bash",
			description: "Run a shell command",
			parameters: type({ command: "string" }),
		},
	];
}

/** Long, tool-heavy session: repeated logs, huge outputs, old reasoning, errors. */
export function longSessionFixture(): HarnessInput {
	const messages: (ReturnType<typeof createUserMessage> | AssistantMessage | ToolResultMessage)[] = [];
	messages.push(createUserMessage("Run the full test suite and fix the build."));

	// 8 identical CI reruns (repeated content target) + huge outputs.
	for (let i = 0; i < 8; i++) {
		const call = toolCallBlock("bash", { command: "bun test" });
		messages.push(assistantCall(call));
		const { id, name } = extractCalls(messages[messages.length - 1] as AssistantMessage)[0];
		messages.push(toolResult({ id, name }, testLog("unit", 40)));
		messages.push(createUserMessage("re-run")); // repetitive narration
		messages.push(createUserMessage("re-run"));
	}

	// Huge JSON artifact dump + failing build log with deep error lines.
	const jsonCall = toolCallBlock("bash", { command: "ls -la" });
	messages.push(assistantCall(jsonCall));
	const jsonIds = extractCalls(messages[messages.length - 1] as AssistantMessage)[0];
	messages.push(toolResult(jsonIds, bigJsonOutput(300)));

	const failCall = toolCallBlock("bash", { command: "npm run build" });
	messages.push(assistantCall(failCall));
	const failIds = extractCalls(messages[messages.length - 1] as AssistantMessage)[0];
	messages.push(toolResult(failIds, buildFailureLog(6), true));

	// Old assistant reasoning (select target).
	messages.push(
		createAssistantMessage(
			[
				{ type: "thinking", thinking: "Long discarded reasoning. ".repeat(200) },
				{ type: "text", text: "Let me inspect the failing module." },
			],
			"stop",
		),
	);

	// Code-heavy tool output (compress must not corrupt fenced code).
	const codeCall = toolCallBlock("read", { path: "parser.py" });
	messages.push(assistantCall(codeCall));
	const codeIds = extractCalls(messages[messages.length - 1] as AssistantMessage)[0];
	messages.push(toolResult(codeIds, fencedCodeFile()));

	// Recent tail: 4 messages that must stay verbatim.
	messages.push(createAssistantMessage([{ type: "text", text: "Found the bug in the parser." }], "stop"));
	messages.push(createUserMessage("Fix it and add a regression test."));
	const finalCall = toolCallBlock("edit", { path: "parser.py" });
	messages.push(assistantCall(finalCall));
	const finalIds = extractCalls(messages[messages.length - 1] as AssistantMessage)[0];
	messages.push(toolResult(finalIds, "Edited parser.py: fixed delimiter handling."));

	return {
		systemPrompt: ["You are PrimePi, a coding agent. Follow the project rules exactly."],
		messages: messages as HarnessInput["messages"],
		tools: toolsFixture(),
	};
}

/** Small session where the harness should be a near no-op. */
export function shortSessionFixture(): HarnessInput {
	return {
		systemPrompt: ["Be brief."],
		messages: [createUserMessage("What is 2+2?")],
	};
}
