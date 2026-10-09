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
	/**
	 * Full routed selector for `model`. Two upstream routes of one model id
	 * (`provider/id@cerebras` vs `provider/id@chutes`) are different failures with
	 * different recovery, so identity has to carry the route. The caller owns this
	 * because the route lives in host-specific catalog policy; without it,
	 * `provider:id` collapses a working route into "the model that just failed".
	 */
	selector?: string;
	/** Set when the candidate is known to need credentials that are not present. */
	credentialMissing?: boolean;
}

/** Identity used for de-duplication: the routed selector when given, else `provider:id`. */
function identity(model: Model<Api>, selector: string | undefined): string {
	return selector ?? `${model.provider}:${model.id}`;
}

export type UnavailableReason =
	| { kind: "disabled" }
	| { kind: "exhausted"; considered: number; freeRequired: boolean; blocked: string[] };

export interface FailoverDecision {
	model: Model<Api>;
	/** Routed selector of the chosen candidate, so the caller dispatches this exact route. */
	selector: string;
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
 * `attempted` holds the routed selector of every candidate already tried in this
 * failover cycle, which is what prevents oscillation.
 */
export function selectFailoverCandidate(input: {
	failed: Model<Api>;
	/** Full routed selector for `failed`; see {@link FailoverCandidateInput.selector}. */
	failedSelector?: string;
	policy: FailoverPolicy;
	candidates: readonly FailoverCandidateInput[];
	requirements: TurnRequirements;
	cooldowns: AvailabilityCooldowns;
	attempted: ReadonlySet<string>;
	now: number;
}): FailoverDecision | { unavailable: UnavailableReason } {
	const { failed, policy, candidates, requirements, cooldowns, attempted, now } = input;
	const failedKey = identity(failed, input.failedSelector);
	if (policy === "off") return { unavailable: { kind: "disabled" } };

	// The active model is free, so recovery must not silently start spending money.
	const freeRequired = failed.free === true && !policyAllowsPaid(policy);

	const eligible: FailoverDecision[] = [];
	const blocked: string[] = [];
	let considered = 0;

	for (const candidate of candidates) {
		const model = candidate.model;
		const key = identity(model, candidate.selector);
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
		// The candidate's own route decides whether a recorded failure applies: a
		// sibling upstream is still a working recovery after one route breaks.
		const route = { provider: model.provider, modelId: model.id, baseUrl: model.baseUrl, now };
		if (cooldowns.isModelUnavailable(route)) {
			const reasons = cooldowns.reasonsForModel(route);
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
			selector: key,
			reason: model.free === true ? "free replacement route" : "compatible replacement route",
		});
	}

	if (eligible.length === 0) {
		return { unavailable: { kind: "exhausted", considered, freeRequired, blocked } };
	}

	// The surviving list keeps the order the caller built it in, which is the
	// operator's configured fallback chain. Re-ranking by provider or credential
	// need would silently override that configuration: a chain that deliberately
	// moves cross-provider must be allowed to do so even when a same-provider
	// sibling is still listed.
	return eligible[0];
}
