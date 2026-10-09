import { describe, expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { classifyAvailabilityFailure } from "@oh-my-pi/pi-ai/utils/availability";
import { AvailabilityCooldowns } from "@oh-my-pi/pi-ai/utils/availability-cooldowns";
import { isRetryableProviderErrorText } from "@oh-my-pi/pi-ai/utils/retry-text";
import { parseTimeoutSeconds, timeoutSecondsToMs } from "@oh-my-pi/pi-ai/utils/stream-watchdog";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function baseContext(): Context {
	return { messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] };
}

/** Headers arrive, the SSE body never produces a complete event. */
function stallingFetch(): { fetch: FetchImpl; released: () => boolean } {
	let released = false;
	const body = new ReadableStream<Uint8Array>({
		start() {
			// Never enqueue: the response opens and then goes silent.
		},
		cancel() {
			released = true;
		},
	});
	return {
		fetch: (async () =>
			new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as FetchImpl,
		released: () => released,
	};
}

describe("stream watchdog integration", () => {
	it("interrupts a real provider stream that stalls before its first event", async () => {
		// The adapter's first-event watchdog is a real platform timer, so this case
		// deliberately runs on the wall clock: replacing the timers would not
		// exercise the same scheduling the provider sees in production.
		const { fetch, released } = stallingFetch();
		const message = await streamOpenAIResponses(model, baseContext(), {
			apiKey: "test-key",
			streamFirstEventTimeoutMs: 50,
			fetch,
		}).result();

		// The turn fails with the provider's own timeout wording rather than
		// hanging until the user aborts.
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("OpenAI responses stream timed out while waiting for the first event");
		// Resource cleanup: the stalled body is released, not left open.
		expect(released()).toBe(true);
	});

	it("makes a stalled stream recoverable by failover instead of a terminal error", () => {
		// Adapters have no channel but the error text, so this is the contract that
		// carries a real stall from the transport into retry and cooldown recording.
		const message = "OpenAI responses stream timed out while waiting for the first event";
		expect(isRetryableProviderErrorText("error", message)).toBe(true);

		const failure = classifyAvailabilityFailure({
			provider: "openrouter",
			modelId: "vendor/model:free",
			errorMessage: message,
			stopReason: "error",
		});
		expect(failure?.scope).toBe("model");

		// The recorded cooldown is what keeps the stalled route out of the next
		// failover decision instead of being picked again immediately.
		const cooldowns = new AvailabilityCooldowns();
		cooldowns.record({
			key: failure!.key,
			scope: failure!.scope,
			reason: failure!.reason,
			now: Date.now(),
		});
		expect(
			cooldowns.isModelUnavailable({ provider: "openrouter", modelId: "vendor/model:free", now: Date.now() }),
		).toBe(true);
	});

	it("keeps a quota error non-retryable even when the stall wording is present", () => {
		// Precedence: a spent pool is not a transport problem, and must not be
		// relabelled as one by the watchdog branch.
		expect(
			isRetryableProviderErrorText(
				"error",
				"insufficient_quota: stream timed out while waiting for the first event",
			),
		).toBe(false);
	});

	it("maps the three watchdog setting states onto provider budgets", () => {
		// The settings registry feeds these straight into the per-request budgets,
		// so "auto" must stay unset (provider/env default) and "off" must be a real
		// zero the adapter reads as disabled rather than an immediate timeout.
		expect(timeoutSecondsToMs(parseTimeoutSeconds(-1))).toBeUndefined();
		expect(timeoutSecondsToMs(parseTimeoutSeconds("0"))).toBe(0);
		expect(timeoutSecondsToMs(parseTimeoutSeconds("600"))).toBe(600_000);
		// Settings files may hold a fractional value; it must never become a zero deadline.
		expect(timeoutSecondsToMs(0.0001)).toBe(1);
	});
});
