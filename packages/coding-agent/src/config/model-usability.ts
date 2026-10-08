/**
 * The provider-usability authority.
 *
 * ## The defect this exists to close
 *
 * `disabledProviders` was enforced in exactly one place — `evaluateEligibility`,
 * the role-chain path (`packages/ai/src/utils/model-roles.ts:675`) — while four
 * other paths could still reach a disabled provider:
 *
 * - `ModelRuntime.updateModelSnapshot` filtered `available` on configured-auth or
 *   credential-free, never on disabled, so a disabled provider stayed a live
 *   failover candidate.
 * - `ModelRegistry.find` answered from the full catalog, so a literal
 *   `provider/id` recovered it.
 * - `getApiKeyForProvider` resolved auth unconditionally, so a request reached it
 *   and was given a credential.
 * - `resolvePlanExitTransition` restored a model captured before the provider was
 *   disabled.
 *
 * The upstream reference hit the identical defect and fixed it in `oh-my-pi`
 * commit `f10425abad` (PR #13194): with ambient AWS credentials, a
 * `retry.fallbackChains` entry naming an amazon-bedrock model sent the retry to
 * Bedrock despite `disabledProviders: [amazon-bedrock]`. Its fix was three
 * `isProviderDisabled` checks — the symptom-level version of this change, and
 * what would drift again on the next new path.
 *
 * ## The rule
 *
 * **A disabled provider is unusable. Nothing about a model makes it otherwise.**
 *
 * Precedence is explicit and total:
 *
 * 1. `disabled` — the user turned the provider off. Beats everything below.
 * 2. `blocked-by-policy` — a paid model when policy forbids spending.
 * 3. `unreachable` — no credential, and the model is not served anonymously.
 * 4. `usable`.
 *
 * A **free or credential-free model on a disabled provider is still disabled.**
 * That is the case a naive filter misses, because "needs no credentials" and "the
 * user disabled it" look like the same fact and are not: the first is a property
 * of the model, the second is an instruction.
 *
 * ## Why one authority rather than four checks
 *
 * The four paths above are the ones that exist today. A fifth — a new resolver, a
 * new fallback, an extension path — would be added by someone who cannot see the
 * other four. A single predicate with one call site per consumer makes a leak a
 * missing call rather than a forgotten rule, and the tests assert the predicate
 * directly so its contract is stated once.
 *
 * ## Live reads, not captured sets
 *
 * Consumers take a {@link DisabledProvidersReader}, not a set. A captured set
 * makes a live settings change invisible to whichever consumer was constructed
 * first, so re-enabling a provider would depend on construction order. A reader
 * makes it immediate, which is what "re-enabling works without a restart" means.
 */

import type { Model } from "@oh-my-pi/pi-catalog/types";

/**
 * Why a provider is or is not usable, in precedence order.
 *
 * The order is the rule. `disabled` outranks every other reason so a disabled
 * provider is never reported as merely unreachable: "you have no credential" and
 * "you turned this off" call for different user actions, and conflating them
 * makes a disable look like a login problem.
 */
export type ProviderUsability = "usable" | "disabled" | "unreachable" | "blocked-by-policy";

/** Everything the predicate needs, supplied by the caller rather than captured. */
export interface ProviderUsabilityInput {
	/** True when no credential exists for this provider. */
	readonly credentialMissing: boolean;
	/** True when the model is served without any credential. */
	readonly credentialFree: boolean;
	/** Whether policy permits spending. */
	readonly allowsPaid: boolean;
}

/**
 * The per-provider question: may this provider be used at all?
 *
 * A missing or empty set means "nothing is disabled", which is the correct
 * reading for a consumer with no settings access. It must never mean "everything
 * is disabled".
 */
export function isProviderUsable(provider: string, disabledProviders?: ReadonlySet<string>): boolean {
	return !disabledProviders?.has(provider);
}

/**
 * The full answer for one model: is it usable, and if not, why.
 *
 * Pure and total, so every refusal is explainable. The disabled check is taken
 * from the caller rather than captured, so it stays live across a settings change.
 */
export function evaluateModelUsability(
	model: Pick<Model, "provider" | "free">,
	input: ProviderUsabilityInput & { readonly disabledProviders?: ReadonlySet<string> },
): ProviderUsability {
	// Disabling wins over everything, including a model that needs no credential.
	// A "filter by whether it needs auth" check would let this through.
	if (!isProviderUsable(model.provider, input.disabledProviders)) return "disabled";
	// The free-stays-free guarantee, expressed the way `selectFailoverCandidate`
	// expresses it: `free` is opt-in and never derived from cost, and the block
	// applies only when the model is not marked free. Keeping the two in step
	// matters — a second, subtly different reading of "paid" here would let a model
	// through that failover refuses, or refuse one it would have used.
	if (model.free !== true && !input.allowsPaid) return "blocked-by-policy";
	if (!input.credentialFree && input.credentialMissing) return "unreachable";
	return "usable";
}

/**
 * A live reader of the disabled set.
 *
 * Passed as a function so a settings change reaches every consumer immediately,
 * including consumers constructed before the change.
 */
export type DisabledProvidersReader = () => ReadonlySet<string>;
