/**
 * Prime Token Harness — coding-agent integration (shadow + controlled active).
 *
 * Wired exclusively through `createSettingsAwareStreamFn` (the single seam for
 * every coding-agent online inference). Disabled by default:
 * `tokenHarness.enabled:false` and `tokenHarness.shadowEnabled:false`. No
 * Settings UI; config-file only.
 *
 * Modes:
 * - off       → provider path untouched (current behaviour).
 * - shadow    → the harness computes the proposed reduction and records its
 *               report, but the ORIGINAL context is dispatched unchanged.
 * - active    → the harness output is dispatched; any processing failure or
 *               validation violation fails open to the original context.
 *
 * Bypass: on-device/local runtimes (transport category, not per-model policy)
 * never go through the harness. Custom local-openai-completion servers are not
 * in this category today (still fail-open-correct); catalog-owned classification
 * is the planned refinement.
 */

import type { Context, Model } from "@oh-my-pi/pi-ai";
import type { ArtifactRef, ArtifactStore, HarnessReport } from "@oh-my-pi/pi-agent-core";
import { runTokenHarness, type HarnessInput } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { register } from "../config/registry";

// Prime Token Harness settings (config-file only - no Settings UI per the
// harness brief). Both default OFF: the feature is opt-in and reversible.
// Registered here (not session/settings.ts) so the harness commit stays
// self-contained and Wave 1 model-authority changes remain un-mixed.
export const cfgTokenHarnessEnabled = register({
	id: "tokenHarness.enabled",
	type: "boolean",
	default: false,
});

export const cfgTokenHarnessShadow = register({
	id: "tokenHarness.shadowEnabled",
	type: "boolean",
	default: false,
});

/**
 * Opt-in diagnostic: append one JSON line per harness decision to this file
 * (config-file only, default unset). Used for Phase-D shadow evidence; the
 * decision itself is unchanged and the append is synchronous so it always
 * flushes before process exit.
 */
export const cfgTokenHarnessStatsFile = register({
	id: "tokenHarness.statsFile",
	type: "string",
	default: undefined,
});

/**
 * On-device/local runtimes bypass the harness (they do not bill tokens and the
 * harness adds no value). This is a transport-category bypass — a capability
 * fact about the runtime, not model-specific spending/eligibility policy.
 */
const LOCAL_RUNTIME_APIS = new Set(["ollama-chat", "apple-foundation-models"]);

export function isTokenHarnessBypassModel(model: Model | undefined): boolean {
	return model === undefined || LOCAL_RUNTIME_APIS.has(model.api);
}

/**
 * Persistent artifact store: content-addressed files under
 * `<agentDir>/token-harness/`. Ids are deterministic (content hash), so the
 * same suppressed output resolves to the same file across requests, sessions
 * and restarts — matching the in-memory prototype's marker references without
 * losing recoverability. Synchronous by necessity: the harness module contract
 * is synchronous and this runs inside the request path under a feature flag.
 */
