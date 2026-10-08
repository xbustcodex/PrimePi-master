/**
 * Automatic model failover: choosing a replacement model for an unfinished turn.
 *
 * Two invariants dominate the design.
 *
 * 1. **Free stays free.** When the active model is free and the policy is
 *    `free-only`, a paid model is never selected, even if one is reachable. Lack of
 *    a free route is reported as a clean stop, never as permission to spend money.
 *
 * 2. **Candidates must fit the turn.** Switching to an incompatible model would
 *    corrupt the reply, so tool-calling, modality, and context requirements are
 *    checked before a candidate is eligible.
 *
 * Candidates are ranked deterministically so a failover cycle is reproducible, and
 * every candidate already attempted in the cycle is excluded, which bounds the cycle
 * and makes A -> B -> A impossible.
 */

import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import type { AvailabilityCooldowns } from "./availability-cooldowns";

/**
 * How far failover may range.
 *
 * `off` disables automatic failover entirely. `same-provider` stays on the current
 * provider. `free-only` is restricted to free models and is the safe default for
 * recovering free routes. `compatible` may pick a paid model and therefore requires
 * explicit configuration.
 */
export type FailoverPolicy = "off" | "same-provider" | "free-only" | "compatible";

/** Requirements the unfinished turn imposes on a replacement model. */
export interface TurnRequirements {
	/** Context window must cover the current transcript size. */
	requiredContextTokens?: number;
	/** The conversation contains images, so the replacement must accept them. */
	requiresImageInput?: boolean;
	/** The turn asked for reasoning, so the replacement must support it. */
	requiresReasoning?: boolean;
	/** Tool definitions are in play, so the replacement must support tool calling. */
	requiresTools?: boolean;
}

export interface FailoverCandidateInput {
	model: Model<Api>;
	/** Set when the candidate is known to need credentials that are not present. */
	credentialMissing?: boolean;
}

export type UnavailableReason =
	| { kind: "disabled" }
	| { kind: "exhausted"; considered: number; freeRequired: boolean; blocked: string[] };

export interface FailoverDecision {
	model: Model<Api>;
	/** Why this candidate was chosen, for the user-facing notice. */
	reason: string;
}

/** The api a replacement must speak to keep the turn's tool calls valid. */
const TOOL_CAPABLE_APIS: readonly Api[] = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"google-generative-ai",
	"bedrock-converse-stream",
	"mistral-conversations",
];

/** Whether a model can carry the turn's tool definitions. */
function supportsToolCalling(model: Model<Api>): boolean {
	// Only chat apis that implement tool calling can resume a coding turn. Image and
	// classifier models are excluded because their apis are not in this list.
	return TOOL_CAPABLE_APIS.includes(model.api);
}

function isCompatible(model: Model<Api>, requirements: TurnRequirements): boolean {
	if (requirements.requiresTools && !supportsToolCalling(model)) return false;
	if (requirements.requiresImageInput && !model.input.includes("image")) return false;
	if (requirements.requiresReasoning && model.reasoning !== true) return false;
	if (
		requirements.requiredContextTokens !== undefined &&
		model.contextWindow !== null &&
		model.contextWindow < requirements.requiredContextTokens
	) {
		return false;
	}
	return true;
}

/**
 * Whether a policy permits selecting a paid model.
 *
 * Only `compatible` may. This is the single place the free-stays-free guarantee is
 * enforced for candidate selection, so it is deliberately a total function over the
 * policy rather than a check scattered through the selector.
 */
export function policyAllowsPaid(policy: FailoverPolicy): boolean {
	return policy === "compatible";
}

/**
 * Picks a replacement model, or explains why none is usable.
 *
 * `attempted` holds `provider:id` for every candidate already tried in this failover
 * cycle, which is what prevents oscillation.
 */
