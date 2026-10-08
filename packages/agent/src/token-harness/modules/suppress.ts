import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { HarnessContext, HarnessModule, HarnessState } from "../contract";
import { hasHarnessMarker, truncatePreservingErrors } from "../util";

function resultText(result: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

/**
 * Suppression: per-tool-result output budget for history older than the
 * recent window (the AWS-Strands-style 1,500-token convention).
 *
 * - head-preserving truncation with error-line retention (failures stay
 *   visible after suppression)
 * - full original text written to the local artifact store ("store large,
 *   send small") and referenced by id in the marker
 * - idempotent: a result carrying a harness marker is never re-suppressed
 * - `isError` results still get budgeted (resolved errors are history), but
 *   the head + error lines guarantee the failure itself survives
 * - recent-window results are NEVER touched (critical context)
 */
export const suppressModule: HarnessModule = {
	name: "suppress.tool-output-budget",
	stage: "suppress",
	priority: 10,
	accepts: ["tool-result"],
	health() {
		return { status: "available" };
	},
	process(state: HarnessState, ctx: HarnessContext): void {
		const budget = ctx.config.toolResultBudgetTokens;
		let mutated = 0;
		for (let i = 0; i < state.protectedIndex.recentStart; i++) {
			const message = state.messages[i];
			if (message.role !== "toolResult") continue;
			const text = resultText(message);
			if (text.length === 0 || hasHarnessMarker(text)) continue;
			const truncated = truncatePreservingErrors(text, budget, t => ctx.tokenizer.countTokens(t));
			if (!truncated) continue;
			const artifact = ctx.store.put(text, { messageIndex: i, toolName: message.toolName });
			artifact.tokens = ctx.tokenizer.countTokens(text);
			const marker =
				`\n… [prime-token-harness: output reduced ` +
				`${ctx.tokenizer.countTokens(text)} → ~${budget} tokens, ` +
				`${truncated.removedLines}/${truncated.totalLines} lines, ` +
				`full text in local artifact ${artifact.id} …]`;
			state.messages[i] = {
				...message,
				content: message.content.map(block =>
					block.type === "text" ? { ...block, text: truncated.kept + marker } : block,
				),
			};
			state.artifacts.push(artifact);
			mutated++;
		}
		if (mutated > 0) state.mutated[this.name] = mutated;
	},
};
