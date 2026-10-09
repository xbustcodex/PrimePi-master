import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AvailabilityCooldowns } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Model, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type RecoveryCompactionResult,
	TurnRecovery,
	type TurnRecoveryHost,
} from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeModel(over: { provider: string; id: string; api: string } & Partial<Model>): Model {
	return {
		name: over.id,
		contextWindow: 200_000,
		maxTokens: 8_192,
		input: ["text"],
		output: ["text"],
		reasoning: false,
		...over,
	} as Model;
}

/** The model whose stream stalls. */
const STALLED = makeModel({ provider: "alpha", id: "stalled:free", api: "openai-completions", free: true });
/** A free sibling route that can serve the same turn. */
const FREE_SPARE = makeModel({ provider: "alpha", id: "spare:free", api: "openai-completions", free: true });
/** A paid route: reachable, but forbidden while the failed model is free. */
const PAID_SPARE = makeModel({ provider: "beta", id: "paid-spare", api: "openai-completions" });
/** A free route that accepts text only: it cannot carry a turn holding an image. */
const TEXT_ONLY = makeModel({ provider: "alpha", id: "text-only:free", api: "openai-completions", free: true });
/** A free route that accepts images, and can therefore serve an image turn. */
const VISION_SPARE = makeModel({
	provider: "gamma",
	id: "vision:free",
	api: "openai-completions",
	free: true,
	input: ["text", "image"],
});

/** The wording a provider emits when its idle watchdog interrupts a stream. */
const STALLED_STREAM_MESSAGE = "Provider stream stalled while waiting for the next event";

/** A failed assistant turn with no partial output, so it is replay-safe. */
function failedTurn(model: Model, errorMessage: string): AssistantMessage {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...USAGE },
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
	message.errorId = AIError.classifyMessage(message);
	return message;
}

interface Harness {
	recovery: TurnRecovery;
	activeModel: () => Model;
	cooldowns: AvailabilityCooldowns;
	events: string[];
	continues: () => number;
}

function harness(options: {
	/** Chain entries keyed by the selector that fails, so a chain can wrap around. */
	chains: Record<string, string[]>;
	failoverPolicy?: "off" | "same-provider" | "free-only" | "compatible";
	models?: Model[];
	messages?: AgentMessage[];
	tools?: unknown[];
}): Harness {
	const settings = Settings.isolated({
		"retry.fallbackChains": options.chains,
		"retry.failoverPolicy": options.failoverPolicy ?? "free-only",
		// No real backoff sleep: the contract under test is which route is picked.
		"retry.baseDelayMs": 0,
		"retry.maxRetries": 5,
		"retry.modelFallback": true,
	});
	const pool = options.models ?? [FREE_SPARE, PAID_SPARE, TEXT_ONLY];
	const modelRegistry = {
		getAvailable: () => pool,
		find: (provider: string, id: string) => pool.find(m => m.provider === provider && m.id === id),
		getApiKey: async () => "test-key",
		hasConfiguredAuth: async () => true,
		isProviderDiscoveryPending: () => false,
		// Selector suppression is the retry-path cooldown; the registry owns the
		// timers, so a stub that never suppresses keeps the harness focused on
		// route selection.
		suppressSelector: () => {},
		isSelectorSuppressed: () => false,
		authStorage: {},
	} as unknown as ModelRegistry;

	const messages: AgentMessage[] = [...(options.messages ?? [])];
	let active: Model = STALLED;
	const cooldowns = new AvailabilityCooldowns();
	const events: string[] = [];
	const state = { continues: 0 };

	const host: TurnRecoveryHost = {
		agent: {
			state: { messages, tools: options.tools ?? [] },
			replaceMessages(next: AgentMessage[]) {
				messages.length = 0;
				messages.push(...next);
			},
		} as never,
		sessionManager: {
			appendModelChange: () => {},
			getSessionId: () => "failover-session",
			getBranch: () => [],
			getLastModelChangeRole: () => undefined,
		} as never,
		persistedAssistantEntryId: () => undefined,
		settings,
		modelRegistry,
		configWarnings: [],
		model: () => active,
		availabilityCooldowns: () => cooldowns,
		contextFitsModel: () => true,
		textOutputCommitted: () => true,
		thinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		thinkingLevelCeiling: () => undefined,
		isDisposed: () => false,
		isStreaming: () => false,
		isCompacting: () => false,
		abortInProgress: () => false,
		streamingEditAbortTriggered: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		sessionId: () => "failover-session",
		emitSessionEvent: async event => {
			events.push(event.type);
		},
		scheduleAgentContinue: () => {
			state.continues++;
		},
		waitForSessionMessagePersistence: async () => {},
		appendSessionMessage: () => {},
		sessionMessageAlreadyPersisted: () => false,
		setModelWithProviderSessionReset: async next => {
			active = next;
		},
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		resetCurrentResponsesProviderSession: () => {},
		maybeAutoRedeemReset: async () => ({ restored: false }),
		runAutoCompaction: async () => ({ continuationScheduled: false }) as RecoveryCompactionResult,
		shakeForRequestBodyReadTimeout: async () => false,
		withBashBranchTransition: <T>(operation: () => T): T => operation(),
	};

	return {
		recovery: new TurnRecovery(host),
		activeModel: () => active,
		cooldowns,
		events,
		continues: () => state.continues,
	};
}

