import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import {
	decideTokenHarness,
	getTokenHarnessStats,
	PersistedTokenHarnessStore,
	resetDefaultPersistedHarnessStore,
	resetTokenHarnessStats,
} from "@oh-my-pi/pi-coding-agent/session/token-harness-integration";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";

const TS = 1_700_000_000_000;
let tempDir = "";

function chatModel() {
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		tokenizer: "claude-v5",
	});
}

function localModel() {
	return buildModel({
		id: "llama3.2",
		name: "Llama 3.2",
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "http://localhost:11434",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
		maxTokens: 4096,
	});
}

function bigLog(rounds: number): string {
	const lines = [`> suite :: run`, ""];
	for (let i = 0; i < rounds; i++) {
		lines.push(`ok ${i + 1} - should compute value ${i}`);
		lines.push(`ok ${i + 2} - should handle input ${i}`);
	}
	lines.push("# tests 2", "# pass 2", "# fail 0");
	return lines.join("\n");
}

function toolHeavyContext(): {
	context: { systemPrompt?: string[]; messages: Message[]; tools: import("@oh-my-pi/pi-ai").Tool[] };
	passthrough: Message[];
} {
	const messages: Message[] = [{ role: "user", content: "run the suite and report", timestamp: TS } as Message];
	for (let i = 0; i < 8; i++) {
		messages.push({
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${i}`, name: "bash", arguments: { command: `run ${i}` } }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: TS,
		} as Message);
		messages.push({
			role: "toolResult",
			toolCallId: `call_${i}`,
			toolName: "bash",
			content: [{ type: "text", text: bigLog(250) }],
			isError: false,
			timestamp: TS,
		} as Message);
	}
	messages.push({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: TS,
	} as Message);
	const passthrough = [...messages];
	return { context: { systemPrompt: ["You are PrimePi."], messages, tools: [] }, passthrough };
}

describe("token-harness production integration", () => {
	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "token-harness-"));
		const old = getConfigRootDir();
		await setAgentDir(tempDir);
		return () => setAgentDir(old);
	});
	afterAll(async () => {
		resetSettingsForTest();
		resetDefaultPersistedHarnessStore();
		await rm(tempDir, { recursive: true, force: true });
	});
	afterEach(() => {
		resetTokenHarnessStats();
	});

	function settingsWith(flag: "enabled" | "shadow") {
		const key = flag === "enabled" ? "tokenHarness.enabled" : "tokenHarness.shadowEnabled";
		return Settings.isolated({ [key]: true });
	}

	it("is disabled by default: the provider receives the exact original context", () => {
		const { context, passthrough } = toolHeavyContext();
		const seen: Message[] = [];
		const fn = createSettingsAwareStreamFn(Settings.isolated({}), (_m, ctx) => {
			seen.push(...ctx.messages);
			return { async *[Symbol.asyncIterator]() {} } as unknown as AssistantMessageEventStream;
		});
		fn(chatModel(), context);
		expect(seen).toEqual(passthrough);
		expect(getTokenHarnessStats().active).toBe(0);
		expect(getTokenHarnessStats().shadow).toBe(0);
	});

	it("shadow mode: computes savings but dispatches the ORIGINAL context", () => {
		const { context, passthrough } = toolHeavyContext();
		const seen: Message[] = [];
		const fn = createSettingsAwareStreamFn(settingsWith("shadow"), (_m, ctx) => {
			seen.push(...ctx.messages);
			return {} as unknown as AssistantMessageEventStream;
		});
		fn(chatModel(), context);
		expect(seen).toEqual(passthrough);
		expect(getTokenHarnessStats().shadow).toBe(1);
		expect(getTokenHarnessStats().lastReport?.reductionPct).toBeGreaterThan(20);
		expect(getTokenHarnessStats().lastReport?.failure).toBeUndefined();
	});

	it("active mode: the provider receives the harness-reduced context", () => {
		const { context, passthrough } = toolHeavyContext();
		const seen: Message[] = [];
		const fn = createSettingsAwareStreamFn(settingsWith("enabled"), (_m, ctx) => {
			seen.push(...ctx.messages);
			return {} as unknown as AssistantMessageEventStream;
		});
		fn(chatModel(), context);
		expect(seen).not.toEqual(passthrough);
		expect(seen.length).toBe(passthrough.length);
		expect(getTokenHarnessStats().active).toBe(1);
		expect(getTokenHarnessStats().lastReport?.outputTokens).toBeLessThan(
			getTokenHarnessStats().lastReport?.inputTokens ?? 0,
		);
	});

	it("bypasses on-device runtimes even when enabled", () => {
		const { context, passthrough } = toolHeavyContext();
		const seen: Message[] = [];
		const fn = createSettingsAwareStreamFn(settingsWith("enabled"), (_m, ctx) => {
			seen.push(...ctx.messages);
			return {} as unknown as AssistantMessageEventStream;
		});
		fn(localModel(), context);
		expect(seen).toEqual(passthrough);
		expect(getTokenHarnessStats().bypassed).toBe(1);
		expect(getTokenHarnessStats().active).toBe(0);
	});

	it("persisted store: suppresses outputs to deterministic files retrievable from a fresh instance", () => {
		const storeA = new PersistedTokenHarnessStore(join(tempDir, "artifacts"));
		const { context } = toolHeavyContext();
		const model = chatModel();
		const decision = decideTokenHarness(settingsWith("enabled"), model, context, new Tokenizer(model), storeA);
		expect(decision.mode).toBe("active");
		expect((decision as { report: { artifacts: unknown[] } }).report.artifacts.length).toBeGreaterThan(0);
		const artifact = (decision as { report: { artifacts: Array<{ id: string }> } }).report.artifacts[0];
		const storeB = new PersistedTokenHarnessStore(join(tempDir, "artifacts"));
		const recovered = storeB.get(artifact.id);
		expect(recovered).toBeString();
		expect(recovered!.includes("should compute value")).toBe(true);
		// Deterministic id: re-put returns the same id and does not duplicate the file.
		const secondPut = storeB.put(recovered!, { messageIndex: 0 });
		expect(secondPut.id).toBe(artifact.id);
	});
});
