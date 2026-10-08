import { describe, expect, it } from "bun:test";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import {
	runTokenHarness,
	type HarnessModule,
	type ProtectedKind,
	InMemoryArtifactStore,
} from "@oh-my-pi/pi-agent-core";
import { longSessionFixture, shortSessionFixture } from "./fixtures";

function roles(messages: readonly Message[]): string[] {
	return messages.map(m => m.role);
}

function resultTexts(messages: readonly Message[]): string[] {
	return messages
		.filter((m): m is ToolResultMessage => m.role === "toolResult")
		.map(m =>
			m.content
				.filter(b => b.type === "text")
				.map(b => b.text)
				.join("\n"),
		);
}

describe("token-harness pipeline contracts", () => {
	it("reduces provider-facing tokens on a tool-heavy session while keeping every message", () => {
		const input = longSessionFixture();
		const result = runTokenHarness(input);
		expect(result.ok).toBe(true);
		expect(result.messages.length).toBe(input.messages.length);
		expect(roles(result.messages)).toEqual(roles(input.messages));
		expect(result.report.outputTokens).toBeLessThan(result.report.inputTokens);
		expect(result.report.reductionPct).toBeGreaterThan(0);
	});

	it("fails open to the ORIGINAL message objects when a module throws", () => {
		const input = longSessionFixture();
		const exploding: HarnessModule = {
			name: "test.explode",
			stage: "compress",
			priority: 5,
			health: () => ({ status: "available" }),
			process() {
				throw new Error("boom");
			},
		};
		const result = runTokenHarness(input, undefined, { modules: [exploding] });
		expect(result.ok).toBe(false);
		expect(result.report.failure?.module).toBe("test.explode");
		expect(result.report.failure?.reason).toContain("boom");
		expect(result.messages).toBe(input.messages);
		expect(result.report.outputTokens).toBe(result.report.inputTokens);
	});

	it("fails open when validation cannot establish safety", () => {
		const input = longSessionFixture();
		const tamper: HarnessModule = {
			name: "test.tamper",
			stage: "suppress",
			priority: 5,
			health: () => ({ status: "available" }),
			process(state) {
				// Violates the protect contract: mutates a recent-window message.
				const i = state.messages.length - 1;
				state.messages[i] = { ...state.messages[i], role: "user" } as Message;
			},
		};
		// Build the module set with tamper + assemble + validate only.
		const validate = runTokenHarness(input, undefined, {
			modules: [
				tamper,
				{
					name: "assemble",
					stage: "assemble",
					priority: 10,
					health: () => ({ status: "available" }),
					process() {},
					validate: () => [],
				},
				{
					name: "validate",
					stage: "validate",
					priority: 10,
					health: () => ({ status: "available" }),
					process() {},
					validate: state => {
						const errors: string[] = [];
						if (state.systemPrompt !== state.baseline.systemPrompt) errors.push("system prompt was mutated");
						for (let i = state.protectedIndex.recentStart; i < state.baseline.messages.length; i++) {
							if (state.messages[i] !== state.baseline.messages[i])
								errors.push(`recent-window message ${i} was mutated`);
						}
						return errors;
					},
				},
			],
		});
		expect(validate.ok).toBe(false);
		expect(validate.report.failure?.module).toBe("validate");
		expect(validate.report.failure?.reason).toContain("recent-window message");
		expect(validate.messages).toBe(input.messages);
	});

	it("is idempotent: a second run over its own output changes nothing", () => {
		const input = longSessionFixture();
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);
		const second = runTokenHarness({ ...input, messages: [...first.messages] });
		expect(second.ok).toBe(true);
		expect(second.report.outputTokens).toBe(first.report.outputTokens);
		expect(resultTexts(second.messages)).toEqual(resultTexts(first.messages));
	});

	it("keeps the mutated-history prefix stable across appended turns (cache-friendly)", () => {
		const input = longSessionFixture();
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);
		// Append a new turn; re-run. Messages already processed in the first run
		// (i.e. already older than the recent window then) must be byte-stable
		// so the provider's cached prefix survives. The one message that aged
		// INTO the old region only changes once (the new suppression), then
		// stabilizes — the CAPC query-agnostic invariant.
		const appended = [...first.messages, { ...input.messages[input.messages.length - 4] }];
		const second = runTokenHarness({ ...input, messages: appended });
		expect(second.ok).toBe(true);
		const agedBoundary = first.messages.length - 8; // recentWindow default
		for (let i = 0; i < agedBoundary; i++) {
			expect(resultTexts([second.messages[i]])).toEqual(resultTexts([first.messages[i]]));
			expect(second.messages[i]).toBe(first.messages[i]);
		}
		expect(second.report.unchangedPrefixTokens).toBeGreaterThan(0);
	});

	it("preserves system prompt, tool schemas and the current instruction", () => {
		const input = longSessionFixture();
		const result = runTokenHarness(input);
		expect(result.ok).toBe(true);
		expect(result.report.protectedElements.map(p => p.kind).sort()).toEqual(
			(["current-instruction", "recent-turns", "system-prompt", "tool-schemas"] as ProtectedKind[]).sort(),
		);
		// Reference-locked: the harness passes them through untouched.
		expect(result.messages.length).toBeGreaterThan(0);
		const lastUser = input.messages.map(m => m.role).lastIndexOf("user");
		const outLastUser = result.messages.map(m => m.role).lastIndexOf("user");
		expect(outLastUser).toBe(lastUser);
		expect(result.messages[outLastUser]).toBe(input.messages[lastUser]);
	});

	it("bypasses when disabled or when the caller's shouldProcess rejects the input", () => {
		const input = shortSessionFixture();
		const off = runTokenHarness(input, { enabled: false });
		expect(off.ok).toBe(false);
		expect(off.report.bypassed).toBe(true);
		expect(off.messages).toBe(input.messages);

		const rejected = runTokenHarness(input, { shouldProcess: () => false });
		expect(rejected.ok).toBe(false);
		expect(rejected.report.bypassed).toBe(true);
		expect(rejected.messages).toBe(input.messages);
	});

	it("skips unavailable modules with a warning instead of failing", () => {
		const input = longSessionFixture();
		const unavailable: HarnessModule = {
			name: "test.unavailable",
			stage: "compress",
			priority: 5,
			health: () => ({ status: "unavailable", reason: "no model" }),
			process() {
				throw new Error("must not run");
			},
		};
		const result = runTokenHarness(input, undefined, { modules: [unavailable] });
		expect(result.ok).toBe(true);
		expect(result.report.warnings.some(w => w.includes("module unavailable"))).toBe(true);
		expect(result.report.modules.find(m => m.module === "test.unavailable")?.status).toBe("unavailable");
	});

	it("records artifacts for every suppressed tool output with retrievable full text", () => {
		const input = longSessionFixture();
		const store = new InMemoryArtifactStore();
		const result = runTokenHarness(input, { artifactStore: store });
		expect(result.ok).toBe(true);
		expect(result.report.artifacts.length).toBeGreaterThan(0);
		for (const artifact of result.report.artifacts) {
			const full = store.get(artifact.id);
			expect(full).toBeString();
			expect(full!.length).toBeGreaterThan(artifact.bytes * 0.9);
		}
		// The suppressed message references its artifact id.
		const anyMarker = resultTexts(result.messages).find(t => t.includes("local artifact pth:"));
		expect(anyMarker).toBeDefined();
	});

	it("never mutates the input array or its messages", () => {
		const input = longSessionFixture();
		const snapshot = [...input.messages];
		runTokenHarness(input);
		expect(input.messages).toEqual(snapshot);
		expect(input.messages.length).toBe(snapshot.length);
		for (let i = 0; i < snapshot.length; i++) expect(input.messages[i]).toBe(snapshot[i]);
	});
});