describe("TurnRecovery production failover", () => {
	it("replaces a stalled free route and retries on the free sibling", async () => {
		const h = harness({ chains: { [`${STALLED.provider}/${STALLED.id}`]: ["alpha/spare:free"] } });
		const message = failedTurn(STALLED, STALLED_STREAM_MESSAGE);

		// The stall reaches the cooldown registry before recovery consults it.
		h.recovery.recordAvailabilityFailure(message);
		expect(h.cooldowns.isModelUnavailable({ provider: STALLED.provider, modelId: STALLED.id, now: Date.now() })).toBe(
			true,
		);

		expect(await h.recovery.handleRetryableError(message)).toBe(true);
		expect(h.activeModel().id).toBe("spare:free");
		expect(h.continues()).toBe(1);
		expect(h.events).toContain("retry_fallback_applied");
	});

	it("refuses a paid replacement while the failed route is free", async () => {
		const h = harness({ chains: { [`${STALLED.provider}/${STALLED.id}`]: ["beta/paid-spare"] } });
		const message = failedTurn(STALLED, STALLED_STREAM_MESSAGE);

		// Reachable and configured, but free-stays-free under the default policy.
		await h.recovery.handleRetryableError(message);
		expect(h.activeModel().id).toBe("stalled:free");
	});

	it("selects the paid route only when the policy explicitly allows it", async () => {
		const h = harness({
			chains: { [`${STALLED.provider}/${STALLED.id}`]: ["beta/paid-spare"] },
			failoverPolicy: "compatible",
		});
		const message = failedTurn(STALLED, STALLED_STREAM_MESSAGE);

		expect(await h.recovery.handleRetryableError(message)).toBe(true);
		expect(h.activeModel().id).toBe("paid-spare");
	});

	it("reports the turn as unrecovered when every free route is already exhausted", async () => {
		const h = harness({ chains: { [`${STALLED.provider}/${STALLED.id}`]: ["alpha/spare:free"] } });
		h.cooldowns.record({
			key: `model:${FREE_SPARE.provider}:${FREE_SPARE.id}`,
			scope: "model",
			reason: "transient provider availability failure",
			now: Date.now(),
		});

		const message = failedTurn(STALLED, STALLED_STREAM_MESSAGE);
		await h.recovery.handleRetryableError(message);
		expect(h.activeModel().id).toBe("stalled:free");
	});

	it("does not switch onto a route that cannot accept the turn's image", async () => {
		// The conversation holds an image, so a text-only replacement would reject
		// the request outright rather than serve it.
		const withImage: AgentMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "what is in this?" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			} as unknown as AgentMessage,
		];
		const h = harness({
			chains: { [`${STALLED.provider}/${STALLED.id}`]: ["alpha/text-only:free", "gamma/vision:free"] },
			models: [TEXT_ONLY, VISION_SPARE],
			messages: withImage,
		});

		await h.recovery.handleRetryableError(failedTurn(STALLED, STALLED_STREAM_MESSAGE));
		// The text-only route is skipped; the image-capable one still serves.
		expect(h.activeModel().id).toBe("vision:free");
	});

	it("never fails over on a cancellation", async () => {
		// An abort is the user's own decision, not a route fault. Both gates the
		// recovery path consults must reject it before a route is considered.
		const h = harness({ chains: { [`${STALLED.provider}/${STALLED.id}`]: ["alpha/spare:free"] } });
		const message: AssistantMessage = {
			...failedTurn(STALLED, "Request was aborted"),
			stopReason: "aborted",
		};
		message.errorId = AIError.classifyMessage(message);

		expect(h.recovery.isRetryableError(message)).toBe(false);
		expect(h.recovery.isHardErrorFallbackEligible(message)).toBe(false);
	});
});
