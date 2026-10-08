/**
 * Prime Token Harness — pipeline engine (prototype).
 *
 * Pure and package-local: no production dispatch, settings UI, or provider
 * code is touched. The eventual integration wraps
 * `createSettingsAwareStreamFn` and passes its result straight through.
 *
 * Failure model:
 * - module throws        → fail open to the ORIGINAL context
 * - validation violated  → fail open to the ORIGINAL context
 * - module unavailable   → skipped with a warning, pipeline continues
 * - config disabled / shouldProcess false → immediate pass-through (bypass)
 */

import { Tokenizer } from "../tokenizer";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	type ArtifactStore,
	type HarnessConfig,
	type HarnessContext,
	type HarnessInput,
	type HarnessModule,
	type HarnessReport,
	type HarnessResult,
	type HarnessState,
	resolveHarnessConfig,
} from "./contract";
import { InMemoryArtifactStore } from "./artifacts";
import { dedupModule } from "./modules/dedup";
import { selectModule } from "./modules/select";
import { suppressModule } from "./modules/suppress";
import { compressModule } from "./modules/compress";
import { assembleModule } from "./modules/assemble";
import { validateModule } from "./modules/validate";

/** Canonical pipeline stage order (protect runs as a harness pre-pass). */
const STAGE_ORDER = ["dedup", "select", "suppress", "compress", "assemble", "validate"] as const;

export interface HarnessOptions {
	/** Override the module set (plug-and-play swap tests). */
	modules?: HarnessModule[];
	/** Supply a preconfigured tokenizer (e.g. catalog-resolved encoding). */
	tokenizer?: Tokenizer;
	clock?: () => number;
	/** Called with pipeline warnings; defaults to silent (TUI-safe). */
	onWarning?: (warning: string) => void;
}

/** The default prototype module set, in stage order. */
export function defaultHarnessModules(): HarnessModule[] {
	return [dedupModule, selectModule, suppressModule, compressModule, assembleModule, validateModule];
}

function countSystem(tokens: Tokenizer, systemPrompt: string[] | undefined): number {
	return systemPrompt && systemPrompt.length > 0 ? tokens.countTokens(systemPrompt) : 0;
}

/** Tokens of the leading run of messages that are object-identical to baseline. */
function unchangedPrefixTokens(messages: Message[], baseline: Message[], tokenizer: Tokenizer): number {
	let tokens = 0;
	for (let i = 0; i < Math.min(messages.length, baseline.length); i++) {
		if (messages[i] !== baseline[i]) break;
		tokens += tokenizer.countMessage(messages[i]);
	}
	return tokens;
}

function bypassResult(
	input: HarnessInput,
	tokenizer: Tokenizer,
	latencyMs: number,
	bypassed: boolean,
	failure?: HarnessReport["failure"],
): HarnessResult {
	const systemTokens = countSystem(tokenizer, input.systemPrompt);
	return {
		ok: false,
		messages: input.messages,
		report: {
			inputTokens: tokenizer.countMessages(input.messages) + systemTokens,
			outputTokens: tokenizer.countMessages(input.messages) + systemTokens,
			reductionRatio: 1,
			reductionPct: 0,
			latencyMs,
			modules: [],
			protectedElements: [],
			artifacts: [],
			warnings: [],
			...(failure ? { failure } : {}),
			unchangedPrefixTokens: tokenizer.countMessages(input.messages) + systemTokens,
			bypassed,
		},
	};
}

