/**
 * Temporary unavailability tracking for automatic model failover.
 *
 * Different failures invalidate different amounts of the catalog, so exclusions are
 * keyed by the scope the provider reported rather than by a single global flag:
 *
 *   model        exclude one model
 *   route        exclude one model's upstream route
 *   funding-pool exclude every model that draws on the same account quota
 *   provider     exclude the whole provider
 *
 * A funding-pool exclusion is what stops Pi from cycling through every remaining
 * `:free` model on an account whose free quota is already spent: all of them share
 * the pool, so they are all unavailable for the same reason and at the same time.
 *
 * Expiries are absolute epoch milliseconds taken from the provider when it supplies
 * a reset time, so a clock that jumps cannot extend an exclusion indefinitely. When
 * no trustworthy reset is known, a bounded fallback keeps the entry from becoming
 * permanent, and the next real failure refreshes it.
 */

import type { FailureScope } from "./availability";

/** Bound used when the provider gives no reset time. Deliberately short. */
export const DEFAULT_UNAVAILABLE_TTL_MS = 60_000;

/**
 * Sanity bound on a provider-supplied absolute reset. A daily free pool observed on
 * 2026-09-26 reset ~19h out, so the bound has to clear a day comfortably while still
 * rejecting an absurd or hostile value that would disable a provider indefinitely.
 */
const MAX_PROVIDER_RESET_MS = 7 * 24 * 60 * 60 * 1000;

export interface UnavailabilityEntry {
	key: string;
	scope: FailureScope;
	reason: string;
	untilMs: number;
}

export class AvailabilityCooldowns {
	private readonly entries = new Map<string, UnavailabilityEntry>();

	/** Records a failure and returns the stored entry. */
	record(failure: {
		key: string;
		scope: FailureScope;
		reason: string;
		/** Absolute epoch ms from the provider; clamped like any other source. */
		resetAtMs?: number;
		now: number;
	}): UnavailabilityEntry {
		// Never trust an unbounded future reset: clamp to a maximum so a bogus or
		// hostile value cannot disable a provider indefinitely.
		const untilMs =
			failure.resetAtMs === undefined
				? failure.now + DEFAULT_UNAVAILABLE_TTL_MS
				: Math.min(failure.resetAtMs, failure.now + MAX_PROVIDER_RESET_MS);
		const entry: UnavailabilityEntry = {
			key: failure.key,
			scope: failure.scope,
			reason: failure.reason,
			untilMs: Math.max(untilMs, failure.now),
		};
		this.entries.set(failure.key, entry);
		return entry;
	}

	/** Live entry for a key, or undefined when absent or expired. */
	get(key: string, now: number): UnavailabilityEntry | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.untilMs <= now) {
			this.entries.delete(key);
			return undefined;
		}
		return entry;
	}

	/**
	 * Whether a specific model is currently excluded, given its provider and id.
	 *
	 * Checks the model/route key plus every provider-wide and pool-wide key that
	 * could apply, so a pool exclusion excludes all of its models.
	 */
	isModelUnavailable(input: { provider: string; modelId: string; baseUrl?: string; now: number }): boolean {
		return this.reasonsForModel(input).length > 0;
	}

	/**
	 * Entries that currently apply to a model, for user-facing explanations.
	 *
	 * `baseUrl` narrows the match to one upstream route. A model served through
	 * several routes is only excluded when the route that failed is the one being
	 * asked about; without it a single bad route would exclude the whole model.
	 */
	reasonsForModel(input: { provider: string; modelId: string; baseUrl?: string; now: number }): UnavailabilityEntry[] {
		const found: UnavailabilityEntry[] = [];
		const now = input.now;
		for (const [key, entry] of this.entries) {
			if (entry.untilMs <= now) {
				this.entries.delete(key);
				continue;
			}
			if (this.appliesTo(entry, input.provider, input.modelId, input.baseUrl)) found.push(entry);
		}
		return found.sort((a, b) => a.untilMs - b.untilMs);
	}

	/**
	 * Whether an entry excludes a given model.
	 *
	 * Pool and provider keys are matched by prefix because their identity carries no
	 * model id: `pool:<provider>:<source>` deliberately lets sibling models share one
	 * exclusion, and `provider:<provider>` covers a whole provider.
	 *
	 * The pool prefix keeps its trailing separator so an exclusion scoped to one
	 * funding source does not leak onto a differently-sourced pool for the same
	 * provider. A provider key has no further segment, so it is compared whole —
	 * matching it by prefix required a separator that never appears, which meant a
	 * provider-scoped outage silently excluded nothing.
	 */
	private appliesTo(entry: UnavailabilityEntry, provider: string, modelId: string, baseUrl?: string): boolean {
		if (entry.scope === "route") {
			// A route entry names the upstream that failed; it applies only when the
			// model being asked about is served by that same upstream.
			return baseUrl !== undefined && entry.key === `route:${provider}:${modelId}:${baseUrl}`;
		}
		if (entry.scope === "model") {
			return entry.key === `model:${provider}:${modelId}`;
		}
		if (entry.scope === "provider") {
			return entry.key === `provider:${provider}`;
		}
		return entry.key.startsWith(`pool:${provider}:`);
	}

	/** Drops expired entries. Returns how many were removed. */
	prune(now: number): number {
		let removed = 0;
		for (const [key, entry] of this.entries) {
			if (entry.untilMs <= now) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	clear(): void {
		this.entries.clear();
	}

	/** Live entries, oldest first. Test/diagnostic helper. */
	list(now: number): UnavailabilityEntry[] {
		this.prune(now);
		return [...this.entries.values()].sort((a, b) => a.untilMs - b.untilMs);
	}
}
