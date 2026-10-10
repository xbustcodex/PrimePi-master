/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

/**
 * IAI Personal Memory Engine backend settings.
 */

// IAI Memory Backend Selector
export const cfgIaiEnabled = register({
	id: "iai.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "IAI Memory Engine",
		description: "Enable the IAI Personal Memory Engine backend",
	},
});

// Bank configuration
export const cfgIaiBank = register({
	id: "iai.bank",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Retain Bank",
		description: "Bank name for retaining memories (defaults to session ID)",
	},
});

export const cfgIaiBaseBank = register({
	id: "iai.baseBank",
	type: "string",
	default: "shared",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Base Bank",
		description: "Base bank for global/shared memories",
	},
});

export const cfgIaiGlobalBank = register({
	id: "iai.globalBank",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Global Bank",
		description: "Global/shared bank for cross-project recall (per-project-tagged scoping)",
	},
});

export const cfgIaiRecallBanks = register({
	id: "iai.recallBanks",
	type: "array",
	default: [],
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Banks",
		description: "Additional banks to include in recall",
	},
});

export const cfgIaiScoping = register({
	id: "iai.scoping",
	type: "enum",
	values: ["per-project", "per-project-tagged", "global"] as const,
	default: "per-project",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Project Scoping",
		description: "How memories are scoped across projects",
		options: [
			{ value: "per-project", label: "Per Project", description: "Each project has isolated banks" },
			{
				value: "per-project-tagged",
				label: "Per Project Tagged",
				description: "Project banks + shared global bank",
			},
			{ value: "global", label: "Global", description: "Single shared bank for all projects" },
		],
	},
});

export const cfgIaiAutoRecall = register({
	id: "iai.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Auto Recall",
		description: "Automatically recall relevant memories at session start",
	},
});

export const cfgIaiAutoRetain = register({
	id: "iai.autoRetain",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Auto Retain",
		description: "Automatically retain session transcript at session end",
	},
});

export const cfgIaiRetainEveryNTurns = register({
	id: "iai.retainEveryNTurns",
	type: "number",
	default: 5,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Retain Every N Turns",
		description: "Retain transcript every N user turns",
	},
});

export const cfgIaiRetainOverlapTurns = register({
	id: "iai.retainOverlapTurns",
	type: "number",
	default: 2,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Retain Overlap Turns",
		description: "Overlap turns for windowed retention",
		condition: "iaiRetainModeWindowed",
	},
});

export const cfgIaiRetainMode = register({
	id: "iai.retainMode",
	type: "enum",
	values: ["full-session", "windowed"] as const,
	default: "full-session",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Retain Mode",
		description: "Full session transcript or windowed retention",
		options: [
			{
				value: "full-session",
				label: "Full Session",
				description: "Retain entire session transcript incrementally",
			},
			{ value: "windowed", label: "Windowed", description: "Retain last N turns with overlap" },
		],
	},
});

export const cfgIaiRetainContext = register({
	id: "iai.retainContext",
	type: "string",
	default: "coding-agent session transcript",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Retain Context",
		description: "Context prefix for retained transcripts",
	},
});

export const cfgIaiRecallBudget = register({
	id: "iai.recallBudget",
	type: "number",
	default: 4000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Budget (tokens)",
		description: "Token budget for recall operations",
	},
});

export const cfgIaiRecallMaxTokens = register({
	id: "iai.recallMaxTokens",
	type: "number",
	default: 2000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Max Tokens",
		description: "Maximum tokens in recall response",
	},
});

export const cfgIaiRecallContextTurns = register({
	id: "iai.recallContextTurns",
	type: "number",
	default: 3,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Context Turns",
		description: "Number of conversation turns to include in recall query",
	},
});

export const cfgIaiRecallMaxQueryChars = register({
	id: "iai.recallMaxQueryChars",
	type: "number",
	default: 2000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Max Query Chars",
		description: "Maximum characters in recall query",
	},
});

export const cfgIaiRecallPromptPreamble = register({
	id: "iai.recallPromptPreamble",
	type: "string",
	default: "Relevant memories from your long-term memory:",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Recall Prompt Preamble",
		description: "Preamble text for recalled memories block",
	},
});

export const cfgIaiMentalModelsEnabled = register({
	id: "iai.mentalModelsEnabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Mental Models",
		description: "Enable mental model extraction and injection",
	},
});

export const cfgIaiMentalModelAutoSeed = register({
	id: "iai.mentalModelAutoSeed",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Mental Model Auto-Seed",
		description: "Automatically seed mental models from project scope",
		condition: "iaiMentalModelsEnabled",
	},
});

export const cfgIaiMentalModelMaxRenderChars = register({
	id: "iai.mentalModelMaxRenderChars",
	type: "number",
	default: 8000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Mental Model Max Chars",
		description: "Maximum characters for rendered mental models block",
		condition: "iaiMentalModelsEnabled",
	},
});

export const cfgIaiProactiveLinking = register({
	id: "iai.proactiveLinking",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Proactive Linking",
		description: "Enable proactive cross-memory linking",
	},
});

export const cfgIaiPolyphonicRecall = register({
	id: "iai.polyphonicRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Polyphonic Recall",
		description: "Enable multi-perspective recall",
	},
});

export const cfgIaiEnhancedRecall = register({
	id: "iai.enhancedRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Enhanced Recall",
		description: "Enable enhanced recall with fact integration",
	},
});

export const cfgIaiWorkingMemoryTtlHours = register({
	id: "iai.workingMemoryTtlHours",
	type: "number",
	default: 24,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Working Memory TTL (hours)",
		description: "Time-to-live for working memory before consolidation",
	},
});

export const cfgIaiProviderOptions = register({
	id: "iai.providerOptions",
	type: "record",
	default: {},
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Provider Options",
		description: "Embedding provider options (e.g., model, API key for HTTP provider)",
	},
});

// Daemon connection settings
export const cfgIaiSocketPath = register({
	id: "iai.socketPath",
	type: "string",
	default: "",
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Daemon Socket Path",
		description: "Custom path to IAI daemon socket (auto-detected if empty)",
	},
});

export const cfgIaiConnectTimeoutMs = register({
	id: "iai.connectTimeoutMs",
	type: "number",
	default: 5000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Connection Timeout (ms)",
		description: "Timeout for connecting to IAI daemon",
	},
});

export const cfgIaiRequestTimeoutMs = register({
	id: "iai.requestTimeoutMs",
	type: "number",
	default: 30000,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Request Timeout (ms)",
		description: "Timeout for IAI daemon requests",
	},
});

export const cfgIaiDebug = register({
	id: "iai.debug",
	type: "boolean",
	default: false,
	ui: {
		tab: "memory",
		group: "IAI Memory",
		label: "Debug Mode",
		description: "Enable debug logging for IAI backend",
	},
});
