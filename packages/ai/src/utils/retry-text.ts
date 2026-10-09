/**
 * Text classifier for transient provider/transport failures.
 * Ported from PrimePi `packages/ai/src/utils/retry.ts` so availability
 * classification and retry decisions never disagree about transientness.

 */

/**
 * Every provider watchdog reports a timeout in the same shape: the adapter
 * passes its own wording to `iterateWithIdleTimeout`, but each ends by naming
 * the same two waits — the first event, and the next one. Matching the shape
 * rather than any single provider's string is what keeps a stall recoverable
 * when an adapter rewords its message.
 */
const STREAM_WATCHDOG_TIMEOUT_PATTERN = /stream (?:stalled|timed out) while waiting for the (?:first|next) event/i;

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	"GoUsageLimitError",
	"FreeUsageLimitError",
	"Monthly usage limit reached",
	"available balance",
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	"overloaded",
	"currently experiencing high demand",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"520",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
]);

export function isRetryableProviderErrorText(stopReason: string, errorMessage: string | undefined): boolean {
	if (stopReason !== "error" || !errorMessage) return false;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	// A watchdog timeout is transport liveness we own, so it is retryable by
	// definition. It carries none of the provider vocabulary above, so without this
	// branch a stalled stream is classified as an unrecoverable error and never
	// reaches failover recovery.
	if (STREAM_WATCHDOG_TIMEOUT_PATTERN.test(errorMessage)) return true;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
