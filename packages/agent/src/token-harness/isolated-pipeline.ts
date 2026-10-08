/**
 * Prime Token Harness — async isolated pipeline entrypoint.
 *
 * Executes modules that opt into isolation (a module carrying `isolated`) in a
 * separate runtime via an {@link IsolatedBackend}, while every other module
 * keeps the established lightweight in-process execution. Isolation and
 * fallback are pipeline-owned, never plugin-trusted:
 *
 *   primary isolated plugin
 *     → on deadline/crash/malformed: attempt the next alternative backend /
 *       module in the same stage
 *     → if no alternative validates: run the failed module's conservative
 *       in-process path (validated)
 *     → if that cannot validate either: fail open to the ORIGINAL context
 *
 * Each isolated attempt gets its own bounded budget; all attempts share one
 * overall deadline, so an endless fallback loop is impossible. A plugin that
 * hangs, crashes, ignores cancellation, or emits malformed output can never
 * bypass validation — every path through validation is required before any
 * transformed context may be dispatched.
 */

import type { Message } from "@oh-my-pi/pi-ai";
import { Tokenizer } from "../tokenizer";
import {
	type ArtifactStore,
	type HarnessConfig,
	type HarnessContext,
	type HarnessInput,
	type HarnessModule,
	type HarnessReport,
	type HarnessResult,
	type HarnessState,
	type IsolatedBackend,
	type IsolatedRequest,
	type IsolatedBudgetConfig,
	resolveHarnessConfig,
	resolveIsolatedBudget,
} from "./contract";
import { InMemoryArtifactStore } from "./artifacts";
import {
	bypassResult,
	countSystemTokens,
	countUnchangedPrefix,
	defaultHarnessModules,
	STAGE_ORDER,
	type HarnessOptions,
} from "./pipeline";

export interface IsolatedHarnessOptions extends HarnessOptions {
	/** The isolated execution backends: primary, then available alternatives. */
	backends: IsolatedBackend | readonly IsolatedBackend[];
	/** Bounded per-module and shared overall execution budgets. */
	budget?: IsolatedBudgetConfig;
	/** External cancellation: aborted mid-attempt fails the stage to conservative/fail-open. */
	signal?: AbortSignal;
}

type ModuleStat = HarnessReport["modules"][number];

