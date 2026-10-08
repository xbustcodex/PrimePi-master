/**
 * Stream watchdogs: bounding how long a model stream may stall.
 *
 * ## The failure
 *
 * A provider request that never produces an event hangs forever. The turn
 * never completes, the abort button is the only exit, and from the user's side
 * the session has simply stopped. There is no error and no trace, which is what
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
 * `0` means *disabled*. Not "immediate" — a zero timeout that aborted
 * instantly would make the watchdog fire on every request, and a user who
 * turned it off deserves silence rather than an error.
 *
 * A positive value is seconds, and the conversion is at least 1ms so a
 * fractional value cannot produce a zero deadline.
 *
 * ## Why the timer is refilled rather than absolute
 *
 * A deadline set once at the start of a request would abort a long but healthy
 * generation. The idle budget is per *gap*, not per request, so a stream that
 * emits steadily for ten minutes is never touched.
 */

// `TransformStream`, `ReadableStream` and `TransformStreamDefaultController` are
// WHATWG globals — present in every supported browser and in Node 18+ with no import
// at all. They were imported from `node:stream/web`, which broke the browser bundle
// check: that builds this package for `platform: "browser"`, where a node specifier
// cannot resolve. Nothing is lost; this file already used `TransformStream` at runtime
// without owning its definition.
import type { FetchImpl } from "../types.ts";

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

/** Classifies a setting for a status line, keeping the three states distinct. */
export function describeTimeout(value: number): StreamTimeoutSetting {
	if (!Number.isFinite(value) || value < 0) return "auto";
	if (value === 0) return "disabled";
	return value;
}

export interface WatchdogOptions {
	/** Milliseconds to wait for the first event, or `undefined`/`0` for no watchdog. */
	readonly firstEventTimeoutMs: number | undefined;
	/** Milliseconds a running stream may stay silent, or `undefined`/`0` for none. */
	readonly idleTimeoutMs: number | undefined;
	/** Called when a watchdog fires. */
	readonly onTimeout: (kind: "first-event" | "idle", waitedMs: number) => void;
}

/**
 * Wraps a byte stream with first-event and idle watchdogs.
 *
 * The returned stream is a `TransformStream` over the input, so a consumer sees
 * identical bytes and ordering. Watchdog state is per-call: two concurrent
 * streams never share a timer.
 */
export function withStreamWatchdog<T extends Uint8Array>(
	source: ReadableStream<T>,
	options: WatchdogOptions,
): ReadableStream<T> {
	const { firstEventTimeoutMs, idleTimeoutMs, onTimeout } = options;
	const firstEventArmed = typeof firstEventTimeoutMs === "number" && firstEventTimeoutMs > 0;
	const idleArmed = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0;
	// Auto and disabled both mean "no watchdog"; the difference is kept for the
	// status line, not for behaviour.
	if (!firstEventArmed && !idleArmed) return source;

	const startedAt = Date.now();
	let firstEventSeen = false;
	// Held outside the transformer so every path clears the same timers.
	let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	const clear = () => {
		if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		firstEventTimer = undefined;
		idleTimer = undefined;
	};

	const fire = (kind: "first-event" | "idle") => {
		// Latched: a stream that times out while its error propagates must report
		// once, or the consumer sees two failures for one stall.
		if (settled) return;
		settled = true;
		clear();
		onTimeout(kind, Date.now() - startedAt);
	};

	/** Refills both timers. The budget is per gap, not per request. */
	const refill = () => {
		if (settled) return;
		if (idleArmed) {
			if (idleTimer !== undefined) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => fire("idle"), idleTimeoutMs);
			// A watchdog that keeps the process alive would hang a shutdown.
			if (typeof idleTimer.unref === "function") idleTimer.unref();
		}
		if (!firstEventSeen && firstEventArmed) {
			if (firstEventTimer !== undefined) clearTimeout(firstEventTimer);
			firstEventTimer = setTimeout(() => fire("first-event"), firstEventTimeoutMs);
			if (typeof firstEventTimer.unref === "function") firstEventTimer.unref();
		}
	};

	refill();

	return source.pipeThrough(
		new TransformStream<T, T>({
			transform(chunk, controller) {
				firstEventSeen = true;
				controller.enqueue(chunk);
				refill();
			},
			flush() {
				clear();
			},
			// @ts-ignore: TransformStream constructor types vary by runtime lib
			cancel() {
				clear();
			},
		}),
	);
}