export class PersistedTokenHarnessStore implements ArtifactStore {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
		mkdirSync(dir, { recursive: true });
	}

	static defaultFor(agentDir: string): PersistedTokenHarnessStore {
		return new PersistedTokenHarnessStore(join(agentDir, "token-harness"));
	}

	put(text: string, meta: { messageIndex: number; toolName?: string }): ArtifactRef {
		const id = tokenHarnessArtifactId(text);
		const path = join(this.#dir, tokenHarnessArtifactFile(id));
		if (!existsSync(path)) writeFileSync(path, text, "utf8");
		return { id, messageIndex: meta.messageIndex, bytes: Buffer.byteLength(text, "utf-8"), tokens: 0 };
	}

	get(id: string): string | undefined {
		const path = join(this.#dir, tokenHarnessArtifactFile(id));
		if (!existsSync(path)) return undefined;
		return readFileSync(path, "utf8");
	}
}

function tokenHarnessArtifactId(text: string): string {
	// The id travels on the wire in markers; ":" is fine there. Windows forbids ":"
	// in filenames, so the storage name is derived from the id, not equal to it.
	return `pth:${Bun.hash(text).toString(36)}:${text.length.toString(36)}`;
}

function tokenHarnessArtifactFile(id: string): string {
	return `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
}

/** Module accumulation of shadow/active decisions for tests and diagnostics. */
export interface TokenHarnessStats {
	active: number;
	shadow: number;
	bypassed: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	lastReport?: HarnessReport;
}

const stats: TokenHarnessStats = { active: 0, shadow: 0, bypassed: 0, totalInputTokens: 0, totalOutputTokens: 0 };

export function getTokenHarnessStats(): TokenHarnessStats {
	return stats;
}

export function resetTokenHarnessStats(): void {
	stats.active = 0;
	stats.shadow = 0;
	stats.bypassed = 0;
	stats.totalInputTokens = 0;
	stats.totalOutputTokens = 0;
	stats.lastReport = undefined;
}

export type TokenHarnessDecision =
	| { mode: "off" }
	| { mode: "shadow"; report: HarnessReport }
	| { mode: "active"; context: Context; report: HarnessReport };

function harnessInputFor(model: Model, context: Context): HarnessInput {
	return {
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools,
		model: { id: model.id, provider: model.provider, tokenizer: model.tokenizer },
	};
}

function recordStats(report: HarnessReport, mode: "active" | "shadow"): void {
	stats[mode]++;
	stats.totalInputTokens += report.inputTokens;
	stats.totalOutputTokens += report.outputTokens;
	stats.lastReport = report;
	logger.debug("prime-token-harness", {
		mode,
		inputTokens: report.inputTokens,
		outputTokens: report.outputTokens,
		reductionPct: report.reductionPct,
		latencyMs: report.latencyMs,
		failure: report.failure ?? null,
	});
}

/** Opt-in on-disk evidence line (Phase-D shadow collection). Synchronous so it survives process exit. */
function appendStatsFile(settings: Settings, decision: TokenHarnessDecision, model: string): void {
	const path = cfgTokenHarnessStatsFile.get(settings);
	if (!path || decision.mode === "off") return;
	try {
		const dir = dirname(path);
		if (dir) mkdirSync(dir, { recursive: true });
		appendFileSync(
			path,
			`${JSON.stringify({ t: Date.now(), model, mode: decision.mode, report: decision.report })}\n`,
			"utf8",
		);
	} catch (error) {
		if (error instanceof Error)
			logger.debug("prime-token-harness stats append failed", { path, error: error.message });
	}
}

/**
 * Decide how to handle one request. Reads settings per call (a mid-request
 * toggle takes effect immediately). Returns `off` when disabled, bypassed, or
 * when the harness cannot process safely — the provider path then always
 * receives the ORIGINAL context.
 */
export function decideTokenHarness(
	settings: Settings,
	model: Model,
	context: Context,
	tokenizer: Tokenizer,
	store?: ArtifactStore,
): TokenHarnessDecision {
	const enabled = cfgTokenHarnessEnabled.get(settings);
	const shadow = cfgTokenHarnessShadow.get(settings);
	if (!enabled && !shadow) return { mode: "off" };
	if (isTokenHarnessBypassModel(model)) {
		stats.bypassed++;
		return { mode: "off" };
	}
	const storeArg = store ?? defaultPersistedHarnessStore(getAgentDir());
	const result = runTokenHarness(harnessInputFor(model, context), { artifactStore: storeArg }, { tokenizer });
	if (enabled) {
		recordStats(result.report, "active");
		if (!result.ok) return { mode: "off" }; // fail open
		const decision: TokenHarnessDecision = {
			mode: "active",
			context: { ...context, messages: result.messages },
			report: result.report,
		};
		appendStatsFile(settings, decision, model.id);
		return decision;
	}
	// shadow mode: compute + record, dispatch the ORIGINAL context.
	recordStats(result.report, "shadow");
	const decision: TokenHarnessDecision = { mode: "shadow", report: result.report };
	appendStatsFile(settings, decision, model.id);
	return decision;
}

/**
 * Lazy process-wide default store. Created on first harness use; the directory
 * is derived from the same agentDir resolution the config loader uses.
 */
let defaultStore: PersistedTokenHarnessStore | undefined;
export function defaultPersistedHarnessStore(agentDir: string): PersistedTokenHarnessStore {
	defaultStore ??= PersistedTokenHarnessStore.defaultFor(agentDir);
	return defaultStore;
}

export function resetDefaultPersistedHarnessStore(): void {
	defaultStore = undefined;
}
