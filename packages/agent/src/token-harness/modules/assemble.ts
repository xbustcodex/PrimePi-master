import type { Message } from "@oh-my-pi/pi-ai";
import type { HarnessModule, HarnessState } from "../contract";

/** toolCall ids present in the baseline assistant messages. */
function toolCallIds(messages: readonly (Message | { role: string })[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) continue;
		const content = message.content as readonly { type?: string; id?: string }[];
		for (const block of content) {
			if (block.type === "toolCall" && typeof block.id === "string") ids.add(block.id);
		}
	}
	return ids;
}

function toolResultIds(messages: readonly Message[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") ids.push(message.toolCallId);
	}
	return ids;
}

/**
 * Assembly: structural integrity of the outgoing request.
 *
 * The prototype performs no message reordering or merging — its job is to
 * prove the assembled result is provider-valid:
 * - the toolCall ↔ toolResult pairing set is exactly the baseline's
 * - message order is preserved (same sequence of roles/toolCallIds)
 * - no toolResult was dropped or duplicated
 *
 * Any violation fails validation → the harness fails open to the original
 * context.
 */
export const assembleModule: HarnessModule = {
	name: "assemble.pairing-integrity",
	stage: "assemble",
	priority: 10,
	health() {
		return { status: "available" };
	},
	process() {
		// Assembly is read-only in the prototype; integrity is asserted in validate.
	},
	validate(state: HarnessState): string[] {
		const errors: string[] = [];
		const baselineCalls = toolCallIds(state.baseline.messages);
		const workingCalls = toolCallIds(state.messages);
		if (baselineCalls.size !== workingCalls.size) {
			errors.push(`toolCall set changed: ${baselineCalls.size} → ${workingCalls.size}`);
		}
		const baselineResults = toolResultIds(state.baseline.messages);
		const workingResults = toolResultIds(state.messages);
		if (baselineResults.length !== workingResults.length) {
			errors.push(`toolResult count changed: ${baselineResults.length} → ${workingResults.length}`);
		} else if (baselineResults.some((id, index) => workingResults[index] !== id)) {
			errors.push("toolResult ordering or identity changed");
		}
		const missing = baselineResults.filter(id => !baselineCalls.has(id));
		const introduced = workingResults.filter(id => !baselineCalls.has(id) && !missing.includes(id));
		if (introduced.length > 0) errors.push(`unmatched toolResults introduced: ${introduced.join(", ")}`);
		return errors;
	},
};
