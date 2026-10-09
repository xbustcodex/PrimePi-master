/**
 * Classification of provider availability failures by *scope*.
 *
 * A bare "429" does not say what is unavailable, and the difference decides the
 * correct recovery. OpenRouter, observed live on 2026-09-26 with an exhausted free
 * account, answers:
 *
 *   429  x-ratelimit-remaining: 0  x-ratelimit-reset: 1790467200000
 *   {"error":{"message":"Rate limit exceeded: free-models-per-day. ...",
 *     "metadata":{"limit_source":"openrouter_free_tier_daily", ...}}}
 *
 * Two failures that both look like "429" need opposite handling:
 *
 *  - `openrouter_shared_capacity`  one model/route is busy. Another route on the
 *    same account is likely fine, and an ordinary backoff is reasonable.
 *  - `openrouter_free_tier_daily` the account's free *funding pool* is spent until
 *    a known reset. Every `:free` model on that account shares the pool, so
 *    retrying, or failing over to a sibling free model, cannot succeed. Retrying is
 *    pure waste and the only recovery is to stop using that pool until it resets.
 *
 * This module reads the structured `limit_source` and rate-limit metadata that
 * providers already embed in the error body, so no adapter needs new plumbing.
 */

import { isRetryableProviderErrorText } from "./retry-text";

/** How widely a failure applies. Narrower scopes invalidate fewer candidates. */
export type FailureScope =
	/** Only the model that failed. */
	| "model"
	/** A provider route/upstream for this model. */
	| "route"
	/** An account's shared funding or quota pool: every model drawing on it. */
	| "funding-pool"
	/** The whole provider, regardless of account. */
	| "provider";

export interface AvailabilityFailure {
	recoverable: boolean;
	scope: FailureScope;
	/**
	 * Stable identity of the exhausted thing, used as the cooldown key. Model-scoped
	 * keys include provider and model; pool-scoped keys deliberately do not, so all
	 * models sharing a pool collide on purpose.
	 */
	key: string;
	/** Human-readable cause, surfaced in the failover notice. */
	reason: string;
	/**
	 * Absolute epoch milliseconds at which the provider says this may work again,
	 * when it supplied a trustworthy reset time. Absolute rather than a duration
	 * because that is the form providers send, and because a duration would let a
	 * skewed clock extend an exclusion indefinitely.
	 */
	resetAtMs?: number;
	/**
	 * True when repeating the identical request is provably pointless until
	 * `resetAtMs`, so the caller should skip backoff retries and fail over instead.
	 */
	exhausted: boolean;
}

