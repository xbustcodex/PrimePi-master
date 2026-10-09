/**
 * Stream-watchdog timeout settings: the vocabulary shared by the provider
 * watchdogs and the settings layer.
 *
 * ## The failure this bounds
 *
 * A provider request that never produces an event hangs forever. The turn never
 * completes, the abort button is the only exit, and from the user's side the
 * session has simply stopped. There is no error and no trace, which is what
 * makes it worse than a failure: a failed request can be retried.
 *
 * Two separate bounds, because "no first event" and "silence in the middle" are
 * different failures with different costs. A first-event watchdog is generous —
 * some models think for a long time before emitting anything. An idle watchdog
 * is tight — once a stream is running, a long gap means it has ended without
 * saying so.
 *
 * ## The three states
 *
 * `-1` means *auto*: use the provider's own default, or the environment's. This
 * is the default and it is deliberately not a number, because a hard-coded
 * constant would override whatever the provider or operator configured.
 *
 * `0` means *disabled*. Not "immediate" — a zero timeout that aborted instantly
 * would make the watchdog fire on every request, and a user who turned it off
 * deserves silence rather than an error.
 *
 * A positive value is seconds, and the conversion is at least 1ms so a
 * fractional value cannot produce a zero deadline.
 *
 * ## Why the timer is refilled rather than absolute
 *
 * A deadline set once at the start of a request would abort a long but healthy
 * generation. The idle budget is per *gap*, not per request, so a stream that
 * emits steadily for ten minutes is never touched.
 *
 * ## Where the watchdog itself lives
 *
 * Not here. Every provider adapter arms `iterateWithIdleTimeout` over its own
 * event stream, and `forwardStream` arms it again for anything that has not,
 * with the budgets this module converts. A second, byte-level watchdog on the
 * fetch would duplicate that layer, arm at the same instant, and race the
 * adapter's own provider-specific timeout — replacing a precise
 * "timed out waiting for the first event" with a generic transport error. The
 * value this module keeps is the shared meaning of the three states above.
 */

/** Sentinel meaning "use the provider or environment default". */
export const TIMEOUT_AUTO = -1;

/** How a timeout setting is interpreted. */
export type StreamTimeoutSetting = "auto" | "disabled" | number;

/**
 * Converts a seconds-valued setting into a millisecond deadline.
 *
 * Returns `undefined` for *auto* and `0` for *disabled*, which the watchdog
 * treats as "no watchdog" in both cases — the difference is preserved only for
 * the diagnostics, where "inherited" and "explicitly off" are different facts.
 */
export function timeoutSecondsToMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	return Math.max(1, Math.trunc(value * 1000));
}

/** Reads a seconds-valued setting, tolerating the string form settings files hold. */
export function parseTimeoutSeconds(raw: unknown): number {
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Number(raw.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return TIMEOUT_AUTO;
}

/** Classifies a setting for diagnostics, keeping the three states distinct. */
export function describeTimeout(value: number): StreamTimeoutSetting {
	if (!Number.isFinite(value) || value < 0) return "auto";
	if (value === 0) return "disabled";
	return value;
}
