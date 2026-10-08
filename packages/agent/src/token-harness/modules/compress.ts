import type { Message } from "@oh-my-pi/pi-ai";
import type { HarnessContext, HarnessModule, HarnessState } from "../contract";
import { hasHarnessMarker, normalizeHistoryText } from "../util";

/**
 * Compression (deterministic, no learned model): whitespace/log-noise
 * normalization on lower-sensitivity history older than the recent window.
 *
 * - trailing whitespace stripped outside code fences
 * - ≥3 consecutive blank lines collapsed to one outside code fences
 * - content inside ``` fences is never touched (code fidelity)
 * - the current instruction and system prompt are never touched (protect)
 *
 * Fallback path: if the transformed text would not shrink the message, the
 * original object is kept (identity preserved for the tokenizer cache).
 */
export const compressModule: HarnessModule = {
	name: "compress.normalize-history",
	stage: "compress",
	priority: 10,
	accepts: ["user", "assistant", "tool-result"],
	health() {
		return { status: "available" };
	},
	process(state: HarnessState, _ctx: HarnessContext): void {
		let mutated = 0;
		const instruction = state.protectedIndex.currentInstructionIndex;
		for (let i = 0; i < state.protectedIndex.recentStart; i++) {
			if (i === instruction) continue;
			const message = state.messages[i];
			if (message.role === "user" || message.role === "developer") {
				if (typeof message.content !== "string") {
					let changed = false;
					const content = message.content.map(block => {
						if (block.type !== "text") return block;
						const next = normalizeHistoryText(block.text);
						if (next === block.text) return block;
						changed = true;
						return { ...block, text: next };
					});
					if (changed) {
						state.messages[i] = { ...message, content };
						mutated++;
					}
					continue;
				}
				const next = normalizeHistoryText(message.content);
				if (next !== message.content) {
					state.messages[i] = { ...message, content: next };
					mutated++;
				}
				continue;
			}
			if (message.role !== "assistant" && message.role !== "toolResult") continue;
			if (message.role === "toolResult" && message.content.some(b => b.type === "image")) continue;
			let changed = false;
			const content = message.content.map(block => {
				if (block.type !== "text") return block;
				if (hasHarnessMarker(block.text)) return block;
				const next = normalizeHistoryText(block.text);
				if (next === block.text) return block;
				changed = true;
				return { ...block, text: next };
			});
			if (changed) {
				// Text blocks keep their shape; only text fields change.
				state.messages[i] = { ...message, content } as Message;
				mutated++;
			}
		}
		if (mutated > 0) state.mutated[this.name] = mutated;
	},
};
