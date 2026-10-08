import type { HarnessContext, HarnessModule, HarnessState } from "../contract";

/**
 * Selection: message-tier policy. The recent window stays verbatim; older
 * assistant reasoning (`thinking` blocks) is history the provider no longer
 * needs to re-receive — the same material OMP's `shake` already drops in
 * emergency compaction. Content structure (tool calls, text) is untouched.
 *
 * Stripping only applies to messages OLDER than the recent window, so the
 * turn currently being reasoned about keeps its full reasoning.
 */
export const selectModule: HarnessModule = {
	name: "select.age-out-reasoning",
	stage: "select",
	priority: 10,
	accepts: ["assistant"],
	health() {
		return { status: "available" };
	},
	process(state: HarnessState, _ctx: HarnessContext): void {
		let mutated = 0;
		for (let i = 0; i < state.protectedIndex.recentStart; i++) {
			const message = state.messages[i];
			if (message.role !== "assistant") continue;
			if (!message.content.some(block => block.type === "thinking")) continue;
			state.messages[i] = {
				...message,
				content: message.content.filter(block => block.type !== "thinking"),
			};
			mutated++;
		}
		if (mutated > 0) state.mutated[this.name] = mutated;
	},
};