export async function runTokenHarnessIsolated(
	input: HarnessInput,
	config: HarnessConfig | undefined,
	options: IsolatedHarnessOptions,
): Promise<HarnessResult> {
	const clock = options?.clock ?? (() => performance.now());
	const startedAt = clock();
	const tokenizer = options?.tokenizer ?? new Tokenizer(null);
	const store: ArtifactStore = config?.artifactStore ?? new InMemoryArtifactStore();
	const resolved = resolveHarnessConfig(config);
	const budget = resolveIsolatedBudget(options.budget);
	const ctx: HarnessContext = { config: resolved, tokenizer, store, clock };
	const modules = (options?.modules ?? defaultHarnessModules())
		.slice()
		.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.priority - b.priority);
	const backends: readonly IsolatedBackend[] = Array.isArray(options.backends)
		? [...options.backends]
		: [options.backends];

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

	const systemTokens = countSystemTokens(tokenizer, input.systemPrompt);
	const inputTokens = tokenizer.countMessages(state.messages) + systemTokens;
	const reportModules: ModuleStat[] = [];
	const overallDeadline = startedAt + budget.overallBudgetMs;

	const failOpen = (module: string, reason: string): HarnessResult => {
		options?.onWarning?.(`[prime-token-harness] fail-open: ${module}: ${reason}`);
		const result = bypassResult(input, tokenizer, clock() - startedAt, false, { module, reason });
		result.report.modules = reportModules;
		result.report.protectedElements = state.protectedRefs;
		result.report.warnings = state.warnings;
		return result;
	};

	const validate = (module: HarnessModule): string[] => {
		if (!module.validate) return [];
		try {
			return module.validate(state, ctx);
		} catch (error) {
			return [`validator threw: ${error instanceof Error ? error.message : String(error)}`];
		}
	};

	const snapshot = (): { messages: Message[]; artifactsLength: number } => ({
		messages: [...state.messages],
		artifactsLength: state.artifacts.length,
	});
	const restore = (value: { messages: Message[]; artifactsLength: number }): void => {
		state.messages = value.messages;
		state.artifacts.length = value.artifactsLength;
	};

	const handledStages = new Set<import("./contract").StageKind>();
	const isolatedFailures = new Map<import("./contract").StageKind, HarnessModule>();

	const runInProcess = (module: HarnessModule): string[] => {
		try {
			module.process(state, ctx);
		} catch (error) {
			return [`${module.name} threw: ${error instanceof Error ? error.message : String(error)}`];
		}
		return validate(module);
	};

	for (const module of modules) {
		if (handledStages.has(module.stage)) {
			reportModules.push({
				module: module.name,
				stage: module.stage,
				status: "skipped-stage-handled",
				latencyMs: 0,
				mutatedMessages: 0,
			});
			continue;
		}
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

		if (!module.isolated) {
			const before = clock();
			const violations = runInProcess(module);
			const elapsed = clock() - before;
			if (violations.length > 0) return failOpen(module.name, violations.join("; "));
			const applied = state.mutated[module.name] !== undefined;
			reportModules.push({
				module: module.name,
				stage: module.stage,
				status: applied ? "applied" : "no-change",
				latencyMs: elapsed,
				mutatedMessages: state.mutated[module.name] ?? 0,
			});
			if (applied) handledStages.add(module.stage);
			continue;
		}

		// Isolated module: primary is the plugin in an isolated runtime.
		if (options.signal?.aborted) {
			return failOpen(module.name, "cancelled before isolated attempt");
		}
		const remaining = overallDeadline - clock();
		const attemptBudget = Math.max(0, Math.min(budget.moduleBudgetMs, remaining));
		if (attemptBudget <= 0) {
			state.warnings.push(`overall isolation deadline exhausted before ${module.name}; conservative fallback`);
			isolatedFailures.set(module.stage, module);
			continue;
		}

		let request: IsolatedRequest | undefined;
		try {
			request = module.isolated.prepare(state, ctx);
		} catch {
			isolatedFailures.set(module.stage, module);
			state.warnings.push(`${module.name}.prepare threw; conservative fallback`);
			continue;
		}
		if (request === undefined) {
			reportModules.push({
				module: module.name,
				stage: module.stage,
				status: "no-change",
				latencyMs: 0,
				mutatedMessages: 0,
			});
			handledStages.add(module.stage);
			continue;
		}

		const before = clock();
		let matched = false;
		let lastFailure = "";
		for (const backend of backends) {
			if (options.signal?.aborted) {
				return failOpen(module.name, "cancelled by caller");
			}
			let result;
			try {
				result = await backend.run(request, { timeoutMs: attemptBudget, signal: options.signal });
			} catch (error) {
				if (options.signal?.aborted) {
					return failOpen(module.name, "cancelled by caller");
				}
				lastFailure = `backend unavailable: ${error instanceof Error ? error.message : String(error)}`;
				continue;
			}
			if (options.signal?.aborted) {
				return failOpen(module.name, "cancelled by caller");
			}
			if (result.ok) {
				const rollback = snapshot();
				try {
					module.isolated.apply(state, ctx, result.payload);
				} catch (error) {
					restore(rollback);
					lastFailure = `apply threw: ${error instanceof Error ? error.message : String(error)}`;
					continue;
				}
				const violations = validate(module);
				if (violations.length > 0) {
					restore(rollback);
					lastFailure = `validation after apply: ${violations.join("; ")}`;
					continue;
				}
				matched = true;
				break;
			}
			lastFailure = `<${result.reason}> ${result.message}`;
		}

		if (matched) {
			reportModules.push({
				module: module.name,
				stage: module.stage,
				status: "applied-isolated",
				latencyMs: clock() - before,
				mutatedMessages: state.mutated[module.name] ?? 0,
			});
			handledStages.add(module.stage);
			continue;
		}
		reportModules.push({
			module: module.name,
			stage: module.stage,
			status: "failed-isolated",
			latencyMs: clock() - before,
			mutatedMessages: 0,
		});
		state.warnings.push(`${module.name}: ${lastFailure || "isolated execution failed"}`);
		isolatedFailures.set(module.stage, module);
	}

	// Conservative validated fallback for stages whose isolated primary failed
	// and no alternative validated. If even the conservative path cannot
	// validate, fail open to the ORIGINAL context.
	for (const [stage, failedModule] of isolatedFailures) {
		if (handledStages.has(stage)) continue;
		const rollback = snapshot();
		const before = clock();
		const violations = runInProcess(failedModule);
		reportModules.push({
			module: failedModule.name,
			stage,
			status: "conservative",
			latencyMs: clock() - before,
			mutatedMessages: state.mutated[failedModule.name] ?? 0,
		});
		if (violations.length > 0) {
			restore(rollback);
			return failOpen(failedModule.name, `conservative fallback failed validation: ${violations.join("; ")}`);
		}
		handledStages.add(stage);
	}

	// Final validation pass (mirror of the sync entrypoint).
	const violations: string[] = [];
	for (const module of modules) {
		if (!module.validate) continue;
		try {
			violations.push(...module.validate(state, ctx));
		} catch (error) {
			return failOpen(module.name, `validator threw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (violations.length > 0) return failOpen("validate", violations.join("; "));

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
		unchangedPrefixTokens: countUnchangedPrefix(state.messages, baselineMessages, tokenizer),
		bypassed: false,
	};
	return { ok: true, messages: state.messages, report };
}
