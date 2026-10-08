/**
 * Free-tier and credential-free model classification.
 *
 * Ported from PrimePi `packages/ai/src/utils/free-model.ts`; adapted to the
 * OMP catalog ownership rule: this lives next to the model truth and is the
 * single source for `Model.free` / `Model.access` semantics.
 *
 * Invariants preserved:
 * - `free` and `access` are independent: a `:free` model that answers
 *   "401 Missing API key" is free but not credential-free.
 * - Credential-free membership is explicit (`provider:id` confirmed live),
 *   never derived from price.
 */

/** How a model is reached. Explicit on the model; unclassified requires the provider's credentials. */
export type ModelAccess =
	/** Served without any credentials. */
	| "anonymous"
	/** Requires an interactive account login (OAuth-style). */
	| "login"
	/** Requires an API key. */
	| "api-key"
	/** Requires an active paid subscription. */
	| "subscription"
	/** Hosted locally; no upstream account or network egress. */
	| "local"
	/** Not classified. Treat as requiring the provider's credentials. */
	| "unknown";

/**
 * Free-tier models carry an explicit upstream id suffix: OpenRouter `:free`,
 * OpenCode Zen/Go `-free`. Plus OpenRouter's `openrouter/free` router, which
 * only selects free models. Never derived from zero cost.
 */
export function withFreeFlag<M extends { id: string }>(model: M): M & { free?: true } {
	const free = model.id.endsWith(":free") || model.id.endsWith("-free") || model.id === "openrouter/free";
	return free ? { ...model, free: true } : model;
}

/**
 * Free models served **without credentials**. Model-level, not provider-level:
 * OpenCode Zen serves `space-bunny-free` anonymously while its other `-free`
 * models refuse non-OpenCode traffic. Each entry confirmed with a live
 * `max_tokens=1` credential-less probe.
 */
const ANONYMOUS_FREE_MODELS = new Set(["opencode:space-bunny-free"]);

/** True when this exact model is known to be reachable with no credentials. */
export function isAnonymouslyAccessible(provider: string, id: string): boolean {
	return ANONYMOUS_FREE_MODELS.has(`${provider}:${id}`);
}

/** Attaches the explicit `access` value for models known to need no credentials. */
export function withAccessFlag<M extends { id: string; provider: string }>(model: M): M & { access?: ModelAccess } {
	if (!isAnonymouslyAccessible(model.provider, model.id)) return model;
	return { ...model, access: "anonymous" satisfies ModelAccess };
}

/**
 * True when the model can be called without the provider's credentials.
 * A reachability question, not a price question.
 */
export function isCredentialFree(model: { access?: ModelAccess }): boolean {
	return model.access === "anonymous" || model.access === "local";
}

/** True when a provider offers at least one model that needs no credentials. */
export function hasCredentialFreeModels(models: readonly { access?: ModelAccess }[]): boolean {
	return models.some(isCredentialFree);
}

/** Placeholder credential for a request that must carry no Authorization header. */
export const CREDENTIAL_FREE_API_KEY = "credential-free";

/**
 * Resolves the placeholder credential for a credential-free request, or
 * undefined when the normal credential path applies.
 */
export function resolveCredentialFreeApiKey(
	model: { access?: ModelAccess },
	apiKey: string | undefined,
	hasAuthHeader: boolean,
): string | undefined {
	if (apiKey !== undefined) return undefined;
	if (hasAuthHeader) return undefined;
	if (!isCredentialFree(model)) return undefined;
	return CREDENTIAL_FREE_API_KEY;
}