/**
 * The one-line notice shown when Pi switches models on its own.
 *
 * Automatic failover must never be silent: the user is being moved to a different
 * provider, possibly a different account, and needs to see it. Actual ids are used
 * rather than generic wording so the notice is actionable.
 *
 * `noticeKey` lets the caller de-duplicate: repeated failures of the same transition
 * in the same cycle should not spam.
 */
export function failoverNotice(input: {
	failed: Model<Api>;
	reason: string;
	scope: string;
	replacement: Model<Api>;
	resetAtMs?: number;
}): { text: string; noticeKey: string } {
	const until =
		input.resetAtMs === undefined
			? undefined
			: `${new Date(input.resetAtMs).toISOString().replace("T", " ").slice(0, 16)}Z`;
	const suffix = until === undefined ? "" : ` until ${until}`;
	const text =
		`${input.failed.id} [${input.failed.provider}] ${input.reason} (${input.scope}${suffix})` +
		`\n→ continuing with ${input.replacement.id} [${input.replacement.provider}]`;
	return {
		text,
		noticeKey: `${input.failed.provider}:${input.failed.id}->${input.replacement.provider}:${input.replacement.id}`,
	};
}

export function selectFailoverCandidate(input: {
	failed: Model<Api>;
	policy: FailoverPolicy;
	candidates: readonly FailoverCandidateInput[];
	requirements: TurnRequirements;
	cooldowns: AvailabilityCooldowns;
	attempted: ReadonlySet<string>;
	now: number;
}): FailoverDecision | { unavailable: UnavailableReason } {
	const { failed, policy, candidates, requirements, cooldowns, attempted, now } = input;
	if (policy === "off") return { unavailable: { kind: "disabled" } };

	const failedKey = `${failed.provider}:${failed.id}`;
	// The active model is free, so recovery must not silently start spending money.
	const freeRequired = failed.free === true && !policyAllowsPaid(policy);

	const eligible: FailoverDecision[] = [];
	const blocked: string[] = [];
	let considered = 0;

	for (const candidate of candidates) {
		const model = candidate.model;
		const key = `${model.provider}:${model.id}`;
		if (key === failedKey) continue;
		considered++;
		if (attempted.has(key)) {
			blocked.push(`${model.id} [${model.provider}] already attempted`);
			continue;
		}
		if (candidate.credentialMissing) {
			blocked.push(`${model.id} [${model.provider}] missing credentials`);
			continue;
		}
		if (cooldowns.isModelUnavailable({ provider: model.provider, modelId: model.id, now })) {
			const reasons = cooldowns.reasonsForModel({ provider: model.provider, modelId: model.id, now });
			const scope = reasons[0]?.scope ?? "model";
			blocked.push(`${model.id} [${model.provider}] unavailable (${scope})`);
			continue;
		}
		if (freeRequired && model.free !== true) {
			blocked.push(`${model.id} [${model.provider}] is not free and the policy forbids paid models`);
			continue;
		}
		if (policy === "same-provider" && model.provider !== failed.provider) continue;
		if (!isCompatible(model, requirements)) {
			blocked.push(`${model.id} [${model.provider}] incompatible with the unfinished turn`);
			continue;
		}
		eligible.push({
			model,
			reason: model.free === true ? "free replacement route" : "compatible replacement route",
		});
	}

	if (eligible.length === 0) {
		return { unavailable: { kind: "exhausted", considered, freeRequired, blocked } };
	}

	// Prefer the same provider so a single-provider outage does not silently spread,
	// then prefer anonymous access (fewest credentials to go wrong), then keep the
	// runtime's own ordering as the final tie-break for determinism.
	eligible.sort((a, b) => {
		const providerDelta = Number(b.model.provider === failed.provider) - Number(a.model.provider === failed.provider);
		if (providerDelta !== 0) return providerDelta;
		const accessDelta = Number(b.model.access === "anonymous") - Number(a.model.access === "anonymous");
		if (accessDelta !== 0) return accessDelta;
		return 0;
	});

	return eligible[0];
}
