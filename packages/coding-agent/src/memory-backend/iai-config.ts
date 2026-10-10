/**
 * Resolved IAI runtime configuration.
 *
 * Every field reads an `iai.*` setting handle. Handles declare their `IAI_*`
 * environment variable, which wins over the settings layers because operators frequently
 * override per-shell (CI, prod) without touching the persisted settings file.
 */
import type { Settings } from "../config/settings";
import {
	cfgIaiEnabled,
	cfgIaiBank,
	cfgIaiBaseBank,
	cfgIaiGlobalBank,
	cfgIaiRecallBanks,
	cfgIaiScoping,
	cfgIaiAutoRecall,
	cfgIaiAutoRetain,
	cfgIaiRetainEveryNTurns,
	cfgIaiRetainOverlapTurns,
	cfgIaiRetainMode,
	cfgIaiRetainContext,
	cfgIaiRecallBudget,
	cfgIaiRecallMaxTokens,
	cfgIaiRecallContextTurns,
	cfgIaiRecallMaxQueryChars,
	cfgIaiRecallPromptPreamble,
	cfgIaiMentalModelsEnabled,
	cfgIaiMentalModelAutoSeed,
	cfgIaiMentalModelMaxRenderChars,
	cfgIaiProactiveLinking,
	cfgIaiPolyphonicRecall,
	cfgIaiEnhancedRecall,
	cfgIaiWorkingMemoryTtlHours,
	cfgIaiProviderOptions,
	cfgIaiSocketPath,
	cfgIaiConnectTimeoutMs,
	cfgIaiRequestTimeoutMs,
	cfgIaiDebug,
} from "./iai-settings";

export type IaiScoping = "per-project" | "per-project-tagged" | "global";

export interface IaiBackendConfig {
	enabled: boolean;
	bank: string;
	baseBank: string;
	globalBank: string;
	recallBanks: string[];
	scoping: IaiScoping;
	autoRecall: boolean;
	autoRetain: boolean;
	retainEveryNTurns: number;
	retainOverlapTurns: number;
	retainMode: "full-session" | "windowed";
	retainContext: string;
	recallBudget: number;
	recallMaxTokens: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	recallPromptPreamble: string;
	mentalModelsEnabled: boolean;
	mentalModelAutoSeed: boolean;
	mentalModelMaxRenderChars: number;
	proactiveLinking: boolean;
	polyphonicRecall: boolean;
	enhancedRecall: boolean;
	workingMemoryTtlHours: number;
	providerOptions: Record<string, unknown>;
	socketPath: string;
	connectTimeoutMs: number;
	requestTimeoutMs: number;
	debug: boolean;
}

export function loadIaiConfig(settings: Settings): IaiBackendConfig {
	return {
		enabled: cfgIaiEnabled.get(settings),
		bank: cfgIaiBank.get(settings),
		baseBank: cfgIaiBaseBank.get(settings),
		globalBank: cfgIaiGlobalBank.get(settings),
		recallBanks: [...cfgIaiRecallBanks.get(settings)],
		scoping: cfgIaiScoping.get(settings),
		autoRecall: cfgIaiAutoRecall.get(settings),
		autoRetain: cfgIaiAutoRetain.get(settings),
		retainEveryNTurns: cfgIaiRetainEveryNTurns.get(settings),
		retainOverlapTurns: cfgIaiRetainOverlapTurns.get(settings),
		retainMode: cfgIaiRetainMode.get(settings),
		retainContext: cfgIaiRetainContext.get(settings),
		recallBudget: cfgIaiRecallBudget.get(settings),
		recallMaxTokens: cfgIaiRecallMaxTokens.get(settings),
		recallContextTurns: cfgIaiRecallContextTurns.get(settings),
		recallMaxQueryChars: cfgIaiRecallMaxQueryChars.get(settings),
		recallPromptPreamble: cfgIaiRecallPromptPreamble.get(settings),
		mentalModelsEnabled: cfgIaiMentalModelsEnabled.get(settings),
		mentalModelAutoSeed: cfgIaiMentalModelAutoSeed.get(settings),
		mentalModelMaxRenderChars: cfgIaiMentalModelMaxRenderChars.get(settings),
		proactiveLinking: cfgIaiProactiveLinking.get(settings),
		polyphonicRecall: cfgIaiPolyphonicRecall.get(settings),
		enhancedRecall: cfgIaiEnhancedRecall.get(settings),
		workingMemoryTtlHours: cfgIaiWorkingMemoryTtlHours.get(settings),
		providerOptions: cfgIaiProviderOptions.get(settings) ?? {},
		socketPath: cfgIaiSocketPath.get(settings),
		connectTimeoutMs: cfgIaiConnectTimeoutMs.get(settings),
		requestTimeoutMs: cfgIaiRequestTimeoutMs.get(settings),
		debug: cfgIaiDebug.get(settings) ?? false,
	};
}
