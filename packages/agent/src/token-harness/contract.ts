/**
 * Prime Token Harness — module contract (prototype).
 *
 * The harness is an always-on, modular preprocessing pipeline that runs
 * between session state and provider dispatch for ONLINE inference. The
 * production hook (createSettingsAwareStreamFn) is deliberately NOT wired
 * during the prototype; this module is pure and package-local.
 *
 * Invariants the contract enforces:
 * - PROTECT is a harness pre-pass, not a plugin: system prompt, tool schemas,
 *   recent turns and the current instruction are snapshotted before any module
 *   runs, and validation fails the whole pipeline if any of them changed.
 * - FAIL OPEN: any module failure or validation error returns the ORIGINAL
 *   context untouched. The harness may never destroy an inference.
 * - Deterministic, idempotent output over the shared prefix (CAPC-style
 *   query-agnostic compression) so prompt-cache prefixes stay stable.
 */

import type { Message, Tool } from "@oh-my-pi/pi-ai";
import type { Tokenizer } from "../tokenizer";

/** Pipeline stage a module plugs into. Modules compose in this order. */
export type StageKind = "dedup" | "select" | "suppress" | "compress" | "assemble" | "validate";

/** Message shapes a module declares it can operate on. */
export type MessageShape = "system" | "user" | "assistant" | "tool-result" | "image" | "tool-schema";

export interface ModuleHealth {
	status: "available" | "degraded" | "unavailable";
	reason?: string;
}

/** Content guaranteed to survive the pipeline byte-for-byte (or by identity). */
export type ProtectedKind = "system-prompt" | "tool-schemas" | "recent-turns" | "current-instruction";

export interface ProtectedRef {
	kind: ProtectedKind;
	/** Human-readable locator (message index, snapshot size, …). */
	detail: string;
}

/** Local full-fidelity copy of content elided from the provider request. */
export interface ArtifactRef {
	id: string;
	/** Index of the message whose text was spilled. */
	messageIndex: number;
	tokens: number;
	bytes: number;
}

export interface HarnessInput {
	/** System prompt segments, passed through untouched. */
	systemPrompt?: string[];
	messages: Message[];
	/** Tool schemas, passed through untouched. */
	tools?: Tool[];
	/** Model identity for tokenization (and, at wiring time, local-bypass classification). */
	model?: { id?: string; provider?: string; tokenizer?: string };
}

export interface HarnessConfig {
	/** Master switch. Disabled → immediate pass-through. Default true. */
	enabled?: boolean;
	/**
	 * Number of trailing messages treated as the recent window and never
	 * mutated. Default 8.
	 */
	recentWindowMessages?: number;
	/** Per-tool-result suppression budget in tokens. Default 1500. */
	toolResultBudgetTokens?: number;
	/** Minimum text size (chars) before exact-duplicate collapse applies. Default 400. */
	dedupMinChars?: number;
	/** Per-module soft latency budget; exceeding it records a warning. Default 250ms. */
	maxLatencyMs?: number;
	/** Where elided full text is stored. Defaults to an in-memory store. */
	artifactStore?: ArtifactStore;
	/**
	 * Caller-supplied applicability decision (the integration point for
	 * catalog-based local-model exclusion). Defaults to "process".
	 */
	shouldProcess?: (input: HarnessInput) => boolean;
}

/** Write-through local store for content suppressed from the wire. */
export interface ArtifactStore {
	put(text: string, meta: { messageIndex: number; toolName?: string }): ArtifactRef;
	get(id: string): string | undefined;
}

export interface StageStat {
	module: string;
	stage: StageKind;
	status: "applied" | "no-change" | "unavailable" | "skipped" | "failed";
	latencyMs: number;
	mutatedMessages: number;
}

export interface HarnessReport {
	inputTokens: number;
	outputTokens: number;
	/** input/output; 1.0 means no reduction. */
	reductionRatio: number;
	reductionPct: number;
	latencyMs: number;
	modules: StageStat[];
	protectedElements: ProtectedRef[];
	artifacts: ArtifactRef[];
	warnings: string[];
	/** Populated when the pipeline failed open or was bypassed. */
	failure?: { module: string; reason: string };
	/**
	 * Tokens of the leading message run that is byte-identical to the
	 * baseline — the prompt-cache-stable prefix the provider can reuse.
	 */
	unchangedPrefixTokens: number;
	bypassed: boolean;
}

export interface HarnessResult {
	/** False when bypassed or failed open; `messages` is then the original input. */
	ok: boolean;
	messages: Message[];
	report: HarnessReport;
}

/** Mutable state shared across module processing for one pipeline run. */
export interface HarnessState {
	/** Working copy. Modules clone only the messages they modify (identity preservation). */
	messages: Message[];
	systemPrompt?: string[];
	tools?: Tool[];
	/** Immutable baseline (the original input) used by validation and fail-open. */
	baseline: { messages: Message[]; systemPrompt?: string[]; tools?: Tool[] };
	/** Structured protect-pass facts modules consult (recent indices, instruction index, …). */
	protectedIndex: {
		recentStart: number;
		currentInstructionIndex: number | undefined;
	};
	protectedRefs: ProtectedRef[];
	artifacts: ArtifactRef[];
	warnings: string[];
	/** Count of messages actually modified, keyed by module name. */
	mutated: Record<string, number>;
}

export interface HarnessContext {
	config: Required<
		Pick<HarnessConfig, "recentWindowMessages" | "toolResultBudgetTokens" | "dedupMinChars" | "maxLatencyMs">
	>;
	tokenizer: Tokenizer;
	store: ArtifactStore;
	clock: () => number;
}

/**
 * A swappable pipeline module. `process` mutates `state` (cloning only the
 * messages it changes so the tokenizer identity cache keeps hitting), and
 * optional `validate` returns human-readable contract violations.
 */
export interface HarnessModule {
	readonly name: string;
	readonly stage: StageKind;
	/** Lower runs earlier within a stage. */
	readonly priority: number;
	readonly accepts?: readonly MessageShape[];
	health(): ModuleHealth;
	process(state: HarnessState, ctx: HarnessContext): void;
	validate?(state: HarnessState, ctx: HarnessContext): string[];
}

export function resolveHarnessConfig(config?: HarnessConfig): HarnessContext["config"] {
	return {
		recentWindowMessages: config?.recentWindowMessages ?? 8,
		toolResultBudgetTokens: config?.toolResultBudgetTokens ?? 1500,
		dedupMinChars: config?.dedupMinChars ?? 400,
		maxLatencyMs: config?.maxLatencyMs ?? 250,
	};
}