interface ProviderLimitMetadata {
	/** Provider key is snake_case on the wire; camelCase tolerated for adapters that normalize. */
	limit_source?: unknown;
	limitSource?: unknown;
	remedy_hint?: unknown;
	remedyHint?: unknown;
	headers?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extracts the embedded provider error JSON from an assistant error message.
 *
 * Adapters format failures as `"<status>: <body>"` and OpenAI-compatible adapters
 * also append the raw provider payload, so the structured metadata is already in
 * `errorMessage`. Parsing it here is what lets the existing
 * `isRetryableAssistantError` string matching stay byte-identical: error text is
 * never rewritten, only additionally interpreted.
 */
function parseEmbeddedError(errorMessage: string): Record<string, unknown> | undefined {
	// The body is the longest `{...}` run in the message; provider errors are JSON
	// objects and the surrounding text is prose.
	const start = errorMessage.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < errorMessage.length; i++) {
		const ch = errorMessage[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return asRecord(JSON.parse(errorMessage.slice(start, i + 1)));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/** Reads `X-RateLimit-Reset` (epoch seconds or ms) from provider-echoed headers. */
function parseResetMs(headers: Record<string, unknown> | undefined): number | undefined {
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "x-ratelimit-reset") continue;
		const numeric = typeof value === "number" ? value : Number.parseInt(String(value), 10);
		if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
		// Values below ~1e12 are epoch seconds; above are already milliseconds.
		return numeric < 1e12 ? numeric * 1000 : numeric;
	}
	return undefined;
}

/** Maps a provider `limit_source` to the scope it actually invalidates. */
function scopeForLimitSource(limitSource: string, provider: string, modelId: string): FailureScope {
	const source = limitSource.toLowerCase();
	// A shared or per-day *account* pool invalidates every model drawing on it.
	if (
		source.includes("daily") ||
		source.includes("monthly") ||
		source.includes("credit") ||
		source.includes("balance")
	)
		return "funding-pool";
	if (source.includes("shared_capacity") || source.includes("capacity") || source.includes("route")) return "route";
	if (source.includes("provider") || source.includes("upstream")) return "provider";
	void provider;
	void modelId;
	return "model";
}

function fundingPoolKey(provider: string, limitSource: string): string {
	return `pool:${provider}:${limitSource}`;
}

/**
 * Classifies an assistant failure as an availability problem, or returns undefined
 * when it is not one (a malformed request, a tool-schema bug, an auth failure).
 *
 * Only recoverable availability problems are reported. Programming errors and
 * non-recoverable provider errors deliberately fall through to `undefined` so
 * callers never fail over on them.
 */
export function classifyAvailabilityFailure(input: {
	provider: string;
	modelId: string;
	errorMessage: string;
	stopReason: string;
	now?: number;
	/**
	 * The upstream route this request went to, when the model is reached through an
	 * explicit route. A failure there says nothing about the model's other routes,
	 * so recording it against every route would throw away a working recovery.
	 */
	baseUrl?: string;
}): AvailabilityFailure | undefined {
	if (input.stopReason !== "error") return undefined;

	const embedded = parseEmbeddedError(input.errorMessage);
	const errorNode = asRecord(embedded?.error);
	const metadata = asRecord(errorNode?.metadata) as ProviderLimitMetadata | undefined;
	const limitSource =
		typeof metadata?.limit_source === "string"
			? metadata.limit_source
			: typeof metadata?.limitSource === "string"
				? metadata.limitSource
				: undefined;
	const remedyHint =
		typeof metadata?.remedy_hint === "string"
			? metadata.remedy_hint
			: typeof metadata?.remedyHint === "string"
				? metadata.remedyHint
				: undefined;

	/**
	 * The narrowest scope that still covers what failed. A model reached through an
	 * explicit route excludes only that route: a sibling route is a different
	 * upstream and stays a valid recovery, so collapsing them would throw away a
	 * working route on every single-route failure.
	 */
	const limitScope = scopeForLimitSource(limitSource ?? "", input.provider, input.modelId);
	const narrow =
		input.baseUrl === undefined
			? { scope: limitScope === "route" ? "model" : limitScope, key: `model:${input.provider}:${input.modelId}` }
			: {
					scope: limitScope,
					key:
						limitScope === "model" || limitScope === "route"
							? `route:${input.provider}:${input.modelId}:${input.baseUrl}`
							: limitScope === "provider"
								? `provider:${input.provider}`
								: fundingPoolKey(input.provider, limitSource!),
				};
	const scope = narrow.scope;

	if (limitSource) {
		const resetAtMs = parseResetMs(asRecord(metadata?.headers));
		// A pool or provider scope with a known reset is conclusively unavailable:
		// the same request cannot succeed before then, so do not burn retries.
		const exhausted = scope === "funding-pool" || scope === "provider";
		const reason =
			remedyHint !== undefined && remedyHint.length > 0
				? remedyHint
				: `provider reported limit_source=${limitSource}`;
		return {
			recoverable: true,
			scope,
			key: scope === "model" || scope === "route" ? narrow.key : fundingPoolKey(input.provider, limitSource),
			reason,
			...(resetAtMs === undefined ? {} : { resetAtMs }),
			exhausted,
		};
	}

	// No structured metadata: fall back to text matching. Only transient
	// availability language qualifies, and it stays at the narrowest scope that
	// still covers the failure so unrelated models and routes are not excluded.
	if (!isRetryableProviderErrorText(input.stopReason, input.errorMessage)) return undefined;
	return {
		recoverable: true,
		scope: narrow.scope,
		key: narrow.key,
		reason: "transient provider availability failure",
		exhausted: false,
	};
}
