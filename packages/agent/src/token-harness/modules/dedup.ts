import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { HarnessContext, HarnessModule, HarnessState } from "../contract";
import { hasHarnessMarker } from "../util";

function resultText(result: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

function withText(result: ToolResultMessage, text: string): ToolResultMessage {
	return {
		...result,
		content: result.content.map(block => (block.type === "text" ? { ...block, text } : block)),
	};
}

/**
 * Deduplication: collapses EXACT duplicate tool outputs in history older than
 * the recent window. The first occurrence keeps its full text; later
 * occurrences become a deterministic reference marker (the content still
 * exists locally — session JSONL retains it, and the first occurrence keeps
 * it on the wire). Idempotent: markers never re-match the duplicate index.
 */
export const dedupModule: HarnessModule = {
	name: "dedup.exact-tool-outputs",
	stage: "dedup",
	priority: 10,
	accepts: ["tool-result"],
	health() {
		return { status: "available" };
	},
	process(state: HarnessState, ctx: HarnessContext): void {
		const minChars = ctx.config.dedupMinChars;
		/** normalized text → index of first occurrence (older than recent window). */
		const seen = new Map<string, number>();
		let mutated = 0;
		for (let i = 0; i < state.messages.length; i++) {
			const message = state.messages[i];
			if (message.role !== "toolResult") continue;
			const text = resultText(message);
			if (text.length < minChars || hasHarnessMarker(text)) continue;
			const key = text.trim().replace(/\r\n/g, "\n");
			const first = seen.get(key);
			if (first === undefined) {
				seen.set(key, i);
				continue;
			}
			if (i >= state.protectedIndex.recentStart) continue;
			const marker =
				`[prime-token-harness: duplicate of tool output at message ${first}; ` +
				`${text.length} chars collapsed, content retained there …]`;
			state.messages[i] = withText(message, marker);
			mutated++;
		}
		if (mutated > 0) state.mutated[this.name] = mutated;
	},
};