export function runTokenHarness(input: HarnessInput, config?: HarnessConfig, options?: HarnessOptions): HarnessResult {
	const clock = options?.clock ?? (() => performance.now());
	const startedAt = clock();
	const tokenizer = options?.tokenizer ?? new Tokenizer(null);
	const store: ArtifactStore = config?.artifactStore ?? new InMemoryArtifactStore();
	const resolved = resolveHarnessConfig(config);
	const ctx: HarnessContext = { config: resolved, tokenizer, store, clock };
	const modules = (options?.modules ?? defaultHarnessModules())
		.slice()
		.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.priority - b.priority);

	// Bypass: master switch or caller applicability decision (integration point
	// for catalog-based local-model exclusion — never a hard-coded id list here).
	if (config?.enabled === false) return bypassResult(input, tokenizer, clock() - startedAt, true);
	if (config?.shouldProcess && !config.shouldProcess(input)) {
		return bypassResult(input, tokenizer, clock() - startedAt, true);
	}

	const baselineMessages: Message[] = [...input.messages];
	const instructionIdx = input.messages.map(m => m.role).lastIndexOf("user");
	const state: HarnessState = {
		messages: [...input.messages],
		systemPrompt: input.systemPrompt,
		tools: input.tools,
		baseline: { messages: baselineMessages, systemPrompt: input.systemPrompt, tools: input.tools },
		protectedIndex: {
			recentStart: Math.max(0, input.messages.length - resolved.recentWindowMessages),
			currentInstructionIndex: instructionIdx >= 0 ? instructionIdx : undefined,
		},
		protectedRefs: [],
		artifacts: [],
		warnings: [],
		mutated: {},
	};

	// PROTECT pre-pass (harness-owned, not a module): snapshot guarantees.
	state.protectedRefs.push(
		{ kind: "system-prompt", detail: `${input.systemPrompt?.length ?? 0} segments (reference-locked)` },
		{ kind: "tool-schemas", detail: `${input.tools?.length ?? 0} tools (reference-locked)` },
		{
			kind: "recent-turns",
			detail: `messages ${state.protectedIndex.recentStart}..${input.messages.length - 1} (identity-locked)`,
		},
		{
			kind: "current-instruction",
			detail: instructionIdx >= 0 ? `message ${instructionIdx} (identity-locked)` : "none",
		},
	);

	const systemTokens = countSystem(tokenizer, input.systemPrompt);
	const inputTokens = tokenizer.countMessages(state.messages) + systemTokens;

	const reportModules: HarnessReport["modules"] = [];
	const failOpen = (module: string, reason: string): HarnessResult => {
		options?.onWarning?.(`[prime-token-harness] fail-open: ${module}: ${reason}`);
		const result = bypassResult(input, tokenizer, clock() - startedAt, false, { module, reason });
		result.report.modules = reportModules;
		result.report.protectedElements = state.protectedRefs;
		result.report.warnings = state.warnings;
		return result;
	};

	for (const module of modules) {
		const health = module.health();
		if (health.status === "unavailable") {
			reportModules.push({
				module: module.name,
				stage: module.stage,
				status: "unavailable",
				latencyMs: 0,
				mutatedMessages: 0,
			});
			state.warnings.push(`module unavailable${health.reason ? `: ${health.reason}` : ""} (${module.name})`);
			continue;
		}
		const before = clock();
		try {
			module.process(state, ctx);
		} catch (error) {
			return failOpen(module.name, error instanceof Error ? error.message : String(error));
		}
		const elapsed = clock() - before;
		if (elapsed > resolved.maxLatencyMs) {
			const warning = `module exceeded latency budget: ${module.name} ${elapsed.toFixed(1)}ms > ${resolved.maxLatencyMs}ms`;
			state.warnings.push(warning);
			options?.onWarning?.(`[prime-token-harness] ${warning}`);
		}
		reportModules.push({
			module: module.name,
			stage: module.stage,
			status: state.mutated[module.name] ? "applied" : "no-change",
			latencyMs: elapsed,
			mutatedMessages: state.mutated[module.name] ?? 0,
		});
	}

	// Collect validation from every executed module.
	const violations: string[] = [];
	for (const module of modules) {
		if (!module.validate) continue;
		try {
			violations.push(...module.validate(state, ctx));
		} catch (error) {
			return failOpen(module.name, `validator threw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (violations.length > 0) {
		return failOpen("validate", violations.join("; "));
	}

	const outputTokens = tokenizer.countMessages(state.messages) + systemTokens;
	const report: HarnessReport = {
		inputTokens,
		outputTokens,
		reductionRatio: outputTokens > 0 ? inputTokens / outputTokens : 1,
		reductionPct: inputTokens > 0 ? ((inputTokens - outputTokens) / inputTokens) * 100 : 0,
		latencyMs: clock() - startedAt,
		modules: reportModules,
		protectedElements: state.protectedRefs,
		artifacts: state.artifacts,
		warnings: state.warnings,
		unchangedPrefixTokens: unchangedPrefixTokens(state.messages, baselineMessages, tokenizer),
		bypassed: false,
	};
	return { ok: true, messages: state.messages, report };
}
