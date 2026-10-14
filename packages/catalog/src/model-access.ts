/**
 * Free-tier and credential-free model classification.
 *
 * Invariants:
 * - `free` and `access` are independent: a `:free` model that answers
 *   "401 Missing API key" is free but not credential-free.
 * - `free` is derived from the upstream id suffix; `access` is **rule-owned**
 *   through the `model-access` catalog axis (`applyCatalogAssignments`).
 * - A suffix is never evidence of anonymous access. Anonymous routes must be
 *   declared by a rule after a live credential-less probe, and are consumed by
 *   the request path (`ModelRegistry.getApiKey`) only when no credential is
 *   stored for the provider.
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
