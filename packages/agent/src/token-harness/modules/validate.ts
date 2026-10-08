import type { HarnessModule, HarnessState } from "../contract";

/**
 * Validation: the protect contract. Returns human-readable violations; the
 * pipeline treats ANY violation as a fail-open to the original context.
 *
 * Checks:
 * - system prompt: same array reference (never cloned ⇒ never mutated)
 * - tool schemas: same array reference
 * - recent window: every trailing message is object-identical to baseline
 *   (modules clone only what they modify, so identity proves byte-equality)
 * - current instruction: object-identical to baseline
 * - message count preserved
 */
export const validateModule: HarnessModule = {
	name: "validate.protect-contract",
	stage: "validate",
	priority: 10,
	health() {
		return { status: "available" };
	},
	process() {
		// Validation is expressed entirely through validate().
	},
	validate(state: HarnessState): string[] {
		const errors: string[] = [];
		if (state.systemPrompt !== state.baseline.systemPrompt) {
			errors.push("system prompt was mutated");
		}
		if (state.tools !== state.baseline.tools) {
			errors.push("tool schemas were mutated");
		}
		if (state.messages.length !== state.baseline.messages.length) {
			errors.push(`message count changed: ${state.baseline.messages.length} → ${state.messages.length}`);
		}
		const start = state.protectedIndex.recentStart;
		for (let i = start; i < state.baseline.messages.length; i++) {
			if (state.messages[i] !== state.baseline.messages[i]) {
				errors.push(`recent-window message ${i} was mutated`);
			}
		}
		const instruction = state.protectedIndex.currentInstructionIndex;
		if (instruction !== undefined && state.messages[instruction] !== state.baseline.messages[instruction]) {
			errors.push(`current instruction message ${instruction} was mutated`);
		}
		return errors;
	},
};