/**
 * Arms a watchdog budget, or reports that there is nothing to arm.
 *
 * `undefined` and `0` are both "no watchdog" — see the three-states note at the
 * top of this file — so a caller that has not been given a budget gets a
 * `null` back and must leave the transport exactly as it found it.
 */
function armedBudget(value: number | undefined): number | null {
	return typeof value === "number" && value > 0 ? value : null;
}

/** The budgets a {@link withWatchdogFetch} installation needs. */
export interface WatchdogFetchBudgets {
	readonly firstEventTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
}

/**
 * Wraps a `fetch` so a stalled response body fails instead of hanging.
 *
 * ## Why the transport and not each adapter
 *
 * A stall is a property of the bytes, not of any provider's event grammar, so
 * the watchdog belongs where every HTTP-streaming adapter's body passes: the
 * fetch itself. Nine adapters call `buildBaseOptions`, which calls this once.
 * An adapter that issues no HTTP body — Bedrock, Vertex, the Codex WebSocket
 * path — is not covered here; those carry their own timers.
 *
 * ## Why `null` rather than an identity wrapper
 *
 * Several adapters branch on `options.fetch === globalThis.fetch` to detect an
 * injected implementation. Returning `null` when nothing is armed keeps that
 * comparison exact, so a default install is byte-for-byte the previous
 * transport.
 *
 * ## The error, not a silent end
 *
 * `withStreamWatchdog` reports a timeout through a callback because it has no
 * error channel of its own. A transport does: the guarded body is errored, so
 * the adapter's own stream handler sees a rejected read and emits its normal
 * `stopReason: "error"` terminal message. The message names the watchdog and
 * the gap. It never names a header, a URL, or a credential — the wrapper sees
 * only the response body, which is the point of putting the watchdog here
 * rather than in a layer that also handles authentication.
 */
export function withWatchdogFetch(base: FetchImpl | undefined, budgets: WatchdogFetchBudgets): FetchImpl | null {
	const firstEventTimeoutMs = armedBudget(budgets.firstEventTimeoutMs);
	const idleTimeoutMs = armedBudget(budgets.idleTimeoutMs);
	if (firstEventTimeoutMs === null && idleTimeoutMs === null) return null;
	const inner = base ?? globalThis.fetch;

	return async (input: Parameters<FetchImpl>[0], init?: Parameters<FetchImpl>[1]): Promise<Response> => {
		const response = await inner(input, init);
		const body = response.body;
		// A null body is a bodiless response (204, or a runtime with no streams).
		// There is nothing to watch and nothing to break.
		if (!body) return response;

		// The bridge exists so the watchdog callback can error the body from
		// outside. `controller.error` on the bridge's writable side errors its
		// readable side, which the watchdog pipes through, so the failure
		// reaches the adapter as a rejected read.
		let bridge: TransformStreamDefaultController<Uint8Array> | undefined;
		const source = body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				start(controller) {
					bridge = controller;
				},
			}),
		);
		const guarded = withStreamWatchdog(source, {
			firstEventTimeoutMs: firstEventTimeoutMs ?? undefined,
			idleTimeoutMs: idleTimeoutMs ?? undefined,
			onTimeout: (kind, waitedMs) => {
				const error = new Error(
					`Stream ${kind === "first-event" ? "first-event" : "idle"} watchdog fired after ${waitedMs}ms. ` +
						"Raise providers.streamFirstEventTimeoutSeconds or providers.streamIdleTimeoutSeconds, " +
						"or set the matching value to 0 to disable that watchdog.",
				);
				bridge?.error(error);
			},
		});
		return new Response(guarded, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
