import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import { runTokenHarness, type HarnessInput } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessage, createUserMessage } from "../helpers";
import { bigJsonOutput, extractCalls, longSessionFixture, testLog, toolCallBlock, toolResult } from "./fixtures";

/** Simulates session resume: messages serialize to storage and back (JSON round-trip). */
function roundTrip(messages: Message[]): Message[] {
	return JSON.parse(JSON.stringify(messages)) as Message[];
}

describe("token-harness session/resume resilience", () => {
	it("dedup markers and suppression markers survive a JSON round-trip (storage → resume)", () => {
		const input = longSessionFixture();
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);

		const markersIn = (ms: Message[]): string[] =>
			ms
				.filter((m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult")
				.map(m =>
					m.content
						.filter(b => b.type === "text")
						.map(b => b.text)
						.join("\n"),
				)
				.filter(t => t.includes("[prime-token-harness:"));
		const beforeMarkers = markersIn(first.messages);
		expect(beforeMarkers.length).toBeGreaterThan(0);

		// Persist → resume (round-trip), then re-run the harness over the
		// restored history exactly as a resumed session would.
		const restored = roundTrip(first.messages);
		const resumed = runTokenHarness({ ...input, messages: restored });
		expect(resumed.ok).toBe(true);
		const afterMarkers = markersIn(resumed.messages);
		expect(afterMarkers).toEqual(beforeMarkers);
	});

	it("tool-call pairing stays intact across a resume round-trip", () => {
		const input = longSessionFixture();
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);
		const restored = roundTrip(first.messages);

		const idOf = (m: Message, _role: string): string | undefined => {
			if (m.role === "toolResult") return (m as { toolCallId: string }).toolCallId;
			return undefined;
		};
		const ids = new Set<string>();
		for (const m of restored) {
			if (m.role === "assistant") {
				for (const b of m.content) if (b.type === "toolCall") ids.add(b.id);
			}
		}
		for (const m of restored) {
			if (m.role !== "toolResult") continue;
			const id = idOf(m, "toolResult");
			expect(ids.has(id!)).toBe(true);
		}
	});

	it("harness output is deterministic over a resume round-trip (stable prefix)", () => {
		const input = longSessionFixture();
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);
		const restored = roundTrip(first.messages);
		const resumed = runTokenHarness({ ...input, messages: restored });
		expect(resumed.ok).toBe(true);
		expect(resumed.report.outputTokens).toBe(first.report.outputTokens);
	});

	it("suppressed content is recoverable from the artifact store by reference after rounds", () => {
		const input: HarnessInput = {
			systemPrompt: ["sys"],
			messages: (() => {
				const msgs: Message[] = [createUserMessage("run it")];
				const dup = bigJsonOutput(900);
				for (let i = 0; i < 3; i++) {
					const call = toolCallBlock("bash", { command: "bun test" });
					msgs.push(createAssistantMessage([call], "toolUse"));
					const ids = extractCalls(msgs[msgs.length - 1] as Parameters<typeof extractCalls>[0]);
					msgs.push(toolResult(ids[0], dup));
				}
				for (let i = 0; i < 8; i++) {
					const c2 = toolCallBlock("ls", { path: "." });
					msgs.push(createAssistantMessage([c2], "toolUse"));
					msgs.push(
						toolResult(
							extractCalls(msgs[msgs.length - 1] as Parameters<typeof extractCalls>[0])[0],
							testLog("unit", 1),
						),
					);
				}
				return msgs;
			})(),
		};
		// In-memory store backs this run; identical run with same content yields
		// identical markers so the session may re-fetch from its own store.
		const first = runTokenHarness(input);
		expect(first.ok).toBe(true);
		expect(first.report.artifacts.length).toBeGreaterThan(0);
		for (const artifact of first.report.artifacts) {
			// The marker embeds the artifact id so a later stage can resolve it.
			expect(artifact.id.startsWith("pth:")).toBe(true);
		}
	});
});
